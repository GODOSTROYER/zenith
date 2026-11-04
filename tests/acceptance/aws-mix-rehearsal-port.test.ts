/**
 * PROD-MIX-01..04 operational rehearsal port (`mix-rehearsal`), offline. The browser driver is a stateful fake of the four mixed
 * parents, the AWS side is an in-memory world answered only for planned calls, and the real Guard admits or refuses every call.
 * No cloud, stack or browser is used. Live evidence comes only from an approved run of scripts/acceptance/aws-live.ts.
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { allCalls, buildPlan, evidenceLevel, LANE_SCENARIOS, mix01ProductCalls, scopedRequirementIds } from "../../scripts/acceptance/live/plan";
import { grantsFor, Guard } from "../../scripts/acceptance/live/guard";
import { evidencePacket, releaseSource } from "../../scripts/acceptance/live/evidence";
import type { Call, Journal, Json, Plan } from "../../scripts/acceptance/live/contracts";
import { PlanRefusal, trustDocument, type Mix03Child, type Mix03Product, type Mix03Run, type MixedReadback } from "../../scripts/acceptance/live/product/mix-03";
import { mixRehearsalPort, type MixRehearsalSeams } from "../../scripts/acceptance/live/product/mix-rehearsal";
import { SETTLING } from "../../scripts/acceptance/live/product/teardown-01";
import { buildReceipt } from "@/lib/execution/mixed/receipt";
import { inspectEvidence, sourceOutcome } from "../../scripts/release/status.mjs";
import { main as evidenceCli } from "../../scripts/release/evidence-cli.mjs";

const ACCOUNT = "123456789012", REGION = "ap-south-1", RUN = "zlive-202611040000-ab01", COMMIT = "a".repeat(40);
const PRINCIPAL = `arn:aws:iam::${ACCOUNT}:role/ZenithLiveAcceptance`;
const OLD_EXT = "old-live-external-id", NEW_EXT = `zenith-${"b".repeat(32)}`;
const settings = { accountId: ACCOUNT, region: REGION, runId: RUN, durationMinutes: 150, dbSubnetGroup: "zenith-live-sandbox", dbSecurityGroup: "sg-12345678", workloadBoundaryArn: `arn:aws:iam::${ACCOUNT}:policy/ZenithLiveWorkloadBoundary`, scenario: "mix-rehearsal" as const };
const env = { ZENITH_LIVE_PRODUCT: "1", AWS_ACCESS_KEY_ID: "test-access", AWS_SECRET_ACCESS_KEY: "test-secret", AWS_SESSION_TOKEN: "test-token" };
const STATE = { a: `zenith-state-${ACCOUNT}-${REGION}-live`, b: `zenith-state-${ACCOUNT}-${REGION}-live2` };
const REVIEW = { previousParentDigest: "1".repeat(64), requiredParentDigest: "c".repeat(64), consumers: 1, effectChanged: true };
const IDS = ["PROD-MIX-01", "PROD-MIX-02", "PROD-MIX-03", "PROD-MIX-04"] as const;
const h = (c: string) => c.repeat(64);

type ProducerState = "awaiting" | "planning" | "applying" | "succeeded" | "uncertain";
type ConsumerState = "pending" | "review" | "awaiting" | "succeeded" | "cancelled";
interface ParentFake { n: number; kind: "independent" | "pair"; connections: [string, string]; producer: ProducerState; consumer: ConsumerState; cancelled: boolean; reconciled: boolean; destroyed: Set<string> }
interface Options { crossAccepted?: boolean; revokedReason?: string; uncertainAfterRestart?: boolean; skipApply?: boolean; partialOutcome?: string; leftover?: boolean; settling?: number; settleReason?: string }

/** The world: both stacks' trust documents, every parent the fake product created, and what was deleted. */
function world() {
  return {
    trust: { "-live": { observe: trustDocument(PRINCIPAL, OLD_EXT), deploy: trustDocument(PRINCIPAL, OLD_EXT) }, "-live2": { observe: trustDocument(PRINCIPAL, OLD_EXT), deploy: trustDocument(PRINCIPAL, OLD_EXT) } } as Record<string, Record<"observe" | "deploy", string>>,
    parents: [] as ParentFake[], deleted: new Set<string>(), events: [] as string[], revoked: new Set<string>(),
  };
}
type World = ReturnType<typeof world>;
const envOf = (n: number, role: "p" | "c") => `env${n}${role}`, partOf = (n: number, role: "p" | "c") => `partition/${String(n)}${role}`;
const bucketOf = (n: number, role: "p" | "c") => `zenith-env${n}${role}-bucket`, fnOf = (n: number) => `zenith-env${n}c-consumer`;
const tags = (environmentId: string) => [{ Key: "zenith:managed", Value: "true" }, { Key: "zenith:environment", Value: environmentId }];

