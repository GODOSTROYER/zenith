/**
 * Fresh-image packaged worker acceptance. Node built-ins only: no host SDKs,
 * host node_modules, mounted source or replacement activities. Opt in with
 * ZENITH_PACKAGED_WORKER_ACCEPTANCE=1 and --platform linux/amd64|linux/arm64.
 * All service/container/volume names are unique; no host ports are published.
 */
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, lstat, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const POSTGRES_IMAGE = "postgres:16.15-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685";
// Official temporalio/cli v1.9.1 multiarch index, verified 2026-10-02.
export const TEMPORAL_IMAGE = "temporalio/temporal:1.9.1@sha256:ad4c82c97bd12b417d1ea942610dbcd511afb250c4d5ed26c694009533df447e";
// The pinned image creates /home/temporal for its UID1000 user. A volume at a
// nonexistent /var/lib/temporal would instead be initialized root-owned.
export const TEMPORAL_DATA_DIR = "/home/temporal";
const workerFailureCategories = new Set(["module-load", "configuration", "health-listener", "platform-store", "platform-composition", "policy-assets", "plan-directory", "activity-composition", "temporal-runtime", "workflow-bundle", "temporal-connect", "temporal-worker", "worker-lifecycle", "worker-run", "resource-close"]);
const refusalKinds = ["missing-schema", "invalid-secret", "invalid-signer"];
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

