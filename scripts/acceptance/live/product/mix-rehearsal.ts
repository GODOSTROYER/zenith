/**
 * ProductScenarioPort for the PROD-MIX-01..04 operational rehearsal (live sandbox, scenario `mix-rehearsal`).
 *
 * One run walks the operator runbooks on the AWS sandbox: docs/platform/operations/MIXED-PARTITIONS.md and MIXED-RECOVERY.md
 * sections 1 and 4. Everything Zenith does goes through the browser driver (`Mix03Product`, mix-03-driver.ts) on the stack the
 * workflow started; this port changes only the sandbox trust of both connection stacks (-live, -live2) and reads AWS back.
 *
 *   P1 (MIX-01)  two connections, A on -live and B on -live2. A plan whose consumer on B depends on a producer on A without
 *                declared connectivity is refused (plan_refused); an independent plan over A and B runs, each environment holds
 *                its own bucket and each child's state is in its own connection's backend.
 *   P2 (MIX-02/03) producer and consumer on A. The execution worker is stopped while the PRODUCER's OpenTofu apply runs and
 *                restarted; the producer must end succeeded with one tagged bucket and unchanged stable addresses. If it ends
 *                indeterminate, the operator reads AWS, records the reconciliation and replans (runbook section 4), and PROD-MIX-02
 *                is not claimed. The consumer waits for the output review (changed parent digest), a person approves it, and
 *                readback proves the consumer's PRODUCER_BUCKET_ARN is the producer bucket.
 *   P3 (MIX-04)  producer and consumer on A; with the producer done and the consumer waiting for its review, the operator cancels
 *                the run: partial, the producer applied without run completion, the consumer cancelled before it started,
 *                nothing compensated, and AWS still holds the producer bucket.
 *   Teardown     P3, P2 (and its replan), P1 through the product (runbook section 1): propose, then per step open the child's own
 *                destroy, release, approve, sync, one at a time, consumers first; releasing a producer first is refused. The
 *                review opens only once each environment's deploy activity settled (about 85 minutes after its deploy), so the
 *                OIDC session is refreshed once before the first destroy. AWS then shows nothing tagged for any environment.
 *   Revocation   connection B is revoked and a new plan on it is refused (connection_unverified).
 *
 * The harness `teardown` (mix-03.ts) still runs last, restores the trust and deletes anything tagged that is left (a leak).
 * Seams: everything mix-03 has, plus `settle`, `refresh`, `applyPollMs` and `relist`. Tests inject all of them.
 */
import type { EnvLike } from "../../config";
import type { Call, ProductScenarioPort } from "../contracts";
import { liveRoleNames } from "../plan";
import {
  canonical, childState, connectLane, fill, inventoryOf, LANES, mix02Order, owned, partitionReadback, pinned, PlanRefusal, preconditions, producerConsumerReadback,
  receiptOf, refuse, Refusal, s3Upload, teardown, TEARDOWN_RESERVE_MS, unwiredProduct, uploadConsumerPackage, verifyConnection,
  type Invoke, type LaneConnection, type Mix03Artifact, type Mix03Child, type Mix03Review, type Mix03Run, type Mix03Seams, type Mix03Tenant, type MixedReadback, type RunState,
} from "./mix-03";
import { refreshSandboxSession } from "./session-refresh";
import { SETTLING } from "./teardown-01";
import { createHash } from "node:crypto";

export const REHEARSAL_REQUIREMENTS = ["PROD-MIX-01", "PROD-MIX-02", "PROD-MIX-03", "PROD-MIX-04"] as const;
type Requirement = (typeof REHEARSAL_REQUIREMENTS)[number];
type Result = Awaited<ReturnType<ProductScenarioPort["verify"]>>;

