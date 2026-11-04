/** Demo E: crash a controlled sandbox worker during apply. Progress and events
 * are observations, never proof of exactly-once external effects. No live run yet. */
import type { Manifest } from "@/lib/domain/types";
import { requireClient, type PassCriterion, type ScenarioDefinition } from "../types";
import { checker, awsTargetConfig, liveControlPlaneConfig, controlPlaneReachable, dependsOnEarlier, configPrerequisite, cp, awaitApproval, awaitTerminal, adoptNow } from "./_shared";
import { runResourcesOfType } from "./_aws";
import { buildLiveManifest } from "./_manifest";

const CRITERIA: readonly PassCriterion[] = [
  { id: "crash-injected", text: "The worker was killed immediately after observing an apply step running." },
  { id: "durable", text: "Temporal still reports RUNNING with the worker down, and the operation is not failed." },
  { id: "terminal-safe", text: "After restart the operation ends succeeded or uncertain." },
  { id: "no-unsafe-replay", text: "One operation.started event, one ECS service per manifest service, and no new apply event after recovery when uncertain." },
];
const C = checker("E", CRITERIA);

export const demoE: ScenarioDefinition = {
  id: "E", title: "Restart recovery during apply", summary: "Crash the sandbox execution worker during a second deploy; observe durable recovery or an honest uncertain outcome.",
  needs: { cloud: "aws", controlPlane: true, temporal: true }, mutates: true, createsResources: true, dependsOn: ["A"],
  prerequisites: [awsTargetConfig, liveControlPlaneConfig, controlPlaneReachable, dependsOnEarlier("A"), configPrerequisite("worker-control", "A sandbox worker is under harness control", (c) => !!c.workerControl, "set ZENITH_LIVE_WORKER_CONTROL for a dedicated sandbox worker")],
  steps: [
    { id: "preflight", title: "Check Temporal and worker control; price the larger manifest", effect: "none",
      plan: () => ["check Temporal availability and the configured worker controller", "analyse the fixture with replicas=2; check the monthly estimate before updating intent"],
      async run(ctx) {
        requireClient(ctx.worker, "worker controller");
        const a = await requireClient(ctx.workflows, "Temporal client").available();
        if (!a.available) throw new Error(a.detail);
        const built = buildLiveManifest({ runId: ctx.runId, region: ctx.session!.region, dnsZone: ctx.config.dnsZone, replicas: 2 });
        ctx.session!.checkCost(built.estimateUsd, "Second deploy");
        ctx.state.set("e.manifest", built.manifest);
      } },
    { id: "deploy", title: "Update, plan, propose and wait for human approval", effect: "mutate",
      plan: () => ["project.updateManifest with replicas=2", "propose infrastructure.plan; verify digest and cost", "propose deployment.deploy; wait for a person if policy requires approval"],
      async run(ctx) {
        const projectId = ctx.state.get("a.projectId") as string;
        const scope = { workspaceId: ctx.config.workspaceId!, projectId, environmentId: ctx.state.get("a.environmentId") as string };
        const updated = await cp(ctx).runAction("project.updateManifest", { mode: "execute", scope: { projectId }, input: { projectId, manifest: ctx.state.get("e.manifest") } });
        if (updated.ok !== true) throw new Error("Manifest update did not succeed.");
        const plan = await cp(ctx).proposeCapability({ capability: "infrastructure.plan", scope, idempotencyKey: `${ctx.runId}-e-plan` });
        await awaitApproval(ctx, plan);
        const planned = await awaitTerminal(ctx, "E", plan.operation.id, ctx.config.deployTimeoutMs);
        const planDigest = planned.planDigest ?? planned.proposal?.planDigest;
        if (planned.status !== "succeeded" || !/^[a-f0-9]{64}$/.test(planDigest ?? "")) throw new Error("Second deploy has no successful digest-bound plan.");
        ctx.session!.checkCost(planned.proposal?.costDeltaUsd, "Second plan");
        const proposed = await cp(ctx).proposeCapability({ capability: "deployment.deploy", scope, input: { planDigest }, idempotencyKey: `${ctx.runId}-e-deploy` });
        ctx.state.set("e.operationId", proposed.operation.id);
        await awaitApproval(ctx, proposed);
      } },
    { id: "crash", title: "Observe a running apply, then kill the worker", effect: "mutate",
      plan: () => ["poll workflow progress until apply_* is running (query needs a worker)", "record the event sequence; SIGKILL the dedicated worker immediately", "describe the workflow through the Temporal service while the worker is down"],
      async run(ctx) {
        const wf = requireClient(ctx.workflows, "Temporal client");
        const worker = requireClient(ctx.worker, "worker controller");
        const id = ctx.state.get("e.operationId") as string;
        const deadline = ctx.now().getTime() + ctx.config.deployTimeoutMs;
        // Get the event boundary BEFORE the final query so kill follows it immediately.
        for (;;) {
          const before = (await cp(ctx).listOperationEvents(id)).events;
          const progress = await wf.getProgress(id);
          if (progress?.steps.some((s) => s.step.startsWith("apply_") && s.status === "running")) {
            ctx.state.set("e.workerDown", true); // finally must restart even if kill partially fails
            const killed = await worker.kill();
            C.expect(ctx, "crash-injected", killed.done, killed.detail);
            if (!killed.done) throw new Error("Worker kill was not confirmed.");
            ctx.state.set("e.eventBoundary", Math.max(0, ...before.map((e) => e.seq ?? 0)));
            break;
          }
          if (progress && ["succeeded", "failed", "uncertain", "cancelled"].includes(progress.status)) throw new Error("Deploy ended before a running apply could be observed; no crash injected.");
          if (ctx.signal.aborted || ctx.now().getTime() >= deadline) throw new Error("No running apply observed within the deadline.");
          await ctx.sleep(500);
        }
        const description = await wf.describe(id);
        const op = (await cp(ctx).getOperation(id)).operation;
        C.expect(ctx, "durable", description?.status === "RUNNING" && op.status !== "failed", `Temporal ${description?.status ?? "missing"}; operation ${op.status}.`);
      } },
    { id: "recover", title: "Restart, await a safe terminal state and check replay evidence", effect: "mutate",
      plan: () => ["start the worker; wait for succeeded or uncertain", "adopt newly created resources", "require one operation.started and one ECS service per manifest service; for uncertain require no apply event after the recovery boundary"],
      async run(ctx) {
        const id = ctx.state.get("e.operationId") as string;
        // Read a second boundary before restart; do not query the down worker.
        const boundaryEvents = (await cp(ctx).listOperationEvents(id)).events;
        const boundary = Math.max(0, ...boundaryEvents.map((e) => e.seq ?? 0));
        const started = await requireClient(ctx.worker, "worker controller").start();
        if (!started.done) throw new Error(started.detail);
        ctx.state.set("e.workerDown", false);
        const op = await awaitTerminal(ctx, "E", id, ctx.config.deployTimeoutMs, async () => { await adoptNow(ctx, "E"); });
        C.expect(ctx, "terminal-safe", op.status === "succeeded" || op.status === "uncertain", `terminal status ${op.status}.`);
        await adoptNow(ctx, "E");
        const events = (await cp(ctx).listOperationEvents(id)).events;
        const services = await runResourcesOfType(ctx, "ecs:service");
        const manifest = ctx.state.get("e.manifest") as Manifest;
        const expected = manifest.services.filter((s) => s.kind !== "static").length;
        const sequenced = events.length > 0 && events.every((e) => typeof e.seq === "number");
        const applyAfter = events.some((e) => (e.seq ?? 0) > boundary && /^resource\.appl(?:ying|ied)$/.test(e.type));
        const once = events.filter((e) => e.type === "operation.started").length === 1;
        C.expect(ctx, "no-unsafe-replay", sequenced && once && services.length === expected && (op.status !== "uncertain" || !applyAfter), `sequenced events ${sequenced}; starts ${events.filter((e) => e.type === "operation.started").length}; ECS services ${services.length}/${expected}; apply after recovery ${applyAfter}.`);
      } },
  ],
  async cleanup(ctx) {
    if (ctx.state.get("e.workerDown") === true) {
      const r = await requireClient(ctx.worker, "worker controller").start();
      if (!r.done) throw new Error(`Worker remains down: ${r.detail}`);
      ctx.state.set("e.workerDown", false);
    }
  },
  passCriteria: CRITERIA, proves: ["Durability and bounded replay evidence for one sandbox crash during an observed apply."],
  cannotProve: ["Exactly-once cloud effects: workflow progress is a query and the apply can finish between the query and kill.", "Every crash point or lease race; missing or truncated operation events cannot establish safe replay."],
  blockedOn: ["Needs Demo A and real WS-ACT activities with leases and fencing.", "Needs Temporal and a dedicated restartable worker (ZENITH_LIVE_WORKER_CONTROL); process mode needs supervisor/operator restart."],
  runsLocally: false, costNote: "Demo A resources plus a second small task; the larger monthly estimate is checked again.",
};