/** The tagged resources one environment holds right now. */
function resourcesOf(state: World, environmentId: string, options: Options) {
  const parent = state.parents.find(p => envOf(p.n, "p") === environmentId || envOf(p.n, "c") === environmentId);
  if (!parent) return [];
  const role = envOf(parent.n, "p") === environmentId ? "p" : "c";
  const out: { ResourceARN: string; Tags: { Key: string; Value: string }[] }[] = [];
  const keep = (arn: string) => !state.deleted.has(arn) && (!parent.destroyed.has(partOf(parent.n, role)) || (options.leftover && role === "p" && parent.n === 1));
  if (parent.kind === "independent" && parent.producer === "succeeded") out.push({ ResourceARN: `arn:aws:s3:::${bucketOf(parent.n, role)}`, Tags: tags(environmentId) });
  if (parent.kind === "pair" && role === "p" && ["succeeded", "uncertain"].includes(parent.producer)) out.push({ ResourceARN: `arn:aws:s3:::${bucketOf(parent.n, "p")}`, Tags: tags(environmentId) });
  if (parent.kind === "pair" && role === "c" && parent.consumer === "succeeded") out.push({ ResourceARN: `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${fnOf(parent.n)}`, Tags: tags(environmentId) });
  return out.filter(r => keep(r.ResourceARN));
}

function respond(state: World, options: Options, c: Call, input: Record<string, Json>): Record<string, unknown> {
  const lane = c.id.startsWith("mix01-live2-") ? "-live2" : "-live";
  const role = c.id.endsWith("observe") ? "observe" : "deploy";
  if (/iam-read-(observe|deploy)$/.test(c.id)) return { Role: { AssumeRolePolicyDocument: encodeURIComponent(state.trust[lane]![role]) } };
  if (/iam-trust-(observe|deploy)$/.test(c.id)) { state.trust[lane]![role] = String(input.PolicyDocument); return {}; }
  switch (c.id) {
    case "mix03-sts-assume": expect(input.ExternalId).toBe(NEW_EXT); return { Credentials: { AccessKeyId: "A", SecretAccessKey: "S", SessionToken: "T" } };
    case "mix03-tag-read": return { ResourceTagMappingList: resourcesOf(state, (input.TagFilters as { Values: string[] }[])[0]!.Values[0]!, options) };
    case "mix03-lambda-read": { const n = Number(/^zenith-env(\d+)c-consumer$/.exec(String(input.FunctionName))?.[1]); return { Role: `arn:aws:iam::${ACCOUNT}:role/zenith-env${n}c-fn`, Environment: { Variables: { PRODUCER_BUCKET_ARN: `arn:aws:s3:::${bucketOf(n, "p")}` } } }; }
    case "mix03-bucket-head": return {};
    case "mix03-bucket-tags": return { TagSet: tags(String(input.Bucket).replace(/^zenith-(env\d+[pc])-bucket$/, "$1")) };
    case "mix01-state-list": {
      const parent = state.parents.find(p => p.kind === "independent")!;
      const keys = [STATE.a === input.Bucket ? `zenith/ws-1/${envOf(parent.n, "p")}/terraform.tfstate` : `zenith/ws-1/${envOf(parent.n, "c")}/terraform.tfstate`];
      return { Contents: keys.filter(key => key.startsWith(String(input.Prefix))).map(Key => ({ Key })) };
    }
    case "mix03-lambda-delete": state.deleted.add(`arn:aws:lambda:${REGION}:${ACCOUNT}:function:${String(input.FunctionName)}`); return {};
    case "mix03-bucket-delete": state.deleted.add(`arn:aws:s3:::${String(input.Bucket)}`); return {};
    case "mix03-logs-delete": case "mix03-role-inline-delete": case "mix03-role-delete": return {};
    case "mix03-role-read": return { Role: { Tags: tags(String(input.RoleName).replace(/^zenith-(env\d+c)-fn$/, "$1")) } };
    case "mix03-role-attached-list": return { AttachedPolicies: [] };
    case "mix03-role-inline-list": return { PolicyNames: [] };
    default: throw new Error(`unexpected planned call in the fake: ${c.id}`);
  }
}

