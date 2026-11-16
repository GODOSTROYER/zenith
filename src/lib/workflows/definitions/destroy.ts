/**
 * Explicit teardown, never compensation: lease → destroy plan → policy → human
 * approval → [mixed teardown release] → final destroy plan → fenced apply → observed absence.
 * Existing workflows and their command order are unchanged for replay: the release gate
 * runs only behind the `mixed-teardown-release-gate-v1` patch marker.
 * All effects are activities; history contains only ids, digests and counts.
 */
import { patched, proxyActivities } from "@temporalio/workflow";
import type { LeaseRef, PlanSummary, VerifyStepResult, WorkflowResult } from "../types";
import { activities } from "./activities";
import { ACTIVITY_OPTIONS } from "./policies";
import { OperationRun } from "./runtime";

export interface DestroyWorkflowInput {
  operationId: string;
  workspaceId: string;
  environmentId: string;
}

/**
 * PROD-MIX-04 "teardown order". `gated: false`: no mixed run proposes a teardown step for a child in this environment.
 * Otherwise the run's step for that child must be `released` to this destroy before it applies; `blocked`: the step
 * ended failed or uncertain and can never be released.
 */
export type TeardownReleaseCheck =
  | { gated: false }
  | { gated: true; state: "released" | "waiting" | "blocked"; childIds: string[]; parentOperationIds: string[] };

/** Additive worker activities; existing ExecutionActivities implementers stay compatible. */
export interface DestroyActivities {
  /** Read-only. `announce`: record the wait as an operation event (first check only). */
  checkTeardownRelease(input: { operationId: string; announce: boolean }): Promise<TeardownReleaseCheck>;
  planDestroyInfrastructure(input: { operationId: string; lease: LeaseRef }): Promise<PlanSummary>;
  finalDestroyPlan(input: { operationId: string; approvedPlanDigest: string; lease: LeaseRef }): Promise<PlanSummary>;
  applyDestroyInfrastructure(input: { operationId: string; planDigest: string; lease: LeaseRef }): Promise<{ deleted: number }>;
  verifyDestroyedInfrastructure(input: { operationId: string; planDigest: string; lease: LeaseRef }): Promise<VerifyStepResult>;
}

const destroy = {
  checkTeardownRelease: proxyActivities<DestroyActivities>(ACTIVITY_OPTIONS.checkApproval).checkTeardownRelease,
  planDestroyInfrastructure: proxyActivities<DestroyActivities>(ACTIVITY_OPTIONS.planInfrastructure).planDestroyInfrastructure,
  finalDestroyPlan: proxyActivities<DestroyActivities>(ACTIVITY_OPTIONS.finalPlan).finalDestroyPlan,
  applyDestroyInfrastructure: proxyActivities<DestroyActivities>(ACTIVITY_OPTIONS.applyInfrastructure).applyDestroyInfrastructure,
  verifyDestroyedInfrastructure: proxyActivities<DestroyActivities>(ACTIVITY_OPTIONS.verifyInfrastructure).verifyDestroyedInfrastructure,
};

export async function infrastructureDestroyWorkflow(input: DestroyWorkflowInput): Promise<WorkflowResult> {
  const { operationId } = input;
  const releaseGate = patched("mixed-teardown-release-gate-v1");
  const run = new OperationRun({ operationId, leaseScope: `env:${input.environmentId}`, steps: ["lease", "plan", "policy", "approval", ...(releaseGate ? ["teardown_release" as const] : []), "final_plan", "apply_infrastructure", "verify_infrastructure", "finalize", "release"] });
  return run.run(async () => {
    await run.acquireLeaseStep();
    const plan = await run.step("plan", () => destroy.planDestroyInfrastructure({ operationId, lease: run.requireLease() }), (p) => `${p.delete} delete${p.destroysData ? " · destroys data" : ""}`);
    await run.step("policy", async () => {
      const decision = await activities.evaluatePolicy({ operationId, planDigest: plan.planDigest });
      if (decision.outcome === "deny") throw run.halt("failed", `Policy denied teardown: ${decision.reasons.slice(0, 5).join("; ")}`);
      return decision;
    });
    // Teardown always needs human approval even if policy allows it unattended.
    await run.approvalGate();
    // A child of a mixed run is destroyed only once the run released its teardown step to this destroy (consumers first).
    if (releaseGate) {
      await run.releaseGate("teardown_release", async (announce) => {
        const gate = await destroy.checkTeardownRelease({ operationId, announce });
        if (!gate.gated) return { ready: true };
        const children = gate.childIds.join(", ");
        if (gate.state === "blocked") return { ready: false, blocked: `The mixed teardown step of ${children} ended failed or uncertain and cannot be released; reconcile the run. Nothing was applied.` };
        return { ready: gate.state === "released", waiting: `Waiting for the mixed teardown release of ${children}, then a person's approval.` };
      }, "No mixed teardown release and approval were recorded within 24 hours; the operation expired and nothing was changed.");
    }
    const final = await run.step("final_plan", async () => {
      const result = await destroy.finalDestroyPlan({ operationId, approvedPlanDigest: plan.planDigest, lease: run.requireLease() });
      if (result.planDigest !== plan.planDigest) throw run.halt("failed", "The destroy plan changed after review; a new plan and approval are required. Nothing was applied.");
      return result;
    });
    await run.step("apply_infrastructure", () => destroy.applyDestroyInfrastructure({ operationId, planDigest: final.planDigest, lease: run.requireLease() }), (r) => `${r.deleted} deletion(s) applied`);
    await run.step("verify_infrastructure", async () => {
      const verified = await destroy.verifyDestroyedInfrastructure({ operationId, planDigest: final.planDigest, lease: run.requireLease() });
      if (verified.status === "unknown") throw run.halt("uncertain", "Teardown was applied, but resource absence could not be confirmed.");
      if (verified.status === "failed") throw run.halt("failed", "Teardown was applied, but resources are still present.");
      return verified;
    }, (v) => `${v.checks} absence check(s) passed`);
  });
}
