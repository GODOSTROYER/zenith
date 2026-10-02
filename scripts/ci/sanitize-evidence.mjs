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
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ENVIRONMENT_ENTRIES = 4096;
const MAX_ENVIRONMENT_BYTES = 1024 * 1024;
const MAX_EXPORTED_ENVIRONMENT_CHANGES = 128;
const EXECUTION_RECEIPT_V1_DIGEST_KEYS = Object.freeze([
  "reportSha256", "manifestSha256", "sourceSha256", "effectiveEnvironmentSha256",
  "shellContextSha256", "shellLevelSha256", "shellCommandSha256", "runtimeSha256",
]);
const EXECUTION_RECEIPT_V2_DIGEST_KEYS = Object.freeze([...EXECUTION_RECEIPT_V1_DIGEST_KEYS, "environmentInventorySha256"]);
const EXECUTION_RECEIPT_V1_KEYS = Object.freeze(["schemaVersion", "lane", "sourceBindingComplete", ...EXECUTION_RECEIPT_V1_DIGEST_KEYS, "exitCode", "termination", "signal"]);
const EXECUTION_RECEIPT_V2_KEYS = Object.freeze(["schemaVersion", "lane", "sourceBindingComplete", ...EXECUTION_RECEIPT_V2_DIGEST_KEYS, "exitCode", "termination", "signal"]);

function validExecutionReceipt(receipt) {
  const keys = receipt?.schemaVersion === 1 ? EXECUTION_RECEIPT_V1_KEYS : EXECUTION_RECEIPT_V2_KEYS;
  const digests = receipt?.schemaVersion === 1 ? EXECUTION_RECEIPT_V1_DIGEST_KEYS : EXECUTION_RECEIPT_V2_DIGEST_KEYS;
  return Boolean(receipt && typeof receipt === "object" && !Array.isArray(receipt)
    && Object.keys(receipt).length === keys.length && keys.every((key) => Object.hasOwn(receipt, key))
    && [1, 2].includes(receipt.schemaVersion) && typeof receipt.lane === "string" && Object.hasOwn(GATE_LANES, receipt.lane)
    && typeof receipt.sourceBindingComplete === "boolean"
    && digests.every((key) => typeof receipt[key] === "string" && SHA256.test(receipt[key]))
    && ((receipt.termination === "exit" && Number.isSafeInteger(receipt.exitCode) && receipt.exitCode >= 0 && receipt.exitCode <= 255 && receipt.signal === null)
      || (receipt.termination === "signal" && receipt.exitCode === null && SIGNALS.has(receipt.signal))
      || (receipt.termination === "launch-failed" && receipt.exitCode === null && receipt.signal === null)));
}

/** Per-step runner output handles change between execution and validation; they are not engine inputs. */
export const ENVIRONMENT_FINGERPRINT_EXCLUSIONS = Object.freeze([
  "GITHUB_ACTION", "GITHUB_ENV", "GITHUB_PATH", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY", "GITHUB_STATE",
]);

/**
 * Diagnostic IDs only, never exclusions. Fixed names from official runner sources:
 * https://github.com/actions/runner/blob/main/src/Runner.Worker/GitHubContext.cs
 * https://github.com/actions/runner/blob/main/src/Runner.Worker/Handlers/ScriptHandler.cs
 * https://github.com/actions/runner/blob/main/src/Runner.Worker/Handlers/NodeScriptActionHandler.cs
 * https://github.com/actions/runner/blob/main/src/Runner.Worker/JobExtension.cs
 * https://docs.github.com/en/actions/reference/workflows-and-actions/variables
 */