/** The stored plan of one parent, as the driver reads it back: stable digests and addresses, receipts once a child succeeded. */
function readbackOf(parent: ParentFake): MixedReadback {
  const at = "2026-11-04T00:00:00.000Z", planId = `plan-${parent.n}`;
  const child = (role: "p" | "c", done: boolean, ordinal: number) => {
    const partitionId = partOf(parent.n, role), childOperationId = `op-${parent.n}-${role}`, semantics = h(role === "p" ? "d" : "e");
    return {
      partitionId, dependsOn: parent.kind === "pair" && role === "c" ? [partOf(parent.n, "p")] : [], subplanDigest: h(role === "p" ? "4" : "8"), semanticsDigest: h("5"), effectDigest: h("6"),
      nodes: [{ stableAddress: `aws:${ACCOUNT}:${REGION}::${role}.${parent.n}`, address: `${role}.${parent.n}`, specDigest: h("7") }],
      state: done ? "succeeded" : "pending", childOperationId: done ? childOperationId : null, executableSemanticsDigest: done ? semantics : null,
      receipt: done ? buildReceipt({ workspaceId: "ws-1", parentPlanId: planId, partitionId, ordinal, childOperationId, outcome: "succeeded", childStatus: "succeeded", executableSemanticsDigest: semantics, planDigest: h("f") }, at) : null,
    };
  };
  const producerDone = parent.producer === "succeeded", consumerDone = parent.kind === "independent" ? producerDone : parent.consumer === "succeeded";
  return {
    status: "running", parentOperationId: `op-${parent.n}`, parentDigest: h("1"), desiredDigest: h("2"), childSetDigest: h("3"),
    executionOrder: [partOf(parent.n, "p"), partOf(parent.n, "c")], children: [child("p", producerDone, 0), child("c", consumerDone, 1)],
  };
}

