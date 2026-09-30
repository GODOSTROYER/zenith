/**
 * Negative control for replay.test.ts: a workflow with the same name as the real
 * deploy workflow that schedules its activities in a different order (an
 * unpatched change). Replaying a history recorded by the real workflow against
 * this must fail with a determinism violation; if it does not, the replay test
 * proves nothing.
 */
import { proxyActivities } from "@temporalio/workflow";
import type { WorkerActivities } from "../../../src/lib/workflows/types";

const acts = proxyActivities<Pick<WorkerActivities, "validateDesiredState" | "markOperation">>({ startToCloseTimeout: "1m" });

export async function infrastructureDeployWorkflow(input: { operationId: string }): Promise<void> {
  // The real workflow calls markOperation("running") first.
  await acts.validateDesiredState({ operationId: input.operationId });
  await acts.markOperation({ operationId: input.operationId, status: "running" });
}
