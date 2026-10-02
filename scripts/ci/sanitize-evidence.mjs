/** Produce a whitelist-only artifact: untrusted names, errors and environment values never leave this module. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertionMatches, manifestFor } from "./gate-manifest.mjs";
import { reportFailures } from "../../tests/ci/assert-lane-report.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const normalize = (value) => String(value).replaceAll("\\", "/");
const VERSION = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/;
const PACKAGES = ["vitest", "postgres", "@electric-sql/pglite", "@temporalio/worker", "@temporalio/testing", "@open-policy-agent/opa-wasm"];

/** Per-step runner output handles change between execution and validation; they are not engine inputs. */
export const ENVIRONMENT_FINGERPRINT_EXCLUSIONS = Object.freeze([
  "GITHUB_ACTION", "GITHUB_ENV", "GITHUB_PATH", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY", "GITHUB_STATE",
]);

export function countsFor(assertions) {
  const counts = { total: assertions.length, passed: 0, failed: 0, skipped: 0, unknown: 0 };
  for (const assertion of assertions) {
    const status = assertion?.status;
    if (status === "passed" || status === "failed") counts[status]++;
    else if (["pending", "skipped", "todo"].includes(status)) counts.skipped++;
    else counts.unknown++;
  }
  return counts;
}

/**
 * Source/version provenance is read locally; caller-provided labels are never exported.
 * @param {string} root
 * @param {Record<string, string | undefined>} [env]
 */
