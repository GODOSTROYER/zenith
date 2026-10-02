/** Pre-repair workflow shape, for replay compatibility only. */
import type { DayTwoWorkflowInput, WorkflowResult } from "../../../src/lib/workflows/types";
import { CAPABILITY_STEPS, runCapabilityOperation } from "../../../src/lib/workflows/definitions/capability";
import { OperationRun } from "../../../src/lib/workflows/definitions/runtime";

export async function dayTwoOperationWorkflow(input: DayTwoWorkflowInput): Promise<WorkflowResult> {
  const run = new OperationRun({ operationId: input.operationId, leaseScope: `env:${input.environmentId}`, steps: CAPABILITY_STEPS });
  return run.run(() => runCapabilityOperation(run, "day-two operation"));
}
