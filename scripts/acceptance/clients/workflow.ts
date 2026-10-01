/**
 * `WorkflowClient`: the harness's window onto Temporal, for scenarios that have
 * to see what the durable workflow is doing independently of the control
 * plane's own report (Demo E most of all: after a worker is killed, the control
 * plane's answer and Temporal's answer must agree).
 *
 * The default implementation delegates to the merged client in
 * `src/lib/workflows/client.ts` and is imported lazily so a run that never
 * touches Temporal never loads the gRPC client.
 *
 * `getProgress` answers through a workflow QUERY, which needs a live worker:
 * with the worker down it times out. `describe` asks the Temporal service
 * itself (status, history length) and answers with no worker at all.
 */
import type { WorkflowProgress } from "@/lib/workflows/types";

export type WorkflowRunStatus = "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "TERMINATED" | "CONTINUED_AS_NEW" | "TIMED_OUT" | "UNKNOWN";

export interface WorkflowDescription {
  status: WorkflowRunStatus;
  runId: string;
  historyLength: number;
}

export interface WorkflowClient {
  /** Is Temporal reachable and the namespace present? Never throws. */
  available(): Promise<{ available: boolean; detail: string }>;
  /** The workflow's own progress (a query: needs a live worker), or null when there is no such workflow. */
  getProgress(operationId: string): Promise<WorkflowProgress | null>;
  /** What the Temporal service says about the execution; needs no worker. Null when there is no such workflow. */
  describe(operationId: string): Promise<WorkflowDescription | null>;
  /** Wake a workflow that waits for an approval the control plane has recorded. */
  signalApproval(operationId: string): Promise<{ delivered: boolean }>;
  cancel(operationId: string): Promise<{ delivered: boolean }>;
}

const KNOWN: readonly WorkflowRunStatus[] = ["RUNNING", "COMPLETED", "FAILED", "CANCELLED", "TERMINATED", "CONTINUED_AS_NEW", "TIMED_OUT"];

export function temporalWorkflowClient(): WorkflowClient {
  return {
    async available() {
      const { temporalAvailable } = await import("@/lib/workflows/client");
      const a = await temporalAvailable({ ttlMs: 0 });
      return a.available ? { available: true, detail: `Temporal at ${a.address}, namespace ${a.namespace}, answered in ${a.latencyMs} ms.` } : { available: false, detail: `${a.reason}: ${a.message}` };
    },
    async getProgress(operationId) {
      const { getProgress } = await import("@/lib/workflows/client");
      return getProgress(operationId);
    },
    async describe(operationId) {
      const { workflowClient } = await import("@/lib/workflows/client");
      const { WORKFLOW_ID } = await import("@/lib/workflows/types");
      const { WorkflowNotFoundError } = await import("@temporalio/client");
      const client = await workflowClient();
      try {
        const d = await client.workflow.getHandle(WORKFLOW_ID(operationId)).describe();
        const name = String(d.status.name).toUpperCase() as WorkflowRunStatus;
        return { status: KNOWN.includes(name) ? name : "UNKNOWN", runId: d.runId, historyLength: d.historyLength };
      } catch (err) {
        if (err instanceof WorkflowNotFoundError) return null;
        throw err;
      }
    },
    async signalApproval(operationId) {
      const { signalApproval } = await import("@/lib/workflows/client");
      return { delivered: (await signalApproval(operationId)).delivered };
    },
    async cancel(operationId) {
      const { cancelOperation } = await import("@/lib/workflows/client");
      return { delivered: (await cancelOperation(operationId)).delivered };
    },
  };
}
