/**
 * Deterministic budgets (PROD-MACH-06): limits are validated and clamped, every
 * dimension is checked before the work it bounds, and arithmetic is integer.
 */
import { describe, expect, it } from "vitest";
import { BudgetError, BudgetMeter, DEFAULT_LIMITS, HARD_CEILINGS, MIN_OUTPUT_TOKENS, MODEL_PRICES, PER_CALL_OUTPUT_CAP, estimateInputTokens, priceFor, raiseLimits, resolveLimits } from "@/lib/coding-agent/budget";
import { emptyUsage } from "@/lib/coding-agent/types";

const limits = (over: Partial<typeof DEFAULT_LIMITS> = {}) => ({ ...DEFAULT_LIMITS, ...over });

describe("limits", () => {
  it("defaults, clamps to the platform ceilings and refuses non-integers", () => {
    expect(resolveLimits(undefined)).toEqual(DEFAULT_LIMITS);
    expect(resolveLimits({ toolCalls: 10_000 }).toolCalls).toBe(HARD_CEILINGS.toolCalls);
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, "5" as unknown as number]) expect(() => resolveLimits({ toolCalls: bad })).toThrow(BudgetError);
  });

  it("a resume can raise limits but never lower them", () => {
    const current = limits({ toolCalls: 10, wallTimeMs: 60_000 });
    const next = raiseLimits(current, { toolCalls: 3, spendMicroUsd: DEFAULT_LIMITS.spendMicroUsd * 2 });
    expect(next.toolCalls).toBe(10);
    expect(next.spendMicroUsd).toBe(DEFAULT_LIMITS.spendMicroUsd * 2);
    expect(raiseLimits(current, { toolCalls: 99_999 }).toolCalls).toBe(HARD_CEILINGS.toolCalls);
  });

  it("prices only the models it knows, with integer micro-USD per token", () => {
    expect(Object.keys(MODEL_PRICES).sort()).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    for (const p of Object.values(MODEL_PRICES)) {
      expect(Number.isInteger(p.inputMicroUsdPerToken)).toBe(true);
      expect(Number.isInteger(p.outputMicroUsdPerToken)).toBe(true);
    }
    expect(() => priceFor("gpt-whatever")).toThrow(/No price is known/);
    expect(() => new BudgetMeter(limits(), emptyUsage(), "claude-unknown")).toThrow(BudgetError);
  });
});

describe("meter admission", () => {
  const model = "claude-sonnet-5-5";

  it("caps max_tokens to the remaining output and spend, never above the per-call cap", () => {
    const m = new BudgetMeter(limits({ outputTokens: 1_000 }), emptyUsage(), model);
    const a = m.admitModelCall(2_000);
    expect(a).toEqual({ ok: true, maxTokens: 1_000 });
    const rich = new BudgetMeter(limits(), emptyUsage(), model).admitModelCall(2_000);
    expect(rich.ok && rich.maxTokens).toBe(PER_CALL_OUTPUT_CAP);
    // spend: 20_000 micro-USD, input estimate 2_000 tokens at 2 each leaves 16_000 / 10 = 1_600 output tokens
    const spend = new BudgetMeter(limits({ spendMicroUsd: 20_000 }), emptyUsage(), model).admitModelCall(2_000);
    expect(spend).toEqual({ ok: true, maxTokens: 1_600 });
  });

  it("refuses a call whose worst case does not fit, naming the binding dimension", () => {
    expect(new BudgetMeter(limits({ inputTokens: 1_000 }), emptyUsage(), model).admitModelCall(2_000)).toEqual({ ok: false, dimension: "inputTokens" });
    expect(new BudgetMeter(limits({ spendMicroUsd: 3_000 }), emptyUsage(), model).admitModelCall(2_000)).toEqual({ ok: false, dimension: "spendMicroUsd" });
    const m = new BudgetMeter(limits({ outputTokens: 1_000 }), { ...emptyUsage(), outputTokens: 1_000 - (MIN_OUTPUT_TOKENS - 1) }, model);
    expect(m.admitModelCall(100)).toEqual({ ok: false, dimension: "outputTokens" });
  });

  it("counts tool calls on admission and refuses the one over the limit without counting it", () => {
    const m = new BudgetMeter(limits({ toolCalls: 2 }), emptyUsage(), model);
    expect(m.admitToolCall().ok).toBe(true);
    expect(m.admitToolCall().ok).toBe(true);
    expect(m.admitToolCall()).toEqual({ ok: false, dimension: "toolCalls" });
    expect(m.usage.toolCalls).toBe(2);
  });

  it("measures wall time with the injected clock across segments and refuses at the limit", () => {
    let t = 1_000;
    const m = new BudgetMeter(limits({ wallTimeMs: 10_000 }), { ...emptyUsage(), wallTimeMs: 4_000 }, model, () => t);
    expect(m.wallMs()).toBe(4_000);
    t += 5_000;
    expect(m.wallMs()).toBe(9_000);
    expect(m.admitModelCall(100).ok).toBe(true);
    t += 1_000;
    expect(m.admitModelCall(100)).toEqual({ ok: false, dimension: "wallTimeMs" });
    expect(m.exceeded()).toBe("wallTimeMs");
    m.settleWall();
    expect(m.usage.wallTimeMs).toBe(10_000);
  });

  it("accumulates provider usage as integer spend", () => {
    const m = new BudgetMeter(limits(), emptyUsage(), "claude-opus-5-5");
    m.recordModelUsage({ inputTokens: 1_000, outputTokens: 500 });
    expect(m.usage).toMatchObject({ inputTokens: 1_000, outputTokens: 500, spendMicroUsd: 1_000 * 4 + 500 * 20 });
    m.recordModelUsage({ inputTokens: -5, outputTokens: Number.NaN });
    expect(m.usage.inputTokens).toBe(1_000);
  });

  it("estimates input pessimistically from everything sent", () => {
    const small = estimateInputTokens({ system: "x", messages: [], tools: [] });
    const big = estimateInputTokens({ system: "x".repeat(10_000), messages: [], tools: [] });
    expect(big - small).toBeGreaterThanOrEqual(5_000 - 1);
  });
});