/** The product side: four parents' child rounds, the run summary, cancel, reconcile, teardown and revocation. */
function fakeProduct(state: World, options: Options = {}): Mix03Product & { calls: string[] } {
  const calls: string[] = [];
  let settling = options.settling ?? 2, connections = 0;
  const applyShown = new Set<number>();
  const parentOf = (key: string) => state.parents.find(p => key === `plan-${p.n}` || key === `op-${p.n}`) ?? (() => { throw new Error(`no parent ${key}`); })();
  const runOf = (parent: ParentFake): Mix03Run => {
    const p = partOf(parent.n, "p"), c = partOf(parent.n, "c");
    const indeterminate = parent.producer === "uncertain" && !parent.reconciled ? [p] : [];
    const partial = parent.cancelled;
    return {
      outcome: partial ? options.partialOutcome ?? "partial" : indeterminate.length ? "indeterminate" : "complete", nextSteps: partial ? ["propose_teardown_for_human_approval", "review_replan"] : ["none"], steps: [],
      atomicity: "none", automaticCompensation: "never", cancelled: partial, appliedWithoutRunCompletion: partial ? [p] : [], indeterminate,
      children: [{ childId: p, status: parent.producer === "succeeded" ? "succeeded" : "failed", effects: "present", started: true }, { childId: c, status: partial ? "cancelled" : "succeeded", effects: partial ? "none" : "present", started: !partial }],
    };
  };
  return {
    calls,
    createTenant: async () => ({ workspaceId: "ws-1", approverId: "approver-1" }),
    createAwsConnection: async (_t, input) => { calls.push(`connection ${input.bootstrapNameSuffix} ${input.stateBucket}`); return { connectionId: `conn-${++connections}`, externalId: NEW_EXT }; },
    verifyAws: async () => ({ ok: true, reason: "" }),
    proposeMixed: async (_t, input) => {
      const consumerConnection = input.consumerConnectionId ?? input.connectionId;
      if ([input.connectionId, consumerConnection].some(id => state.revoked.has(id))) throw new PlanRefusal("the product refused the mixed plan (invalid state, connection_unverified)", options.revokedReason ?? "connection_unverified");
      if (!input.independent && consumerConnection !== input.connectionId && !options.crossAccepted) throw new PlanRefusal("the product refused the mixed plan (invalid state, plan_refused)", "plan_refused");
      const n = state.parents.length + 1;
      state.parents.push({ n, kind: input.independent ? "independent" : "pair", connections: [input.connectionId, consumerConnection], producer: "awaiting", consumer: "pending", cancelled: false, reconciled: false, destroyed: new Set() });
      calls.push(`propose ${n} ${input.independent ? "independent" : "pair"}`);
      return { environmentIds: [envOf(n, "p"), envOf(n, "c")], planId: `plan-${n}`, parentOperationId: `op-${n}` };
    },
    approve: async (_t, operationId) => {
      calls.push(`approve ${operationId}`);
      const parent = state.parents.find(p => operationId.startsWith(`op-${p.n}-`));
      if (!parent) return;
      if (operationId.endsWith("-p")) parent.producer = parent.kind === "independent" ? "succeeded" : options.skipApply ? "succeeded" : "planning";
      if (operationId.endsWith("-review")) parent.consumer = "awaiting";
      if (operationId.endsWith("-c")) parent.consumer = "succeeded";
    },
    startMixed: async () => ({ started: true }),
    planReadback: async (_t, planId) => readbackOf(parentOf(planId)),
    children: async (_t, planId) => {
      const parent = parentOf(planId), n = parent.n;
      const producer: Mix03Child = { role: "producer", status: "running", childOperationId: `op-${n}-p` };
      if (parent.producer === "awaiting") Object.assign(producer, { operationStatus: "awaiting_approval", awaitingOperationId: `op-${n}-p` });
      else if (parent.producer === "planning") { Object.assign(producer, { operationStatus: "running", step: "final_plan" }); parent.producer = "applying"; }
      // The apply shows once; the next read sees it finished, unless a worker restart decided its end first.
      else if (parent.producer === "applying" && !applyShown.has(n)) { Object.assign(producer, { operationStatus: "running", step: "apply_infrastructure" }); applyShown.add(n); }
      else if (parent.producer === "applying") { parent.producer = "succeeded"; Object.assign(producer, { status: "succeeded", receiptOperationId: `op-${n}-p` }); }
      else if (parent.producer === "uncertain") Object.assign(producer, { status: "uncertain", operationStatus: "uncertain" });
      else Object.assign(producer, { status: "succeeded", receiptOperationId: `op-${n}-p` });
      if (parent.kind === "independent") return [producer, { ...producer, role: "consumer", childOperationId: `op-${n}-c`, ...(producer.receiptOperationId ? { receiptOperationId: `op-${n}-c` } : {}), ...(producer.awaitingOperationId ? { awaitingOperationId: `op-${n}-c` } : {}) }];
      if (parent.producer === "succeeded" && parent.consumer === "pending" && !parent.cancelled) parent.consumer = "review";
      const consumer: Mix03Child = parent.consumer === "review" ? { role: "consumer", status: "pending", awaitingOperationId: `op-${n}-review`, review: REVIEW }
        : parent.consumer === "awaiting" ? { role: "consumer", status: "running", childOperationId: `op-${n}-c`, operationStatus: "awaiting_approval", awaitingOperationId: `op-${n}-c` }
        : parent.consumer === "succeeded" ? { role: "consumer", status: "succeeded", childOperationId: `op-${n}-c`, receiptOperationId: `op-${n}-c` }
        : { role: "consumer", status: parent.cancelled ? "cancelled" : "pending" };
      return [producer, consumer];
    },
    issueOutputPreauthorization: async () => undefined,
    preauthorizationUses: async () => ({ total: 0, uses: 0, maxUses: 0, active: 0 }),
    mixedRun: async (_t, op) => runOf(parentOf(op)),
    cancelMixed: async (_t, op) => { calls.push(`cancel ${op}`); const parent = parentOf(op); parent.cancelled = true; parent.consumer = "cancelled"; },
    reconcileChild: async (_t, op, childId, outcome, digest) => { calls.push(`reconcile ${op} ${childId} ${outcome} ${digest.length}`); parentOf(op).reconciled = true; return { recorded: true }; },
    teardownBlocked: async () => (settling-- > 0 ? `${SETTLING} Teardown can start once ...` : options.settleReason),
    proposeTeardown: async (_t, op) => {
      calls.push(`propose-teardown ${op}`);
      const parent = parentOf(op), p = partOf(parent.n, "p"), c = partOf(parent.n, "c");
      const step = (childId: string, after: string[]) => ({ childId, status: "planned", after, addresses: 1 });
      const steps = parent.kind === "independent" ? [step(p, []), step(c, [])] : parent.cancelled || parent.producer === "uncertain" ? [step(p, [])] : [step(c, []), step(p, [c])];
      return { steps, retained: 0, nothingToDestroy: [] };
    },
    openChildDestroy: async (_t, _planId, childId) => { calls.push(`open ${childId}`); return { destroyOperationId: `d-${childId.replace("partition/", "")}`, status: "awaiting_approval" }; },
    releaseTeardown: async (_t, op, childId) => {
      const parent = parentOf(op);
      if (parent.kind === "pair" && !parent.cancelled && parent.producer !== "uncertain" && childId === partOf(parent.n, "p") && !parent.destroyed.has(partOf(parent.n, "c")))
        return { released: false, reason: "the product refused the release (invalid state, ordering_blocked: wait)" };
      calls.push(`release ${childId}`);
      return { released: true };
    },
    finishChildDestroy: async (_t, destroyOperationId) => {
      const parent = state.parents.find(p => destroyOperationId === `d-${p.n}p` || destroyOperationId === `d-${p.n}c`)!;
      parent.destroyed.add(`partition/${destroyOperationId.slice(2)}`);
      return { status: "succeeded" };
    },
    syncTeardown: async (_t, _op, childId) => ({ childId, status: "destroyed", after: [], addresses: 1 }),
    revokeConnection: async (_t, connectionId) => { calls.push(`revoke ${connectionId}`); state.revoked.add(connectionId); return { status: "revoked" }; },
  };
}