export function provenanceFor(root, env = process.env) {
  const git = (args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const head = git(["rev-parse", "HEAD"]);
  const commit = head.status === 0 && /^[a-f0-9]{40}$/.test(head.stdout.trim()) ? head.stdout.trim() : null;
  const diff = git(["diff", "--binary", "HEAD"]);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]);
  let untrackedComplete = untracked.status === 0;
  const untrackedPaths = untracked.status === 0 ? untracked.stdout.split("\0").filter(Boolean).sort() : [];
  const untrackedSource = untrackedPaths.map((file) => {
    try {
      const target = path.join(root, file);
      const content = fs.lstatSync(target).isSymbolicLink() ? fs.readlinkSync(target) : fs.readFileSync(target);
      return [file, hash(content)];
    } catch { untrackedComplete = false; return [file, null]; }
  });
  const sourceFiles = ["scripts/ci/gate-manifest.mjs", "scripts/ci/run-gate.mjs", "scripts/ci/sanitize-evidence.mjs", "scripts/ci/lane-report.mjs", "tests/ci/assert-lane-report.mjs", "vitest.config.ts"];
  const source = sourceFiles.map((file) => ({ file, sha256: fs.existsSync(path.join(root, file)) ? hash(fs.readFileSync(path.join(root, file))) : null }));
  const lockPath = path.join(root, "package-lock.json");
  const lock = fs.existsSync(lockPath) ? fs.readFileSync(lockPath) : null;
  const locked = lock ? JSON.parse(lock.toString("utf8")) : {};
  const dependencies = PACKAGES.map((name) => {
    let installed;
    try { installed = JSON.parse(fs.readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8")).version; } catch { installed = null; }
    const expected = locked.packages?.[`node_modules/${name}`]?.version;
    return { name, locked: typeof expected === "string" && VERSION.test(expected) ? expected : null, installed: typeof installed === "string" && VERSION.test(installed) ? installed : null };
  });
  // Hash configuration, credentials, tool paths and GitHub commit/repository/run
  // identity without exporting values. Only these six trusted per-step output
  // handles are omitted, allowing the always-validation step to retain the
  // execution observation from the preceding step.
  const environment = Object.keys(env).filter((name) => !ENVIRONMENT_FINGERPRINT_EXCLUSIONS.includes(name)).sort().map((name) => [name, env[name] ?? null]);
  return {
    commit, trackedChangesSha256: diff.status === 0 ? hash(diff.stdout) : null,
    untrackedContentSha256: untrackedComplete ? hash(JSON.stringify(untrackedSource)) : null,
    worktreeDirty: untracked.status === 0 && untrackedPaths.length > 0 ? true : diff.status === 0 && untracked.status === 0 ? diff.stdout.length > 0 : null,
    sourceBindingComplete: commit !== null && diff.status === 0 && untrackedComplete,
    gateSources: source, lockfileSha256: lock ? hash(lock) : null, dependencies,
    environment: { sha256: hash(JSON.stringify(environment)), excludedKeys: ENVIRONMENT_FINGERPRINT_EXCLUSIONS, platform: process.platform, architecture: process.arch, node: process.versions.node },
  };
}

export function sanitizedEvidence(lane, report, root, provenance, rawReport = JSON.stringify(report)) {
  const manifest = manifestFor(lane, root);
  const failures = reportFailures(manifest.requirements, report, root);
  const files = report && Array.isArray(report.testResults) ? report.testResults : [];
  const assertions = files.flatMap((file) => Array.isArray(file?.assertionResults) ? file.assertionResults : []);
  const requirementEvidence = manifest.requirements.map((required) => {
    const expected = normalize(path.resolve(root, required.file));
    const matchedFiles = files.filter((file) => typeof file?.name === "string" && normalize(path.resolve(root, normalize(file.name))) === expected);
    const matched = matchedFiles.flatMap((file) => Array.isArray(file.assertionResults) ? file.assertionResults.filter((assertion) => assertionMatches(required, assertion)) : []);
    const counts = countsFor(matched);
    const satisfied = matchedFiles.length === 1 && matchedFiles[0].status === "passed" && counts.total > 0 && counts.passed === counts.total;
    return { id: required.id, file: required.file, backend: required.postgres || required.backend === "postgres" ? "postgres" : null, counts, status: satisfied && failures.length === 0 ? "passed" : "unverified" };
  });
  // These versions are expectations, not a claim that a tool was measured.
  return {
    schemaVersion: 1, lane, validatedAt: new Date().toISOString(), verdict: failures.length === 0 ? "passed" : "failed",
    provenance, reportSha256: hash(rawReport ?? "unavailable"), manifestSha256: hash(JSON.stringify(manifest)),
    expectedTools: manifest.tools, counts: countsFor(assertions), required: requirementEvidence,
    validation: { failureCount: failures.length, complete: failures.length === 0 },
    execution: { exitCode: null, observed: false },
    externalAcceptance: manifest.externalAcceptance.map((group) => ({ id: group.id, file: group.file, status: "unverified", releaseBlocker: group.releaseBlocker })),
  };
}

/**
 * Reuse only the execution observation for identical report, manifest and provenance.
 * @param {number} [observedStatus]
 */
export function preserveExecutionObservation(evidence, previous, observedStatus) {
  let executionStatus = observedStatus;
  if (executionStatus === undefined && previous?.schemaVersion === evidence.schemaVersion && previous.lane === evidence.lane && previous.reportSha256 === evidence.reportSha256 && previous.manifestSha256 === evidence.manifestSha256 && JSON.stringify(previous.provenance) === JSON.stringify(evidence.provenance) && previous.execution?.observed === true && Number.isSafeInteger(previous.execution.exitCode)) executionStatus = previous.execution.exitCode;
  evidence.execution = { exitCode: executionStatus ?? null, observed: executionStatus !== undefined };
  if (executionStatus !== undefined && executionStatus !== 0) {
    evidence.verdict = "failed";
    evidence.validation = { failureCount: evidence.validation.failureCount + 1, complete: false };
    for (const required of evidence.required) required.status = "unverified";
  }
  return executionStatus;
}

export function main(args) {
  const [lane, reportPath, outputPath] = args;
  if (args.length !== 3) { console.error("usage: node scripts/ci/sanitize-evidence.mjs <lane> <report> <output>"); return 2; }
  try {
    const raw = fs.readFileSync(reportPath, "utf8");
    let report;
    try { report = JSON.parse(raw); } catch { report = null; }
    const evidence = sanitizedEvidence(lane, report, process.cwd(), provenanceFor(process.cwd()), raw);
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(outputPath, "utf8")); } catch { /* No earlier observation exists. */ }
    preserveExecutionObservation(evidence, previous);
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    console.log(`${lane}: sanitized evidence ${evidence.verdict}; ${evidence.counts.passed} passed, ${evidence.counts.failed} failed, ${evidence.counts.skipped} skipped`);
    return evidence.verdict === "passed" ? 0 : 1;
  } catch {
    console.error("::error::Cannot create sanitized gate evidence from available source and report.");
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
