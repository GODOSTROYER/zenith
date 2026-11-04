/**
 * Shared shapes of the bounded coding agent (PROD-MACH-06).
 *
 * The agent is a loop: a model proposes tool calls, deterministic code decides
 * whether each one is allowed, runs it, and feeds the (untrusted) result back.
 * Nothing the model or the repository says can add a tool, widen a budget,
 * change policy or approve anything: the tool set, the budgets and the broker
 * are fixed by the caller before the first model call.
 */

export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
export type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
/** A provider-signed reasoning block. Carried back verbatim (editing history invalidates it) and never interpreted. */
export type OpaqueBlock = { type: "thinking" | "redacted_thinking"; [key: string]: unknown };
export type Block = TextBlock | ToolUseBlock | ToolResultBlock | OpaqueBlock;

export interface Message {
  role: "user" | "assistant";
  content: Block[];
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  /** Hard ceiling for this one call; already capped to the remaining output and spend budget. */
  maxTokens: number;
  signal?: AbortSignal;
}

export type ModelStop = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface ModelResponse {
  content: Block[];
  stopReason: ModelStop;
  usage: { inputTokens: number; outputTokens: number };
}

/** The model provider seam. The Anthropic adapter is the only production implementation; tests and the eval harness script it. */
export interface ModelProvider {
  readonly id: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/* --------------------------------- budgets --------------------------------- */

export interface BudgetLimits {
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  wallTimeMs: number;
  /** Estimated spend ceiling in micro-USD (1 USD = 1_000_000). Integer arithmetic only. */
  spendMicroUsd: number;
}

export type BudgetUsage = BudgetLimits;

export type BudgetDimension = keyof BudgetLimits;

export type RunStatus = "running" | "completed" | "budget_exhausted" | "failed" | "cancelled";

/** Why a run stopped before the model finished. Machine-readable; never model text. */
export type StopReason =
  | { kind: "budget"; dimension: BudgetDimension }
  | { kind: "provider_error"; detail: string }
  | { kind: "model_refused" }
  | { kind: "model_truncated" }
  | { kind: "cancelled" }
  | { kind: "unsafe_loop"; detail: string };

/* -------------------------------- run state -------------------------------- */

export interface AgentSourceRef {
  /** `owner/repo` or a fixture label */
  repository: string;
  /** exact commit the snapshot was read at; a resume re-reads this commit, never a moving ref */
  commit: string;
  root?: string;
}

/** What the model produced: a manifest proposal artifact. Data, never authority. */
export interface ProposalArtifact {
  manifest: unknown;
  manifestDigest: string;
  requirementsDigest: string;
  explanations: string[];
  unresolved: string[];
  confidence: string;
  environmentClass: string;
}

export interface UnsafeAttempt {
  step: number;
  tool: string;
  code: "unknown_tool" | "invalid_arguments" | "authority_request" | "path_escape" | "not_permitted";
}

/** Everything needed to continue a stopped run. Contains tool results (repository text), so it is stored as data and re-fenced on resume. */
export interface Checkpoint {
  version: 1;
  messages: Message[];
  usage: BudgetUsage;
  steps: number;
  /** tool name -> count, for evals and audit */
  toolHistogram: Record<string, number>;
  /** refused or unknown tool calls and refused arguments; the unsafe-action count */
  unsafeAttempts: UnsafeAttempt[];
  /** injection markers seen in untrusted content (informational; they change nothing) */
  injectionSignals: string[];
  artifact?: ProposalArtifact;
  finalText?: string;
}

export const emptyUsage = (): BudgetUsage => ({ inputTokens: 0, outputTokens: 0, toolCalls: 0, wallTimeMs: 0, spendMicroUsd: 0 });

export const newCheckpoint = (): Checkpoint => ({ version: 1, messages: [], usage: emptyUsage(), steps: 0, toolHistogram: {}, unsafeAttempts: [], injectionSignals: [] });
