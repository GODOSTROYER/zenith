/**
 * Scenarios that produce the committed workflow-history fixtures
 * (tests/fixtures/workflow-histories/*.json) for PROD-OPS-03.
 *
 * Each scenario runs a REAL registered workflow on a real local Temporal server
 * with scripted (fake) activities, and returns the handles whose histories are
 * exported. Activities are scripted, so these are workflow-determinism fixtures,
 * not evidence about any cloud provider.
 *
 * Coverage rule (tests/workflows/history-replay.test.ts): every type in
 * REGISTERED_WORKFLOW_TYPES needs at least one scenario here AND one committed
 * fixture. A new workflow type, or a new patched branch, needs a new scenario.
 * Recording never overwrites an existing fixture (see history-record.test.ts):
 * the committed files are the frozen "released" histories.
 */
import type { WorkflowHandle } from "@temporalio/client";
import { ApplicationFailure } from "@temporalio/common";
import { Context } from "@temporalio/activity";
import { FAILURE_TYPES, RECONCILE_WORKFLOW_ID, WORKFLOW_ID, WORKFLOW_TYPES, type PlanSummary } from "@/lib/workflows/types";
import { cancelOperation, signalApproval, startDeploy } from "@/lib/workflows/client";
import type { CodingAgentActivities, CodingAgentStepResult } from "@/lib/workflows/definitions/codingAgent";
import type { CriticalMaintenanceActivities } from "@/lib/workflows/definitions/criticalMaintenance";
import type { DestroyActivities } from "@/lib/workflows/definitions/destroy";
import type { MixedActivities } from "@/lib/workflows/definitions/mixedParent";
import type { ReconcileSweepActivities } from "@/lib/workflows/definitions/reconcileSweep";
import { deployInput, uniqueId, waitForStatus, type Harness } from "./support";

export interface HistoryScenario {
  /** fixture file stem; stable forever once a fixture is committed */
  id: string;
  /** the registered workflow type the recorded histories belong to */
  workflowType: string;
  /** what the history exercises, for the manifest */
  covers: string;
  /** Verified before any candidate fixture is written. */
  outcome: { result: Record<string, unknown>; errorIncludes?: string } | { failureType: string };
  /** Counts from actual scheduled activity events, including forbidden writes. */
  activityCounts?: Record<string, number>;
  /** Actual completed results for activities whose failure the workflow may suppress. */
  completedActivityResults?: Record<string, Record<string, unknown>>;
  /** Retry attempts are recorded by the fake wrapper, not separate scheduled events. */
  fakeActivityCounts?: Record<string, number>;
  run(h: Harness): Promise<WorkflowHandle[]>;
}

const needsApproval = (h: Harness): void => h.fake.setResult("evaluatePolicy", { outcome: "require_approval", decisionId: "d-1", reasons: ["prod"] });
const install = (h: Harness, impl: object): void => void Object.assign(h.fake.activities as unknown as Record<string, unknown>, impl);
const repairPlan: PlanSummary = { planDigest: "a".repeat(64), create: 0, update: 1, delete: 0, replace: 0, destroysData: false, empty: false };

async function startAndWait(h: Harness, type: string, workflowId: string, arg: unknown): Promise<WorkflowHandle> {
  const handle = await h.client.workflow.start(type, { workflowId, taskQueue: h.taskQueue, args: [arg] });
  await handle.result().catch(() => undefined);
  return handle;
}

