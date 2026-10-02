#!/usr/bin/env node
/** Shared execution/validation entry point for CI and local evidence. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { manifestFor } from "./gate-manifest.mjs";
import { reportFailures } from "../../tests/ci/assert-lane-report.mjs";
import { preserveExecutionObservation, provenanceFor, sanitizedEvidence } from "./sanitize-evidence.mjs";

export function validateGate(lane, reportPath, evidencePath, root = process.cwd(), executionStatus) {
  const manifest = manifestFor(lane, root);
  let raw = "unavailable";
  let report = null;
  try { raw = fs.readFileSync(path.resolve(root, reportPath), "utf8"); report = JSON.parse(raw); } catch { /* Missing/malformed evidence fails closed and still produces a sanitized artifact. */ }
  const evidence = sanitizedEvidence(lane, report, root, provenanceFor(root), raw);
  const output = path.resolve(root, evidencePath ?? `.data-ci-lane/${lane}-evidence.json`);
  let previous = null;
  if (executionStatus === undefined) {
    try { previous = JSON.parse(fs.readFileSync(output, "utf8")); } catch { /* No previous execution observation exists. */ }
  }
  const observedStatus = preserveExecutionObservation(evidence, previous, executionStatus);
  const failures = reportFailures(manifest.requirements, report, root);
  if (observedStatus !== undefined && observedStatus !== 0) failures.push("Canonical test command did not succeed");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  for (const failure of failures) console.error(`::error::${failure}`);
  const message = `${lane}: ${evidence.verdict}; ${evidence.required.length} required groups; ${evidence.counts.passed} passed, ${evidence.counts.failed} failed, ${evidence.counts.skipped} skipped`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const external = evidence.externalAcceptance.map((group) => `- ${group.id}: UNVERIFIED. ${group.releaseBlocker}`).join("\n");
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n## Canonical ${lane} gate\n\n${message}\n\n${external}\n`);
  }
  return failures.length === 0 ? 0 : 1;
}

export function main(args) {
  const [lane, mode, ...options] = args;
  try {
    const manifest = manifestFor(lane);
    const values = {};
    if (mode === "--validate") {
      if (!options[0] || options[0].startsWith("--")) throw new Error("usage");
      values.report = options.shift();
    } else if (mode !== "--run") throw new Error("usage");
    while (options.length) {
      const flag = options.shift();
      const value = options.shift();
      if (!["--report", "--evidence", "--step"].includes(flag) || !value || value.startsWith("--") || Object.hasOwn(values, flag.slice(2))) throw new Error("usage");
      values[flag.slice(2)] = value;
    }
    if (lane === "core" || lane === "fresh") {
      if (mode !== "--run" || values.report || values.evidence || !values.step) throw new Error("usage");
      const step = manifest.steps.find((step) => step.id === values.step);
      if (!step) throw new Error("usage");
      const [binary, ...command] = step.command;
      return spawnSync(binary === "node" ? process.execPath : binary, command, { cwd: process.cwd(), env: process.env, stdio: "inherit" }).status ?? 1;
    }
    if (values.step) throw new Error("usage");
    const reportPath = values.report ?? manifest.report;
    if (mode === "--validate") return validateGate(lane, reportPath, values.evidence);
    const runnable = manifestFor(lane, process.cwd(), reportPath);
    // Never accept an old report if Vitest fails before writing a new one.
    fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
    fs.rmSync(reportPath, { force: true });
    const [, ...command] = runnable.command;
    const run = spawnSync(process.execPath, command, { cwd: process.cwd(), env: { ...process.env, ...runnable.env }, stdio: "inherit" });
    // Bind evidence to the effective flags supplied to the actual child run.
    for (const [name, value] of Object.entries(runnable.env)) process.env[name] = value;
    const status = validateGate(lane, reportPath, values.evidence, process.cwd(), run.status ?? 1);
    return run.status === 0 && status === 0 ? 0 : 1;
  } catch {
    console.error("usage: node scripts/ci/run-gate.mjs <fresh|core|postgres|policy|tofu|workflows|platform-postgres> <--run [--report PATH]|--validate REPORT> [--evidence PATH] [--step CORE_CHECK]");
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
