/** Produce a whitelist-only artifact: untrusted names, errors and environment values never leave this module. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { constants as osConstants } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertionMatches, GATE_LANES, manifestFor } from "./gate-manifest.mjs";
import { reportFailures } from "../../tests/ci/assert-lane-report.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const normalize = (value) => String(value).replaceAll("\\", "/");
const VERSION = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/;
const PACKAGES = ["vitest", "postgres", "@electric-sql/pglite", "@temporalio/worker", "@temporalio/testing", "@open-policy-agent/opa-wasm"];
const SIGNALS = new Set(Object.keys(osConstants.signals));

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
  const git = (args) => spawnSync("git", ["-c", "core.fsmonitor=false", "-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const head = git(["rev-parse", "HEAD"]);
  const commit = head.status === 0 && /^[a-f0-9]{40}$/.test(head.stdout.trim()) ? head.stdout.trim() : null;
  const diff = git(["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD"]);
  // These index flags can hide changed tracked bytes from Git's ordinary diff.
  // Reject incomplete inventories and export only fixed counts, never paths.
  const inventory = git(["ls-files", "--cached", "-v", "-z"]);
  const records = inventory.status === 0 ? inventory.stdout.split("\0").filter(Boolean) : [];
  const index = {
    inventoryComplete: inventory.status === 0 && (inventory.stdout === "" || inventory.stdout.endsWith("\0")) && records.every((record) => /^[HSMRCK?] .+/i.test(record)),
    assumeUnchanged: records.filter((record) => /^[a-z] /.test(record)).length,
    skipWorktree: records.filter((record) => /^[Ss] /.test(record)).length,
    unmerged: records.filter((record) => /^[Mm] /.test(record)).length,
  };
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
  // handles are omitted. All remaining execution inputs stay bound; a later
  // validation step must retain the origin receipt even when they differ.
  const environment = Object.keys(env).filter((name) => !ENVIRONMENT_FINGERPRINT_EXCLUSIONS.includes(name)).sort().map((name) => [name, env[name] ?? null]);
  return {
    commit, trackedChangesSha256: diff.status === 0 ? hash(diff.stdout) : null,
    untrackedContentSha256: untrackedComplete ? hash(JSON.stringify(untrackedSource)) : null,
    worktreeDirty: untracked.status === 0 && untrackedPaths.length > 0 ? true : diff.status === 0 && untracked.status === 0 ? diff.stdout.length > 0 : null,
    sourceBindingComplete: commit !== null && diff.status === 0 && untrackedComplete && index.inventoryComplete && index.assumeUnchanged === 0 && index.skipWorktree === 0 && index.unmerged === 0,
    index,
    gateSources: source, lockfileSha256: lock ? hash(lock) : null, dependencies,
    environment: {
      sha256: hash(JSON.stringify(environment)),
      shellContextSha256: hash(JSON.stringify(["_", "SHLVL", "PWD", "OLDPWD"].map((name) => [name, env[name] ?? null]))),
      shellLevelSha256: hash(JSON.stringify(env.SHLVL ?? null)),
      shellCommandSha256: hash(JSON.stringify(env._ ?? null)),
      excludedKeys: ENVIRONMENT_FINGERPRINT_EXCLUSIONS, platform: process.platform, architecture: process.arch, node: process.versions.node,
    },
  };
}

export function sanitizedEvidence(lane, report, root, provenance, rawReport = JSON.stringify(report), manifest = manifestFor(lane, root)) {
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
    validation: { failureCount: failures.length, complete: failures.length === 0, caseIdentity: "not-exported-by-standard-vitest-json" },
    execution: { exitCode: null, termination: null, signal: null, observed: false, binding: "missing", receiptSha256: null, originReceipt: null },
    externalAcceptance: manifest.externalAcceptance.map((group) => ({ id: group.id, file: group.file, status: "unverified", releaseBlocker: group.releaseBlocker })),
  };
}

/**
 * Canonical overrides describe the actual child environment, including in a later validator.
 * @param {string} lane
 * @param {string} root
 * @param {Record<string, string | undefined>} [env]
 */
export function effectiveEnvironmentFor(lane, root, env = process.env) {
  return { ...env, ...manifestFor(lane, root).env };
}

export const executionReceiptPath = (evidencePath) => `${evidencePath}.execution.json`;

function executionBindings(evidence) {
  const { environment, ...source } = evidence.provenance;
  const { sha256, shellContextSha256, shellLevelSha256, shellCommandSha256, ...runtime } = environment;
  return {
    lane: evidence.lane, reportSha256: evidence.reportSha256, manifestSha256: evidence.manifestSha256,
    sourceSha256: hash(JSON.stringify(source)), sourceBindingComplete: source.sourceBindingComplete,
    effectiveEnvironmentSha256: sha256, shellContextSha256, shellLevelSha256, shellCommandSha256,
    runtimeSha256: hash(JSON.stringify(runtime)),
  };
}

