/**
 * Fresh-image packaged worker acceptance. Node built-ins only: no host SDKs,
 * host node_modules, mounted source or replacement activities. Opt in with
 * ZENITH_PACKAGED_WORKER_ACCEPTANCE=1 and --platform linux/amd64|linux/arm64.
 * All service/container/volume names are unique; no host ports are published.
 */
import { spawn } from "node:child_process";
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, X509Certificate } from "node:crypto";
import { chmod, lstat, mkdtemp, open, readFile, readdir, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const POSTGRES_IMAGE = "postgres:16.15-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685";
// Official multiarch metadata read 2026-10-03; no image was pulled in preparation.
// Immutable server/config/tool source: temporalio/temporal d94e34a1ebba5410a2e7d07119a76896909591aa.
export const TEMPORAL_IMAGE = "temporalio/server:1.32.0@sha256:c3e752127759616bb1615e0f9ba0e21635aeb5fdeb922de4f371c350955f46ae";
export const TEMPORAL_ADMIN_IMAGE = "temporalio/admin-tools:1.32.0@sha256:a9f84fb9a374b2374fe2e67c8efc0468ff3f1c66c8a0b14597ec86e349e62bca";
export const TEMPORAL_CONFIG_DIR = "/etc/zenith-temporal";
export const WORKER_TLS_DIR = "/var/run/zenith-temporal";
export const RECONCILE_SCHEDULE_ID = "zenith-reconcile-sweep-v1";
export const RECONCILE_SWEEP_TYPE = "reconcileSweepWorkflow";
export const PACKAGED_TASK_QUEUE = "zenith-execution";
const TEMPORAL_CONFIG_TEMPLATE = "deploy/acceptance/temporal-worker-test.yaml";
const OWNED_BUILDKIT_IMAGE = "moby/buildkit:buildx-stable-1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea";
const workerFailureCategories = new Set(["module-load", "configuration", "health-listener", "platform-store", "platform-composition", "policy-assets", "plan-directory", "activity-composition", "reconcile-composition", "reconcile-client", "reconcile-pollers", "reconcile-schedule", "temporal-runtime", "workflow-bundle", "temporal-connect", "temporal-worker", "worker-lifecycle", "worker-run", "resource-close"]);
const refusalKinds = ["missing-schema", "invalid-secret", "invalid-signer", "plaintext-temporal", "missing-namespace", "wrong-queue"];
const diagnosticRoles = new Set(["postgres", "temporal", "worker", ...refusalKinds]);
const refusalCommandPhases = new Set(refusalKinds.flatMap((kind) => [`refusal-launch-${kind}`, `refusal-exit-${kind}`, `refusal-logs-${kind}`]));
export const REFUSAL_LAUNCH_TIMEOUT_MS = 120_000;
export const REFUSAL_EXIT_TIMEOUT_MS = 45_000;

/** Resolve aliases before accepting private storage; never return paths in evidence.
 * @param {string} source
 * @param {string} base
 */
export async function privateTemporaryBase(source, base) {
  const sourceRoot = await realpath(source);
  const temporaryRoot = await realpath(base);
  if (temporaryRoot === sourceRoot || temporaryRoot.startsWith(sourceRoot + path.sep)
    || !(await lstat(temporaryRoot)).isDirectory()) throw new Error("Private temporary storage must be outside the source tree.");
  return { sourceRoot, temporaryRoot };
}

/** The location is admitted before any key generation, secret write or Docker call.
 * @param {string} source
 * @param {string} base
 * @param {string} prefix
 */
export async function createPrivateScratch(source, base, prefix) {
  const { sourceRoot, temporaryRoot } = await privateTemporaryBase(source, base);
  const directory = await mkdtemp(path.join(temporaryRoot, prefix));
  try {
    const canonical = await realpath(directory);
    if (canonical === sourceRoot || canonical.startsWith(sourceRoot + path.sep)
      || path.dirname(canonical) !== temporaryRoot || (await lstat(directory)).isSymbolicLink()) {
      throw new Error("Private temporary storage must be outside the source tree.");
    }
    await chmod(canonical, 0o700);
    return canonical;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

const COPY_INPUTS = ["package.json", "package-lock.json", "tsconfig.json", "src/lib", "workers/execution", "deploy/aws/ssm-documents", "policy/dist"];
const CONTEXT_CONTROLS = ["docker/worker.Dockerfile", ".dockerignore"];
const OPTIONAL_CONTEXT_CONTROL = "docker/worker.Dockerfile.dockerignore";
const SOURCE_BYTE_LIMIT = 64 * 1024 * 1024;
const SOURCE_ENTRY_LIMIT = 20_000;

/** Hash a conservative superset of every host COPY input, independent of Git ignores.
 * Symlinks and special files are refused rather than claiming incomplete provenance.
 * @param {string} source
 * @returns {Promise<string>}
 */
export async function packagedSourceDigest(source) {
  const root = await realpath(source);
  const hash = createHash("sha256").update("zenith-packaged-source-v1\0");
  let bytes = 0;
  let entries = 0;
  let dockerfile = "";
  /** @param {string} kind @param {string} relative @param {Buffer} content */
  const frame = (kind, relative, content) => {
    const name = Buffer.from(relative, "utf8");
    hash.update(`${kind}\0${name.length}\0`).update(name).update(`\0${content.length}\0`).update(content);
  };
  /** @param {string} relative @returns {Promise<void>} */
  const visit = async (relative) => {
    if (++entries > SOURCE_ENTRY_LIMIT) throw new Error("Packaged source inventory exceeds its bound.");
    const filename = path.join(root, relative);
    // Check all lexical ancestors too: lstat of a leaf alone follows directory aliases.
    let ancestor = root;
    for (const segment of relative.split("/")) {
      ancestor = path.join(ancestor, segment);
      if ((await lstat(ancestor)).isSymbolicLink()) throw new Error("Packaged source cannot contain symlinks.");
    }
    const before = await lstat(filename);
    if ((CONTEXT_CONTROLS.includes(relative) || ["package.json", "package-lock.json", "tsconfig.json", OPTIONAL_CONTEXT_CONTROL].includes(relative)) && !before.isFile()) {
      throw new Error("Packaged source controls must be regular files.");
    }
    if (["src/lib", "workers/execution", "deploy/aws/ssm-documents", "policy/dist"].includes(relative) && !before.isDirectory()) {
      throw new Error("Packaged source COPY roots must be directories.");
    }
    if (before.isDirectory()) {
      frame(`directory:${before.mode & 0o7777}`, relative, Buffer.alloc(0));
      const names = (await readdir(filename)).sort();
      for (const name of names) await visit(`${relative}/${name}`);
      const after = await lstat(filename);
      if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Packaged source changed while being captured.");
      return;
    }
    if (!before.isFile()) throw new Error("Packaged source inputs must be regular files.");
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size > SOURCE_BYTE_LIMIT - bytes) throw new Error("Packaged source inventory is incomplete or exceeds its bound.");
      /** @type {Buffer[]} */
      const chunks = [];
      let size = 0;
      for (;;) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, SOURCE_BYTE_LIMIT - bytes - size + 1));
        const read = await handle.read(chunk, 0, chunk.length, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
        if (bytes + size > SOURCE_BYTE_LIMIT) throw new Error("Packaged source inventory exceeds its bound.");
        chunks.push(chunk.subarray(0, read.bytesRead));
      }
      const after = await handle.stat();
      const final = await lstat(filename);
      if (!final.isFile() || final.dev !== opened.dev || final.ino !== opened.ino || size !== opened.size
        || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
        || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs) throw new Error("Packaged source changed while being captured.");
      const content = Buffer.concat(chunks);
      frame(`file:${opened.mode & 0o7777}`, relative, content);
      bytes += size;
      if (relative === "docker/worker.Dockerfile") dockerfile = content.toString("utf8");
    } finally { await handle.close(); }
  };
  for (const relative of [...CONTEXT_CONTROLS, ...COPY_INPUTS].sort()) await visit(relative);
  let optionalPresent = false;
  try { await lstat(path.join(root, OPTIONAL_CONTEXT_CONTROL)); optionalPresent = true; }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    frame("absent", OPTIONAL_CONTEXT_CONTROL, Buffer.alloc(0));
  }
  // Optional Dockerfile-specific rules override the root ignore file in Docker.
  if (optionalPresent) await visit(OPTIONAL_CONTEXT_CONTROL);
  /** @type {Set<string>} */
  const declared = new Set();
  for (const line of dockerfile.split("\n")) {
    if (/^\s*ADD\s/i.test(line)) throw new Error("Packaged Docker ADD inputs are not bound.");
    if (!/^\s*COPY\s/i.test(line)) continue;
    const tokens = line.trim().split(/\s+/).slice(1);
    if (tokens.some((token) => token.startsWith("--from="))) continue;
    if (tokens[0]?.startsWith("--chown=")) tokens.shift();
    if (tokens.length < 2 || tokens.some((token) => /[\\\[\]"']/.test(token) || token.startsWith("--"))) {
      throw new Error("Packaged Docker COPY inventory is not supported.");
    }
    for (const input of tokens.slice(0, -1)) declared.add(input);
  }
  if (declared.size !== COPY_INPUTS.length || COPY_INPUTS.some((input) => !declared.has(input))) {
    throw new Error("Packaged Docker COPY inventory differs from its source binding.");
  }
  return hash.digest("hex");
}

/** @param {string} before @param {string} after */
export function assertPackagedSourceUnchanged(before, after) {
  if (before !== after) throw new Error("Packaged source changed during the fresh image build.");
}

/** Only fixed scalar container state may leave the private diagnostic store.
 * @param {{ Status?: unknown, Running?: unknown, ExitCode?: unknown, OOMKilled?: unknown }} value
 */
export function sanitizeContainerState(value) {
  if (!value || !["created", "running", "paused", "restarting", "removing", "exited", "dead"].includes(String(value.Status))
    || typeof value.Running !== "boolean" || typeof value.OOMKilled !== "boolean"
    || !Number.isSafeInteger(value.ExitCode) || Number(value.ExitCode) < 0 || Number(value.ExitCode) > 255) return undefined;
  return { status: String(value.Status), running: value.Running, exitCode: Number(value.ExitCode), oomKilled: value.OOMKilled };
}

/** Parse worker-owned JSON lines without exporting arbitrary messages/fields.
 * @param {string} logs
 * @returns {string}
 */
export function workerFailureCategory(logs) {
  for (const line of logs.split("\n").reverse()) {
    try {
      const value = JSON.parse(line);
      if (value?.component === "execution-worker" && value.msg === "execution worker failed" && workerFailureCategories.has(value.failureCategory)) return String(value.failureCategory);
    } catch { /* Docker/native logs need not be JSON. */ }
  }
  return "unavailable";
}

/** Detailed diagnostics remain private even after known runtime secrets are removed.
 * @param {string} logs
 * @param {readonly string[]} secrets
 */
export function redactDiagnosticLogs(logs, secrets) {
  let redacted = logs;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) redacted = redacted.split(secret).join("[REDACTED]");
  return redacted;
}