export interface MixRehearsalSeams extends Mix03Seams {
  /** Wait for deploy settlement before the product teardown: poll interval and bound after the last deploy. */
  settle?: { intervalMs: number; boundMs: number };
  /** Fresh OIDC session for the stack and the harness, once, before the first destroy (session-refresh.ts). */
  refresh?: (env: EnvLike) => Promise<void>;
  /** Poll interval while the producer's operation runs, so the worker stop lands inside its apply. */
  applyPollMs?: number;
  /** Re-lists of the tag inventory after the product teardown: the index lags deletes. */
  relist?: { attempts: number; intervalMs: number };
}
interface Parent { label: string; planId: string; parentOperationId: string; environmentIds: string[] }
interface Pair { parent: Parent; proposed: MixedReadback; atStop?: MixedReadback; downMs?: number; missed?: boolean; reviewed?: Mix03Review; ended: "succeeded" | "indeterminate" }

const ENDED = ["failed", "uncertain", "cancelled", "blocked"];
const WORD = /^[a-z_]{1,40}$/;
const word = (value: string): string => (WORD.test(value) ? value : "unknown");
const APPROVER = "Approvals by an automated test approver through the browser path";
const PHASES = { p1: "partitions", revoke: "revocation", mix02: "worker restart", mix03: "output review", p3: "cancel", teardown: "teardown" } as const;