/** Only the command runner creates this fixed-scalar, immutable origin receipt. */
export function executionReceiptFor(evidence, outcome) {
  const status = typeof outcome === "number" ? outcome : outcome.status;
  const signal = typeof outcome === "number" ? null : outcome.signal;
  if (status !== null && (!Number.isSafeInteger(status) || status < 0 || status > 255)) throw new Error("Invalid execution status");
  if (signal !== null && !SIGNALS.has(signal)) throw new Error("Invalid execution signal");
  if (status !== null && signal !== null) throw new Error("Inconsistent execution status");
  return { schemaVersion: 1, ...executionBindings(evidence), exitCode: status, termination: status !== null ? "exit" : signal !== null ? "signal" : "launch-failed", signal };
}

export function writeExecutionReceipt(evidencePath, receipt) {
  const target = executionReceiptPath(evidencePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

export function readExecutionReceipt(evidencePath) {
  let raw;
  try { raw = fs.readFileSync(executionReceiptPath(evidencePath), "utf8"); }
  catch (error) { return { receipt: error?.code === "ENOENT" ? null : {}, sha256: null }; }
  try { return { receipt: JSON.parse(raw) ?? {}, sha256: hash(raw) }; }
  catch { return { receipt: {}, sha256: hash(raw) }; }
}

/** Never erase a prior command failure or promote changed bindings to execution success. */
export function preserveExecutionObservation(evidence, receipt, requireExecution = false, receiptSha256) {
  const expected = executionBindings(evidence);
  const keys = ["schemaVersion", ...Object.keys(expected), "exitCode", "termination", "signal"];
  const valid = receipt && typeof receipt === "object" && !Array.isArray(receipt)
    && Object.keys(receipt).length === keys.length && keys.every((key) => Object.hasOwn(receipt, key))
    && receipt.schemaVersion === 1 && typeof receipt.lane === "string" && Object.hasOwn(GATE_LANES, receipt.lane)
    && typeof receipt.sourceBindingComplete === "boolean"
    && Object.keys(expected).filter((key) => key.endsWith("Sha256")).every((key) => typeof receipt[key] === "string" && /^[a-f0-9]{64}$/.test(receipt[key]))
    && ((receipt.termination === "exit" && Number.isSafeInteger(receipt.exitCode) && receipt.exitCode >= 0 && receipt.exitCode <= 255 && receipt.signal === null)
      || (receipt.termination === "signal" && receipt.exitCode === null && SIGNALS.has(receipt.signal))
      || (receipt.termination === "launch-failed" && receipt.exitCode === null && receipt.signal === null));
  const matched = valid && receipt.sourceBindingComplete === true && expected.sourceBindingComplete === true
    && Object.entries(expected).every(([key, value]) => receipt[key] === value);
  evidence.execution = {
    exitCode: valid ? receipt.exitCode : null, termination: valid ? receipt.termination : null, signal: valid ? receipt.signal : null,
    observed: Boolean(valid && receipt.termination !== "launch-failed"),
    binding: matched ? "matched" : receipt === null ? "missing" : "mismatch",
    receiptSha256: receiptSha256 ?? (valid ? hash(`${JSON.stringify(receipt, null, 2)}\n`) : null),
    // Reconstruct the complete fixed-scalar whitelist; the raw origin sidecar is never an upload artifact.
    originReceipt: valid ? {
      schemaVersion: 1, lane: receipt.lane, reportSha256: receipt.reportSha256, manifestSha256: receipt.manifestSha256,
      sourceSha256: receipt.sourceSha256, sourceBindingComplete: receipt.sourceBindingComplete,
      effectiveEnvironmentSha256: receipt.effectiveEnvironmentSha256,
      shellContextSha256: receipt.shellContextSha256, shellLevelSha256: receipt.shellLevelSha256, shellCommandSha256: receipt.shellCommandSha256,
      runtimeSha256: receipt.runtimeSha256, exitCode: receipt.exitCode, termination: receipt.termination, signal: receipt.signal,
    } : null,
    ...(valid ? { checks: Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, receipt[key] === value])) } : {}),
  };
  if ((receipt !== null && !matched) || (requireExecution && !matched) || (valid && (receipt.termination !== "exit" || receipt.exitCode !== 0))) {
    evidence.verdict = "failed";
    evidence.validation = { ...evidence.validation, failureCount: evidence.validation.failureCount + 1, complete: false };
    for (const required of evidence.required) required.status = "unverified";
  }
  return valid ? receipt.exitCode : undefined;
}

export function main(args) {
  const [lane, reportPath, outputPath] = args;
  if (args.length !== 3) { console.error("usage: node scripts/ci/sanitize-evidence.mjs <lane> <report> <output>"); return 2; }
  try {
    const raw = fs.readFileSync(reportPath, "utf8");
    let report;
    try { report = JSON.parse(raw); } catch { report = null; }
    const evidence = sanitizedEvidence(lane, report, process.cwd(), provenanceFor(process.cwd(), effectiveEnvironmentFor(lane, process.cwd())), raw, manifestFor(lane, process.cwd(), reportPath));
    const receipt = readExecutionReceipt(outputPath);
    preserveExecutionObservation(evidence, receipt.receipt, false, receipt.sha256);
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