export const RUNNER_ENVIRONMENT_DIAGNOSTIC_IDS = Object.freeze([
  "GITHUB_ACTION_PATH", "GITHUB_ACTION_REF", "GITHUB_ACTION_REPOSITORY", "GITHUB_ACTOR", "GITHUB_ACTOR_ID",
  "GITHUB_ACTIONS", "GITHUB_API_URL", "GITHUB_ARTIFACTS", "GITHUB_ARTIFACTS_LIST", "GITHUB_BASE_REF", "GITHUB_EVENT_NAME", "GITHUB_EVENT_PATH",
  "GITHUB_GRAPHQL_URL", "GITHUB_HEAD_REF", "GITHUB_JOB", "GITHUB_REF_NAME", "GITHUB_REF_PROTECTED", "GITHUB_REF_TYPE", "GITHUB_REF",
  "GITHUB_REPOSITORY", "GITHUB_REPOSITORY_ID", "GITHUB_REPOSITORY_OWNER", "GITHUB_REPOSITORY_OWNER_ID", "GITHUB_RETENTION_DAYS",
  "GITHUB_RUN_ATTEMPT", "GITHUB_RUN_ID", "GITHUB_RUN_NUMBER", "GITHUB_SERVER_URL", "GITHUB_SHA", "GITHUB_TRIGGERING_ACTOR",
  "GITHUB_WORKFLOW", "GITHUB_WORKFLOW_REF", "GITHUB_WORKFLOW_SHA", "GITHUB_WORKSPACE", "RUNNER_TRACKING_ID",
  "RUNNER_ARCH", "RUNNER_OS", "RUNNER_NAME", "RUNNER_DEBUG", "RUNNER_TEMP", "RUNNER_TOOL_CACHE", "RUNNER_ENVIRONMENT", "RUNNER_WORKSPACE",
  "ACTIONS_RUNTIME_URL", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_CACHE_URL", "ACTIONS_RESULTS_URL", "ACTIONS_CACHE_SERVICE_V2", "ACTIONS_CACHE_MODE",
  "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ORCHESTRATION_ID",
]);
const RUNNER_KEY_IDS = new Map(RUNNER_ENVIRONMENT_DIAGNOSTIC_IDS.map((name) => [hash(name), name]));

/** @typedef {{ keySha256: string, valueSha256: string }} EnvironmentInventoryEntry */
/** @typedef {{ schemaVersion: 1, environmentSha256: string, entries: EnvironmentInventoryEntry[] }} EnvironmentInventory */
/** @typedef {{ inventory: EnvironmentInventory | null, sha256: string | null, status: "available" | "missing" | "invalid" }} EnvironmentInventoryState */
/** @typedef {{ id: string, status: "changed" | "added" | "removed" }} EnvironmentChange */
/** @typedef {{ complete: boolean, status: "matched" | "changed" | "missing" | "invalid" | "unbound", originSha256: string | null, counts: { unchanged: number, changed: number, added: number, removed: number }, changes: EnvironmentChange[], truncated: boolean }} EnvironmentDiagnostics */

/** @param {Record<string, string | undefined>} env */
function effectiveEnvironmentEntries(env) {
  return Object.keys(env).filter((name) => !ENVIRONMENT_FINGERPRINT_EXCLUSIONS.includes(name)).sort().map((name) => [name, env[name] ?? null]);
}

/** Private hash-only inventory: never upload it or copy its per-value digests into evidence.
 * @param {Record<string, string | undefined>} [env]
 * @returns {EnvironmentInventory}
 */
export function environmentInventoryFor(env = process.env) {
  const entries = effectiveEnvironmentEntries(env);
  if (entries.length > MAX_ENVIRONMENT_ENTRIES) throw new Error("Environment inventory exceeds its bound");
  return {
    schemaVersion: 1, environmentSha256: hash(JSON.stringify(entries)),
    entries: entries.map(([name, value]) => ({ keySha256: hash(name), valueSha256: hash(JSON.stringify(value)) })).sort((a, b) => a.keySha256 < b.keySha256 ? -1 : a.keySha256 > b.keySha256 ? 1 : 0),
  };
}

const serializeEnvironmentInventory = (inventory) => `${JSON.stringify(inventory, null, 2)}\n`;
export const environmentInventoryPath = (evidencePath) => `${evidencePath}.environment.json`;

function validEnvironmentInventory(inventory) {
  return inventory && typeof inventory === "object" && !Array.isArray(inventory)
    && Object.keys(inventory).length === 3 && ["schemaVersion", "environmentSha256", "entries"].every((key) => Object.hasOwn(inventory, key))
    && inventory.schemaVersion === 1 && typeof inventory.environmentSha256 === "string" && SHA256.test(inventory.environmentSha256)
    && Array.isArray(inventory.entries) && inventory.entries.length <= MAX_ENVIRONMENT_ENTRIES
    && inventory.entries.every((entry, index) => entry && typeof entry === "object" && !Array.isArray(entry)
      && Object.keys(entry).length === 2 && Object.hasOwn(entry, "keySha256") && Object.hasOwn(entry, "valueSha256")
      && typeof entry.keySha256 === "string" && SHA256.test(entry.keySha256) && typeof entry.valueSha256 === "string" && SHA256.test(entry.valueSha256)
      && (index === 0 || inventory.entries[index - 1].keySha256 < entry.keySha256));
}