function harness(state: World, product: Mix03Product, seams: Partial<MixRehearsalSeams> = {}, environment: Record<string, string | undefined> = env, options: Options = {}) {
  const plan: Plan = buildPlan(settings);
  const permission = {
    schema: 1 as const, decision: "DEC-CLOUD" as const, approvedBy: "owner-test", approvedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
    accountId: ACCOUNT, region: REGION, runId: RUN, planSha256: plan.sha256, sourceCommit: COMMIT, maxUsd: plan.estimate.usd, maxMinutes: plan.settings.durationMinutes, grants: grantsFor(plan),
  };
  const guard = new Guard(plan, permission, plan.estimate.usd);
  const sent: string[] = [];
  const call = async (c: Call, input?: Record<string, Json>) => { guard.consume(c); sent.push(c.id); return respond(state, options, c, input ?? c.input); };
  const refresh = vi.fn(async () => { state.events.push("refresh"); });
  const worker = { stop: async () => { state.events.push("stop"); }, start: async () => { state.events.push("start"); for (const p of state.parents) if (p.producer === "applying") p.producer = options.uncertainAfterRestart ? "uncertain" : "succeeded"; } };
  const beginCleanup = vi.fn();
  const port = mixRehearsalPort(environment, { product, worker, refresh, upload: async () => "3HL4kqtJlcpXroDTDmJ", sleep: async () => undefined, propagation: { attempts: 3, intervalMs: 0 }, polls: { attempts: 40, intervalMs: 0 }, settle: { intervalMs: 0, boundMs: 60_000 }, relist: { attempts: 2, intervalMs: 0 }, quietMs: 0, ...seams });
  const verifyAll = async () => Object.fromEntries(await Promise.all(IDS.map(async id => [id, await port.verify({ id, acceptance: [], fixtures: [], join: "" }, { plan, commit: COMMIT, call, beginCleanup })] as const)));
  return { plan, sent, refresh, beginCleanup, verifyAll, port, call };
}

