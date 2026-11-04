/**
 * dayTwoOperationWorkflow — restart, scale, rotate, exec... any catalog
 * capability that acts on a running environment: lease → policy re-check →
 * approval if required → executeCapability → verify → finalize → release.
 *
 * Deterministic (workflow sandbox). See capability.ts for the shared body and
 * runtime.ts for the invariants (no destroy, no compensation, lease released
 * on every path).
 */

import type { DayTwoWorkflowInput, WorkflowResult } from "../types";
import { patched } from "@temporalio/workflow";
import { CAPABILITY_STEPS, runCapabilityOperation } from "./capability";
import { OperationRun } from "./runtime";
import { ECS_REPLICA_REPAIR_STEPS, runEcsReplicaRepairV1 } from "./ecsReplicaRepair";

export async function dayTwoOperationWorkflow(input: DayTwoWorkflowInput): Promise<WorkflowResult> {
  const replicaRepair = input.capability === "drift.repair" && patched("ecs-replica-repair-v1");
  const run = new OperationRun({
    operationId: input.operationId,
    leaseScope: `env:${input.environmentId}`,
    steps: replicaRepair ? ECS_REPLICA_REPAIR_STEPS : CAPABILITY_STEPS,
    preserveMutationUncertaintyOnCancellation: replicaRepair,
  });
  return run.run(() => replicaRepair ? runEcsReplicaRepairV1(run) : runCapabilityOperation(run, "day-two operation"));
}