/** @param {string} evidencePath @param {EnvironmentInventory} inventory */
export function writeEnvironmentInventory(evidencePath, inventory) {
  if (!validEnvironmentInventory(inventory)) throw new Error("Invalid environment inventory");
  const raw = serializeEnvironmentInventory(inventory);
  if (Buffer.byteLength(raw) > MAX_ENVIRONMENT_BYTES) throw new Error("Environment inventory exceeds its bound");
  const target = environmentInventoryPath(evidencePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, raw, { flag: "wx", mode: 0o600 });
}

/** @param {string} evidencePath @returns {EnvironmentInventoryState} */
export function readEnvironmentInventory(evidencePath) {
  let fd;
  let raw;
  try {
    const target = environmentInventoryPath(evidencePath);
    const entry = fs.lstatSync(target);
    if (!entry.isFile()) return { inventory: null, sha256: null, status: "invalid" };
    fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size > MAX_ENVIRONMENT_BYTES) return { inventory: null, sha256: null, status: "invalid" };
    const captured = Buffer.alloc(MAX_ENVIRONMENT_BYTES + 1);
    let length = 0;
    while (length < captured.length) {
      const read = fs.readSync(fd, captured, length, captured.length - length, null);
      if (read === 0) break;
      length += read;
    }
    const finished = fs.fstatSync(fd);
    const current = fs.lstatSync(target);
    if (length > MAX_ENVIRONMENT_BYTES || length !== opened.size || finished.size !== opened.size
      || finished.mtimeMs !== opened.mtimeMs || finished.ctimeMs !== opened.ctimeMs
      || !current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) return { inventory: null, sha256: null, status: "invalid" };
    raw = captured.subarray(0, length);
  } catch (error) { return { inventory: null, sha256: null, status: error?.code === "ENOENT" && fd === undefined ? "missing" : "invalid" }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  const sha256 = hash(raw);
  try {
    const inventory = JSON.parse(raw.toString("utf8"));
    return { inventory: validEnvironmentInventory(inventory) ? inventory : null, sha256, status: validEnvironmentInventory(inventory) ? "available" : "invalid" };
  } catch { return { inventory: null, sha256, status: "invalid" }; }
}

/**
 * Export fixed IDs or a second hash of an unknown key hash, with states only.
 * @param {unknown} receipt
 * @param {EnvironmentInventoryState} origin
 * @param {EnvironmentInventory} current
 * @returns {EnvironmentDiagnostics}
 */