export function parsePackagedArgs(args, env) {
  if (env.ZENITH_PACKAGED_WORKER_ACCEPTANCE !== "1") throw new Error("Explicit opt-in requires ZENITH_PACKAGED_WORKER_ACCEPTANCE=1 for disposable packaged-worker acceptance.");
  if (args.length !== 2 || args[0] !== "--platform" || !["linux/amd64", "linux/arm64"].includes(args[1])) {
    throw new Error("Usage: node scripts/acceptance/packaged-worker.mjs --platform linux/amd64|linux/arm64");
  }
  return { platform: args[1] };
}

/** Raw command output remains private; only curated evidence reaches logs. */
const activeChildren = new Set();
const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
export class PackagedCommandError extends Error {
  /** @param {string} phase
   * @param {"command-launch" | "command-timeout" | "command-output-limit" | "command-exit" | "command-signal"} category
   * @param {number | null} exitCode
   * @param {string | null} signal
   */
  constructor(phase, category, exitCode = null, signal = null) {
    super(`Packaged acceptance phase failed: ${phase}`);
    this.phase = phase;
    this.diagnostic = { category, exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
      signal: ["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV", "SIGBUS"].includes(signal ?? "") ? signal : null };
  }
}
export async function command(binary, args, phase, { timeout = 120_000, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    activeChildren.add(child);
    let out = "";
    let err = "";
    let overflow = false;
    let timedOut = false;
    let outBytes = 0;
    let errBytes = 0;
    child.stdout.on("data", (chunk) => {
      outBytes += chunk.length;
      if (outBytes > OUTPUT_LIMIT_BYTES) { overflow = true; child.kill("SIGKILL"); }
      else out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errBytes += chunk.length;
      if (errBytes > OUTPUT_LIMIT_BYTES) { overflow = true; child.kill("SIGKILL"); }
      else err += chunk;
    });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
    child.once("error", () => { activeChildren.delete(child); clearTimeout(timer); reject(new PackagedCommandError(phase, "command-launch")); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      if (overflow || timedOut || signal || (code !== 0 && !allowFailure)) reject(new PackagedCommandError(phase,
        overflow ? "command-output-limit" : timedOut ? "command-timeout" : signal ? "command-signal" : "command-exit", code, signal));
      else resolve({ code, out, err });
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A Docker client exit is not a worker exit. Inspect only the exact owned
 * container, and never accept an expired observation window as a refusal. */
export async function waitForRefusalExit(name, runId, runDocker, { timeout = REFUSAL_EXIT_TIMEOUT_MS, now = () => performance.now(), wait = delay, phase = "refusal-exit" } = {}) {
  const deadline = now() + timeout;
  while (now() < deadline) {
    const result = await runDocker(["inspect", "--type", "container", "--format", '{{json .}}', name], phase,
      { timeout: Math.min(5000, Math.max(1, deadline - now())), allowFailure: true });
    if (now() >= deadline) throw new PackagedCommandError(phase, "command-timeout");
    if (result.code !== 0) throw new Error("Packaged refusal container could not be inspected.");
    const inspect = JSON.parse(result.out);
    if (inspect.Config?.Labels?.["io.zenith.acceptance.run"] !== runId) throw new Error("Packaged refusal ownership did not match.");
    const state = sanitizeContainerState(inspect.State);
    if (!state) throw new Error("Packaged refusal container state was unavailable.");
    if (state.status === "exited" && !state.running) {
      if (state.exitCode !== 1 || state.oomKilled) throw new Error("Packaged refusal did not have the required worker exit.");
      return state;
    }
    if (["dead", "removing"].includes(state.status)) throw new Error("Packaged refusal container ended without a verified worker exit.");
    await wait(Math.min(250, Math.max(0, deadline - now())));
  }
  throw new PackagedCommandError(phase, "command-timeout");
}

/** Only the expected worker-owned refusal and secret-free output are proof. */
export function refusalFailureCategory(kind, logs, secrets) {
  if (!refusalKinds.includes(kind)) throw new Error("Unsupported startup refusal kind.");
  const category = workerFailureCategory(logs);
  if (category !== (kind === "missing-schema" ? "platform-store" : "configuration")) throw new Error("Packaged startup refusal category did not match.");
  for (const value of secrets.filter(Boolean)) if (logs.includes(value)) throw new Error("Packaged refusal output contained secret material.");
  return category;
}
const requiredActivities = ["acquireLease", "evaluatePolicy", "executeCapability", "markOperation", "releaseLease"];
const allowedActivities = new Set([...requiredActivities, "recordStep", "renewLease", "checkApproval", "verifyApplication"]);
const dependencies = ["@temporalio/worker", "@temporalio/client", "postgres", "jose"];
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const version = (value) => typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value);
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** Admit all fixed versions before publishing any dependency evidence.
 * @param {unknown} lock
 * @returns {Record<string, string>}
 */
export function sanitizeLockedDependencies(lock) {
  if (!isRecord(lock) || !isRecord(lock.packages)) throw new Error("Packaged locked dependency evidence does not match its trusted schema.");
  /** @type {Record<string, string>} */
  const admitted = {};
  for (const name of dependencies) {
    const entry = lock.packages[`node_modules/${name}`];
    if (!isRecord(entry) || typeof entry.version !== "string" || entry.version !== entry.version.trim() || !version(entry.version)) {
      throw new Error("Packaged locked dependency evidence does not match its trusted schema.");
    }
    admitted[name] = entry.version;
  }
  return admitted;
}

/** @param {unknown} value @returns {string} */
export function sanitizeImageId(value) {
  if (typeof value !== "string" || value.length !== 71 || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error("Packaged image identifier does not match its trusted schema.");
  }
  return value;
}
export function sanitizeClientEvidence(action, value) {
  const fail = () => { throw new Error("Packaged client evidence does not match its trusted schema."); };
  if (action === "prepare") {
    if (value?.prepared !== true || value.platformStore !== "postgres" || value.productStore !== "isolated-file-fixture"
      || !Array.isArray(value.appliedVersions) || !value.appliedVersions.every((v) => Number.isSafeInteger(v) && v > 0)) fail();
    return { prepared: true, appliedVersions: value.appliedVersions, productStore: "isolated-file-fixture", platformStore: "postgres" };
  }
  if (action === "operations") {
    if (value?.reconcile?.status !== "observed" || value.reconcile.drift !== 0 || value.reconcile.unknown !== 0
      || value.operation?.workflowStatus !== "failed" || value.operation.ledgerStatus !== "failed"
      || value.operation.outcome !== "expected no-target refusal" || value.operation.signedReadGrantVerified !== true
      || !Number.isSafeInteger(value.operation.policyDecisions) || value.operation.policyDecisions < 2
      || !Array.isArray(value.operation.activityTypes) || requiredActivities.some((name) => !value.operation.activityTypes.includes(name))
      || value.operation.activityTypes.some((name) => !allowedActivities.has(name))
      || value.cloudWritesProven !== false || value.browserApprovalPerformed !== false) fail();
    return { reconcile: { status: "observed", drift: 0, unknown: 0, scope: "no deployed resources" },
      operation: { workflowStatus: "failed", ledgerStatus: "failed", outcome: "expected no-target refusal",
        policyDecisions: value.operation.policyDecisions, activityTypes: value.operation.activityTypes, signedReadGrantVerified: true },
      cloudWritesProven: false, browserApprovalPerformed: false };
  }
  if (action === "assets") {
    if (value?.uid !== 10001 || !["arm64", "x64"].includes(value.arch) || !/^v22\.\d+\.\d+$/.test(value.node)
      || !Array.isArray(value.tofu) || !/^OpenTofu v\d+\.\d+\.\d+$/.test(value.tofu[0]) || !/^on linux_(amd64|arm64)$/.test(value.tofu[1])
      || !digest(value.policySha256) || !Number.isSafeInteger(value.ssmDocuments?.count) || value.ssmDocuments.count < 1
      || !digest(value.ssmDocuments.sha256) || dependencies.some((name) => !version(value.dependencies?.[name]))
      || value.plans?.logicallyExpired !== true || value.plans.ciphertextRetained !== true || value.plans.terminalRetained !== true || value.plans.encryptedLifecycleFixture !== true || value.plans.activeRetained !== true || value.plans.unownedRetained !== true || value.plans.sentinelFiles !== true) fail();
    return { uid: 10001, arch: value.arch, node: value.node, tofu: value.tofu.slice(0, 2), policySha256: value.policySha256,
      ssmDocuments: { count: value.ssmDocuments.count, sha256: value.ssmDocuments.sha256 },
      dependencies: Object.fromEntries(dependencies.map((name) => [name, value.dependencies[name]])),
      plans: { logicallyExpired: true, ciphertextRetained: true, terminalRetained: true, activeRetained: true, unownedRetained: true, sentinelFiles: true, encryptedLifecycleFixture: true } };
  }
  fail();
}

function clientEvidence(action, result) {
  const line = result.out.split("\n").find((value) => value.startsWith("PACKAGED_ACCEPTANCE "));
  if (!line) throw new Error("Packaged client produced no acceptance evidence.");
  return sanitizeClientEvidence(action, JSON.parse(line.slice("PACKAGED_ACCEPTANCE ".length)));
}

/** Removal is bounded, label checked on every attempt, and independently
 * verified. A lost CLI response can still be followed by proven absence.
 * @param {"container" | "volume" | "network" | "image"} kind
 */
export async function cleanupOwnedResource(kind, name, runId, runDocker) {
  if (!["container", "volume", "network", "image"].includes(kind)) throw new Error("Unsupported cleanup resource kind.");
  const label = ["container", "image"].includes(kind) ? ".Config.Labels" : ".Labels";
  const inspectArgs = kind === "container" ? ["inspect", "--type", "container"] : [kind, "inspect"];
  const listArgs = kind === "container" ? ["ps", "-aq", "--filter", `name=^/${name}$`]
    : kind === "image" ? ["image", "ls", "--filter", `reference=${name}`, "--format", "{{.Repository}}:{{.Tag}}"]
      : [kind, "ls", "-q", "--filter", `name=^${name}$`];
  // Removing a tag can leave an untagged image behind. Include dangling images
  // in the independent run inventory, without deleting by an unverified ID.
  const imageInventoryArgs = ["image", "ls", "--all", "--quiet", "--no-trunc", "--filter", `label=io.zenith.acceptance.run=${runId}`];
  let attempts = 0;
  let outcome = "ownership-unconfirmed";
  const safeCommand = async (args, timeout = 15_000) => {
    try { return await runDocker(args, "cleanup", { allowFailure: true, timeout }); }
    catch (error) { return { code: 1, out: "", timedOut: error instanceof PackagedCommandError && error.diagnostic.category === "command-timeout" }; }
  };
  for (let round = 0; round < 2; round++) {
    const inspected = await safeCommand([...inspectArgs, "--format", `{{index ${label} "io.zenith.acceptance.run"}}`, name]);
    if (inspected.code === 0 && inspected.out.trim() !== runId) return { removed: false, outcome: "label-mismatch", attempts };
    let removal;
    if (inspected.code === 0) {
      if (kind === "container") await safeCommand(["unpause", name], 5000);
      attempts++;
      removal = await safeCommand(kind === "container" ? ["rm", "-f", name] : [kind, "rm", name], 20_000);
    }
    // An inspect/delete error is never absence proof. Require successful exact
    // name absence and, for images, an empty owned inventory as well.
    const listing = await safeCommand(listArgs);
    const imageInventory = kind === "image" ? await safeCommand(imageInventoryArgs) : undefined;
    const listingConfirmed = listing.code === 0 && (!imageInventory || imageInventory.code === 0);
    const absent = listingConfirmed && listing.out.trim() === "" && (!imageInventory || imageInventory.out.trim() === "");
    if (absent) return { removed: true,
      outcome: removal?.timedOut ? "absent-after-timeout" : removal?.code !== undefined && removal.code !== 0 ? "absent-after-error" : removal ? "removed" : "already-absent", attempts };
    outcome = !listingConfirmed ? "absence-unconfirmed" : inspected.code !== 0 ? "ownership-unconfirmed"
      : removal?.timedOut ? "remove-timeout" : removal?.code !== 0 ? "remove-failed" : "still-present";
  }
  return { removed: false, outcome, attempts };
}

/** Retain the small boolean interface for callers checking only image absence. */
export async function cleanupOwnedImage(image, runId, runDocker) {
  return (await cleanupOwnedResource("image", image, runId, runDocker)).removed;
}

/** The external private storage wrapper owns this builder and its baseline.
 * This checks its observed identity/options; it does not establish who created
 * it. The wrapper's independent creation/absence receipt is still required.
 * @param {unknown} name @param {string} observed @param {string} expectedEndpoint
 */
export function assertOwnedPackagedBuilder(name, observed, expectedEndpoint) {
  if (typeof name !== "string" || !/^zenith-owned-[a-f0-9]{12}$/.test(name)
    || /^Name:\s+([^\r\n]+)$/m.exec(observed)?.[1]?.trim() !== name
    || !/^Driver:\s+docker-container\s*$/m.test(observed)
    || typeof expectedEndpoint !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(expectedEndpoint)
    || /^Endpoint:\s+([^\r\n]+)$/m.exec(observed)?.[1]?.trim() !== expectedEndpoint
    || !observed.includes(`image="${OWNED_BUILDKIT_IMAGE}"`)
    || !/\bmemory="4g"(?:\s|$)/.test(observed)) {
    throw new Error("Packaged acceptance requires the externally owned bounded builder.");
  }
  return name;
}

/** No YAML escaping or arbitrary connection value enters the private copy. */
export function renderTemporalServerConfiguration(template, password) {
  if (typeof password !== "string" || !/^[a-f0-9]{64}$/.test(password)
    || typeof template !== "string" || template.split("__OWNED_POSTGRES_PASSWORD__").length !== 3) {
    throw new Error("Disposable Temporal configuration is invalid.");
  }
  return template.replaceAll("__OWNED_POSTGRES_PASSWORD__", password);
}

/** Actual current worker readiness includes its authoritative schedule check. */
export function sanitizePackagedReadiness(value) {
  const keys = ["temporal", "store", "policy", "drivers", "reconciliation"];
  if (!isRecord(value) || value.ready !== true || !isRecord(value.checks)
    || keys.some(key => value.checks[key] !== "ok")) throw new Error("Worker readiness evidence is incomplete.");
  return { ready: true, checks: Object.fromEntries(keys.map(key => [key, "ok"])) };
}

/** Third-connection observation, never a sleep-only or claimed PID proof. */
export function schemaOutageObserverSql(runId) {
  if (typeof runId !== "string" || !/^zenith-pkg-(arm64|amd64)-[a-f0-9]{12}$/.test(runId)) throw new Error("Owned schema outage identity is invalid.");
  return `select coalesce(json_agg(json_build_object('observerPid',pg_backend_pid(),'waiterPid',a.pid,'blockerPid',b.pid)), '[]'::json)
    from pg_stat_activity a join pg_stat_activity b on b.pid=any(pg_blocking_pids(a.pid))
    where a.datname='zenith_packaged' and b.datname='zenith_packaged' and a.pid<>pg_backend_pid()
    and a.wait_event_type='Lock' and a.query like 'select version, name, applied_at, checksum from platform.schema_migrations%'
    and b.application_name='${runId}-schema-outage' and b.query like 'begin; set local statement_timeout=%'
    and b.wait_event='PgSleep'`;
}
export function sanitizePgWaiterEvidence(value) {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) throw new Error("Actual schema waiter was not confirmed.");
  const { observerPid, waiterPid, blockerPid } = value[0];
  const pids = [observerPid, waiterPid, blockerPid];
  if (pids.some(pid => !Number.isSafeInteger(pid) || pid <= 1) || new Set(pids).size !== 3) throw new Error("Actual schema waiter was not confirmed.");
  return { observerPid, waiterPid, blockerPid };
}

/** Fixed scalars only, never raw history, certificate, decoded args or errors. */
export function sanitizeTemporalControlEvidence(action, value) {
  const fail = () => { throw new Error("Packaged Temporal control evidence is unconfirmed."); };
  if (!isRecord(value)) fail();
  if (action === "health") {
    if (value.authenticated !== true) fail();
    return { authenticated: true };
  }
  if (action === "namespace") {
    if (value.namespaceConfirmed !== true || value.ownershipAttribute !== "Keyword") fail();
    return { namespaceConfirmed: true, ownershipAttribute: "Keyword" };
  }
  if (["trigger", "pause", "unpause"].includes(action)) {
    if (value.confirmed !== true) fail();
    return { confirmed: true };
  }
  if (action === "observe") {
    if (value.scheduleOwned !== true || value.encryptedInput !== true || typeof value.paused !== "boolean"
      || !["completed", "deferred", "busy", "running", "waiting"].includes(value.status)) fail();
    const out = { scheduleOwned: true, encryptedInput: true, paused: value.paused, status: value.status };
    if (value.status === "waiting") return out;
    if (typeof value.runId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.runId)) fail();
    if (value.status === "running") return { ...out, runId: value.runId };
    if (!Number.isSafeInteger(value.completedAt) || value.completedAt < 1 || typeof value.current !== "boolean") fail();
    if (value.current && (value.status !== "completed" || value.paused)) fail();
    return { ...out, runId: value.runId, completedAt: value.completedAt, current: value.current };
  }
  fail();
}

/** Private scratch, regular files and exact owner/modes are checked after minting.
 * CA private keys never leave scratch. Only leaf keys and the public CA are copied.
 */
export async function prepareTemporalTls(scratch, runCommand = command) {
  const extensions = {
    ca: "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Zenith disposable acceptance CA\n[ca]\nbasicConstraints=critical,CA:true,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n",
    server: "[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=temporal\n[leaf]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=DNS:temporal,DNS:localhost\n",
    client: "[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=zenith-owned-worker\n[leaf]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\nsubjectAltName=DNS:zenith-worker.acceptance.invalid\n",
  };
  const file = name => path.join(scratch, name);
  const before = await lstat(scratch);
  if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== process.getuid?.() || (before.mode & 0o7777) !== 0o700) throw new Error("Private TLS custody is unavailable.");
  const library = await runCommand("openssl", ["version"], "private-tls-tool", { timeout: 5000 });
  const version = /^(OpenSSL 3\.\d+\.\d+[a-z]?|LibreSSL 3\.\d+\.\d+)(?: |$)/.exec(library.out.trim())?.[1];
  if (!version) throw new Error("Disposable TLS requires a supported OpenSSL or LibreSSL tool.");
  for (const [name, content] of Object.entries(extensions)) await writeFile(file(`${name}.cnf`), content, { mode: 0o600, flag: "wx" });
  for (const ca of ["ca", "rogue-ca"]) {
    await runCommand("openssl", ["req", "-new", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
      "-config", file("ca.cnf"), "-keyout", file(`${ca}.key`), "-out", file(`${ca}.crt`)], "private-tls-ca", { timeout: 30_000 });
  }
  for (const leaf of ["server", "client", "rogue-client"]) {
    const config = leaf === "server" ? "server" : "client";
    const ca = leaf === "rogue-client" ? "rogue-ca" : "ca";
    await runCommand("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-config", file(`${config}.cnf`),
      "-keyout", file(`${leaf}.key`), "-out", file(`${leaf}.csr`)], "private-tls-leaf", { timeout: 30_000 });
    await runCommand("openssl", ["x509", "-req", "-sha256", "-days", "2", "-in", file(`${leaf}.csr`), "-CA", file(`${ca}.crt`),
      "-CAkey", file(`${ca}.key`), "-set_serial", `0x${randomBytes(16).toString("hex")}`, "-extfile", file(`${config}.cnf`),
      "-extensions", "leaf", "-out", file(`${leaf}.crt`)], "private-tls-sign", { timeout: 30_000 });
  }
  const secretFiles = ["ca.key", "rogue-ca.key", "server.key", "client.key", "rogue-client.key"];
  const captured = new Map();
  for (const name of ["ca.crt", "rogue-ca.crt", "server.crt", "client.crt", "rogue-client.crt", ...secretFiles]) {
    const target = file(name), observed = await lstat(target);
    if (!observed.isFile() || observed.isSymbolicLink() || observed.uid !== before.uid || observed.size < 1 || observed.size > 64 * 1024) throw new Error("Private TLS custody is unavailable.");
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== observed.dev || opened.ino !== observed.ino || opened.uid !== before.uid || opened.size !== observed.size) throw new Error("Private TLS custody changed.");
      await handle.chmod(0o600);
      const baseline = await handle.stat(), buffer = Buffer.alloc(64 * 1024 + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = await handle.read(buffer, size, buffer.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      const final = await lstat(target), after = await handle.stat();
      if (size !== baseline.size || size > 64 * 1024 || !final.isFile() || final.dev !== opened.dev || final.ino !== opened.ino
        || final.uid !== before.uid || (final.mode & 0o7777) !== 0o600 || after.size !== baseline.size
        || after.mtimeMs !== baseline.mtimeMs || after.ctimeMs !== baseline.ctimeMs || final.ctimeMs !== after.ctimeMs) throw new Error("Private TLS custody changed.");
      captured.set(name, buffer.subarray(0, size));
    } finally { await handle.close(); }
  }
  for (const [leaf, purpose, ca] of [["server", "sslserver", "ca"], ["server", "sslclient", "ca"], ["client", "sslclient", "ca"], ["rogue-client", "sslclient", "rogue-ca"]]) {
    await runCommand("openssl", ["verify", "-purpose", purpose, "-CAfile", file(`${ca}.crt`), file(`${leaf}.crt`)], "private-tls-verify");
  }
  const ca = new X509Certificate(captured.get("ca.crt"));
  for (const leaf of ["server", "client", "rogue-client"]) {
    const cert = new X509Certificate(captured.get(`${leaf}.crt`));
    if (!cert.checkPrivateKey(createPrivateKey(captured.get(`${leaf}.key`)))) throw new Error("Private TLS leaf identity is unconfirmed.");
    if (leaf !== "rogue-client" && !cert.verify(ca.publicKey)) throw new Error("Private TLS leaf trust is unconfirmed.");
    if (leaf === "rogue-client" && cert.verify(ca.publicKey)) throw new Error("Negative TLS leaf trust is invalid.");
    if (leaf === "server" && cert.checkHost("temporal") !== "temporal") throw new Error("Private TLS server SAN is unconfirmed.");
  }
  const after = await lstat(scratch);
  if (after.dev !== before.dev || after.ino !== before.ino || after.uid !== before.uid || (after.mode & 0o7777) !== 0o700) throw new Error("Private TLS custody changed.");
  return { secretFiles, custodyVerified: true,
    library: version,
    certificateSha256: Object.fromEntries(["ca", "server", "client", "rogue-client"].map(leaf =>
      [leaf, createHash("sha256").update(captured.get(`${leaf}.crt`)).digest("hex")])) };
}

