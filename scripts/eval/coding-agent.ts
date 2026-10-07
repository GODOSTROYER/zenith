/**
 * `npm run eval:coding-agent` : run the fixed coding-agent evaluation set
 * against a real model and write a machine-readable report.
 *
 *   ANTHROPIC_API_KEY=...            required (read from the environment only)
 *   ZENITH_EVAL_MODEL                default claude-sonnet-5-5 (claude-opus-5-5 also priced)
 *   ZENITH_EVAL_OUT                  report path, default test-results/coding-agent-eval.json
 *   ZENITH_EVAL_MAX_SPEND_MICRO_USD  stop starting new cases past this estimate, default 1500000 (USD 1.50)
 *   ZENITH_EVAL_CASES                comma-separated case ids to run (default all)
 *
 * Exit codes: 0 every case passed; 1 at least one case failed or errored;
 * 2 skipped because no model key is present (the report says so and is NOT a
 * pass). Nothing here ever prints or stores the key.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { anthropicKeyPresent, anthropicProvider } from "@/lib/coding-agent/anthropic";
import { DEFAULT_AGENT_MODEL } from "@/lib/coding-agent/budget";
import { runEval, skippedReport } from "@/lib/coding-agent/eval/harness";

const out = path.resolve(process.env.ZENITH_EVAL_OUT?.trim() || "test-results/coding-agent-eval.json");
const model = process.env.ZENITH_EVAL_MODEL?.trim() || DEFAULT_AGENT_MODEL;

function write(report: unknown): void {
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
}

async function main(): Promise<number> {
  if (!anthropicKeyPresent()) {
    const report = skippedReport("ANTHROPIC_API_KEY is not set, so no model could be evaluated.", model);
    write(report);
    console.log(`SKIPPED: ${report.skipReason} (report: ${out}). This is not a pass.`);
    return 2;
  }
  const only = process.env.ZENITH_EVAL_CASES?.split(",").map((s) => s.trim()).filter(Boolean);
  const cap = Number(process.env.ZENITH_EVAL_MAX_SPEND_MICRO_USD ?? "1500000");
  const report = await runEval({ provider: anthropicProvider(), model, ...(only?.length ? { only } : {}), maxSpendMicroUsd: Number.isSafeInteger(cap) && cap > 0 ? cap : 1_500_000 });
  write(report);
  for (const c of report.cases) console.log(`${c.status.toUpperCase().padEnd(8)} ${c.category.padEnd(8)} ${c.id}${c.status === "passed" ? "" : ` :: ${c.checks.filter((k) => !k.passed).map((k) => k.name).join(", ")}`}`);
  const s = report.summary;
  console.log(`task ${s.task.passed}/${s.task.total}  unsafe ${s.unsafe.passed}/${s.unsafe.total}  recovery ${s.recovery.passed}/${s.recovery.total}  unsafe attempts ${s.unsafeActionAttempts}  est. spend USD ${(s.estimatedSpendMicroUsd / 1_000_000).toFixed(4)}`);
  console.log(`verdict: ${report.verdict} (report: ${out})`);
  return report.verdict === "pass" ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`eval crashed: ${error instanceof Error ? error.name : "error"}`);
    process.exit(1);
  }
);
