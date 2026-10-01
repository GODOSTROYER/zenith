/** Read-only review wrapper. Policy, lease, evidence and proposal belong to the worker activity. */
import { proxyActivities } from "@temporalio/workflow";

interface ReviewActivities {
  reviewTeardown(input: { workspaceId: string; operationId: string }): Promise<{ operationId: string; planDigest: string; replayed: boolean }>;
}
const activities = proxyActivities<ReviewActivities>({
  startToCloseTimeout: "30m", scheduleToCloseTimeout: "35m", heartbeatTimeout: "60s",
  retry: { maximumAttempts: 1 },
});

export async function teardownReviewWorkflow(input: { workspaceId: string; operationId: string }) {
  return activities.reviewTeardown({ workspaceId: input.workspaceId, operationId: input.operationId });
}
