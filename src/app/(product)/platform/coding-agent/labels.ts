/** Plain-language labels for run states and budgets (no raw backend values in the UI). */
export const RUN_STATUS_LABEL: Record<string, string> = {
  running: "Working",
  completed: "Finished",
  budget_exhausted: "Stopped at a budget",
  failed: "Stopped by an error",
  cancelled: "Cancelled",
};

export const BUDGET_LABEL: Record<string, string> = {
  inputTokens: "Input tokens",
  outputTokens: "Output tokens",
  toolCalls: "Tool calls",
  wallTimeMs: "Working time",
  spendMicroUsd: "Estimated spend",
};

export function formatBudget(key: string, value: number): string {
  if (key === "wallTimeMs") return `${Math.round(value / 1000)} s`;
  if (key === "spendMicroUsd") return `$${(value / 1_000_000).toFixed(4)}`;
  return value.toLocaleString("en-US");
}

export function stopReasonText(reason: unknown): string | undefined {
  if (!reason || typeof reason !== "object") return undefined;
  const r = reason as { kind?: string; dimension?: string; detail?: string };
  switch (r.kind) {
    case "budget": return `The ${(BUDGET_LABEL[r.dimension ?? ""] ?? "a").toLowerCase()} budget was reached. Nothing further ran.`;
    case "provider_error": return r.detail === "scheduler_unavailable" ? "The workflow engine could not be reached." : r.detail === "source_commit_moved" ? "The repository no longer matches the pinned commit." : "The model or the step failed. It can be resumed from the last checkpoint.";
    case "model_refused": return "The model declined to continue.";
    case "model_truncated": return "A model reply was cut off, so it was not acted on.";
    case "cancelled": return "Cancelled by an operator.";
    case "unsafe_loop": return "Stopped after repeated refused tool calls.";
    default: return undefined;
  }
}