export function mixRehearsalPort(env: EnvLike = process.env, seams: MixRehearsalSeams = {}): ProductScenarioPort {
  const product = seams.product ?? unwiredProduct;
  const upload = seams.upload ?? s3Upload;
  const sleep = seams.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const propagation = seams.propagation ?? { attempts: 12, intervalMs: 15_000 };
  const polls = seams.polls ?? { attempts: 400, intervalMs: 15_000 };
  const now = seams.now ?? Date.now;
  const quietMs = seams.quietMs ?? 10_000;
  const settle = seams.settle ?? { intervalMs: 120_000, boundMs: 100 * 60_000 };
  const refresh = seams.refresh ?? refreshSandboxSession;
  const applyPollMs = seams.applyPollMs ?? 1_000;
  const relist = seams.relist ?? { attempts: 4, intervalMs: 90_000 };
  let flow: Promise<Record<Requirement, Result>> | undefined;
  return {
    async verify(requirement, context) {
      if (!(REHEARSAL_REQUIREMENTS as readonly string[]).includes(requirement.id)) return { complete: false, reason: `${requirement.id}: not implemented by this port` };
      flow ??= rehearse(context);
      return (await flow)[requirement.id as Requirement];
    },
  };

  async function rehearse({ plan, call, beginCleanup }: Parameters<ProductScenarioPort["verify"]>[1]): Promise<Record<Requirement, Result>> {
    const startedAt = now();
    const run: RunState = { attempted: false, environmentIds: [], trust: [] };
    const deadline = startedAt + plan.settings.durationMinutes * 60_000 - TEARDOWN_RESERVE_MS;
    const invoke: Invoke = (c, values = {}, extra = {}) => call(c, { ...fill(c.input, values), ...extra });
    const planned = (id: string): Call => plan.productCalls?.find(c => c.id === id) ?? refuse(`the plan has no call ${id}`);
    const account = plan.settings.accountId, region = plan.settings.region;
    const principal = `arn:aws:iam::${account}:role/${liveRoleNames().principal}`;
    let step = "preconditions";
    const at = (name: string) => { step = name; };
    const why = (error: unknown) => error instanceof Refusal ? error.message : "unexpected failure (details withheld; no completion claim)";
    /** Each phase's finding: what held, or where and why it stopped. A failed phase never stops the later ones that do not need it. */
    const found: Partial<Record<"p1" | "mix02" | "mix03" | "p3" | "teardown" | "revoke", { ok: boolean; text: string }>> = {};
    const phase = async (key: keyof typeof found, work: () => Promise<string>) => {
      try { found[key] = { ok: true, text: await work() }; } catch (error) { found[key] ??= { ok: false, text: `not proven at ${step}: ${why(error)}` }; }
    };
    const addEnvironments = (ids: string[]) => { run.environmentIds = [...new Set([...run.environmentIds, ...ids])]; };
    const parents: Parent[] = [];
    let lastDeployAt = startedAt, refreshed = false, setup: string | undefined;
    let tenant: Mix03Tenant | undefined, a: LaneConnection | undefined, b: LaneConnection | undefined, artifact: Mix03Artifact | undefined;

    const readback = (planId: string): Promise<MixedReadback> => product.planReadback ? product.planReadback(tenant!, planId) : refuse("the product driver cannot read the stored plan back");
    const mixedRun = (parent: Parent): Promise<Mix03Run> => product.mixedRun ? product.mixedRun(tenant!, parent.parentOperationId) : refuse("the product driver cannot read the run back");
    const propose = async (label: string, input: Parameters<typeof product.proposeMixed>[1]): Promise<Parent> => {
      at(`${label} plan`);
      run.attempted = true;
      const proposal = await product.proposeMixed(tenant!, input);
      if (proposal.environmentIds.length !== 2) refuse("the mixed proposal did not name exactly two child environments");
      addEnvironments(proposal.environmentIds);
      const parent = { label, ...proposal };
      parents.push(parent);
      return parent;
    };
    const start = async (parent: Parent) => {
      at(`${parent.label} start`);
      await product.approve(tenant!, parent.parentOperationId);
      const started = await product.startMixed(tenant!, parent.planId, parent.parentOperationId);
      if (!started.started) refuse(`the mixed parent did not start: ${started.reason}`);
      at(`${parent.label} child rounds`);
    };
    /** Polls the plan's two children; `round` says whether they are done, or how soon to look again. */
    const rounds = async (planId: string, round: (c: { producer: Mix03Child; consumer: Mix03Child; all: Mix03Child[] }) => Promise<"done" | "next" | "fast">) => {
      for (let poll = 1; ; poll++) {
        const all = await product.children(tenant!, planId);
        const producer = all.find(child => child.role === "producer"), consumer = all.find(child => child.role === "consumer");
        if (!producer || !consumer) refuse("the plan does not have two children");
        const next = await round({ producer, consumer, all });
        if (next === "done") return;
        if (poll >= polls.attempts || now() >= deadline) refuse(`the child operations did not finish within the bound (${[producer, consumer].map(childState).join(", ")})`);
        await sleep(next === "fast" ? applyPollMs : polls.intervalMs);
      }
    };
    const succeededChildren = (c: { producer: Mix03Child; consumer: Mix03Child }) => {
      for (const child of [c.producer, c.consumer]) if (!child.childOperationId || child.receiptOperationId !== child.childOperationId) refuse(`the ${child.role} receipt does not link its child operation`);
      lastDeployAt = now();
    };
    const buckets = async (environmentIds: string[]) => (await inventoryOf(invoke, planned("mix03-tag-read"), environmentIds))
      .filter(m => /^arn:aws:s3:::zenith-/.test(m.arn) && owned(m.tags, environmentIds)).map(m => m.arn).sort();

    /** A producer and consumer on connection A. `stopDuringApply`: stop and restart the execution worker during the producer's apply. */
    const pair = async (label: string, stopDuringApply: boolean): Promise<Pair> => {
      const parent = await propose(label, { connectionId: a!.connectionId, accountId: account, region, artifact: artifact! });
      at(`${label} stored plan`);
      const out: Pair = { parent, proposed: await readback(parent.planId), ended: "succeeded" };
      mix02Order(out.proposed);
      await start(parent);
      let last: { producer: Mix03Child; consumer: Mix03Child } | undefined;
      await rounds(parent.planId, async ({ producer, consumer, all }) => {
        last = { producer, consumer };
        if (producer.status !== "succeeded" && (consumer.status === "running" || consumer.status === "succeeded")) refuse("the consumer started before the producer receipt");
        if (out.atStop && (producer.status === "uncertain" || producer.status === "failed")) { out.ended = "indeterminate"; return "done"; }
        if ([producer, consumer].some(child => ENDED.includes(child.status))) refuse(`a child operation did not succeed (${[producer, consumer].map(childState).join(", ")})`);
        if (stopDuringApply && !out.atStop && !out.missed) {
          if (producer.status === "running" && producer.step === "apply_infrastructure") {
            at(`${label} worker stop`);
            const worker = seams.worker ?? refuse("the stack's execution worker is not wired");
            out.atStop = await readback(parent.planId);
            const stoppedAt = now();
            await worker.stop();
            await sleep(quietMs);
            at(`${label} worker restart`);
            await worker.start();
            out.downMs = now() - stoppedAt;
            at(`${label} child rounds`);
            return "next";
          }
          // Missed: the run goes on without the restart, and PROD-MIX-02 is not claimed.
          if (producer.status === "succeeded") out.missed = true;
        }
        for (const child of all) if (child.awaitingOperationId) {
          const review = child.review;
          if (child.role === "consumer" && review && review.requiredParentDigest !== review.previousParentDigest && review.consumers === 1 && review.effectChanged) out.reviewed = review;
          await product.approve(tenant!, child.awaitingOperationId);
        }
        if (producer.status === "succeeded" && consumer.status === "succeeded") return "done";
        return stopDuringApply && !out.atStop && !out.missed && producer.operationStatus === "running" ? "fast" : "next";
      });
      if (out.ended === "succeeded") succeededChildren(last!);
      return out;
    };

    try {
      preconditions(env, plan, "mix-rehearsal");
      at("tenant");
      tenant = await product.createTenant();
      const io = { product, tenant, invoke, planned, run, account, region, principal, at };
      a = await connectLane(io, LANES[0]);
      b = await connectLane(io, LANES[1]);
      if (a.connectionId === b.connectionId) refuse("the product returned one connection for two connection stacks");
      at("connection verification");
      for (const connection of [a, b]) await verifyConnection(product, tenant, connection.connectionId, propagation, sleep);
      at("consumer package");
      artifact = await uploadConsumerPackage(invoke, planned, upload, { region, runId: plan.settings.runId, stateBucket: a.stateBucket, externalId: a.externalId });
    } catch (error) {
      setup = `not proven at ${step}: ${why(error)}`;
    }

    if (!setup) {
      // P1 (MIX-01): partitions and authorities over two separately authorized connections.
      await phase("p1", async () => {
        at("P1 cross-connection plan");
        run.attempted = true;
        try {
          const accepted = await product.proposeMixed(tenant!, { connectionId: a!.connectionId, consumerConnectionId: b!.connectionId, accountId: account, region, artifact: artifact! });
          addEnvironments(accepted.environmentIds);
          refuse("a dependency across two connections without declared connectivity was accepted");
        } catch (error) {
          if (!(error instanceof PlanRefusal)) throw error;
          if (error.reason !== "plan_refused") refuse(`the cross-connection plan was refused for another reason (${word(error.reason)})`);
        }
        const p1 = await propose("P1", { connectionId: a!.connectionId, consumerConnectionId: b!.connectionId, independent: true, accountId: account, region });
        at("P1 stored plan");
        const proposed = await readback(p1.planId);
        if (proposed.children.length !== 2 || proposed.children[0]!.partitionId === proposed.children[1]!.partitionId) refuse("the stored plan does not have two separate partitions");
        if (proposed.children.some(child => child.dependsOn.length || !child.nodes.length)) refuse("the stored plan's partitions are not independent with stable addresses");
        await start(p1);
        let last: { producer: Mix03Child; consumer: Mix03Child } | undefined;
        await rounds(p1.planId, async ({ producer, consumer, all }) => {
          last = { producer, consumer };
          if ([producer, consumer].some(child => ENDED.includes(child.status))) refuse(`a child operation did not succeed (${[producer, consumer].map(childState).join(", ")})`);
          for (const child of all) if (child.awaitingOperationId) await product.approve(tenant!, child.awaitingOperationId);
          return producer.status === "succeeded" && consumer.status === "succeeded" ? "done" : "next";
        });
        succeededChildren(last!);
        const [first, second] = p1.environmentIds as [string, string];
        await partitionReadback(invoke, planned, tenant!.workspaceId, [{ environmentId: first, stateBucket: a!.stateBucket }, { environmentId: second, stateBucket: b!.stateBucket }], at);
        return "a plan whose child on the -live2 connection consumed a typed output of a child on the -live connection, with no declared connectivity, was refused (plan_refused); an independent plan put one child on each connection in two partitions, both succeeded with receipts linking their child operations, and by independent readback each environment holds exactly one tagged bucket of its own and each child's OpenTofu state is in its own connection's state bucket only";
      });

      // P2 (MIX-02, MIX-03): a worker restart during the producer's apply, then the output review and the typed output's provenance.
      await phase("mix03", async () => {
        const first = await pair("P2", true);
        let final = first;
        try {
          if (!first.atStop) refuse(first.missed ? "the producer's apply finished between two polls, before the worker could be stopped during it" : "the worker was never stopped during the producer's apply");
          if (first.ended === "indeterminate") {
            // Runbook section 4: confirm the blast radius, read the provider, record the reconciliation, then replan.
            at("P2 reconcile");
            const { producer } = mix02Order(first.proposed);
            const before = await mixedRun(first.parent);
            if (!before.indeterminate.includes(producer.partitionId)) refuse(`the producer did not succeed after the restart and the run does not ask for its reconciliation (outcome ${word(before.outcome)}; next steps ${before.nextSteps.map(word).join(" ")})`);
            const producerEnv = first.parent.environmentIds[0]!;
            const seen = await buckets([producerEnv]);
            const evidence = createHash("sha256").update(canonical({ runId: plan.settings.runId, environmentId: producerEnv, buckets: seen })).digest("hex");
            const outcome = seen.length ? "effects_present" : "no_effects";
            const recorded = await (product.reconcileChild ?? refuse("the product driver cannot record a reconciliation"))(tenant!, first.parent.parentOperationId, producer.partitionId, outcome, evidence);
            if (!recorded.recorded) refuse(recorded.reason);
            if ((await mixedRun(first.parent)).indeterminate.includes(producer.partitionId)) refuse("the recorded reconciliation did not clear the producer");
            found.mix02 = { ok: false, text: `not proven: the producer ended indeterminate after the worker restart during its apply; per the runbook the operator read AWS (${seen.length} tagged bucket(s)), recorded the reconciliation (${outcome}, evidence sha256 ${evidence.slice(0, 12)}) and replanned; the replanned parent ran without a restart` };
            final = await pair("P2 replan", false);
          } else {
            at("P2 restart readback");
            const end = await readback(first.parent.planId);
            if (pinned(first.atStop) !== pinned(first.proposed) || pinned(end) !== pinned(first.proposed)) refuse("the stored plan's digests, order or stable addresses changed across the worker restart");
            if ([first.proposed, first.atStop, end].some(stored => stored.parentOperationId !== first.parent.parentOperationId)) refuse("the stored plan is not bound to the approved parent operation");
            const { producer, consumer } = mix02Order(end);
            if (first.atStop.children.find(child => child.partitionId === producer.partitionId)?.receipt) refuse("the producer already had a receipt when the worker stopped; the stop was not during its apply");
            receiptOf(end, producer, "producer", first.parent.planId);
            receiptOf(end, consumer, "consumer", first.parent.planId);
            const left = await buckets(first.parent.environmentIds);
            if (left.length !== 1) refuse(`AWS holds ${left.length} tagged producer buckets after the restart, not exactly one`);
            const addresses = first.proposed.children.reduce((n, child) => n + child.nodes.length, 0);
            found.mix02 = { ok: true, text: `the execution worker was stopped while the producer's OpenTofu apply ran (deployment step apply_infrastructure) and restarted ${Math.round((first.downMs ?? 0) / 1000)} s later; the producer ended succeeded with exactly one tagged bucket in AWS; the stored parent plan's digests, dependency order and all ${addresses} stable resource addresses were identical after the proposal, at the stop and at the end; the producer had no receipt at the stop, and both receipts link their child operations and re-derive from their own fields` };
          }
        } catch (error) {
          found.mix02 ??= { ok: false, text: `not proven at ${step}: ${why(error)}` };
          if (first.ended === "indeterminate" && final === first) throw error;
        }
        at(`${final.parent.label} provenance readback`);
        const reviewed = final.reviewed ?? refuse("the consumer never waited for a review binding a changed parent digest and its changed effect");
        await producerConsumerReadback(invoke, planned, region, account, final.parent.environmentIds);
        return `the producer's newly materialized output changed the consumer's effect, so the consumer waited for a review binding the new parent digest (previous ${reviewed.previousParentDigest.slice(0, 12)}, required ${reviewed.requiredParentDigest.slice(0, 12)}); after a person approved it the consumer ran with the typed output, and by independent readback its deployed PRODUCER_BUCKET_ARN equals the producer bucket ARN, the only tagged bucket of the parent (provenance)${final === first ? "" : " on the parent replanned after the reconciliation"}`;
      });

      // P3 (MIX-04): partial success; the operator cancels the run with the producer applied and the consumer waiting.
      await phase("p3", async () => {
        const p3 = await propose("P3", { connectionId: a!.connectionId, accountId: account, region, artifact: artifact! });
        at("P3 stored plan");
        const { producer: producerPart, consumer: consumerPart } = mix02Order(await readback(p3.planId));
        await start(p3);
        await rounds(p3.planId, async ({ producer, consumer, all }) => {
          if (consumer.status === "running" || consumer.status === "succeeded") refuse("the consumer started; the cancel must land while it waits for its output review");
          if ([producer, consumer].some(child => ENDED.includes(child.status))) refuse(`a child operation did not succeed (${[producer, consumer].map(childState).join(", ")})`);
          if (producer.status === "succeeded" && consumer.awaitingOperationId && consumer.review) return "done";
          for (const child of all) if (child.awaitingOperationId && child.role === "producer") await product.approve(tenant!, child.awaitingOperationId);
          return "next";
        });
        lastDeployAt = now();
        at("P3 cancel");
        await (product.cancelMixed ?? refuse("the product driver cannot cancel a run"))(tenant!, p3.parentOperationId);
        at("P3 run readback");
        let view = await mixedRun(p3);
        for (let poll = 1; view.outcome === "in_progress"; poll++) {
          if (poll >= polls.attempts || now() >= deadline) refuse("the cancelled run did not settle within the bound");
          await sleep(polls.intervalMs);
          view = await mixedRun(p3);
        }
        const consumerRun = view.children.find(child => child.childId === consumerPart.partitionId);
        if (view.outcome !== "partial" || !view.cancelled) refuse(`the cancelled run reads ${word(view.outcome)}${view.cancelled ? "" : ", not cancelled"}, not partial`);
        if (view.atomicity !== "none" || view.automaticCompensation !== "never") refuse("the run summary claims atomicity or automatic compensation");
        if (view.appliedWithoutRunCompletion.join() !== producerPart.partitionId) refuse("the run does not list exactly the producer as applied without run completion");
        if (consumerRun?.status !== "cancelled" || consumerRun.started) refuse("the consumer is not cancelled before it started");
        if (!view.nextSteps.includes("propose_teardown_for_human_approval")) refuse("the run's next steps do not propose a teardown for human approval");
        at("P3 AWS readback");
        const [producerEnv, consumerEnv] = p3.environmentIds as [string, string];
        if ((await buckets([producerEnv])).length !== 1) refuse("AWS does not still hold exactly the producer bucket after the cancel");
        if ((await inventoryOf(invoke, planned("mix03-tag-read"), [consumerEnv])).some(m => owned(m.tags, [consumerEnv]))) refuse("the cancelled consumer's environment holds tagged resources");
        return `with the producer succeeded and the consumer waiting for its output review, the operator cancelled the run (POST /api/platform/v1/operations/:id/mixed-run/cancel); the run reads partial and cancelled, with the producer in appliedWithoutRunCompletion, the consumer cancelled before it started, atomicity none, automatic compensation never and propose_teardown_for_human_approval among the next steps (${view.nextSteps.map(word).join(", ")}), and AWS still holds the producer bucket and nothing of the consumer (nothing compensated)`;
      });

      // Teardown (MIX-04, runbook section 1) of every parent, newest first, through the product only.
      await phase("teardown", async () => {
        const settled = async (planId: string, childId: string) => {
          const blocked = product.teardownBlocked ?? refuse("the product driver cannot read teardown readiness");
          for (let reason = await blocked(tenant!, planId, childId); reason !== undefined; reason = await blocked(tenant!, planId, childId)) {
            if (!reason.startsWith(SETTLING)) refuse(`the teardown review was refused for another reason than settlement (product: ${reason})`);
            if (now() - lastDeployAt >= settle.boundMs || now() >= deadline) refuse(`the deploy activity did not settle within ${Math.round(settle.boundMs / 60_000)} minutes of the last deploy`);
            await sleep(settle.intervalMs);
          }
        };
        const need = <T>(method: T | undefined, what: string): T => method ?? refuse(`the product driver cannot ${what}`);
        const proposeTeardown = need(product.proposeTeardown, "propose a teardown"), openChildDestroy = need(product.openChildDestroy, "open a child destroy");
        const releaseTeardown = need(product.releaseTeardown, "release a teardown step"), finishChildDestroy = need(product.finishChildDestroy, "finish a child destroy");
        const syncTeardown = need(product.syncTeardown, "sync a teardown step");
        let orderingRefused = false, steps = 0, settledAfterMs = 0;
        for (const parent of [...parents].reverse()) {
          at(`${parent.label} teardown proposal`);
          const proposal = await proposeTeardown(tenant!, parent.parentOperationId);
          const opened = new Map<string, string>();
          const open = async (childId: string): Promise<string> => {
            at(`${parent.label} settlement wait`);
            await settled(parent.planId, childId);
            settledAfterMs ||= now() - lastDeployAt;
            if (!refreshed) { at("session refresh"); await refresh(env); refreshed = true; }
            at(`${parent.label} child destroy`);
            const destroy = await openChildDestroy(tenant!, parent.planId, childId);
            if (destroy.status !== "awaiting_approval") refuse(`a child's destroy ended ${word(destroy.status)} before its release`);
            opened.set(childId, destroy.destroyOperationId);
            return destroy.destroyOperationId;
          };
          // Ordering: a producer released while its consumer stands is refused; the step stays planned, and its destroy keeps
          // waiting for the release instead of applying (its later release is accepted only because it has not ended).
          const early = proposal.steps.find(item => item.after.length);
          if (early && !orderingRefused) {
            at(`${parent.label} ordering check`);
            const released = await releaseTeardown(tenant!, parent.parentOperationId, early.childId, await open(early.childId));
            if (released.released) refuse("a producer's teardown was released while its consumer still stands");
            if (!released.reason.includes("ordering_blocked")) refuse(`the early producer release was refused for another reason (${released.reason})`);
            orderingRefused = true;
          }
          const pending = [...proposal.steps], done = new Set<string>();
          while (pending.length) {
            const index = pending.findIndex(item => item.after.every(id => done.has(id)));
            if (index < 0) refuse("a teardown step waits for a step outside the proposal");
            const [item] = pending.splice(index, 1);
            const destroyOperationId = opened.get(item!.childId) ?? await open(item!.childId);
            at(`${parent.label} teardown release`);
            const released = await releaseTeardown(tenant!, parent.parentOperationId, item!.childId, destroyOperationId);
            if (!released.released) refuse(released.reason);
            at(`${parent.label} child destroy`);
            const ended = await finishChildDestroy(tenant!, destroyOperationId);
            if (ended.status !== "succeeded") refuse(`a child's destroy ended ${word(ended.status)}${ended.halt ? `:${word(ended.halt)}` : ""}`);
            at(`${parent.label} teardown sync`);
            const synced = await syncTeardown(tenant!, parent.parentOperationId, item!.childId);
            if (synced.status !== "destroyed") refuse(`a synced teardown step is ${word(synced.status)}, not destroyed`);
            done.add(item!.childId);
            steps++;
          }
        }
        if (!orderingRefused) refuse("no run had a producer behind a consumer, so the ordering refusal was never shown");
        at("teardown AWS readback");
        const left = async () => (await inventoryOf(invoke, planned("mix03-tag-read"), run.environmentIds))
          .filter(m => owned(m.tags, run.environmentIds) && (/^arn:aws:s3:::/.test(m.arn) || /:function:/.test(m.arn))).length;
        let remaining = await left();
        // The tagging index lags deletes: re-list a few times before calling anything a leftover.
        for (let attempt = 1; remaining && attempt < relist.attempts; attempt++) { await sleep(relist.intervalMs); remaining = await left(); }
        if (remaining) refuse(`${remaining} tagged bucket(s) or function(s) of the run's environments remain after the product teardown`);
        return `the product tore down all ${parents.length} parents, newest first: each run's teardown proposal (consumers first); each step's destroy opened in the child's own environment once its deploy activity settled (${Math.round(settledAfterMs / 60_000)} minutes after the last deploy), released, approved by a person and synced destroyed, one at a time (${steps} steps); releasing a producer before its consumer was refused (ordering_blocked); afterwards AWS shows no tagged bucket or function in any of the run's ${run.environmentIds.length} environments`;
      });

      // Runbook section 4, revoked partition connection: revocation is terminal and a new plan on it is refused.
      await phase("revoke", async () => {
        at("connection revoke");
        const revoked = await (product.revokeConnection ?? refuse("the product driver cannot revoke a connection"))(tenant!, b!.connectionId);
        if (revoked.status !== "revoked") refuse(`the revoked connection reads back ${word(revoked.status)}`);
        at("plan on the revoked connection");
        try {
          const accepted = await product.proposeMixed(tenant!, { connectionId: b!.connectionId, consumerConnectionId: b!.connectionId, independent: true, accountId: account, region });
          addEnvironments(accepted.environmentIds);
          refuse("a plan on the revoked connection was accepted");
        } catch (error) {
          if (!(error instanceof PlanRefusal)) throw error;
          if (error.reason !== "connection_unverified") refuse(`the plan on the revoked connection was refused for another reason (${word(error.reason)})`);
        }
        return "the -live2 connection was then revoked through connection.revoke (status revoked) and a new plan on it was refused (connection_unverified)";
      });
    }

    // From here the run's duration envelope no longer applies; the harness bounds cleanup on its own clock.
    beginCleanup?.();
    const leaks: string[] = [];
    // The harness cleanup needs a live session: refresh once if the run outlived the first one and did not refresh yet.
    if (!refreshed && run.attempted && now() - startedAt >= 40 * 60_000) {
      try { await refresh(env); } catch (error) { leaks.push(`session refresh before cleanup failed${error instanceof Refusal ? `: ${error.message}` : ""}`); }
    }
    leaks.push(...await teardown(run, plan, invoke, planned, principal).catch(() => ["cleanup did not complete; resources may remain"]));
    try { await product.close?.(); } catch { /* the browser is released best-effort; the outcome above stands */ }

    const head = (id: Requirement) => `${id} operational rehearsal (live AWS sandbox, operator runbook MIXED-PARTITIONS.md and MIXED-RECOVERY.md sections 1 and 4)`;
    const result = (id: Requirement, parts: (keyof typeof found)[]): Result => {
      if (setup) return { complete: false, reason: `${head(id)} ${setup}` };
      const missing = parts.filter(key => !found[key]?.ok);
      if (missing.length) return { complete: false, reason: `${head(id)} not proven: ${parts.map(key => `${PHASES[key]} ${found[key]?.ok ? "held" : found[key]?.text ?? "not reached"}`).join("; ")}` };
      return { complete: true, reason: `${head(id)} passed: ${parts.map(key => found[key]!.text).join("; ")}. ${APPROVER}` };
    };
    const results: Record<Requirement, Result> = {
      "PROD-MIX-01": result("PROD-MIX-01", ["p1", "revoke"]),
      "PROD-MIX-02": result("PROD-MIX-02", ["mix02"]),
      "PROD-MIX-03": result("PROD-MIX-03", ["mix03"]),
      "PROD-MIX-04": result("PROD-MIX-04", ["p3", "teardown"]),
    };
    // Leaks are reported once, on PROD-MIX-04, and fail all four.
    if (leaks.length) for (const id of REHEARSAL_REQUIREMENTS) results[id] = { complete: false, reason: `${results[id].reason}; cleanup leaks: ${leaks.length} (${id === "PROD-MIX-04" ? "see the cleanup checks" : "reported on PROD-MIX-04"})`, ...(id === "PROD-MIX-04" ? { leaks } : {}) };
    else results["PROD-MIX-04"] = { ...results["PROD-MIX-04"], leaks: [] };
    return results;
  }
}
