/**
 * dayTwoOperationWorkflow, remediationWorkflow and reconcileEnvironmentWorkflow
 * against a real Temporal dev server with the fake activities (see
 * deploy.test.ts for what that does and does not prove).
 */

import { describe, expect } from "vitest";
import { WorkflowFailedError } from "@temporalio/client";
import { CancelledFailure } from "@temporalio/common";
import { FAILURE_TYPES, RECONCILE_WORKFLOW_ID, WORKFLOW_ID, WORKFLOW_TYPES, type DayTwoWorkflowInput, type ReconcileWorkflowInput, type ReconcileWorkflowResult, type RemediationWorkflowInput, type WorkflowResult } from "@/lib/workflows/types";
import { cancelOperation, signalApproval } from "@/lib/workflows/client";
import { findCredentialKeys, uniqueId, serverSuite, waitForStatus, type Harness } from "./support";

const { scenario } = serverSuite("local", { concurrent: true });

const dayTwoInput = (overrides: Partial<DayTwoWorkflowInput> = {}): DayTwoWorkflowInput => ({
  operationId: uniqueId("op2"),
  workspaceId: "ws-1",
  environmentId: "env-1",
  capability: "workload.restart",
  ...overrides,
});

const remediationInput = (overrides: Partial<RemediationWorkflowInput> = {}): RemediationWorkflowInput => ({
  operationId: uniqueId("opr"),
  workspaceId: "ws-1",
  environmentId: "env-1",
  incidentId: "inc-1",
  ...overrides,
});

function startOperation(h: Harness, type: string, input: { operationId: string }) {
  return h.client.workflow.start(type, { workflowId: WORKFLOW_ID(input.operationId), taskQueue: h.taskQueue, args: [input] });
}

async function runOperation(h: Harness, type: string, input: { operationId: string }): Promise<WorkflowResult> {
  return (await (await startOperation(h, type, input)).result()) as WorkflowResult;
}

const stepStatuses = (result: WorkflowResult) => Object.fromEntries(result.steps.map((s) => [s.step, s.status]));

/* --------------------------- day-two and remediation -------------------------- */

const KINDS = [
  { label: "day-two", type: WORKFLOW_TYPES.dayTwo, input: dayTwoInput, noun: "day-two operation" },
  { label: "remediation", type: WORKFLOW_TYPES.remediation, input: remediationInput, noun: "remediation" },
] as const;