export const WORKFLOW_HISTORY_SCENARIOS: readonly HistoryScenario[] = [
  {
    id: "deploy-happy-build",
    workflowType: WORKFLOW_TYPES.deploy,
    covers: "build step on the durable-build-launch-v1 patched branch, full happy path",
    outcome: { result: { status: "succeeded" } },
    activityCounts: { buildArtifacts: 1, applyInfrastructure: 1, verifyApplication: 1 },
    run: (h) => h.run(async () => {
      const input = deployInput();
      return [await startAndWait(h, WORKFLOW_TYPES.deploy, WORKFLOW_ID(input.operationId), input)];
    }),
  },
  {
    id: "deploy-pinned-images-no-build",
    workflowType: WORKFLOW_TYPES.deploy,
    covers: "manifest-pinned images (the Kubernetes/registry route): build skipped, deploy+migrate+verify",
    outcome: { result: { status: "succeeded" } },
    activityCounts: { buildArtifacts: 0, applyInfrastructure: 1, verifyApplication: 1 },
    run: (h) => h.run(async () => {
      const input = deployInput({ build: false });
      return [await startAndWait(h, WORKFLOW_TYPES.deploy, WORKFLOW_ID(input.operationId), input)];
    }),
  },
  {
    id: "deploy-started-by-client",
    workflowType: WORKFLOW_TYPES.deploy,
    covers: "start through startDeploy (the path the durable workflow-start intents use) with REJECT_DUPLICATE id reuse",
    outcome: { result: { status: "succeeded" } },
    run: (h) => h.run(async () => {
      const input = deployInput();
      const started = await startDeploy(input, { client: h.client, taskQueue: h.taskQueue });
      await started.handle.result();
      return [started.handle];
    }),
  },
  {
    id: "deploy-approval-signal",
    workflowType: WORKFLOW_TYPES.deploy,
    covers: "approval wait, approvalRecorded signal, second lease",
    outcome: { result: { status: "succeeded" } },
    activityCounts: { applyInfrastructure: 1 },
    run: (h) => h.run(async () => {
      needsApproval(h);
      const input = deployInput();
      const handle = await h.client.workflow.start(WORKFLOW_TYPES.deploy, { workflowId: WORKFLOW_ID(input.operationId), taskQueue: h.taskQueue, args: [input] });
      await waitForStatus(handle, "awaiting_approval");
      h.fake.approve();
      await signalApproval(input.operationId, { client: h.client });
      await handle.result();
      return [handle];
    }),
  },
  {
    id: "deploy-lease-lost",
    workflowType: WORKFLOW_TYPES.deploy,
    covers: "non-retryable LeaseLost during apply finalizing uncertain",
    outcome: { result: { status: "uncertain" }, errorIncludes: "lease was lost" },
    activityCounts: { applyInfrastructure: 1, verifyInfrastructure: 0 },
    run: (h) => h.run(async () => {
      h.fake.failOn("applyInfrastructure", { type: FAILURE_TYPES.leaseLost, message: "fence moved" });
      const input = deployInput();
      return [await startAndWait(h, WORKFLOW_TYPES.deploy, WORKFLOW_ID(input.operationId), input)];
    }),
  },
  {
    id: "deploy-cancelled",
    workflowType: WORKFLOW_TYPES.deploy,
    covers: "cancellation delivered while deployWorkloads is running",
    outcome: { result: { status: "cancelled" }, errorIncludes: "Cancelled by request" },
    activityCounts: { deployWorkloads: 1, runMigrations: 0, verifyApplication: 0 },
    run: (h) => h.run(async () => {
      const held = h.fake.hold("deployWorkloads");
      const input = deployInput();
      const handle = await h.client.workflow.start(WORKFLOW_TYPES.deploy, { workflowId: WORKFLOW_ID(input.operationId), taskQueue: h.taskQueue, args: [input] });
      await held.started;
      await cancelOperation(input.operationId, { client: h.client });
      await handle.result().catch(() => undefined);
      return [handle];
    }),
  },
  {
    id: "deploy-retried-read",
    workflowType: WORKFLOW_TYPES.deploy,
    covers: "activity attempts that fail and retry (evaluatePolicy x2) do not disturb replay",
    outcome: { result: { status: "succeeded" } },
    fakeActivityCounts: { evaluatePolicy: 3 },
    run: (h) => h.run(async () => {
      h.fake.failOn("evaluatePolicy", { message: "temporarily unavailable", times: 2 });
      const input = deployInput();
      return [await startAndWait(h, WORKFLOW_TYPES.deploy, WORKFLOW_ID(input.operationId), input)];
    }),
  },
  {
    id: "destroy-happy",
    workflowType: WORKFLOW_TYPES.destroy,
    covers: "destroy plan, approval, final plan, apply, verify",
    outcome: { result: { status: "succeeded" } },
    activityCounts: { planDestroyInfrastructure: 1, finalDestroyPlan: 1, applyDestroyInfrastructure: 1, verifyDestroyedInfrastructure: 1 },
    run: (h) => {
      h.fake.approve();
      const plan = { planDigest: "a".repeat(64), create: 0, update: 0, delete: 1, replace: 0, empty: false, destroysData: true };
      const extra: DestroyActivities = {
        planDestroyInfrastructure: async () => plan,
        finalDestroyPlan: async () => plan,
        applyDestroyInfrastructure: async () => ({ deleted: 1 }),
        verifyDestroyedInfrastructure: async () => ({ status: "passed", checks: 1, failed: 0 }),
      };
      install(h, extra);
      return h.run(async () => {
        const input = { operationId: uniqueId("destroy"), workspaceId: "ws-1", environmentId: "env-1" };
        return [await startAndWait(h, WORKFLOW_TYPES.destroy, WORKFLOW_ID(input.operationId), input)];
      });
    },
  },
  {
    id: "destroy-plan-changed",
    workflowType: WORKFLOW_TYPES.destroy,
    covers: "final plan moved after approval: nothing applied",
    outcome: { result: { status: "failed" }, errorIncludes: "infrastructure plan changed after it was reviewed" },
    activityCounts: { planDestroyInfrastructure: 1, finalDestroyPlan: 1, applyDestroyInfrastructure: 0, verifyDestroyedInfrastructure: 0 },
    run: (h) => {
      h.fake.approve();
      const plan = { planDigest: "a".repeat(64), create: 0, update: 0, delete: 1, replace: 0, empty: false, destroysData: true };
      const extra: DestroyActivities = {
        planDestroyInfrastructure: async () => plan,
        finalDestroyPlan: async () => { throw ApplicationFailure.nonRetryable("plan moved", FAILURE_TYPES.planChanged); },
        applyDestroyInfrastructure: async () => ({ deleted: 1 }),
        verifyDestroyedInfrastructure: async () => ({ status: "passed", checks: 1, failed: 0 }),
      };
      install(h, extra);
      return h.run(async () => {
        const input = { operationId: uniqueId("destroy"), workspaceId: "ws-1", environmentId: "env-1" };
        return [await startAndWait(h, WORKFLOW_TYPES.destroy, WORKFLOW_ID(input.operationId), input)];
      });
    },
  },
  {
    id: "day-two-restart",
    workflowType: WORKFLOW_TYPES.dayTwo,
    covers: "workload.restart day-two capability (unpatched branch)",
    outcome: { result: { status: "succeeded" } },
    activityCounts: { executeCapability: 1 },
    run: (h) => h.run(async () => {
      const input = { operationId: uniqueId("d2"), workspaceId: "ws-1", environmentId: "env-1", capability: "workload.restart" };
      return [await startAndWait(h, WORKFLOW_TYPES.dayTwo, WORKFLOW_ID(input.operationId), input)];
    }),
  },
  {
    id: "day-two-drift-repair-ecs",
    workflowType: WORKFLOW_TYPES.dayTwo,
    covers: "drift.repair on the ecs-replica-repair-v1 patched branch with approval signal",
    outcome: { result: { status: "succeeded" } },
    activityCounts: { applyInfrastructure: 1 },
    run: (h) => h.run(async () => {
      h.fake.setResult("planInfrastructure", repairPlan);
      h.fake.setResult("finalPlan", repairPlan);
      needsApproval(h);
      const input = { operationId: uniqueId("ecs-repair"), workspaceId: "ws-1", environmentId: "env-1", capability: "drift.repair" };
      const handle = await h.client.workflow.start(WORKFLOW_TYPES.dayTwo, { workflowId: WORKFLOW_ID(input.operationId), taskQueue: h.taskQueue, args: [input] });
      await waitForStatus(handle, "awaiting_approval");
      h.fake.approve();
      await signalApproval(input.operationId, { client: h.client });
      await handle.result();
      return [handle];
    }),
  },
  {
    id: "remediation",
    workflowType: WORKFLOW_TYPES.remediation,
    covers: "incident remediation workflow",
    outcome: { result: { status: "succeeded" } },
    activityCounts: { executeCapability: 1 },
    run: (h) => h.run(async () => {
      const input = { operationId: uniqueId("rm"), workspaceId: "ws-1", environmentId: "env-1", incidentId: "inc-1" };
      return [await startAndWait(h, WORKFLOW_TYPES.remediation, WORKFLOW_ID(input.operationId), input)];
    }),
  },
  {
    id: "reconcile-observe-only",
    workflowType: WORKFLOW_TYPES.reconcile,
    covers: "reconcile-canonical-proposals-v1 patched branch, allowAutoRepair=false",
    outcome: { result: { status: "observed", repair: "not_requested", drift: 1, unknown: 0 } },
    activityCounts: { reconcileObserve: 1 },
    run: (h) => h.run(async () => {
      const input = { workspaceId: "ws-1", environmentId: uniqueId("env"), allowAutoRepair: false };
      return [await startAndWait(h, WORKFLOW_TYPES.reconcile, RECONCILE_WORKFLOW_ID(input.environmentId), input)];
    }),
  },
  {
    id: "reconcile-auto-repair",
    workflowType: WORKFLOW_TYPES.reconcile,
    covers: "reconcile-canonical-proposals-v1 patched branch, allowAutoRepair=true",
    outcome: { result: { status: "observed", repair: "considered", drift: 1, unknown: 0 } },
    activityCounts: { reconcileObserve: 1 },
    run: (h) => h.run(async () => {
      const input = { workspaceId: "ws-1", environmentId: uniqueId("env"), allowAutoRepair: true };
      return [await startAndWait(h, WORKFLOW_TYPES.reconcile, RECONCILE_WORKFLOW_ID(input.environmentId), input)];
    }),
  },
  {
    id: "teardown-review",
    workflowType: WORKFLOW_TYPES.destroyReview,
    covers: "read-only teardown review wrapper (wave-3 destroy review dispatch)",
    outcome: { result: { planDigest: "a".repeat(64), replayed: false } },
    activityCounts: { reviewTeardown: 1 },
    run: (h) => {
      install(h, { reviewTeardown: async (i: { operationId: string }) => ({ operationId: i.operationId, planDigest: "a".repeat(64), replayed: false }) });
      return h.run(async () => {
        const input = { workspaceId: "ws-1", operationId: uniqueId("review") };
        return [await startAndWait(h, WORKFLOW_TYPES.destroyReview, `review-${input.operationId}`, input)];
      });
    },
  },
  {
    id: "reconcile-sweep",
    workflowType: WORKFLOW_TYPES.reconcileSweep,
    covers: "durable reconcile sweep (schedule-started workflow), completed pass",
    outcome: { result: { status: "completed", counts: { claimed: 1, reconciled: 1, failed: 0 } } },
    activityCounts: { sweepReconcilePass: 1 },
    run: (h) => {
      const counts = { claimed: 1, reconciled: 1, nothingToReconcile: 0, busy: 0, ineligible: 0, failed: 0, deferred: 0, nudged: 0, driftDetected: 0, driftCleared: 0, openFindings: 0, unreadNodes: 0, repairsProposed: 0, repairsStarted: 0, repairsAwaitingApproval: 0, repairsDenied: 0, saturated: false, timedOut: false, ms: 1 };
      const impl: ReconcileSweepActivities = { sweepReconcilePass: async () => ({ status: "completed", counts }) };
      install(h, impl);
      return h.run(async () => {
        const input = { contract: "zenith.reconcile-sweep.v1" as const, maxEnvironments: 5, environmentConcurrency: 1 };
        return [await startAndWait(h, WORKFLOW_TYPES.reconcileSweep, uniqueId("sweep"), input)];
      });
    },
  },
  {
    id: "critical-maintenance",
    workflowType: WORKFLOW_TYPES.criticalMaintenance,
    covers: "durable critical maintenance pass (reaping, housekeeping, runbooks)",
    outcome: { result: { engine: "ok", alerts: "ok", outbox: "ok", housekeeping: "ok", "runner-reaper": "ok", runbooks: "ok" } },
    activityCounts: { runCriticalMaintenance: 1 },
    run: (h) => {
      const impl: CriticalMaintenanceActivities = { runCriticalMaintenance: async () => ({ engine: "ok", alerts: "ok", outbox: "ok", housekeeping: "ok", "runner-reaper": "ok", runbooks: "ok" }) };
      install(h, impl);
      return h.run(async () => {
        return [await startAndWait(h, WORKFLOW_TYPES.criticalMaintenance, uniqueId("maint"), { contract: "zenith.critical-maintenance.v1" })];
      });
    },
  },
  {
    id: "coding-agent-run-steps",
    workflowType: WORKFLOW_TYPES.codingAgentRun,
    covers: "wave-3 coding agent run: several durable steps then completion",
    outcome: { result: { status: "completed" } },
    activityCounts: { agentStep: 3, agentFinalize: 0 },
    run: (h) => {
      let n = 0;
      const impl: CodingAgentActivities = {
        async agentStep() { Context.current().heartbeat({ n }); n += 1; return { status: n < 3 ? "running" : "completed" } as CodingAgentStepResult; },
        async agentFinalize() { return { status: "failed" } as CodingAgentStepResult; },
      };
      install(h, impl);
      return h.run(async () => {
        const runId = uniqueId("car");
        return [await startAndWait(h, WORKFLOW_TYPES.codingAgentRun, `car-${runId}`, { contract: "zenith.coding-agent-run.v1", runId, workspaceId: "ws_test" })];
      });
    },
  },
  {
    id: "mixed-parent-all-children-succeed",
    workflowType: WORKFLOW_TYPES.mixedParent,
    covers: "wave-4 mixed parent: children advance and are observed one at a time in dependency order, then the parent settles succeeded",
    outcome: { result: { status: "succeeded" } },
    activityCounts: { verifyMixedParent: 1, advanceMixedChild: 2, awaitMixedChild: 2, settleMixedParent: 1 },
    completedActivityResults: { settleMixedParent: { status: "succeeded" } },
    run: (h) => {
      const impl: MixedActivities = {
        async verifyMixedParent() { return { order: [{ partitionId: "partition/a", ordinal: 0 }, { partitionId: "partition/b", ordinal: 1 }], childSetDigest: "d".repeat(64) }; },
        async advanceMixedChild() { return { state: "started" }; },
        async awaitMixedChild() { Context.current().heartbeat({ phase: "observing" }); return { state: "succeeded" }; },
        async settleMixedParent(i) { return { status: i.outcome }; },
      };
      install(h, impl);
      return h.run(async () => {
        const operationId = uniqueId("opm");
        return [await startAndWait(h, WORKFLOW_TYPES.mixedParent, WORKFLOW_ID(operationId), { workspaceId: "ws-1", operationId, environmentId: "env-parent", parentPlanId: "mpp_test" })];
      });
    },
  },
  {
    id: "mixed-parent-child-fails",
    workflowType: WORKFLOW_TYPES.mixedParent,
    covers: "wave-4 mixed parent: the first child ends failed, later children are never started, nothing is compensated and the parent settles failed",
    outcome: { result: { status: "failed" }, errorIncludes: "Child 1 ended failed" },
    activityCounts: { verifyMixedParent: 1, advanceMixedChild: 1, awaitMixedChild: 1, settleMixedParent: 1 },
    completedActivityResults: { settleMixedParent: { status: "failed" } },
    run: (h) => {
      const impl: MixedActivities = {
        async verifyMixedParent() { return { order: [{ partitionId: "partition/a", ordinal: 0 }, { partitionId: "partition/b", ordinal: 1 }], childSetDigest: "d".repeat(64) }; },
        async advanceMixedChild() { return { state: "started" }; },
        async awaitMixedChild() { Context.current().heartbeat({ phase: "observing" }); return { state: "failed" }; },
        async settleMixedParent(i) { return { status: i.outcome }; },
      };
      install(h, impl);
      return h.run(async () => {
        const operationId = uniqueId("opm");
        return [await startAndWait(h, WORKFLOW_TYPES.mixedParent, WORKFLOW_ID(operationId), { workspaceId: "ws-1", operationId, environmentId: "env-parent", parentPlanId: "mpp_test" })];
      });
    },
  },
  {
    id: "coding-agent-run-step-failure",
    workflowType: WORKFLOW_TYPES.codingAgentRun,
    covers: "wave-3 coding agent run: a step fails non-retryably and the finalizer runs",
    outcome: { failureType: "CodingAgentContractInvalid" },
    activityCounts: { agentStep: 1, agentFinalize: 1 },
    run: (h) => {
      const impl: CodingAgentActivities = {
        async agentStep() { throw ApplicationFailure.nonRetryable("step failed", "CodingAgentContractInvalid"); },
        async agentFinalize() { return { status: "failed" } as CodingAgentStepResult; },
      };
      install(h, impl);
      return h.run(async () => {
        const runId = uniqueId("car");
        return [await startAndWait(h, WORKFLOW_TYPES.codingAgentRun, `car-${runId}`, { contract: "zenith.coding-agent-run.v1", runId, workspaceId: "ws_test" })];
      });
    },
  },
];
