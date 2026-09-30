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
import { CAPABILITY_STEPS, runCapabilityOperation } from "./capability";
import { OperationRun } from "./runtime";

export async function dayTwoOperationWorkflow(input: DayTwoWorkflowInput): Promise<WorkflowResult> {
  const run = new OperationRun({
    operationId: input.operationId,
    leaseScope: `env:${input.environmentId}`,
    steps: CAPABILITY_STEPS,
  });
  return run.run(() => runCapabilityOperation(run, "day-two operation"));
}