for (const kind of KINDS) {
  describe(`${kind.label} workflow`, () => {
    scenario("runs lease -> policy -> execute -> verify -> finalize -> release and marks succeeded", async (h) => {
      const result = await h.run(() => runOperation(h, kind.type, kind.input()));
      expect(result.status).toBe("succeeded");
      expect(h.fake.names().filter((n) => n !== "recordStep")).toEqual([
        "markOperation",
        "acquireLease",
        "renewLease",
        "evaluatePolicy",
        "renewLease",
        "executeCapability",
        "renewLease",
        "verifyApplication",
        "markOperation",
        "releaseLease",
      ]);
      expect(stepStatuses(result)).toEqual({
        lease: "done",
        policy: "done",
        approval: "skipped",
        execute_capability: "done",
        verify_application: "done",
        finalize: "done",
        release: "done",
      });
      expect(h.fake.statuses.map((s) => s.status)).toEqual(["running", "succeeded"]);
      // The capability ran under the lease taken for it.
      const fence = h.fake.lease.acquired[0]!.fenceToken;
      expect((h.fake.callsTo("executeCapability")[0]!.input as { lease: { fenceToken: number } }).lease.fenceToken).toBe(fence);
      expect(h.fake.lease.acquired[0]!.scope).toBe("env:env-1");
      expect(h.fake.lease.released).toHaveLength(1);
      // The verification result is on the step, evidence included.
      expect(result.steps.find((s) => s.step === "verify_application")?.detail).toMatch(/2 check\(s\) passed/);
      for (const call of h.fake.calls) expect(findCredentialKeys([call.input, call.result]), call.activity).toEqual([]);
    });

    scenario("re-checks policy and a deny stops it before anything runs", async (h) => {
      h.fake.setResult("evaluatePolicy", { outcome: "deny", decisionId: "d-1", reasons: ["change freeze"] });
      const result = await h.run(() => runOperation(h, kind.type, kind.input()));
      expect(result.status).toBe("failed");
      expect(result.error).toContain(`Policy denied this ${kind.noun}: change freeze`);
      expect(h.fake.callsTo("executeCapability")).toHaveLength(0);
      expect(h.fake.lease.released).toHaveLength(1);
    });

    scenario("waits for approval without a lease, then runs under a fresh one", async (h) => {
      h.fake.setResult("evaluatePolicy", { outcome: "require_approval", decisionId: "d-2", reasons: ["prod"] });
      const input = kind.input();
      const result = await h.run(async () => {
        const handle = await startOperation(h, kind.type, input);
        await waitForStatus(handle, "awaiting_approval");
        expect(h.fake.callsTo("executeCapability")).toHaveLength(0);
        expect(h.fake.lease.held).toBeUndefined();
        h.fake.approve();
        await signalApproval(input.operationId, { client: h.client });
        return (await handle.result()) as WorkflowResult;
      });
      expect(result.status).toBe("succeeded");
      expect(h.fake.lease.acquired.map((l) => l.fenceToken)).toEqual([1, 2]);
      expect((h.fake.callsTo("executeCapability")[0]!.input as { lease: { fenceToken: number } }).lease.fenceToken).toBe(2);
    });

    scenario("a rejected approval fails it and executes nothing", async (h) => {
      h.fake.setResult("evaluatePolicy", { outcome: "require_approval", decisionId: "d-2", reasons: [] });
      h.fake.reject();
      const result = await h.run(() => runOperation(h, kind.type, kind.input()));
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/approval was rejected/);
      expect(h.fake.callsTo("executeCapability")).toHaveLength(0);
    });

    scenario("a capability that reports failure is failed, and is never retried", async (h) => {
      h.fake.setResult("executeCapability", { ok: false, summary: "task did not stabilise" });
      const result = await h.run(() => runOperation(h, kind.type, kind.input()));
      expect(result.status).toBe("failed");
      expect(result.error).toContain(`The ${kind.noun} did not succeed: task did not stabilise`);
      expect(h.fake.callsTo("executeCapability")).toHaveLength(1);
      expect(h.fake.callsTo("verifyApplication")).toHaveLength(0);
    });

    scenario("an unclassified execution error is one attempt and ends uncertain", async (h) => {
      h.fake.failOn("executeCapability", { message: "connection reset" });
      const result = await h.run(() => runOperation(h, kind.type, kind.input()));
      expect(result.status).toBe("uncertain");
      expect(h.fake.callsTo("executeCapability")).toHaveLength(1);
      expect(h.fake.callsTo("releaseLease")).toHaveLength(1);
    });

    scenario("a lost lease during execution is uncertain", async (h) => {
      h.fake.failOn("executeCapability", { type: FAILURE_TYPES.leaseLost, message: "fence moved" });
      const result = await h.run(() => runOperation(h, kind.type, kind.input()));
      expect(result.status).toBe("uncertain");
      expect(h.fake.callsTo("releaseLease")).toHaveLength(1);
    });

    scenario("failed verification -> failed, recorded, not retried, not rolled back", async (h) => {
      h.fake.setResult("verifyApplication", { status: "failed", checks: 3, failed: 1, evidenceId: "ev-7" });
      const result = await h.run(() => runOperation(h, kind.type, kind.input()));
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/verification failed \(1 of 3 checks\)\. It is not retried automatically and nothing was rolled back/);
      expect(h.fake.callsTo("executeCapability")).toHaveLength(1);
      expect(h.fake.callsTo("verifyApplication")).toHaveLength(1);
      expect(stepStatuses(result).verify_application).toBe("failed");
      expect(h.fake.names().filter((n) => /destroy|delete|rollback|remove/i.test(n))).toEqual([]);
    });

    scenario("inconclusive verification -> uncertain", async (h) => {
      h.fake.setResult("verifyApplication", { status: "unknown", checks: 0, failed: 0 });
      const result = await h.run(() => runOperation(h, kind.type, kind.input()));
      expect(result.status).toBe("uncertain");
      expect(result.error).toMatch(/inconclusive/);
    });

    scenario("cancelling during execution cancels the activity, marks cancelled and releases the lease", async (h) => {
      const held = h.fake.hold("executeCapability");
      const input = kind.input();
      const result = await h.run(async () => {
        const handle = await startOperation(h, kind.type, input);
        await held.started;
        await cancelOperation(input.operationId, { client: h.client });
        return (await handle.result()) as WorkflowResult;
      });
      expect(result.status).toBe("cancelled");
      expect(h.fake.statuses.at(-1)).toMatchObject({ status: "cancelled" });
      expect(h.fake.callsTo("releaseLease")).toHaveLength(1);
      expect(h.fake.callsTo("verifyApplication")).toHaveLength(0);
    });
  });
}