/** Image-local SDK control only. No host SDK, mounted source, replacement
 * activity or ready flag. The read codec matches the committed production v1
 * wire format and cannot encode/start an operation. Worker readiness separately
 * applies the canonical raw schedule guard to this same owned namespace.
 */
export function packagedTemporalControlSource() {
  return String.raw`
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { createDecipheriv, createHash, hkdfSync } from 'node:crypto';
import { Client, Connection, ScheduleOverlapPolicy } from '@temporalio/client';
import { SearchAttributeType, defineSearchAttributeKey } from '@temporalio/common';
import { temporal } from '@temporalio/proto';
const action=process.argv[1], auth=process.argv[2]??'client';
let connection;
try {
 if(!['health','namespace','observe','trigger','pause','unpause'].includes(action)||!['client','none','rogue','wrong-server-name'].includes(auth)
  ||process.env.NODE_ENV!=='production'||process.env.ZENITH_TEMPORAL_ADDRESS!=='temporal:7233'
  ||!/^zenith-pkg-(arm64|amd64)-[a-f0-9]{12}$/.test(process.env.ZENITH_TEMPORAL_NAMESPACE??''))throw new Error();
 const file=name=>{
  const parent=lstatSync('/var/run/zenith-temporal'),path='/var/run/zenith-temporal/'+name,stat=lstatSync(path);
  if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==10001||(parent.mode&0o7777)!==0o700
   ||!stat.isFile()||stat.isSymbolicLink()||stat.uid!==10001||(stat.mode&0o7777)!==0o600||stat.size<1||stat.size>65536)throw new Error();
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const opened=fstatSync(fd),b=Buffer.alloc(65537);let n=0;
   if(!opened.isFile()||opened.dev!==stat.dev||opened.ino!==stat.ino||opened.size!==stat.size||opened.uid!==10001)throw new Error();
   while(n<b.length){const k=readSync(fd,b,n,b.length-n,null);if(!k)break;n+=k;}
   const after=fstatSync(fd),final=lstatSync(path);
   if(n!==opened.size||n>65536||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs
    ||final.dev!==opened.dev||final.ino!==opened.ino||final.ctimeMs!==after.ctimeMs)throw new Error();
   return b.subarray(0,n);
  }finally{closeSync(fd);}
 };
 const tls={serverRootCACertificate:file('ca.crt'),serverNameOverride:auth==='wrong-server-name'?'unowned.acceptance.invalid':'temporal',
  ...(auth==='none'?{}:{clientCertPair:{crt:file(auth==='rogue'?'rogue-client.crt':'client.crt'),key:file(auth==='rogue'?'rogue-client.key':'client.key')}})};
 connection=await Connection.connect({address:'temporal:7233',tls,connectTimeout:5000});
 const namespace=process.env.ZENITH_TEMPORAL_NAMESPACE;
 const rpc=fn=>connection.withDeadline(Date.now()+10000,fn);
 if(!/^[a-f0-9]{64}$/.test(process.env.ZENITH_SECRET_KEY??''))throw new Error();
 const key=Buffer.from(hkdfSync('sha256',Buffer.from(process.env.ZENITH_SECRET_KEY,'hex'),Buffer.alloc(0),'zenith.temporal.payload.v1',32));
 const id=createHash('sha256').update(key).digest('hex').slice(0,32),encoding='binary/zenith.temporal.v1';
 const codec={encode:async()=>{throw new Error();},decode:async payloads=>payloads.map(p=>{
  if(Buffer.from(p.metadata?.encoding??[]).toString()!==encoding||Buffer.from(p.metadata?.['zenith.temporal.key-id']??[]).toString()!==id
   ||Object.keys(p.metadata).length!==2||!p.data||p.data.length<28)throw new Error();
  const b=Buffer.from(p.data),d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));
  d.setAAD(Buffer.from(JSON.stringify([encoding,id])));d.setAuthTag(b.subarray(12,28));
  return temporal.api.common.v1.Payload.decode(Buffer.concat([d.update(b.subarray(28)),d.final()]));
 })};
 const client=new Client({connection,namespace,dataConverter:{payloadCodecs:[codec]}});
 const schedule=client.schedule.getHandle('zenith-reconcile-sweep-v1');
 let result;
 if(action==='health'){await rpc(()=>connection.workflowService.getSystemInfo({}));result={authenticated:true};}
 if(action==='namespace'){
  await rpc(()=>connection.workflowService.registerNamespace({namespace,workflowExecutionRetentionPeriod:{seconds:86400},description:'Owned packaged acceptance.'}));
  const n=await rpc(()=>connection.workflowService.describeNamespace({namespace}));
  if(n.namespaceInfo?.name!==namespace||n.namespaceInfo.state!==1)throw new Error();
  const attrs=await rpc(()=>connection.operatorService.listSearchAttributes({namespace}));
  if(attrs.customAttributes?.ZenithScheduleOwner!==undefined)throw new Error();
  await rpc(()=>connection.operatorService.addSearchAttributes({namespace,searchAttributes:{ZenithScheduleOwner:2}}));
  const confirmed=await rpc(()=>connection.operatorService.listSearchAttributes({namespace}));
  if(confirmed.customAttributes?.ZenithScheduleOwner!==2)throw new Error();
  result={namespaceConfirmed:true,ownershipAttribute:'Keyword'};
 }
 if(['trigger','pause','unpause'].includes(action)){
  const current=await rpc(()=>schedule.describe());
  if(current.scheduleId!=='zenith-reconcile-sweep-v1'||current.memo?.zenithOwner!=='zenith')throw new Error();
  if(action==='trigger')await rpc(()=>schedule.trigger(ScheduleOverlapPolicy.SKIP));
  if(action==='pause')await rpc(()=>schedule.pause('Owned packaged acceptance operator hold.'));
  if(action==='unpause')await rpc(()=>schedule.unpause('Owned packaged acceptance operator resume.'));
  result={confirmed:true};
 }
 if(action==='observe'){
  const s=await rpc(()=>schedule.describe()),owner=defineSearchAttributeKey('ZenithScheduleOwner',SearchAttributeType.KEYWORD);
  const expected={contract:'zenith.reconcile-sweep.v1',maxEnvironments:25,environmentConcurrency:1};
  const config=createHash('sha256').update(JSON.stringify([expected.contract,25,1])).digest('hex');
  if(s.scheduleId!=='zenith-reconcile-sweep-v1'||s.memo?.zenithOwner!=='zenith'||s.memo.zenithContract!==expected.contract||s.memo.zenithConfigSha256!==config
   ||s.typedSearchAttributes.get(owner)!==expected.contract||s.action.type!=='startWorkflow'||s.action.workflowType!=='reconcileSweepWorkflow'
   ||s.action.workflowId!=='zenith-reconcile-sweep-v1'||s.action.taskQueue!=='zenith-execution'||JSON.stringify(s.action.args)!==JSON.stringify([expected])
   ||s.spec.intervals?.length!==1||s.spec.intervals[0].every!==60000||s.policies.overlap!==ScheduleOverlapPolicy.SKIP||s.policies.pauseOnFailure)throw new Error();
  const raw=s.raw.schedule?.action?.startWorkflow?.input?.payloads;
  if(raw?.length!==1||Buffer.from(raw[0].metadata?.encoding??[]).toString()!==encoding)throw new Error();
  result={scheduleOwned:true,encryptedInput:true,paused:s.state.paused,status:'waiting'};
  const entry=s.info.recentActions.at(-1);
  if(entry){
   if(entry.action.type!=='startWorkflow'||!entry.action.workflow.workflowId.startsWith('zenith-reconcile-sweep-v1-'))throw new Error();
   const runId=entry.action.workflow.firstExecutionRunId;
   const h=client.workflow.getHandle(entry.action.workflow.workflowId,runId,{followRuns:false});
   const d=await client.workflow.withDeadline(Date.now()+10000,()=>h.describe());
   if(d.runId!==runId||d.type!=='reconcileSweepWorkflow'||d.taskQueue!=='zenith-execution')throw new Error();
   if(d.status.name==='RUNNING')result={...result,status:'running',runId};
   else{
    if(d.status.name!=='COMPLETED'||!d.closeTime)throw new Error();
    const p=await client.workflow.withDeadline(Date.now()+10000,()=>h.result()),age=Date.now()-d.closeTime.getTime();
    if(!['completed','busy','deferred'].includes(p.status))throw new Error();
    const c=p.counts;
    if(p.status==='completed'&&!['claimed','reconciled','nothingToReconcile','busy','ineligible','failed','deferred','nudged','driftDetected','driftCleared','openFindings','unreadNodes','repairsProposed','repairsStarted','repairsAwaitingApproval','repairsDenied','ms'].every(k=>Number.isSafeInteger(c?.[k])&&c[k]>=0))throw new Error();
    if(p.status==='deferred'&&!['prerequisites_unavailable','pass_unconfirmed'].includes(p.reason))throw new Error();
    const current=p.status==='completed'&&['failed','deferred','unreadNodes','busy'].every(k=>c?.[k]===0)&&c.saturated===false&&c.timedOut===false&&age>=-5000&&age<=180000&&!s.state.paused;
    result={...result,status:p.status,runId,completedAt:d.closeTime.getTime(),current};
   }
  }
 }
 console.log('PACKAGED_TEMPORAL '+JSON.stringify(result));
} catch { console.error('Packaged authenticated Temporal control failed.'); process.exitCode=1; }
finally { try { await connection?.close(); } catch { console.error('Packaged Temporal connection close failed.'); process.exitCode=1; } }
`;
}