describe("mix-rehearsal plan", () => {
  it("scopes PROD-MIX-01..04, runs on both stacks with the PROD-MIX-01 calls, 120..150 minutes, and records operational_rehearsal", () => {
    const plan = buildPlan(settings);
    expect(plan.fixtures).toEqual([]);
    expect(scopedRequirementIds(plan.settings, ["PROD-MIX-01", "PROD-OPS-01"])).toEqual([...IDS]);
    expect(LANE_SCENARIOS).toContain("mix-rehearsal");
    const ids = allCalls(plan).map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect((plan.productCalls ?? []).map(c => [c.id, c.action, c.resource])).toEqual(mix01ProductCalls(ACCOUNT, REGION, RUN).map(c => [c.id, c.action, c.resource]));
    expect(plan.productCalls!.find(c => c.id === "mix03-tag-read")!.maximumCalls).toBe(80);
    expect(plan.estimate.usd).toBe(2.75);
    expect(buildPlan({ ...settings, durationMinutes: 120 }).estimate.usd).toBe(2.3);
    expect(() => buildPlan({ ...settings, durationMinutes: 119 })).toThrow("120..150");
    expect(() => buildPlan({ ...settings, durationMinutes: 151 })).toThrow("120..150");
    expect(evidenceLevel(plan.settings)).toBe("operational_rehearsal");
    expect(evidenceLevel(buildPlan({ ...settings, scenario: "mix-01", durationMinutes: 40 }).settings)).toBe("live_sandbox");
  });
});

