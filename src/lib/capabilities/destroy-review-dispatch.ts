/** Worker-only read-only workflow dispatch. Public and Temporal payloads carry ids only. */
import { WorkflowExecutionAlreadyStartedError, WorkflowIdConflictPolicy, WorkflowIdReusePolicy } from "@temporalio/client";
import { TASK_QUEUE, WORKFLOW_TYPES } from "@/lib/workflows/types";
import { workflowClient } from "@/lib/workflows/client";

type Dispatch = (input: { workspaceId: string; operationId: string }) => Promise<void>;
let override: Dispatch | undefined;
export function setDestroyReviewDispatcherForTests(dispatch: Dispatch | undefined) { override = dispatch; }
export const dispatchDestroyReview: Dispatch = async (input) => {
  if (override) return override(input);
  const client = await workflowClient();
  const workflowId = `teardown-review-${input.operationId}`;
  try {
    await client.workflow.start(WORKFLOW_TYPES.destroyReview, {
      workflowId, taskQueue: TASK_QUEUE,
      args: [{ workspaceId: input.workspaceId, operationId: input.operationId }],
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    });
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    // A completed request also keeps its original execution, never another plan.
    await client.workflow.getHandle(workflowId).describe();
  }
};