describe("remediation workflow: never re-runs", () => {
  scenario("a failed remediation is not retried by the workflow, whatever the failure", async (h) => {
    h.fake.setResult("executeCapability", { ok: false, summary: "rollout stuck" });
    h.fake.setResult("verifyApplication", { status: "failed", checks: 1, failed: 1 });
    const result = await h.run(() => runOperation(h, WORKFLOW_TYPES.remediation, remediationInput()));
    expect(result.status).toBe("failed");
    expect(h.fake.callsTo("executeCapability")).toHaveLength(1);
    expect(h.fake.callsTo("acquireLease")).toHaveLength(1);
  });
});

/* -------------------------------- reconcile ---------------------------------- */

const reconcileInput = (overrides: Partial<ReconcileWorkflowInput> = {}): ReconcileWorkflowInput => ({
  workspaceId: "ws-1",
  environmentId: uniqueId("env"),
  allowAutoRepair: false,
  ...overrides,
});

async function runReconcile(h: Harness, input: ReconcileWorkflowInput): Promise<ReconcileWorkflowResult> {
  const handle = await h.client.workflow.start(WORKFLOW_TYPES.reconcile, { workflowId: RECONCILE_WORKFLOW_ID(input.environmentId), taskQueue: h.taskQueue, args: [input] });
  return (await handle.result()) as ReconcileWorkflowResult;
}

describe("reconcile workflow", () => {
  scenario("takes the reconcile lease, observes, reports the counts and releases", async (h) => {
    const input = reconcileInput();
    const result = await h.run(() => runReconcile(h, input));
    expect(result).toEqual({ environmentId: input.environmentId, status: "observed", drift: 1, unknown: 0, repair: "not_requested" });
    expect(h.fake.names()).toEqual(["acquireLease", "reconcileObserve", "releaseLease"]);
    expect(h.fake.lease.acquired[0]).toMatchObject({ scope: `reconcile:${input.environmentId}`, holder: RECONCILE_WORKFLOW_ID(input.environmentId) });
    expect(h.fake.callsTo("reconcileObserve")[0]!.input).toMatchObject({ workspaceId: "ws-1", environmentId: input.environmentId, passId: RECONCILE_WORKFLOW_ID(input.environmentId) });
    expect(h.fake.lease.released).toHaveLength(1);
    // A pass is not an operation: nothing is written to an operation record.
    expect(h.fake.callsTo("markOperation")).toHaveLength(0);
    expect(findCredentialKeys(h.fake.calls.map((c) => [c.input, c.result]))).toEqual([]);
  });

  scenario("allowAutoRepair does not repair: drift is reported and the repair is marked not implemented", async (h) => {
    const input = reconcileInput({ allowAutoRepair: true });
    const result = await h.run(() => runReconcile(h, input));
    expect(result).toMatchObject({ status: "observed", drift: 1, repair: "not_implemented" });
    // Observe-only: none of the mutating activities were even reachable.
    expect(h.fake.names()).toEqual(["acquireLease", "reconcileObserve", "releaseLease"]);
  });

  scenario("no drift with auto-repair allowed reports nothing to repair", async (h) => {
    h.fake.setResult("reconcileObserve", { drift: 0, unknown: 2 });
    const result = await h.run(() => runReconcile(h, reconcileInput({ allowAutoRepair: true })));
    expect(result).toMatchObject({ status: "observed", drift: 0, unknown: 2, repair: "not_requested" });
  });

  scenario("another pass holding the lease means this one is skipped, without observing", async (h) => {
    h.fake.failOn("acquireLease", { type: FAILURE_TYPES.leaseBusy, message: "held by another pass" });
    const result = await h.run(() => runReconcile(h, reconcileInput()));
    expect(result.status).toBe("skipped");
    expect(h.fake.callsTo("reconcileObserve")).toHaveLength(0);
    expect(h.fake.callsTo("releaseLease")).toHaveLength(0);
  });

  scenario("an observation failure is reported as a failed pass, and the lease is still released", async (h) => {
    h.fake.failOn("reconcileObserve", { type: FAILURE_TYPES.stepFailed, message: "describe-instances denied" });
    const result = await h.run(() => runReconcile(h, reconcileInput()));
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/Reconcile pass failed: describe-instances denied/);
    expect(h.fake.lease.released).toHaveLength(1);
  });

  scenario("cancelling the workflow releases the lease and cancels the observation", async (h) => {
    const held = h.fake.hold("reconcileObserve");
    const input = reconcileInput();
    await h.run(async () => {
      const handle = await h.client.workflow.start(WORKFLOW_TYPES.reconcile, { workflowId: RECONCILE_WORKFLOW_ID(input.environmentId), taskQueue: h.taskQueue, args: [input] });
      await held.started;
      await handle.cancel();
      const failure = await handle.result().catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(WorkflowFailedError);
      expect((failure as WorkflowFailedError).cause).toBeInstanceOf(CancelledFailure);
    });
    expect(h.fake.callsTo("releaseLease")).toHaveLength(1);
  });
});