describe("PROD-MIX-01..04 operational rehearsal port", () => {
  it("refuses all four without ZENITH_LIVE_PRODUCT=1 and makes no call", async () => {
    const state = world();
    const { verifyAll, sent } = harness(state, fakeProduct(state), {}, { ...env, ZENITH_LIVE_PRODUCT: undefined });
    const results = await verifyAll();
    for (const id of IDS) expect(results[id]).toMatchObject({ complete: false, reason: expect.stringContaining("ZENITH_LIVE_PRODUCT=1") });
    expect(sent).toEqual([]);
  });

  it("walks the runbook: refusal and partitions, restart during the apply, review and provenance, cancel, ordered teardown, revocation", async () => {
    const state = world(), product = fakeProduct(state);
    const { verifyAll, refresh, beginCleanup, sent } = harness(state, product);
    const results = await verifyAll();
    for (const id of IDS) {
      expect(results[id]!.reason, id).toContain(`${id} operational rehearsal`);
      expect(results[id]!.complete, results[id]!.reason).toBe(true);
    }
    expect(results["PROD-MIX-01"]!.reason).toContain("(plan_refused)");
    expect(results["PROD-MIX-01"]!.reason).toContain("(connection_unverified)");
    expect(results["PROD-MIX-02"]!.reason).toContain("apply_infrastructure");
    expect(results["PROD-MIX-03"]!.reason).toContain("PRODUCER_BUCKET_ARN equals the producer bucket ARN");
    expect(results["PROD-MIX-04"]!.reason).toContain("ordering_blocked");
    expect(results["PROD-MIX-04"]!.leaks).toEqual([]);
    // Connections: -live then -live2, each with its own state bucket.
    expect(product.calls.slice(0, 2)).toEqual([`connection -live ${STATE.a}`, `connection -live2 ${STATE.b}`]);
    // The worker stopped once, during the producer's apply, and the session was refreshed once, before the first destroy.
    expect(state.events).toEqual(["stop", "start", "refresh"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(beginCleanup).toHaveBeenCalledTimes(1);
    // Teardown newest first (P3 = parent 3, P2 = parent 2, P1 = parent 1); P2's producer only after its consumer.
    const teardownOrder = product.calls.filter(call => /^(propose-teardown|release|cancel|revoke|reconcile)/.test(call));
    expect(teardownOrder).toEqual(["cancel op-3", "propose-teardown op-3", "release partition/3p", "propose-teardown op-2", "release partition/2c", "release partition/2p", "propose-teardown op-1", "release partition/1p", "release partition/1c", "revoke conn-2"]);
    // Three parents ran; the cross-connection plan and the plan on the revoked connection were refused before one existed.
    expect(product.calls.filter(call => call.startsWith("propose "))).toEqual(["propose 1 independent", "propose 2 pair", "propose 3 pair"]);
    for (const lane of ["-live", "-live2"]) for (const role of ["observe", "deploy"] as const) expect(state.trust[lane]![role]).toBe(trustDocument(PRINCIPAL, OLD_EXT));
    expect(sent.filter(id => id === "mix03-sts-assume")).toHaveLength(1);
  });

  it("reconciles and replans when the producer ends indeterminate after the restart, and does not claim PROD-MIX-02", async () => {
    const state = world(), product = fakeProduct(state, { uncertainAfterRestart: true });
    const results = await harness(state, product, {}, env, { uncertainAfterRestart: true }).verifyAll();
    expect(results["PROD-MIX-02"]!.complete).toBe(false);
    expect(results["PROD-MIX-02"]!.reason).toContain("recorded the reconciliation (effects_present");
    expect(product.calls).toContain("reconcile op-2 partition/2p effects_present 64");
    expect(results["PROD-MIX-03"]!.complete, results["PROD-MIX-03"]!.reason).toBe(true);
    expect(results["PROD-MIX-03"]!.reason).toContain("replanned after the reconciliation");
    expect(results["PROD-MIX-04"]!.complete, results["PROD-MIX-04"]!.reason).toBe(true);
    expect(product.calls.filter(call => call.startsWith("propose-teardown"))).toEqual(["propose-teardown op-4", "propose-teardown op-3", "propose-teardown op-2", "propose-teardown op-1"]);
  });

  it("does not claim PROD-MIX-02 when the producer's apply finished between two polls, and still proves the rest", async () => {
    const state = world();
    const results = await harness(state, fakeProduct(state, { skipApply: true })).verifyAll();
    expect(results["PROD-MIX-02"]!.complete).toBe(false);
    expect(results["PROD-MIX-02"]!.reason).toContain("finished between two polls");
    expect(state.events).not.toContain("stop");
    for (const id of ["PROD-MIX-01", "PROD-MIX-03", "PROD-MIX-04"] as const) expect(results[id]!.complete, results[id]!.reason).toBe(true);
  });

  it("fails PROD-MIX-01 when a cross-connection dependency without connectivity is accepted", async () => {
    const state = world();
    const results = await harness(state, fakeProduct(state, { crossAccepted: true })).verifyAll();
    expect(results["PROD-MIX-01"]!.complete).toBe(false);
    expect(results["PROD-MIX-01"]!.reason).toContain("without declared connectivity was accepted");
    expect(results["PROD-MIX-03"]!.complete).toBe(true);
  });

  it("fails PROD-MIX-01 when the plan on the revoked connection is refused for another reason", async () => {
    const state = world();
    const results = await harness(state, fakeProduct(state, { revokedReason: "plan_refused" })).verifyAll();
    expect(results["PROD-MIX-01"]!.complete).toBe(false);
    expect(results["PROD-MIX-01"]!.reason).toContain("refused for another reason (plan_refused)");
  });

  it("fails PROD-MIX-04 when the cancelled run does not read partial", async () => {
    const state = world();
    const results = await harness(state, fakeProduct(state, { partialOutcome: "indeterminate" })).verifyAll();
    expect(results["PROD-MIX-04"]!.complete).toBe(false);
    expect(results["PROD-MIX-04"]!.reason).toContain("reads indeterminate");
  });

  it("fails PROD-MIX-04 when AWS still shows a tagged resource after the product teardown; the harness then removes it", async () => {
    const state = world(), options = { leftover: true };
    const results = await harness(state, fakeProduct(state, options), {}, env, options).verifyAll();
    expect(results["PROD-MIX-04"]!.complete).toBe(false);
    expect(results["PROD-MIX-04"]!.reason).toContain("remain after the product teardown");
    expect(state.deleted.has(`arn:aws:s3:::${bucketOf(1, "p")}`)).toBe(true);
    expect(results["PROD-MIX-04"]!.leaks).toEqual([]);
  });

  it("fails the teardown when the review is refused for another reason than settlement", async () => {
    const state = world();
    const results = await harness(state, fakeProduct(state, { settling: 0, settleReason: "This environment has deploy history from before Zenith tracked deploy writers" })).verifyAll();
    expect(results["PROD-MIX-04"]!.complete).toBe(false);
    expect(results["PROD-MIX-04"]!.reason).toContain("another reason than settlement");
  });

  it("answers no other requirement", async () => {
    const state = world(), { port, plan, call } = harness(state, fakeProduct(state));
    await expect(port.verify({ id: "PROD-OPS-01", acceptance: [], fixtures: [], join: "" }, { plan, commit: COMMIT, call })).resolves.toEqual({ complete: false, reason: "PROD-OPS-01: not implemented by this port" });
  });
});

describe("rehearsal evidence binds at operational_rehearsal only", () => {
  const journal = (scenario: "mix-rehearsal" | "mix-01"): Journal => {
    const plan = buildPlan(scenario === "mix-01" ? { ...settings, scenario, durationMinutes: 40 } : settings);
    return { schema: 1, provenance: "live_sandbox", plan, permissionSha256: "e".repeat(64), commit: COMMIT, startedAt: "2026-11-04T00:00:00.000Z", attempted: [], responses: {}, closed: true, counts: {},
      checks: scopedRequirementIds(plan.settings, []).map(id => ({ id, status: "passed" as const, scope: "product_requirement" as const, reason: `${id} operational rehearsal passed` })) };
  };

  it("records the level on the packet and the release source, and the release tooling binds it at that level only", async () => {
    const packet = evidencePacket(journal("mix-rehearsal"));
    const row = (packet.requirements as { id: string; requiredLevel: string; evidence: { level: string }[] }[]).find(r => r.id === "PROD-MIX-02")!;
    expect(row.requiredLevel).toBe("operational_rehearsal");
    expect(row.evidence[0]!.level).toBe("operational_rehearsal");
    const source = releaseSource(packet, "PROD-MIX-02", h("9"))!;
    expect(source).toMatchObject({ level: "operational_rehearsal", mode: "live", requirements: ["PROD-MIX-02"] });
    expect(source.command).toContain("operational rehearsal (live)");
    expect(sourceOutcome({ ...source })).toMatchObject({ level: "operational_rehearsal", mode: "live" });
    // A live_sandbox run carries no level and is never a rehearsal source.
    const sandbox = releaseSource(evidencePacket(journal("mix-01")), "PROD-MIX-01", h("9"))!;
    expect(sandbox).not.toHaveProperty("level");
    // A packet whose row claims another level than its scenario gives no source.
    expect(releaseSource({ ...packet, scenario: "mix-01" }, "PROD-MIX-02", h("9"))).toBeUndefined();

    const root = await mkdtemp(path.join(os.tmpdir(), "zenith-rehearsal-"));
    try {
      await mkdir(path.join(root, "e"));
      await writeFile(path.join(root, "e/rehearsal.json"), JSON.stringify(source));
      await writeFile(path.join(root, "e/sandbox.json"), JSON.stringify(sandbox));
      const cli = (src: string, level: string, out: string) => evidenceCli(["--source", src, "--requirement", src.includes("rehearsal") ? "PROD-MIX-02" : "PROD-MIX-01", "--level", level, "--mode", "live", "--out", path.join(root, out)], root);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true), stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        expect(cli("e/rehearsal.json", "live_sandbox", "x1.json")).toBe(1);
        expect(cli("e/sandbox.json", "operational_rehearsal", "x2.json")).toBe(1);
        expect(cli("e/rehearsal.json", "operational_rehearsal", "e/receipt.json")).toBe(0);
      } finally { stderr.mockRestore(); stdout.mockRestore(); }
      const { readFileSync } = await import("node:fs");
      const bytes = readFileSync(path.join(root, "e/receipt.json"));
      const { createHash } = await import("node:crypto");
      const sha = createHash("sha256").update(bytes).digest("hex");
      const inspected = inspectEvidence("PROD-MIX-02", { level: "operational_rehearsal", commit: COMMIT, artifact: "e/receipt.json", sha256: sha }, { root });
      expect(inspected.errors).toEqual([]);
      expect(inspected.valid).toBe(true);
      // The same receipt relabelled as live_sandbox evidence no longer matches its source's level.
      const relabelled = { ...JSON.parse(bytes.toString("utf8")), level: "live_sandbox" };
      await writeFile(path.join(root, "e/relabelled.json"), JSON.stringify(relabelled));
      const relabelledSha = createHash("sha256").update(readFileSync(path.join(root, "e/relabelled.json"))).digest("hex");
      expect(inspectEvidence("PROD-MIX-02", { level: "live_sandbox", commit: COMMIT, artifact: "e/relabelled.json", sha256: relabelledSha }, { root }).errors).toContain("original evidence level mismatch");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
