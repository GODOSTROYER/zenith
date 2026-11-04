/**
 * The API view of a run: budgets, usage, outcome and the proposal artifact,
 * never the stored conversation (it holds repository text and model output).
 */
import type { CodingAgentRunRow } from "./store";
import type { Checkpoint } from "./types";

export function runView(row: CodingAgentRunRow): Record<string, unknown> {
  const cp = row.checkpoint as Partial<Checkpoint> | null;
  return {
    id: row.id,
    status: row.status,
    stopReason: row.stopReason ?? null,
    model: row.model,
    task: row.task,
    source: row.source,
    target: row.projectId && row.environmentId ? { projectId: row.projectId, environmentId: row.environmentId } : null,
    limits: row.limits,
    usage: row.usage,
    steps: cp?.steps ?? 0,
    toolCalls: cp?.toolHistogram ?? {},
    unsafeAttempts: cp?.unsafeAttempts ?? [],
    injectionSignals: cp?.injectionSignals ?? [],
    resumable: row.status === "budget_exhausted" || row.status === "failed",
    cancellable: row.status === "running" || row.status === "budget_exhausted" || row.status === "failed",
    workflowId: row.workflowId,
    result: row.result ?? null,
    proposalOperationId: row.proposalOperationId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