export async function packagedWorkerMain(args = process.argv.slice(2), env = process.env) {
  const { platform } = parsePackagedArgs(args, env);
  const runId = `zenith-pkg-${platform.split("/")[1]}-${randomBytes(6).toString("hex")}`;
  const scratch = await createPrivateScratch(process.cwd(), os.tmpdir(), `${runId}-`);
  const network = `${runId}-network`;
  const containers = [];
  const containerRoles = new Map();
  const volumes = [`${runId}-postgres-data`, `${runId}-temporal-config`, `${runId}-worker-data`, `${runId}-worker-tls`];
  const image = `${runId}:acceptance`;
  const created = { containers: [], volumes: [], network: false };
  let interrupted = false;
  let cleaning = false;
  const stop = () => {
    interrupted = true;
    if (cleaning) return;
    for (const child of activeChildren) child.kill("SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const deadline = setTimeout(stop, 3_600_000);
  let phase = "prerequisites";
  const evidence = { runId, platform, startedAt: new Date().toISOString(), status: "failed", checks: {}, limitations: [
    "One disposable Temporal Server with actual frontend/internode mTLS; not Temporal Cloud, HA or namespace ACL acceptance.",
    "Certificate authentication is required; the isolated server has no namespace authorizer and does not prove production namespace permission limits.",
    "Product metadata uses an isolated file-store fixture; platform control store is real Postgres.",
    "No deployed cloud resources: reconcile observes an empty environment; read operation safely refuses a missing target.",
    "No cloud writes or browser approval are performed; plan files are retention sentinels, not executable plans.",
    "Shutdown check drains an idle packaged worker; in-flight cloud activity drain remains outside this harness.",
    "Source binding captures the live context before and after build; transient changes are not excluded by an immutable snapshot.",
  ] };
  const docker = async (args, name, options) => {
    if (interrupted && name !== "cleanup") throw new Error("Packaged acceptance interrupted.");
    if (["run", "create"].includes(args[0])) created.containers.push(args[args.indexOf("--name") + 1]);
    if (args[0] === "volume" && args[1] === "create") created.volumes.push(args.at(-1));
    if (args[0] === "network" && args[1] === "create") created.network = true;
    const result = await command("docker", args, name, options);
    return result;
  };
  const nameContainer = (kind) => { const name = `${runId}-${kind}`; containers.push(name); if (diagnosticRoles.has(kind)) containerRoles.set(name, kind); return name; };
  const pg = nameContainer("postgres");
  const temporal = nameContainer("temporal");
  const worker = nameContainer("worker");
  const envFile = path.join(scratch, "worker.env");
  const tlsSecrets = [];
  const password = randomBytes(32).toString("hex");
  const secret = randomBytes(32).toString("hex");
  const artifactKey = randomBytes(32).toString("hex");
  const jwk = { ...generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }), alg: "EdDSA", kid: runId };
  const url = `postgresql://postgres:${password}@postgres:5432/zenith_packaged`;
  const workerEnv = { ZENITH_PACKAGED_ACCEPTANCE: "1", ZENITH_STORE: "file", ZENITH_DATA: "/var/lib/zenith",
    ZENITH_WORKER_PLAN_DIR: "/var/lib/zenith/platform-plans", ZENITH_PLATFORM_DB: "postgres", ZENITH_PLATFORM_DB_URL: url,
    ZENITH_SECRET_KEY: secret, ZENITH_PLAN_ARTIFACT_KEY: artifactKey, ZENITH_CONTROL_SIGNING_JWK: JSON.stringify(jwk), ZENITH_TEMPORAL_ADDRESS: "temporal:7233",
    NODE_ENV: "production", ZENITH_TEMPORAL_NAMESPACE: runId, ZENITH_WORKER_TASK_QUEUE: PACKAGED_TASK_QUEUE, ZENITH_WORKER_IDENTITY: runId,
    ZENITH_TEMPORAL_TLS: "true", ZENITH_TEMPORAL_TLS_CA_FILE: `${WORKER_TLS_DIR}/ca.crt`,
    ZENITH_TEMPORAL_TLS_CERT_FILE: `${WORKER_TLS_DIR}/client.crt`, ZENITH_TEMPORAL_TLS_KEY_FILE: `${WORKER_TLS_DIR}/client.key`,
    ZENITH_TEMPORAL_TLS_SERVER_NAME: "temporal", ZENITH_WORKER_RECONCILE_SCHEDULE_MODE: "provision",
    ZENITH_WORKER_RECONCILE_MAX_ENVIRONMENTS: "25", ZENITH_WORKER_RECONCILE_CONCURRENCY: "1",
    ZENITH_WORKER_HEALTH_LOG_INTERVAL_MS: "0", ZENITH_WORKER_LOG_LEVEL: "WARN", ZENITH_WORKER_SHUTDOWN_GRACE_MS: "15000",
    ZENITH_WORKER_MAX_CONCURRENT_ACTIVITIES: "1", ZENITH_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS: "2" };
  const encodeEnv = (values) => Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
  const isolated = (name, file = envFile) => ["run", "--name", name, "--platform", platform, "--network", network,
    "--label", `io.zenith.acceptance.run=${runId}`,
    "--memory", "1536m", "--cpus", "1.5", "--pids-limit", "256",
    "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m,mode=1777",
    "--mount", `type=volume,source=${volumes[2]},target=/var/lib/zenith`,
    "--mount", `type=volume,source=${volumes[3]},target=${WORKER_TLS_DIR},readonly`, "--env-file", file];
  const client = async (action) => {
    const name = nameContainer(`client-${action}-${randomBytes(2).toString("hex")}`);
    return clientEvidence(action, await docker([...isolated(name), "--entrypoint", "node", image, "dist/acceptance/packaged-client.cjs", action], `client-${action}`));
  };
  const control = async (action, auth = "client", allowFailure = false) => {
    const name = nameContainer(`control-${action}-${randomBytes(2).toString("hex")}`);
    const result = await docker([...isolated(name), "--entrypoint", "node", image,
      "--input-type=module", "-e", packagedTemporalControlSource(), action, auth], `temporal-control-${action}`,
      { timeout: 30_000, allowFailure });
    if (allowFailure) return result;
    const lines = result.out.split("\n").filter(line => line.startsWith("PACKAGED_TEMPORAL "));
    if (lines.length !== 1) throw new Error("Packaged Temporal control evidence is unconfirmed.");
    return sanitizeTemporalControlEvidence(action, JSON.parse(lines[0].slice("PACKAGED_TEMPORAL ".length)));
  };
  const waitTemporalHealth = async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await control("health", "client", true);
      if (result.code === 0) {
        const lines=result.out.split("\n").filter(line=>line.startsWith("PACKAGED_TEMPORAL "));
        if(lines.length!==1)throw new Error("Authenticated Temporal health is unconfirmed.");
        return sanitizeTemporalControlEvidence("health",JSON.parse(lines[0].slice("PACKAGED_TEMPORAL ".length)));
      }
      if (result.code !== 1) throw new Error("Disposable Temporal ended without a normal transport refusal.");
      await delay(1000);
    }
    throw new Error("Disposable authenticated Temporal did not become ready.");
  };
  const observation = async (expected = "completed", previousRunId) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      const observed = await control("observe");
      if (!observed.paused && observed.status === expected && observed.runId !== previousRunId
        && (expected !== "completed" || observed.current === true)) return observed;
      await delay(1000);
    }
    throw new Error("A fresh owned schedule result was not confirmed.");
  };
  const probe = async (endpoint) => {
    const code = `fetch('http://127.0.0.1:9464/${endpoint}',{signal:AbortSignal.timeout(4000)}).then(async r=>console.log(JSON.stringify({status:r.status,body:await r.json()})),()=>process.exit(1))`;
    const result = await docker(["exec", worker, "node", "-e", code], `probe-${endpoint}`, { timeout: 10_000, allowFailure: true });
    return result.code === 0 ? JSON.parse(result.out) : undefined;
  };
  const failureDiagnostics = async () => {
    // Capture before removing containers. Inspect only the exact expected names
    // and verify their labels before reading any logs or state.
    const states = {};
    const logs = [];
    for (const [name, role] of containerRoles) {
      if (!created.containers.includes(name)) continue;
      try {
        const lookup = await command("docker", ["inspect", "--format", '{{json .}}', name], "failure-state", { timeout: 5000, allowFailure: true });
        if (lookup.code !== 0) continue;
        const inspect = JSON.parse(lookup.out);
        if (inspect.Config?.Labels?.["io.zenith.acceptance.run"] !== runId) continue;
        const state = sanitizeContainerState(inspect.State);
        if (state) states[role] = state;
        const captured = await command("docker", ["logs", "--tail", "200", name], "failure-logs", { timeout: 5000, allowFailure: true });
        if (captured.code !== 0) continue;
        const text = captured.out + captured.err;
        if (role === "worker") evidence.workerFailureCategory = workerFailureCategory(text);
        if (refusalKinds.includes(role)) (evidence.refusalFailureCategories ??= {})[role] = workerFailureCategory(text);
        logs.push({ role, text: redactDiagnosticLogs(text, [password, secret, artifactKey, jwk.d ?? "", url, JSON.stringify(jwk), ...tlsSecrets]) });
      } catch { /* Diagnostics cannot obstruct owned-resource cleanup. */ }
    }
    evidence.failureContainers = states;
    evidence.privateDiagnostics = { captured: false, files: 0 };
    if (!logs.length) return;
    let directory;
    try {
      directory = await createPrivateScratch(process.cwd(), os.tmpdir(), `${runId}-diagnostics-`);
      for (const { role, text } of logs) await writeFile(path.join(directory, `${role}.log`), text, { mode: 0o600, flag: "wx" });
      // Neither private paths nor log contents enter public evidence. Root can
      // locate these files using the unique trusted run id in its temp folder.
      evidence.privateDiagnostics = { captured: true, files: logs.length };
    } catch {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  };
  try {
    await writeFile(envFile, encodeEnv(workerEnv), { mode: 0o600 });
    const pgEnv = path.join(scratch, "postgres.env");
    await writeFile(pgEnv, encodeEnv({ POSTGRES_PASSWORD: password, POSTGRES_DB: "zenith_packaged" }), { mode: 0o600 });
    const free = await statfs(scratch);
    if (free.bavail * free.bsize < 12 * 1024 ** 3) throw new Error("Packaged acceptance requires twelve GiB free before launch.");
    const context = (await docker(["context", "show"], "local-build-context")).out.trim();
    const endpoint = JSON.parse((await docker(["context", "inspect", context], "local-build-endpoint")).out)[0];
    if (!endpoint.Endpoints?.docker?.Host?.startsWith("unix:///")) throw new Error("Packaged acceptance requires its local Docker context.");
    const builder = assertOwnedPackagedBuilder(env.BUILDX_BUILDER,
      (await docker(["buildx", "inspect", env.BUILDX_BUILDER ?? "invalid"], "owned-builder")).out, context);
    evidence.storage = { externallyManagedBuilder: true, builder, minimumFreeGiBBeforeLaunch: 12, monitorWarningFreeGiB: 8,
      baselineAndBuilderCacheCleanupReceiptRequired: true };
    evidence.commit = (await command("git", ["rev-parse", "HEAD"], "source-revision")).out.trim();
    evidence.dirty = (await command("git", ["status", "--porcelain"], "source-state")).out.trim().length > 0;
    evidence.sourceInputSha256 = await packagedSourceDigest(process.cwd());
    evidence.acceptanceHarnessSha256 = createHash("sha256").update(await readFile("scripts/acceptance/packaged-worker.mjs")).digest("hex");
    const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
    evidence.lockedDependencies = sanitizeLockedDependencies(lock);
    const engine = JSON.parse((await docker(["version", "--format", "{{json .Server}}"], "docker-engine")).out);
    const hostArch = engine.Arch;
    if (!["amd64", "arm64"].includes(hostArch)) throw new Error("Docker server architecture could not be established.");
    evidence.environment = { dockerServerOS: engine.Os === "linux" ? "linux" : "other", dockerServerArch: hostArch,
      dockerVersion: version(engine.Version) ? engine.Version : "unavailable", emulated: platform !== `linux/${hostArch}` };
    phase = "fresh-image-build";
    console.log(`Packaged worker acceptance: building ${platform} from fresh dependency installs.`);
    await docker(["build", "--builder", builder, "--pull", "--no-cache", "--target", "acceptance", "--platform", platform, "--label", `org.opencontainers.image.revision=${evidence.commit}`,
      "--label", `io.zenith.acceptance.run=${runId}`,
      "--label", `io.zenith.acceptance.source-sha256=${evidence.sourceInputSha256}`, "-f", "docker/worker.Dockerfile", "-t", image, "."], phase, { timeout: 1_800_000 });
    assertPackagedSourceUnchanged(evidence.sourceInputSha256, await packagedSourceDigest(process.cwd()));
    evidence.sourceBinding = { inventoryComplete: true, unchangedAcrossBuild: true, immutableBuildContext: false };
    const inspect = JSON.parse((await docker(["image", "inspect", image], "image-inspect")).out)[0];
    if (`${inspect.Os}/${inspect.Architecture}` !== platform || inspect.Config.User !== "zenith"
      || JSON.stringify(inspect.Config.Entrypoint) !== JSON.stringify(["/usr/bin/tini", "--", "node", "dist/execution/worker.cjs"])) throw new Error("Packaged image identity/entrypoint differs from the required worker.");
    evidence.image = { id: sanitizeImageId(inspect.Id), platform, user: "zenith", entrypoint: ["/usr/bin/tini", "--", "node", "dist/execution/worker.cjs"], acceptanceDerivative: true };
    phase = "isolated-services";
    await docker(["network", "create", "--internal", "--label", `io.zenith.acceptance.run=${runId}`, network], phase);
    for (const volume of volumes) {
      const before = await docker(["volume", "ls", "-q", "--filter", `name=^${volume}$`], "fresh-volume");
      if (before.out.trim()) throw new Error("Packaged acceptance refuses existing volumes.");
      await docker(["volume", "create", "--label", `io.zenith.acceptance.run=${runId}`, volume], phase);
      const actual = JSON.parse((await docker(["volume", "inspect", volume], "owned-volume")).out)[0];
      if (actual.Name !== volume || actual.Labels?.["io.zenith.acceptance.run"] !== runId
        || actual.Driver !== "local" || Object.keys(actual.Options ?? {}).length) throw new Error("Owned volume custody is unconfirmed.");
    }
    phase = "private-temporal-tls";
    const tls = await prepareTemporalTls(scratch);
    for (const name of tls.secretFiles) tlsSecrets.push(await readFile(path.join(scratch, name), "utf8"));
    const template = await readFile(TEMPORAL_CONFIG_TEMPLATE, "utf8");
    evidence.temporalConfigSha256 = createHash("sha256").update(template).digest("hex");
    await writeFile(path.join(scratch, "server.yaml"), renderTemporalServerConfiguration(template, password), { mode: 0o600, flag: "wx" });
    const installer = nameContainer("private-credential-installer");
    // Only new labeled named volumes are writable. CHOWN is limited to this
    // short-lived initializer; the server/worker have no added capabilities.
    await docker(["run", "-d", "--name", installer, "--platform", platform, "--network", "none", "--user", "0:0",
      "--label", `io.zenith.acceptance.run=${runId}`, "--read-only", "--cap-drop=ALL", "--cap-add=CHOWN",
      "--security-opt=no-new-privileges", "--memory", "128m", "--pids-limit", "32",
      "--mount", `type=volume,source=${volumes[1]},target=/server`, "--mount", `type=volume,source=${volumes[3]},target=/client`,
      "--entrypoint", "node", image, "-e", "const f=require('node:fs');for(const p of ['/server','/client'])if(f.readdirSync(p).length)process.exit(1);setInterval(()=>{},1000)"], phase);
    for (const name of ["ca.crt", "server.crt", "server.key", "server.yaml"]) await docker(["cp", path.join(scratch, name), `${installer}:/server/${name}`], "private-server-copy");
    for (const name of ["ca.crt", "client.crt", "client.key", "rogue-client.crt", "rogue-client.key"]) await docker(["cp", path.join(scratch, name), `${installer}:/client/${name}`], "private-client-copy");
    await docker(["exec", installer, "node", "-e", `const f=require('node:fs');for(const [p,uid,expected]of [['/server',1000,['ca.crt','server.crt','server.key','server.yaml']],['/client',10001,['ca.crt','client.crt','client.key','rogue-client.crt','rogue-client.key']]]){if(JSON.stringify(f.readdirSync(p).sort())!==JSON.stringify(expected.sort()))throw Error();for(const n of expected){const q=p+'/'+n,s=f.lstatSync(q);if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||s.size<1||s.size>65536)throw Error();f.chownSync(q,uid,uid);f.chmodSync(q,0o600);const a=f.lstatSync(q);if(a.ino!==s.ino||a.uid!==uid||(a.mode&0o777)!==0o600)throw Error();}f.chownSync(p,uid,uid);f.chmodSync(p,0o700);}console.log('CUSTODY_VERIFIED')`], "private-volume-custody");
    await docker(["stop", "--time", "5", installer], "private-installer-stop");
    evidence.checks.tlsCustody = { generatedPrivateFiles: true, caPrivateKeysHostOnly: true, privateDirectories: true, privateLeafFiles: true,
      workerUid: 10001, serverUid: 1000, hostMounts: false, certificateSha256: tls.certificateSha256 };
    evidence.checks.tlsCustody.library = tls.library;
    await docker(["run", "-d", "--name", pg, "--network", network, "--network-alias", "postgres", "--platform", platform,
      "--label", `io.zenith.acceptance.run=${runId}`,
      "--memory", "256m", "--cpus", "0.5", "--pids-limit", "128",
      "--mount", `type=volume,source=${volumes[0]},target=/var/lib/postgresql/data`,
      "--env-file", pgEnv, POSTGRES_IMAGE], phase);
    for (let attempt = 0; ; attempt++) {
      const result = await docker(["exec", pg, "pg_isready", "-U", "postgres", "-d", "zenith_packaged"], "postgres-ready", { allowFailure: true });
      if (result.code === 0) break;
      if (attempt >= 60) throw new Error("Disposable Postgres did not become ready.");
      await delay(1000);
    }
    phase = "owned-temporal-schema";
    for (const [database, schema] of [["temporal", "temporal"], ["temporal_visibility", "visibility"]]) {
      const sqlEnv = path.join(scratch, `${database}.env`);
      await writeFile(sqlEnv, encodeEnv({ SQL_HOST: "postgres", SQL_PORT: "5432", SQL_USER: "postgres", SQL_PASSWORD: password,
        SQL_DATABASE: database, SQL_PLUGIN: "postgres12" }), { mode: 0o600, flag: "wx" });
      for (const args of [["create-database"], ["setup-schema", "--version", "0.0"], ["update-schema", "--schema-dir", `/etc/temporal/schema/postgresql/v12/${schema}/versioned`]]) {
        const name = nameContainer(`schema-${database}-${randomBytes(2).toString("hex")}`);
        await docker(["run", "--name", name, "--platform", platform, "--network", network,
          "--label", `io.zenith.acceptance.run=${runId}`, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
          "--memory", "128m", "--cpus", "0.5", "--pids-limit", "64", "--env-file", sqlEnv,
          "--entrypoint", "temporal-sql-tool", TEMPORAL_ADMIN_IMAGE, ...args], phase);
      }
    }
    phase = "authenticated-temporal-server";
    await docker(["run", "-d", "--name", temporal, "--network", network, "--network-alias", "temporal", "--platform", platform,
      "--label", `io.zenith.acceptance.run=${runId}`, "--memory", "1024m", "--cpus", "1", "--pids-limit", "256",
      "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
      "--mount", `type=volume,source=${volumes[1]},target=${TEMPORAL_CONFIG_DIR},readonly`,
      "--entrypoint", "temporal-server", TEMPORAL_IMAGE, "--config-file", `${TEMPORAL_CONFIG_DIR}/server.yaml`, "start"], phase);
    phase = "temporal-ready";
    await waitTemporalHealth();
    for (const auth of ["none", "rogue", "wrong-server-name"]) {
      const result = await control("health", auth, true);
      if (result.code !== 1 || result.out.includes("PACKAGED_TEMPORAL ")) throw new Error("Temporal client authentication refusal was not confirmed.");
    }
    await control("health");
    evidence.checks.temporalAuthentication = { validClientAccepted: true, noClientRefused: true, untrustedClientRefused: true, incorrectServerNameRefused: true, realServerTls: true, namespaceAuthorizationProven: false };
    evidence.checks.namespace = await control("namespace");
    evidence.dependencies = { postgres: POSTGRES_IMAGE, temporal: TEMPORAL_IMAGE, temporalAdmin: TEMPORAL_ADMIN_IMAGE,
      temporalPersistence: "owned PostgreSQL history and visibility databases", hostPortsPublished: false, networkInternal: true };
    phase = "startup-refusals";
    for (const [kind, changed] of [["missing-schema", {}], ["invalid-secret", { ZENITH_SECRET_KEY: "invalid" }], ["invalid-signer", { ZENITH_CONTROL_SIGNING_JWK: "invalid" }],
      ["plaintext-temporal", { ZENITH_TEMPORAL_TLS: "false", ZENITH_TEMPORAL_TLS_CA_FILE: "", ZENITH_TEMPORAL_TLS_CERT_FILE: "", ZENITH_TEMPORAL_TLS_KEY_FILE: "", ZENITH_TEMPORAL_TLS_SERVER_NAME: "" }],
      ["missing-namespace", { ZENITH_TEMPORAL_NAMESPACE: "" }], ["wrong-queue", { ZENITH_WORKER_TASK_QUEUE: "unsupported-sweep-route" }]]) {
      const file = path.join(scratch, `${kind}.env`);
      await writeFile(file, encodeEnv({ ...workerEnv, ...changed }), { mode: 0o600 });
      const name = nameContainer(kind);
      await docker([...isolated(name, file), "-d", image], `refusal-launch-${kind}`, { timeout: REFUSAL_LAUNCH_TIMEOUT_MS });
      const state = await waitForRefusalExit(name, runId, docker, { phase: `refusal-exit-${kind}` });
      const result = await docker(["logs", "--tail", "200", name], `refusal-logs-${kind}`, { timeout: 10_000 });
      const category = refusalFailureCategory(kind, result.out + result.err, [password, secret, artifactKey, jwk.d, url, ...tlsSecrets]);
      evidence.checks[kind] = "refused-without-secret-output";
      (evidence.refusalExits ??= {})[kind] = { ...state, failureCategory: category, launchBudgetMs: REFUSAL_LAUNCH_TIMEOUT_MS, exitBudgetMs: REFUSAL_EXIT_TIMEOUT_MS };
    }
    phase = "prepare-real-stores";
    evidence.preparation = await client("prepare");
    phase = "actual-worker-entrypoint";
    await docker([...isolated(worker), "-d", image], phase);
    for (let attempt = 0; ; attempt++) {
      if ((await probe("readyz"))?.status === 200) break;
      if (attempt >= 90) throw new Error("Packaged worker did not become ready.");
      await delay(1000);
    }
    const ready = sanitizePackagedReadiness((await probe("readyz"))?.body);
    if ((await probe("healthz")).body.alive !== true) throw new Error("Worker liveness evidence is incomplete.");
    evidence.checks.readiness = ready;
    evidence.checks.ownedSchedule = await observation();
    evidence.checks.liveness = { alive: true };
    phase = "real-temporal-operations";
    evidence.operations = await client("operations");
    phase = "filesystem-plan-maintenance";
    evidence.assets = await client("assets");
    if (evidence.assets.arch !== (platform === "linux/amd64" ? "x64" : "arm64")
      || dependencies.some((name) => evidence.assets.dependencies[name] !== evidence.lockedDependencies[name])
      || evidence.assets.policySha256 !== JSON.parse(await readFile("policy/dist/manifest.json", "utf8")).wasmSha256) {
      throw new Error("Packaged architecture, locked versions or verified policy assets differ from the source.");
    }
    phase = "bounded-sql-prerequisite-outage";
    const prior = await control("observe");
    const blocking = docker(["exec", "--env", `PGAPPNAME=${runId}-schema-outage`, pg, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "zenith_packaged", "-c",
      "begin; set local statement_timeout='30s'; lock table platform.schema_migrations in access exclusive mode; select pg_sleep(20); rollback;"], "owned-schema-blocker", { timeout: 35_000 });
    // Retain and await this real blocker even if a later proof fails.
    void blocking.catch(() => undefined);
    try {
      for (let attempt = 0; ; attempt++) {
        const probe = await docker(["exec", pg, "psql", "-X", "-tA", "-U", "postgres", "-d", "zenith_packaged", "-c",
          `select count(*) from pg_stat_activity where application_name='${runId}-schema-outage' and wait_event='PgSleep'`], "owned-schema-held");
        if (probe.out.trim() === "1") break;
        if (attempt >= 20) throw new Error("Owned schema blocker was not confirmed.");
        await delay(100);
      }
      await control("trigger");
      let waited;
      for (let attempt = 0; attempt < 30; attempt++) {
        // Every docker exec opens a fresh PostgreSQL observer connection.
        const probe = await docker(["exec", pg, "psql", "-X", "-tA", "-U", "postgres", "-d", "zenith_packaged", "-c", schemaOutageObserverSql(runId)], "actual-schema-waiter");
        const rows = JSON.parse(probe.out.trim());
        if (rows.length) { waited = sanitizePgWaiterEvidence(rows); break; }
        await delay(100);
      }
      if (!waited) throw new Error("Actual schema waiter was not confirmed.");
      const deferred = await observation("deferred", prior.runId);
      const unavailable = await probe("readyz");
      if (deferred.current || unavailable?.status !== 503 || unavailable.body?.checks?.reconciliation !== "unavailable") throw new Error("Deferred observation incorrectly retained readiness.");
      evidence.checks.sqlPrerequisiteOutage = { actualPgWaiter: waited, deferred, readinessRevoked: true, automaticPause: false };
    } finally { await blocking; }
    await control("trigger");
    evidence.checks.sqlPrerequisiteRecovery = await observation("completed", evidence.checks.sqlPrerequisiteOutage.deferred.runId);
    for (const dependency of [pg, temporal]) {
      phase = dependency === pg ? "store-readiness-outage" : "temporal-readiness-outage";
      await docker(["pause", dependency], phase);
      try {
        await delay(2500);
        const ready = await probe("readyz");
        const live = await probe("healthz");
        if (ready?.status !== 503 || live?.status !== 200) throw new Error("Dependency outage did not revoke readiness while retaining liveness.");
        evidence.checks[phase] = { readyStatus: ready.status, liveStatus: live.status };
      } finally { await docker(["unpause", dependency], "restore-dependency"); }
      const previous = await control("observe");
      await control("trigger");
      const recovered = await observation("completed", previous.runId);
      for (let attempt = 0; (await probe("readyz"))?.status !== 200; attempt++) {
        if (attempt >= 30) throw new Error("Worker readiness did not recover.");
        await delay(1000);
      }
      evidence.checks[`${phase}-recovery`] = { freshRunConfirmed: true, ...recovered };
    }
    phase = "temporal-durable-restart";
    const beforeRestart = await control("observe");
    await docker(["restart", "--time", "15", temporal], phase, { timeout: 45_000 });
    await waitTemporalHealth();
    const retainedSchedule = await control("observe");
    if (!retainedSchedule.scheduleOwned || retainedSchedule.paused) throw new Error("Durable schedule did not survive the owned server restart.");
    await control("trigger");
    evidence.checks.temporalRestart = { sameOwnedDatabase: true, ownedScheduleRetained: true,
      freshPass: await observation("completed", beforeRestart.runId) };
    phase = "operator-pause";
    await control("pause");
    const paused = await control("observe");
    const held = await probe("readyz");
    if (!paused.paused || held?.status !== 503 || held.body?.checks?.reconciliation !== "unavailable"
      || (await probe("healthz"))?.status !== 200) throw new Error("Operator pause did not revoke reconciliation readiness.");
    await control("unpause");
    await control("trigger");
    evidence.checks.operatorPause = { readinessRevoked: true, livenessRetained: true,
      resumedOnlyByOperator: true, freshPass: await observation("completed", paused.runId) };
    phase = "graceful-shutdown";
    await docker(["stop", "--time", "40", worker], phase);
    const stopped = JSON.parse((await docker(["inspect", worker], "stopped-worker")).out)[0];
    const logs = await docker(["logs", worker], "worker-lifecycle-logs");
    if (stopped.State.ExitCode !== 0 || !logs.out.includes("shutdown requested: draining") || !logs.out.includes("execution worker stopped")) throw new Error("Packaged worker did not drain cleanly on SIGTERM.");
    for (const value of [password, secret, artifactKey, jwk.d, url, ...tlsSecrets]) if ((logs.out + logs.err).includes(value)) throw new Error("Worker lifecycle logs contained secret material.");
    evidence.checks.shutdown = { signal: "SIGTERM", exitCode: stopped.State.ExitCode, drained: true, inFlightActivity: false };
    evidence.status = "passed";
  } catch (error) {
    evidence.failurePhase = phase;
    if (error instanceof PackagedCommandError) evidence.failureCommand = { ...error.diagnostic,
      ...(refusalCommandPhases.has(error.phase) ? { phase: error.phase } : {}) };
    await failureDiagnostics();
    // No raw docker/driver error, database URL, private env or SQL payload.
    console.error(`Packaged worker acceptance failed during ${phase}.`);
  } finally {
    cleaning = true;
    clearTimeout(deadline);
    const cleanup = [];
    const removeOwned = async (kind, name, role) => {
      const result = await cleanupOwnedResource(kind, name, runId, docker);
      cleanup.push({ kind, role, ...result });
    };
    for (const name of created.containers.reverse()) await removeOwned("container", name, containerRoles.get(name) ?? "acceptance-client");
    for (const volume of created.volumes) await removeOwned("volume", volume, volume === volumes[0] ? "postgres-data" : volume === volumes[1] ? "temporal-config" : volume === volumes[3] ? "worker-tls" : "worker-data");
    if (created.network) await removeOwned("network", network, "isolated-network");
    await removeOwned("image", image, "acceptance-image");
    await rm(scratch, { recursive: true, force: true });
    evidence.cleanup = { privateFilesRemoved: true, allCreatedResourcesRemoved: cleanup.every((resource) => resource.removed), resources: cleanup };
    if (!evidence.cleanup.allCreatedResourcesRemoved || interrupted) evidence.status = "failed";
    evidence.finishedAt = new Date().toISOString();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    console.log(JSON.stringify(evidence));
  }
  return evidence.status === "passed" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  packagedWorkerMain().then((code) => { process.exitCode = code; }).catch(() => {
    console.error("Packaged worker acceptance requires explicit opt-in and a supported platform."); process.exitCode = 1;
  });
}
