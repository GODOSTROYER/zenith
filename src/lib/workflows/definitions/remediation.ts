/**
 * remediationWorkflow — an incident's proposed fix, run as a capability
 * operation. Same shape as the day-two workflow; after the fix it runs
 * `verifyApplication` and records the result on the step.
 *
 * It NEVER re-runs on failure: the fix gets one attempt (policies.ts), a failed
 * or inconclusive verification ends the operation `failed` / `uncertain`, and
 * whether to try again is a new proposal that a human or the incident engine
 * makes. It never rolls the fix back automatically either.
 *
 * Deterministic (workflow sandbox). `incidentId` is carried for the operation
 * record's provenance (the control plane already links it); the workflow does
 * not need to read it.
 */

import type { RemediationWorkflowInput, WorkflowResult } from "../types";
import { CAPABILITY_STEPS, runCapabilityOperation } from "./capability";
import { OperationRun } from "./runtime";

export async function remediationWorkflow(input: RemediationWorkflowInput): Promise<WorkflowResult> {
  const run = new OperationRun({
    operationId: input.operationId,
    leaseScope: `env:${input.environmentId}`,
    steps: CAPABILITY_STEPS,
  });
  return run.run(() => runCapabilityOperation(run, "remediation"));
}
