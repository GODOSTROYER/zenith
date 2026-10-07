/**
 * Deterministic per-run budgets (PROD-MACH-06).
 *
 * Five dimensions, all integers, all enforced BEFORE the work they bound:
 *
 *  - input tokens, output tokens: a call is made only if its worst case fits.
 *    Input is estimated pessimistically (`ceil(chars / 2)`), output is bounded by
 *    capping `max_tokens` to what is left, so output can never overshoot.
 *    Provider-reported usage replaces the estimate afterwards; if the estimate
 *    was low the overshoot is at most one call and the next admission refuses.
 *  - tool calls: counted when admitted. The call that would exceed the limit is
 *    not run.
 *  - wall time: the injected clock; every provider call gets an abort signal for
 *    the time left.
 *  - spend: integer micro-USD from a fixed price table. Cache discounts are
 *    ignored, so this is an upper estimate. An unpriced model is refused.
 *
 * Limits never come from a model or from repository text; callers pass them
 * and they are clamped to `HARD_CEILINGS`.
 */
import type { BudgetDimension, BudgetLimits, BudgetUsage, ModelRequest } from "./types";

export const HARD_CEILINGS: BudgetLimits = {
  inputTokens: 2_000_000,
  outputTokens: 200_000,
  toolCalls: 200,
  wallTimeMs: 10 * 60_000,
  spendMicroUsd: 25_000_000,
};

export const DEFAULT_LIMITS: BudgetLimits = {
  inputTokens: 300_000,
  outputTokens: 40_000,
  toolCalls: 40,
  wallTimeMs: 3 * 60_000,
  spendMicroUsd: 2_000_000,
};

/** Default models: the latest Sonnet for the agent loop, the latest Opus where a stronger one is asked for. */
export const DEFAULT_AGENT_MODEL = "claude-sonnet-5-5";
export const STRONG_AGENT_MODEL = "claude-opus-5-5";

/** USD per million tokens equals micro-USD per token, so the table is integers. Anthropic list prices as of 2026-09. */
export const MODEL_PRICES: Readonly<Record<string, { inputMicroUsdPerToken: number; outputMicroUsdPerToken: number }>> = {
  "claude-sonnet-5-5": { inputMicroUsdPerToken: 2, outputMicroUsdPerToken: 10 },
  "claude-opus-5-5": { inputMicroUsdPerToken: 4, outputMicroUsdPerToken: 20 },
};

export class BudgetError extends Error {
  constructor(readonly code: "invalid_limits" | "unpriced_model", message: string) {
    super(message);
    this.name = "BudgetError";
  }
}

const DIMENSIONS: readonly BudgetDimension[] = ["inputTokens", "outputTokens", "toolCalls", "wallTimeMs", "spendMicroUsd"];

/** Validate and clamp requested limits. Anything not a positive safe integer is refused, never silently defaulted. */
export function resolveLimits(requested: Partial<BudgetLimits> | undefined): BudgetLimits {
  const out = { ...DEFAULT_LIMITS };
  for (const d of DIMENSIONS) {
    const v = requested?.[d];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new BudgetError("invalid_limits", `Budget ${d} must be a positive integer.`);
    out[d] = Math.min(v, HARD_CEILINGS[d]);
  }
  return out;
}

/** A resume may raise limits (within the ceilings) but never lower them below the run's current ones. */
export function raiseLimits(current: BudgetLimits, requested: Partial<BudgetLimits> | undefined): BudgetLimits {
  const next = resolveLimits({ ...current, ...(requested ?? {}) });
  for (const d of DIMENSIONS) if (next[d] < current[d]) next[d] = current[d];
  return next;
}

export function priceFor(model: string): { inputMicroUsdPerToken: number; outputMicroUsdPerToken: number } {
  const price = MODEL_PRICES[model];
  if (!price) throw new BudgetError("unpriced_model", `No price is known for model "${model}", so a spend budget cannot be enforced. Use ${DEFAULT_AGENT_MODEL} or ${STRONG_AGENT_MODEL}.`);
  return price;
}

