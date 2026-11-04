/** Exercise classified cancellation through the real workflow runtime. */
import type { DayTwoWorkflowInput, WorkflowResult } from "../../../src/lib/workflows/types";
import { activities } from "../../../src/lib/workflows/definitions/activities";
import { OperationRun } from "../../../src/lib/workflows/definitions/runtime";

export async function classifiedRepairCancellationWorkflow(input: DayTwoWorkflowInput): Promise<WorkflowResult> {
  const run = new OperationRun({ operationId: input.operationId, leaseScope: `env:${input.environmentId}`,
    steps: ["lease", "apply_infrastructure", "finalize", "release"], preserveMutationUncertaintyOnCancellation: true });
  return run.run(async () => {
    await run.acquireLeaseStep();
    await run.step("apply_infrastructure", async () => {
      await activities.applyInfrastructure({ operationId: input.operationId, planDigest: "a".repeat(64), lease: run.requireLease() });
      throw run.halt("cancelled", "classified cancellation after an accepted apply");
    });
  });
}
