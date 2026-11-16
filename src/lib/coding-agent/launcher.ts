/**
 * Temporal launcher for coding-agent runs (PROD-MACH-06): starts
 * `codingAgentRunWorkflow` on the execution task queue and propagates cancel.
 * The workflow id is stored on the run row (a resume gets a new one), so a start
 * retry is idempotent (`USE_EXISTING`) and a cancel always targets the live one.
 */
import { WorkflowIdConflictPolicy, WorkflowIdReusePolicy, WorkflowNotFoundError } from "@temporalio/client";
import { workflowClient } from "@/lib/workflows/client";
import { TASK_QUEUE, WORKFLOW_TYPES } from "@/lib/workflows/types";
import type { RunLauncher } from "./service";

export function temporalRunLauncher(): RunLauncher {
  return {
    async start({ workspaceId, runId, workflowId }) {
      const client = await workflowClient();
      await client.workflow.start(WORKFLOW_TYPES.codingAgentRun, {
        workflowId,
        taskQueue: TASK_QUEUE,
        args: [{ contract: "zenith.coding-agent-run.v1", runId, workspaceId }],
        workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      });
    },
    async cancel(workflowId) {
      const client = await workflowClient();
      try {
        await client.workflow.getHandle(workflowId).cancel();
      } catch (error) {
        if (!(error instanceof WorkflowNotFoundError)) throw error;
      }
    },
  };
}