export async function packagedWorkerMain(args = process.argv.slice(2), env = process.env) {
  const { platform } = parsePackagedArgs(args, env);
  const runId = `zenith-pkg-${platform.split("/")[1]}-${randomBytes(6).toString("hex")}`;
  const scratch = await createPrivateScratch(process.cwd(), os.tmpdir(), `${runId}-`);
  const network = `${runId}-network`;
  const containers = [];
  const containerRoles = new Map();
  const volumes = [`${runId}-postgres-data`, `${runId}-temporal-data`, `${runId}-worker-data`];
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
    "Temporal CLI development server, not Temporal Cloud or production Temporal topology.",
    "Product metadata uses an isolated file-store fixture; platform control store is real Postgres.",
    "No deployed cloud resources: reconcile observes an empty environment; read operation safely refuses a missing target.",
    "No cloud writes or browser approval are performed; plan files are retention sentinels, not executable plans.",
    "Shutdown check drains an idle packaged worker; in-flight cloud activity drain remains outside this harness.",
    "Source binding captures the live context before and after build; transient changes are not excluded by an immutable snapshot.",
  ] };
  const docker = async (args, name, options) => {
    if (interrupted && name !== "cleanup") throw new Error("Packaged acceptance interrupted.");
    if (args[0] === "run") created.containers.push(args[args.indexOf("--name") + 1]);
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
  const password = randomBytes(32).toString("hex");
  const secret = randomBytes(32).toString("hex");
  const artifactKey = randomBytes(32).toString("hex");
  const jwk = { ...generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }), alg: "EdDSA", kid: runId };
  const url = `postgresql://postgres:${password}@postgres:5432/zenith_packaged`;
  const workerEnv = { ZENITH_PACKAGED_ACCEPTANCE: "1", ZENITH_STORE: "file", ZENITH_DATA: "/var/lib/zenith",
    ZENITH_WORKER_PLAN_DIR: "/var/lib/zenith/platform-plans", ZENITH_PLATFORM_DB: "postgres", ZENITH_PLATFORM_DB_URL: url,
    ZENITH_SECRET_KEY: secret, ZENITH_PLAN_ARTIFACT_KEY: artifactKey, ZENITH_CONTROL_SIGNING_JWK: JSON.stringify(jwk), ZENITH_TEMPORAL_ADDRESS: "temporal:7233",
    ZENITH_TEMPORAL_NAMESPACE: "default", ZENITH_WORKER_TASK_QUEUE: runId, ZENITH_WORKER_IDENTITY: runId,
    ZENITH_WORKER_HEALTH_LOG_INTERVAL_MS: "0", ZENITH_WORKER_LOG_LEVEL: "WARN", ZENITH_WORKER_SHUTDOWN_GRACE_MS: "15000",
    ZENITH_WORKER_MAX_CONCURRENT_ACTIVITIES: "1", ZENITH_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS: "2" };
  const encodeEnv = (values) => Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
  const isolated = (name, file = envFile) => ["run", "--name", name, "--platform", platform, "--network", network,
    "--label", `io.zenith.acceptance.run=${runId}`,
    "--memory", "1536m", "--cpus", "1.5", "--pids-limit", "256",
    "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m,mode=1777",
    "--mount", `type=volume,source=${volumes[2]},target=/var/lib/zenith`, "--env-file", file];
  const client = async (action) => {
    const name = nameContainer(`client-${action}-${randomBytes(2).toString("hex")}`);
    return clientEvidence(action, await docker([...isolated(name), "--entrypoint", "node", image, "dist/acceptance/packaged-client.cjs", action], `client-${action}`));
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
        logs.push({ role, text: redactDiagnosticLogs(text, [password, secret, artifactKey, jwk.d ?? "", url, JSON.stringify(jwk)]) });
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
    await docker(["build", "--pull", "--no-cache", "--target", "acceptance", "--platform", platform, "--label", `org.opencontainers.image.revision=${evidence.commit}`,
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
    for (const volume of volumes) await docker(["volume", "create", "--label", `io.zenith.acceptance.run=${runId}`, volume], phase);
    await docker(["run", "-d", "--name", pg, "--network", network, "--network-alias", "postgres", "--platform", platform,
      "--label", `io.zenith.acceptance.run=${runId}`,
      "--memory", "256m", "--cpus", "0.5", "--pids-limit", "128",
      "--mount", `type=volume,source=${volumes[0]},target=/var/lib/postgresql/data`,
      "--env-file", pgEnv, POSTGRES_IMAGE], phase);
    await docker(["run", "-d", "--name", temporal, "--network", network, "--network-alias", "temporal", "--platform", platform,
      "--label", `io.zenith.acceptance.run=${runId}`,
      "--memory", "1024m", "--cpus", "1", "--pids-limit", "256",
      "--mount", `type=volume,source=${volumes[1]},target=${TEMPORAL_DATA_DIR}`, TEMPORAL_IMAGE,
      "server", "start-dev", "--headless", "--ip", "0.0.0.0", "--port", "7233", "--db-filename", `${TEMPORAL_DATA_DIR}/acceptance.db`], phase);
    for (let attempt = 0; ; attempt++) {
      const result = await docker(["exec", pg, "pg_isready", "-U", "postgres", "-d", "zenith_packaged"], "postgres-ready", { allowFailure: true });
      if (result.code === 0) break;
      if (attempt >= 60) throw new Error("Disposable Postgres did not become ready.");
      await delay(1000);
    }
    phase = "temporal-ready";
    for (let attempt = 0; ; attempt++) {
      const result = await docker(["exec", temporal, "temporal", "operator", "cluster", "health", "--address", "127.0.0.1:7233"], phase, { timeout: 10_000, allowFailure: true });
      if (result.code === 0) break;
      if (attempt >= 60) throw new Error("Disposable Temporal did not become ready.");
      await delay(1000);
    }
    evidence.dependencies = { postgres: POSTGRES_IMAGE, temporal: TEMPORAL_IMAGE, hostPortsPublished: false, networkInternal: true };
    phase = "startup-refusals";
    for (const [kind, changed] of [["missing-schema", {}], ["invalid-secret", { ZENITH_SECRET_KEY: "invalid" }], ["invalid-signer", { ZENITH_CONTROL_SIGNING_JWK: "invalid" }]]) {
      const file = path.join(scratch, `${kind}.env`);
      await writeFile(file, encodeEnv({ ...workerEnv, ...changed }), { mode: 0o600 });
      const name = nameContainer(kind);
      await docker([...isolated(name, file), "-d", image], `refusal-launch-${kind}`, { timeout: REFUSAL_LAUNCH_TIMEOUT_MS });
      const state = await waitForRefusalExit(name, runId, docker, { phase: `refusal-exit-${kind}` });
      const result = await docker(["logs", "--tail", "200", name], `refusal-logs-${kind}`, { timeout: 10_000 });
      const category = refusalFailureCategory(kind, result.out + result.err, [password, secret, artifactKey, jwk.d, url]);
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
    const ready = (await probe("readyz")).body;
    if (ready.ready !== true || ["temporal", "store", "policy", "drivers"].some((key) => ready.checks?.[key] !== "ok")) throw new Error("Worker readiness evidence is incomplete.");
    if ((await probe("healthz")).body.alive !== true) throw new Error("Worker liveness evidence is incomplete.");
    evidence.checks.readiness = { ready: true, checks: { temporal: "ok", store: "ok", policy: "ok", drivers: "ok" } };
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
      for (let attempt = 0; (await probe("readyz"))?.status !== 200; attempt++) {
        if (attempt >= 30) throw new Error("Worker readiness did not recover.");
        await delay(1000);
      }
    }
    phase = "graceful-shutdown";
    await docker(["stop", "--time", "40", worker], phase);
    const stopped = JSON.parse((await docker(["inspect", worker], "stopped-worker")).out)[0];
    const logs = await docker(["logs", worker], "worker-lifecycle-logs");
    if (stopped.State.ExitCode !== 0 || !logs.out.includes("shutdown requested: draining") || !logs.out.includes("execution worker stopped")) throw new Error("Packaged worker did not drain cleanly on SIGTERM.");
    for (const value of [password, secret, artifactKey, jwk.d, url]) if ((logs.out + logs.err).includes(value)) throw new Error("Worker lifecycle logs contained secret material.");
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
    for (const volume of created.volumes) await removeOwned("volume", volume, volume === volumes[0] ? "postgres-data" : volume === volumes[1] ? "temporal-data" : "worker-data");
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
