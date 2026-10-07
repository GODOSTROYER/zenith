/**
 * LIVE model evaluation (PROD-MACH-06): runs the fixed task / unsafe / recovery
 * set against the real Anthropic API through the same loop production uses.
 *
 * Runs only when ANTHROPIC_API_KEY is present in the environment. Without a
 * key the suite is registered as SKIPPED with an explicit reason: vitest
 * reports skipped, never passed, and the companion test below proves a skipped
 * report cannot be mistaken for a pass. Each run costs a few cents (spend is
 * capped, default USD 1.50) and writes the machine-readable report to
 * test-results/coding-agent-eval.json (override with ZENITH_EVAL_OUT).
 *
 *   ANTHROPIC_API_KEY=... npx vitest run tests/coding-agent/eval-live.test.ts
 *   ZENITH_EVAL_MODEL=claude-opus-5-5 to evaluate the stronger model.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { anthropicKeyPresent, anthropicProvider } from "@/lib/coding-agent/anthropic";
import { DEFAULT_AGENT_MODEL } from "@/lib/coding-agent/budget";
import { runEval, skippedReport } from "@/lib/coding-agent/eval/harness";

const KEY = anthropicKeyPresent();
const SKIP_REASON = "ANTHROPIC_API_KEY is not set: the live coding-agent evaluation needs a real model and was NOT run (skipped, not passed)";
const model = process.env.ZENITH_EVAL_MODEL?.trim() || DEFAULT_AGENT_MODEL;
const out = path.resolve(process.env.ZENITH_EVAL_OUT?.trim() || "test-results/coding-agent-eval.json");

describe.skipIf(!KEY)(`live coding-agent evaluation (${model})`, () => {
  it(
    "task success, unsafe-action containment and recovery after failure all hold with a real model",
    async () => {
      const report = await runEval({ provider: anthropicProvider(), model, maxSpendMicroUsd: 1_500_000 });
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
      const detail = report.cases.filter((c) => c.status !== "passed").map((c) => `${c.id}: ${c.checks.filter((k) => !k.passed).map((k) => k.name).join(", ") || c.error || c.status}`);
      expect(detail, `see ${out}`).toEqual([]);
      expect(report.verdict).toBe("pass");
      expect(report.provider).toBe("anthropic");
      // Containment is structural, so it must hold even if the model misbehaved.
      expect(report.cases.every((c) => c.checks.find((k) => k.name === "no_authority_effect")?.passed ?? true)).toBe(true);
    },
    15 * 60_000
  );
});

describe("live evaluation gating", () => {
  // Visible as SKIPPED (never passed) with the reason in its name when there is no key.
  if (!KEY) it.skip(SKIP_REASON, () => undefined);

  it("with no key the report is skipped with the reason and can never be a pass", () => {
    const report = skippedReport(SKIP_REASON, model);
    expect(report.verdict).toBe("skipped");
    expect(report.skipReason).toContain("ANTHROPIC_API_KEY");
    expect(report.summary.task.passed + report.summary.unsafe.passed + report.summary.recovery.passed).toBe(0);
  });
});
