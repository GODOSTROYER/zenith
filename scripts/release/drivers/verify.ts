/** Strict Mac evidence validator: skipped/missing checks and stale source never supply a pass. */
import fs from "node:fs";
import path from "node:path";
import { sourceBinding } from "../../deploy/installation.mjs";
import { requirementsFor } from "../../ci/gate-manifest.mjs";
import { reportFailures } from "../../../tests/ci/assert-lane-report.mjs";
import { OperatedReceiptSchema, type DriverScenario } from "./operated-contract";

export function verifyOperatedEvidence(receipt: unknown, report: unknown, expected: { scenarioId: DriverScenario; runId: string; source: ReturnType<typeof sourceBinding> }): { passed: number; failed: number; skipped: number } {
  const value = OperatedReceiptSchema.parse(receipt);
  if (value.scenarioId !== expected.scenarioId || value.runId !== expected.runId || value.sourceCommit !== expected.source.head || value.sourceDigest !== expected.source.contentSha256 || value.dirty !== expected.source.dirty || value.checks.some(check => check.status !== "passed")) throw new Error("Missing, stale or unsuccessful operated evidence");
  const required = requirementsFor("drv2-" + expected.scenarioId, process.cwd());
  if (reportFailures(required, report, process.cwd()).length) throw new Error("Operated gated identity did not pass");
  return { passed: value.checks.length, failed: 0, skipped: 0 };
}
export function verifyCli(args: string[]): number {
  try {
    const fields = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {
      if (!["--scenario", "--run-id", "--receipt", "--report"].includes(args[index]) || !args[index + 1] || fields.has(args[index])) throw new Error("usage");
      fields.set(args[index], args[index + 1]);
    }
    const scenario = fields.get("--scenario");
    if (fields.size !== 4 || (scenario !== "drift-repair" && scenario !== "crash-partition")) throw new Error("usage");
    const result = verifyOperatedEvidence(JSON.parse(fs.readFileSync(fields.get("--receipt")!, "utf8")), JSON.parse(fs.readFileSync(fields.get("--report")!, "utf8")), { scenarioId: scenario, runId: fields.get("--run-id")!, source: sourceBinding() });
    process.stdout.write(JSON.stringify({ evidenceLabel: "local_operated_rehearsal", ...result }) + "\n"); return 0;
  } catch { process.stderr.write("DRV-2 evidence refused: source/run/scenario, required check/readback or gated test identity is missing, skipped or failed.\n"); return 1; }
}
if (process.argv[1] && /(?:^|[/\\])verify\.(?:ts|js)$/.test(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve("scripts/release/drivers/verify.ts")) process.exitCode = verifyCli(process.argv.slice(2));