/** Pessimistic token estimate for a request: 2 characters per token over everything sent. */
export function estimateInputTokens(request: Pick<ModelRequest, "system" | "messages" | "tools">): number {
  const chars = request.system.length + JSON.stringify(request.messages).length + JSON.stringify(request.tools).length;
  return Math.ceil(chars / 2) + 64;
}

/** Smallest output allowance worth a model call; below this the run stops instead. */
export const MIN_OUTPUT_TOKENS = 256;
/** Per-call output ceiling (keeps non-streaming calls inside HTTP timeouts). */
export const PER_CALL_OUTPUT_CAP = 8_000;

export type Admission = { ok: true; maxTokens: number } | { ok: false; dimension: BudgetDimension };

export class BudgetMeter {
  private segmentStart: number;
  readonly usage: BudgetUsage;
  private readonly price: { inputMicroUsdPerToken: number; outputMicroUsdPerToken: number };

  constructor(
    readonly limits: BudgetLimits,
    prior: BudgetUsage,
    readonly model: string,
    private readonly now: () => number = Date.now
  ) {
    this.usage = { ...prior };
    this.price = priceFor(model);
    this.segmentStart = this.now();
  }

  /** Wall time including the running segment. */
  wallMs(): number {
    return this.usage.wallTimeMs + Math.max(0, this.now() - this.segmentStart);
  }

  /** Fold the running segment into usage; call before persisting a checkpoint. */
  settleWall(): void {
    const t = this.now();
    this.usage.wallTimeMs += Math.max(0, t - this.segmentStart);
    this.segmentStart = t;
  }

  remainingWallMs(): number {
    return Math.max(0, this.limits.wallTimeMs - this.wallMs());
  }

  /** Decide whether a model call may start, and with what output ceiling. */
  admitModelCall(estimatedInputTokens: number): Admission {
    if (this.wallMs() >= this.limits.wallTimeMs) return { ok: false, dimension: "wallTimeMs" };
    const inLeft = this.limits.inputTokens - this.usage.inputTokens;
    if (estimatedInputTokens > inLeft) return { ok: false, dimension: "inputTokens" };
    const outLeft = this.limits.outputTokens - this.usage.outputTokens;
    const spendLeft = this.limits.spendMicroUsd - this.usage.spendMicroUsd - estimatedInputTokens * this.price.inputMicroUsdPerToken;
    if (spendLeft < 0) return { ok: false, dimension: "spendMicroUsd" };
    const bySpend = Math.floor(spendLeft / this.price.outputMicroUsdPerToken);
    const maxTokens = Math.min(outLeft, bySpend, PER_CALL_OUTPUT_CAP);
    if (maxTokens < MIN_OUTPUT_TOKENS) return { ok: false, dimension: outLeft < MIN_OUTPUT_TOKENS ? "outputTokens" : "spendMicroUsd" };
    return { ok: true, maxTokens };
  }

  recordModelUsage(u: { inputTokens: number; outputTokens: number }): void {
    const i = Math.max(0, Math.trunc(u.inputTokens) || 0);
    const o = Math.max(0, Math.trunc(u.outputTokens) || 0);
    this.usage.inputTokens += i;
    this.usage.outputTokens += o;
    this.usage.spendMicroUsd += i * this.price.inputMicroUsdPerToken + o * this.price.outputMicroUsdPerToken;
  }

  /** Count one tool call. The call over the limit is refused (and not counted). */
  admitToolCall(): { ok: true } | { ok: false; dimension: BudgetDimension } {
    if (this.usage.toolCalls >= this.limits.toolCalls) return { ok: false, dimension: "toolCalls" };
    this.usage.toolCalls += 1;
    return { ok: true };
  }

  /** First dimension already over its limit after the last accounting, if any. */
  exceeded(): BudgetDimension | undefined {
    if (this.wallMs() >= this.limits.wallTimeMs) return "wallTimeMs";
    for (const d of ["inputTokens", "outputTokens", "spendMicroUsd"] as const) if (this.usage[d] > this.limits[d]) return d;
    return undefined;
  }
}