export function environmentDiagnosticsFor(receipt, origin, current) {
  const counts = { unchanged: 0, changed: 0, added: 0, removed: 0 };
  const base = { complete: false, status: "unbound", originSha256: typeof origin.sha256 === "string" && SHA256.test(origin.sha256) ? origin.sha256 : null, counts, changes: [], truncated: false };
  if (origin.status !== "available") return { ...base, status: origin.status === "missing" ? "missing" : "invalid" };
  if (!validEnvironmentInventory(origin.inventory) || !validEnvironmentInventory(current)) return { ...base, status: "invalid" };
  if (!validExecutionReceipt(receipt) || receipt.schemaVersion !== 2 || origin.sha256 !== receipt.environmentInventorySha256 || origin.inventory.environmentSha256 !== receipt.effectiveEnvironmentSha256) return base;
  const before = new Map(origin.inventory.entries.map((entry) => [entry.keySha256, entry.valueSha256]));
  const after = new Map(current.entries.map((entry) => [entry.keySha256, entry.valueSha256]));
  const changes = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const status = !before.has(key) ? "added" : !after.has(key) ? "removed" : before.get(key) === after.get(key) ? "unchanged" : "changed";
    counts[status]++;
    if (status !== "unchanged") changes.push({ id: RUNNER_KEY_IDS.get(key) ?? `opaque:${hash(key)}`, status });
  }
  return {
    ...base, complete: true, status: changes.length > 0 ? "changed" : "matched", counts,
    changes: changes.slice(0, MAX_EXPORTED_ENVIRONMENT_CHANGES), truncated: changes.length > MAX_EXPORTED_ENVIRONMENT_CHANGES,
  };
}

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
  const environment = effectiveEnvironmentEntries(env);
  return {
    commit, trackedChangesSha256: diff.status === 0 ? hash(diff.stdout) : null,
    untrackedContentSha256: untrackedComplete ? hash(JSON.stringify(untrackedSource)) : null,
    worktreeDirty: untracked.status === 0 && untrackedPaths.length > 0 ? true : diff.status === 0 && untracked.status === 0 ? diff.stdout.length > 0 : null,
    sourceBindingComplete: commit !== null && diff.status === 0 && untrackedComplete && index.inventoryComplete && index.assumeUnchanged === 0 && index.skipWorktree === 0 && index.unmerged === 0,
    index,
    gateSources: source, lockfileSha256: lock ? hash(lock) : null, dependencies,
    environment: {
      sha256: hash(JSON.stringify(environment)),
      inventorySha256: hash(serializeEnvironmentInventory(environmentInventoryFor(env))),
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
  const { sha256, inventorySha256, shellContextSha256, shellLevelSha256, shellCommandSha256, ...runtime } = environment;
  return {
    lane: evidence.lane, reportSha256: evidence.reportSha256, manifestSha256: evidence.manifestSha256,
    sourceSha256: hash(JSON.stringify(source)), sourceBindingComplete: source.sourceBindingComplete,
    effectiveEnvironmentSha256: sha256, environmentInventorySha256: inventorySha256, shellContextSha256, shellLevelSha256, shellCommandSha256,
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
  return { schemaVersion: 2, ...executionBindings(evidence), exitCode: status, termination: status !== null ? "exit" : signal !== null ? "signal" : "launch-failed", signal };
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

/** Never erase a prior command failure or promote changed bindings to execution success.
 * @param {string | null} [receiptSha256]
 * @param {EnvironmentDiagnostics} [environmentComparison]
 */
export function preserveExecutionObservation(evidence, receipt, requireExecution = false, receiptSha256, environmentComparison) {
  const expected = executionBindings(evidence);
  const valid = validExecutionReceipt(receipt);
  const inventoryIntegrity = environmentComparison?.complete === true && environmentComparison.originSha256 === receipt?.environmentInventorySha256;
  const matched = valid && receipt.schemaVersion === 2 && receipt.sourceBindingComplete === true && expected.sourceBindingComplete === true
    && Object.entries(expected).every(([key, value]) => receipt[key] === value)
    && inventoryIntegrity;
  evidence.execution = {
    exitCode: valid ? receipt.exitCode : null, termination: valid ? receipt.termination : null, signal: valid ? receipt.signal : null,
    observed: Boolean(valid && receipt.termination !== "launch-failed"),
    binding: matched ? "matched" : receipt === null ? "missing" : "mismatch",
    receiptSha256: receiptSha256 ?? (valid ? hash(`${JSON.stringify(receipt, null, 2)}\n`) : null),
    // Reconstruct the complete fixed-scalar whitelist; the raw origin sidecar is never an upload artifact.
    originReceipt: valid ? {
      schemaVersion: receipt.schemaVersion, lane: receipt.lane, reportSha256: receipt.reportSha256, manifestSha256: receipt.manifestSha256,
      sourceSha256: receipt.sourceSha256, sourceBindingComplete: receipt.sourceBindingComplete,
      effectiveEnvironmentSha256: receipt.effectiveEnvironmentSha256,
      ...(receipt.schemaVersion === 2 ? { environmentInventorySha256: receipt.environmentInventorySha256 } : {}),
      shellContextSha256: receipt.shellContextSha256, shellLevelSha256: receipt.shellLevelSha256, shellCommandSha256: receipt.shellCommandSha256,
      runtimeSha256: receipt.runtimeSha256, exitCode: receipt.exitCode, termination: receipt.termination, signal: receipt.signal,
    } : null,
    ...(valid ? { checks: { ...Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, receipt[key] === value])), environmentInventoryIntegrity: inventoryIntegrity } } : {}),
    environmentComparison: environmentComparison ?? null,
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
    const env = effectiveEnvironmentFor(lane, process.cwd());
    const evidence = sanitizedEvidence(lane, report, process.cwd(), provenanceFor(process.cwd(), env), raw, manifestFor(lane, process.cwd(), reportPath));
    const receipt = readExecutionReceipt(outputPath);
    const comparison = environmentDiagnosticsFor(receipt.receipt, readEnvironmentInventory(outputPath), environmentInventoryFor(env));
    preserveExecutionObservation(evidence, receipt.receipt, false, receipt.sha256, comparison);
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
