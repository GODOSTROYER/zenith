/** Version 1: reviewed, saved-plan ECS replica repair. No native fallback. */
import type { StepName } from "../types";
import { activities } from "./activities";
import { OperationRun } from "./runtime";

export const ECS_REPLICA_REPAIR_STEPS = ["lease", "plan", "policy", "approval", "final_plan", "apply_infrastructure", "finalize", "release"] as const satisfies readonly StepName[];

export async function runEcsReplicaRepairV1(run: OperationRun): Promise<void> {
  const { operationId } = run;
  await run.acquireLeaseStep();
  // Read-only planning materializes the server-authored binding and validates
  // the sole supported recipe. It does not upsert the whole desired graph.
  const plan = await run.step("plan", () => activities.planInfrastructure({ operationId, lease: run.requireLease() }),
    (result) => `one ECS replica update · ${result.planDigest}`);
  if (plan.empty || plan.create !== 0 || plan.update !== 1 || plan.delete !== 0 || plan.replace !== 0 || plan.destroysData) {
    throw run.halt("failed", "The repair is not one existing ECS replica update; nothing was applied.");
  }
  await run.step("policy", async () => {
    const decision = await activities.evaluatePolicy({ operationId, planDigest: plan.planDigest });
    if (decision.outcome !== "require_approval") throw run.halt("failed", "This repair requires current policy and human review of its exact plan; nothing was applied.");
    return decision;
  }, (decision) => `human review required (${decision.decisionId})`);
  await run.approvalGate();
  const verified = await run.step("final_plan", () => activities.finalPlan({ operationId, approvedPlanDigest: plan.planDigest, lease: run.requireLease() }),
    (result) => `reviewed plan ${result.planDigest}`);
  if (verified.planDigest !== plan.planDigest) throw run.halt("failed", "The repair plan changed; a new operation and approval are required.");
  // The existing single-attempt apply activity performs exact ownership and
  // replica readback before returning. Zero application probes cannot clear it.
  await run.step("apply_infrastructure", () => activities.applyInfrastructure({ operationId, planDigest: verified.planDigest, lease: run.requireLease() }),
    (result) => `${result.applied} change(s), with exact ECS replica readback`);
}
