/** Native Linux gate. Untrusted Go output never reaches stdout or published evidence. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { linuxGuestManifest, linuxSystemdManifest } from "./gate-manifest.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const key = (packageName, test) => `${packageName}\0${test}`;
/** @typedef {{status: number|null, signal: string|null, observed: boolean}} Observation */
/** @typedef {{package: string, test: string, id: string}} RequiredCase */
/**
 * Report data supplies observations only. Requirements and exported identifiers
 * come exclusively from the committed manifest. Parents are not leaf cases.
 * @param {string} raw @param {Observation} observation
 * @param {{requiredCases: RequiredCase[], requiredPackages: string[], noTestPackages: string[], allowedSkips: {package:string,test:string}[]}} contract
 */
export function validateGoEvents(raw, observation, contract) {
  const problems = new Set();
  const issue = (code) => problems.add(code);
  if (!observation || observation.observed !== true || observation.status !== 0 || observation.signal !== null) issue("process-exit");
  const packages = new Map();
  const tests = new Map();
  const actions = new Set(["start", "run", "pause", "cont", "output", "pass", "fail", "skip", "build-output", "build-fail"]);
  const approvedPackages = new Set([...contract.requiredPackages, ...contract.noTestPackages]);
  const allowedSkips = new Set(contract.allowedSkips.map((item) => key(item.package, item.test)));
  const required = new Set(contract.requiredCases.map((item) => key(item.package, item.test)));
  if (required.size !== contract.requiredCases.length || required.size === 0) issue("contract");
  if (typeof raw !== "string" || raw.length === 0 || Buffer.byteLength(raw) > 128 * 1024 * 1024 || !raw.endsWith("\n")) issue("stream");
  else for (const line of raw.slice(0, -1).split("\n")) {
    let event;
    try { event = JSON.parse(line); } catch { issue("malformed"); continue; }
    // Go interleaves BuildEvents (ImportPath, not Package) with TestEvents.
    // Build output is inert: it cannot establish a package or test lifecycle.
    if (event && typeof event === "object" && !Array.isArray(event)
      && ["build-output", "build-fail"].includes(event.Action)) {
      if (Object.keys(event).some((name) => !["ImportPath", "Action", "Output"].includes(name))
        || typeof event.ImportPath !== "string" || event.ImportPath.length === 0 || event.ImportPath.length > 2048
        || !/^[^\s\x00-\x1f\x7f]+(?: \[[^\s\x00-\x1f\x7f]+\])?$/.test(event.ImportPath)
        || (event.Action === "build-output" ? typeof event.Output !== "string" : event.Output !== undefined && typeof event.Output !== "string")) {
        issue("malformed"); continue;
      }
      if (event.Action === "build-fail") issue("build");
      continue;
    }
    if (!event || typeof event !== "object" || Array.isArray(event) || !actions.has(event.Action)
      || typeof event.Package !== "string" || !approvedPackages.has(event.Package)
      || (event.Test !== undefined && (typeof event.Test !== "string" || !/^Test[A-Za-z0-9_]+(?:\/[^\s\x00-\x1f]{1,256})*$/.test(event.Test) || event.Test.length > 2048))
      || (event.Output !== undefined && typeof event.Output !== "string")
      || (event.Elapsed !== undefined && (typeof event.Elapsed !== "number" || !Number.isFinite(event.Elapsed) || event.Elapsed < 0))) { issue("malformed"); continue; }
    let pkg = packages.get(event.Package);
    if (event.Action === "start") {
      if (event.Test !== undefined || pkg) { issue("duplicate"); continue; }
      pkg = { terminal: null }; packages.set(event.Package, pkg); continue;
    }
    if (!pkg || pkg.terminal !== null) { issue("lifecycle"); continue; }
    if (event.Test === undefined) {
      if (event.Action === "output") continue;
      if (!["pass", "fail", "skip"].includes(event.Action)) { issue("lifecycle"); continue; }
      pkg.terminal = event.Action;
      if (event.Action === "fail") issue("package-failed");
      if (event.Action === "skip" && !contract.noTestPackages.includes(event.Package)) issue("package-skipped");
      continue;
    }
    const id = key(event.Package, event.Test);
    let test = tests.get(id);
    if (event.Action === "run") {
      if (test) { issue("duplicate"); continue; }
      // A subtest cannot appear before its parent's run event or after its completion.
      if (event.Test.includes("/")) {
        const parent = tests.get(key(event.Package, event.Test.slice(0, event.Test.lastIndexOf("/"))));
        if (!parent || parent.terminal !== null) issue("lifecycle");
      }
      test = { package: event.Package, name: event.Test, terminal: null, paused: false }; tests.set(id, test); continue;
    }
    if (!test || test.terminal !== null) { issue("lifecycle"); continue; }
    if (event.Action === "output") continue;
    if (event.Action === "pause" || event.Action === "cont") {
      if (test.paused === (event.Action === "pause")) issue("lifecycle");
      test.paused = event.Action === "pause"; continue;
    }
    if (!["pass", "fail", "skip"].includes(event.Action) || test.paused) { issue("lifecycle"); continue; }
    if ([...tests.values()].some((child) => child.package === event.Package && child.name.startsWith(event.Test + "/") && child.terminal === null)) issue("incomplete");
    test.terminal = event.Action;
    if (event.Action === "fail") issue("case-failed");
    if (event.Action === "skip" && (required.has(id) || !allowedSkips.has(id))) issue("case-skipped");
  }
  for (const packageName of contract.requiredPackages) {
    const pkg = packages.get(packageName);
    if (!pkg || pkg.terminal !== "pass") issue("required-package");
    if (![...tests.values()].some((test) => test.package === packageName)) issue("zero-package");
  }
  for (const packageName of contract.noTestPackages) {
    const pkg = packages.get(packageName);
    if (!pkg || !["pass", "skip"].includes(pkg.terminal) || [...tests.values()].some((test) => test.package === packageName)) issue("no-test-package");
  }
  if (packages.size === 0 || tests.size === 0) issue("zero");
  for (const pkg of packages.values()) if (pkg.terminal === null) issue("incomplete");
  for (const test of tests.values()) if (test.terminal === null) issue("incomplete");
  const requiredResults = contract.requiredCases.map((item) => {
    const terminal = tests.get(key(item.package, item.test))?.terminal;
    if (terminal !== "pass") issue("required-case");
    return { id: item.id, status: terminal === "pass" ? "passed" : terminal === "skip" ? "skipped" : terminal === "fail" ? "failed" : "missing" };
  });
  const counts = { packages: packages.size, testEvents: tests.size, parents: 0, leaves: 0, passedLeaves: 0, failedLeaves: 0, skippedLeaves: 0 };
  for (const test of tests.values()) {
    if ([...tests.values()].some((child) => child.package === test.package && child.name.startsWith(test.name + "/"))) counts.parents++;
    else { counts.leaves++; if (test.terminal === "pass") counts.passedLeaves++; if (test.terminal === "fail") counts.failedLeaves++; if (test.terminal === "skip") counts.skippedLeaves++; }
  }
  return { verdict: problems.size === 0 ? "passed" : "failed", problems: [...problems].sort(), counts, required: requiredResults };
}

/** Hash source names+bytes privately; publish only the aggregate, never arbitrary paths. */
function sourceBinding(root) {
  const listing = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (listing.status !== 0 || listing.signal || commit.status !== 0 || commit.signal || !/^[a-f0-9]{40}\n$/.test(commit.stdout)) throw new Error("source");
  const files = [...new Set(listing.stdout.split("\0").filter(Boolean))].sort();
  if (files.length === 0 || files.length > 100000) throw new Error("source");
  const hash = createHash("sha256");
  for (const file of files) {
    const full = path.resolve(root, file);
    if (!full.startsWith(root + path.sep)) throw new Error("source");
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) hash.update(file + "\0symlink\0" + fs.readlinkSync(full) + "\0");
    else if (st.isFile()) hash.update(file + "\0" + String(st.mode & 0o777) + "\0" + digest(fs.readFileSync(full)) + "\0");
    else throw new Error("source");
  }
  return { commit: commit.stdout.trim(), sourceSha256: hash.digest("hex"), lockSha256: digest(fs.readFileSync(path.join(root, "package-lock.json"))) };
}
const ATTEMPT_ID = /^[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
/** Closed artifact path: never accept caller-selected filenames or a prior fixed receipt. */
export function attemptEvidencePath(attemptId) {
  if (typeof attemptId !== "string" || !ATTEMPT_ID.test(attemptId)) throw new Error("attempt");
  return `.data-ci-guest/attempt-${attemptId}/sanitized.json`;
}
function ownedDirectory(directory) {
  const st = fs.lstatSync(directory);
  if (!st.isDirectory() || st.isSymbolicLink() || !process.getuid || st.uid !== process.getuid() || (st.mode & 0o7777) !== 0o700) throw new Error("private-data");
}
/** Exclusive fresh directory creation rejects reuse even after an earlier publication failure. */
export function createAttemptDirectory(root, attemptId) {
  const directory = path.join(root, ".data-ci-guest");
  const attempt = path.dirname(path.join(root, attemptEvidencePath(attemptId)));
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  ownedDirectory(directory);
  fs.mkdirSync(attempt, { mode: 0o700 });
  ownedDirectory(attempt);
  return attempt;
}
function emitOutputs(values) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join(""));
}
function readAttemptFile(root, attemptId) {
  ownedDirectory(path.join(root, ".data-ci-guest"));
  const relative = attemptEvidencePath(attemptId);
  const file = path.join(root, relative);
  ownedDirectory(path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || st.nlink !== 1 || (st.mode & 0o7777) !== 0o600 || st.size === 0 || st.size > 16 * 1024 * 1024) throw new Error("evidence");
    const raw = fs.readFileSync(fd, "utf8");
    return { relative, raw, sha256: digest(raw), evidence: JSON.parse(raw) };
  } finally { fs.closeSync(fd); }
}
function attemptMatches(evidence, attemptId, exitCode) {
  return evidence && evidence.schemaVersion === 1 && evidence.lane === "linux-guest"
    && evidence.attempt && Object.keys(evidence.attempt).length === 2
    && evidence.attempt.id === attemptId && evidence.attempt.runnerExitCode === exitCode
    && evidence.verdict === (exitCode === 0 ? "passed" : "failed");
}
/**
 * Release outputs only after fresh exclusive write, atomic publication and readback.
 * Injectable I/O is for synthetic publication regressions, never native proof.
 * @param {string} root @param {string} attemptId @param {object} evidence
 * @param {{writeFile?: typeof fs.writeFileSync, rename?: typeof fs.renameSync, emit?: (values: Record<string,string>) => void}} [io]
 */
export function publishAttemptEvidence(root, attemptId, evidence, io = {}) {
  const relative = attemptEvidencePath(attemptId);
  const file = path.join(root, relative);
  ownedDirectory(path.join(root, ".data-ci-guest")); ownedDirectory(path.dirname(file));
  if (!attemptMatches(evidence, attemptId, evidence.attempt?.runnerExitCode) || ![0, 1].includes(evidence.attempt.runnerExitCode)) throw new Error("evidence");
  try { fs.lstatSync(file); throw new Error("existing-evidence"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const raw = JSON.stringify(evidence, null, 2) + "\n";
  const temporary = path.join(path.dirname(file), ".sanitized.tmp");
  (io.writeFile ?? fs.writeFileSync)(temporary, raw, { flag: "wx", mode: 0o600 });
  (io.rename ?? fs.renameSync)(temporary, file);
  const published = readAttemptFile(root, attemptId);
  if (published.sha256 !== digest(raw) || !attemptMatches(published.evidence, attemptId, evidence.attempt.runnerExitCode)) throw new Error("evidence");
  (io.emit ?? emitOutputs)({ attempt_id: attemptId, evidence_path: relative, evidence_sha256: published.sha256, runner_exit_code: String(evidence.attempt.runnerExitCode) });
  return { path: relative, sha256: published.sha256 };
}
/**
 * Artifact selection needs the wrapper's fresh expected ID and CI's observed
 * runner outcome. A receipt/output alone cannot supply current-step authority.
 * @param {string} root
 * @param {{expectedAttemptId?: string, attemptId?: string, evidencePath?: string, evidenceSha256?: string, runnerExitCode?: string, observedOutcome?: string}} values
 * @returns {string|null}
 */
export function selectCurrentAttempt(root, values) {
  try {
    if (!ATTEMPT_ID.test(values.expectedAttemptId ?? "") || values.attemptId !== values.expectedAttemptId
      || values.evidencePath !== attemptEvidencePath(values.expectedAttemptId)
      || !SHA256.test(values.evidenceSha256 ?? "")
      || !["success", "failure"].includes(values.observedOutcome ?? "")) return null;
    const exitCode = values.observedOutcome === "success" ? 0 : 1;
    if (values.runnerExitCode !== String(exitCode)) return null;
    const published = readAttemptFile(root, values.expectedAttemptId);
    if (published.sha256 !== values.evidenceSha256 || !attemptMatches(published.evidence, values.expectedAttemptId, exitCode)) return null;
    return published.relative;
  } catch { return null; }
}
/** Capture through exclusive 0600 files, wait for actual close, refuse stranded process groups. */
async function execute(command, cwd, env, directory, id) {
  const output = path.join(directory, `${id}.jsonl`);
  const errors = path.join(directory, `${id}.stderr`);
  const out = fs.openSync(output, "wx", 0o600); const err = fs.openSync(errors, "wx", 0o600);
  let child;
  let interrupted = false;
  let escalation;
  const terminate = () => {
    interrupted = true;
    if (child?.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already closed. */ }
      escalation = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already closed. */ } }, 5000); }
  };
  process.on("SIGINT", terminate); process.on("SIGTERM", terminate);
  let observation;
  try {
    observation = await new Promise((resolve) => {
      child = spawn(command[0], command.slice(1), { cwd, env, detached: true, stdio: ["ignore", out, err] });
      let launched = true;
      child.once("error", () => { launched = false; });
      child.once("close", (status, signal) => resolve({ status, signal, observed: launched }));
    });
  } finally {
    clearTimeout(escalation); process.removeListener("SIGINT", terminate); process.removeListener("SIGTERM", terminate); fs.closeSync(out); fs.closeSync(err);
  }
  let drained = true;
  if (child.pid) { try { process.kill(-child.pid, 0); drained = false; } catch (error) { drained = error.code === "ESRCH"; } }
  return { observation, interrupted, drained, output, errors };
}

/** Read only this invocation's completed fixture record; never select a private prior receipt. */
function packageFixtureEvidence(directory, attemptId, arch, contract) {
  const file = path.join(directory, "package-private", "terminal.record");
  ownedDirectory(path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let proof;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || st.nlink !== 1 || (st.mode & 0o7777) !== 0o600 || st.size === 0 || st.size > 1024 * 1024) throw new Error("package-fixture");
    proof = JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally { fs.closeSync(fd); }
  if (proof.schemaVersion !== 1 || proof.attempt !== attemptId || proof.imageIndex !== contract.imageIndex
    || proof.arch !== arch || proof.emulated !== false || proof.status !== "native_and_owned_cleanup_completed"
    || proof.cleanupComplete !== true || proof.delivery !== null
    || typeof proof.apparmorFixtureOverride !== "boolean"
    || JSON.stringify(proof.env) !== JSON.stringify(contract.env)
    || JSON.stringify(proof.nativeCases) !== JSON.stringify(contract.requiredCases.map((item) => item.test))
    || !/^sha256:[a-f0-9]{64}$/.test(proof.imageDigest ?? "")
    || ["goSourceSha256", "toolArchiveSha256", "nativeStateSha256", "afterNativeStateSha256"].some((name) => !SHA256.test(proof[name] ?? ""))) throw new Error("package-fixture");
  return { imageIndex: proof.imageIndex, imageDigest: proof.imageDigest, arch: proof.arch, emulated: false,
    apparmorFixtureOverride: proof.apparmorFixtureOverride, env: proof.env, cleanupComplete: true,
    goSourceSha256: proof.goSourceSha256, toolArchiveSha256: proof.toolArchiveSha256,
    nativeStateSha256: proof.nativeStateSha256, afterNativeStateSha256: proof.afterNativeStateSha256 };
}

export async function runNativeGate(root = process.cwd(), attemptId = randomBytes(16).toString("hex")) {
  root = path.resolve(root);
  const manifest = linuxGuestManifest();
  let directory;
  let active;
  let drained = true;
  let publication;
  const evidence = { schemaVersion: 1, lane: "linux-guest", attempt: { id: attemptId, runnerExitCode: 1 }, verdict: "failed", binding: null, tools: null, steps: [], problems: [] };
  try {
    directory = createAttemptDirectory(root, attemptId);
    if (process.platform !== "linux" || !process.getuid || process.getuid() === 0 || process.version !== "v22.23.3" || process.env.GOTOOLCHAIN !== "local") throw new Error("prerequisites");
    const runId = process.env.ZENITH_GUEST_FIXTURE_RUN_ID;
    if (!/^[a-f0-9]{32}$/.test(runId ?? "")) throw new Error("prerequisites");
    const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "GOCACHE", "GOPATH", "GOROOT", "CC"].filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
    Object.assign(env, manifest.env);
    // No ambient GOFLAGS, platform override, crash-child flag or secret-bearing test configuration.
    const helper = ["bash", path.join(root, "scripts/ci/guest-file-write-fixtures.sh"), "check", String(process.getuid()), String(process.getgid()), runId];
    const checked = await execute(helper, root, env, directory, "fixtures");
    drained = drained && checked.drained;
    if (checked.observation.status !== 0 || checked.observation.signal || !checked.observation.observed || !checked.drained || checked.interrupted) throw new Error("fixtures");
    const markerPath = "/opt/zenith-file-write-tests/.gate-active";
    fs.writeFileSync(markerPath, JSON.stringify({ runId, pid: process.pid }) + "\n", { flag: "wx", mode: 0o600 });
    active = markerPath;
    const tool = await execute(["go", "env", "-json", "GOVERSION", "GOOS", "GOARCH"], path.join(root, "go"), env, directory, "toolchain");
    drained = drained && tool.drained;
    if (tool.observation.status !== 0 || tool.observation.signal || !tool.observation.observed || !tool.drained || tool.interrupted) throw new Error("toolchain");
    const versions = JSON.parse(fs.readFileSync(tool.output, "utf8"));
    if (versions.GOVERSION !== "go1.27.1" || versions.GOOS !== "linux" || !["amd64", "arm64"].includes(versions.GOARCH)) throw new Error("toolchain");
    const before = sourceBinding(root);
    evidence.binding = { ...before, manifestSha256: digest(JSON.stringify(manifest)), fixtureReceiptSha256: digest(fs.readFileSync("/opt/zenith-file-write-mounts/.gate-receipt.json")) };
    evidence.tools = { node: "22.23.3", go: "1.27.1", GOOS: "linux", GOARCH: versions.GOARCH };
    for (const step of manifest.steps) {
      const stepEnv = { ...env, ...(step.id === "goldens" ? { ZENITH_UPDATE_MACHINE_GOLDENS: "1" } : {}) };
      const phaseCommand = step.command.map((argument) => ({ "{sourceRoot}": root, "{attemptId}": attemptId, "{nativeArch}": versions.GOARCH })[argument] ?? argument);
      const command = ["flock", "--shared", "--nonblock", "/opt/zenith-file-write-mounts/.gate-lease", ...phaseCommand];
      const result = await execute(command, step.id === "package-native" ? root : path.join(root, "go"), stepEnv, directory, step.id);
      drained = drained && result.drained;
      const raw = fs.readFileSync(result.output, "utf8");
      const contract = step.id === "goldens" ? { requiredCases: manifest.goldenCases, requiredPackages: [manifest.goldenCases[0].package], noTestPackages: [], allowedSkips: [] }
        : step.id === "package-native" ? manifest.packagePhase : { ...manifest, requiredCases: manifest.raceCases };
      const validation = ["race", "package-native", "goldens"].includes(step.id) ? validateGoEvents(raw, result.observation, contract) : {
        verdict: result.observation.observed && result.observation.status === 0 && result.observation.signal === null && raw.length === 0 ? "passed" : "failed",
      };
      const fixture = step.id === "package-native" && validation.verdict === "passed" && result.drained && !result.interrupted
        ? packageFixtureEvidence(directory, attemptId, versions.GOARCH, manifest.packagePhase) : null;
      evidence.steps.push({ ...(fixture ? { fixture } : {}), id: step.id, command: step.command, exitCode: Number.isSafeInteger(result.observation.status) ? result.observation.status : null, termination: result.observation.signal ? "signal" : result.observation.observed ? "exit" : "launch-failed", reportSha256: digest(raw), validation });
      if (validation.verdict !== "passed" || !result.drained || result.interrupted) throw new Error("execution");
    }
    const after = sourceBinding(root);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("source-changed");
    evidence.verdict = "passed";
  } catch { evidence.problems.push("gate-refused"); }
  finally {
    if (active && drained) { try { fs.unlinkSync(active); } catch { evidence.verdict = "failed"; evidence.problems.push("active-marker"); } }
    if (!drained) { evidence.verdict = "failed"; evidence.problems.push("children-not-drained"); }
    evidence.attempt.runnerExitCode = evidence.verdict === "passed" ? 0 : 1;
    if (directory) {
      try { publication = publishAttemptEvidence(root, attemptId, evidence); }
      catch { evidence.verdict = "failed"; evidence.problems.push("publication-unavailable"); }
    }
    console.log(`linux-guest: ${evidence.verdict}; ${evidence.steps.length} observed native steps; evidence=${publication?.path ?? "unavailable"}`);
  }
  return evidence.verdict === "passed" ? 0 : 1;
}
// Purpose-separated systemd phase: an execution pass remains pending until cleanup.
const SYSTEMD_ROOTS = ["/opt/zenith-file-write-tests", "/opt/zenith-file-write-mounts", "/opt/zenith-file-write-golden", "/opt/zenith-file-upload-golden"];
const SYSTEMD_RECEIPT = "/opt/zenith-file-write-mounts/.mach01-systemd-receipt.json";
const SYSTEMD_LEASE = "/opt/zenith-file-write-mounts/.mach01-systemd-lease";
const SYSTEMD_UNIT = "/run/systemd/system/zenith-mach01-configure-fixture.service";
const SYSTEMD_RULE = "/etc/polkit-1/rules.d/49-zenith-mach01-configure-fixture.rules";
/** @param {string} attemptId */
export function systemdEvidencePath(attemptId) {
  if (!ATTEMPT_ID.test(attemptId)) throw new Error("attempt");
  return `.data-ci-guest/systemd-attempt-${attemptId}/execution.json`;
}
/** @param {string} root @param {string} attemptId */
export function createSystemdAttemptDirectory(root, attemptId) {
  const base = path.join(root, ".data-ci-guest");
  try { fs.mkdirSync(base, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  ownedDirectory(base);
  const directory = path.dirname(path.join(root, systemdEvidencePath(attemptId)));
  fs.mkdirSync(directory, { mode: 0o700 }); ownedDirectory(directory); return directory;
}
function systemdRecord(root, attemptId, name, value) {
  const relative = path.join(path.dirname(systemdEvidencePath(attemptId)), name);
  ownedDirectory(path.join(root, ".data-ci-guest")); ownedDirectory(path.dirname(path.join(root, relative)));
  const file = path.join(root, relative); const raw = JSON.stringify(value, null, 2) + "\n";
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const dir = fs.openSync(path.dirname(file), fs.constants.O_RDONLY); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  const read = readSystemdRecord(root, attemptId, name);
  if (read.sha256 !== digest(raw)) throw new Error("publication");
  return read;
}
function readSystemdRecord(root, attemptId, name) {
  const relative = path.join(path.dirname(systemdEvidencePath(attemptId)), name);
  ownedDirectory(path.join(root, ".data-ci-guest")); ownedDirectory(path.dirname(path.join(root, relative)));
  const fd = fs.openSync(path.join(root, relative), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || st.nlink !== 1 || (st.mode & 0o7777) !== 0o600 || st.size === 0 || st.size > 1024 * 1024) throw new Error("evidence");
    const raw = fs.readFileSync(fd, "utf8"); return { relative, sha256: digest(raw), value: JSON.parse(raw) };
  } finally { fs.closeSync(fd); }
}
/** @param {string} raw @param {Observation} observation @param {ReturnType<typeof linuxSystemdManifest>["steps"][number]} phase */
export function validateSystemdGoEvents(raw, observation, phase) {
  const validation = validateGoEvents(raw, observation, phase); const issues = new Set(validation.problems);
  const expected = phase.requiredCases.map((item) => key(item.package, item.test)); const order = [];
  try {
    for (const line of raw.trimEnd().split("\n")) {
      const item = JSON.parse(line);
      if (item.Test !== undefined && !expected.includes(key(item.Package, item.Test))) issues.add("foreign-case");
      if (item.Action === "run") order.push(key(item.Package, item.Test));
    }
    if (JSON.stringify(order) !== JSON.stringify(expected)) issues.add("case-order");
  } catch { issues.add("malformed"); }
  if (validation.counts.testEvents !== expected.length || validation.counts.parents !== 1 || validation.counts.leaves !== expected.length - 1) issues.add("exact-events");
  return { ...validation, verdict: issues.size === 0 ? "passed" : "failed", problems: [...issues].sort() };
}
function currentSystemdValues() {
  return { expectedAttemptId: process.env.ZENITH_EXPECTED_SYSTEMD_ATTEMPT, attemptId: process.env.ZENITH_SYSTEMD_EVIDENCE_ATTEMPT,
    evidencePath: process.env.ZENITH_SYSTEMD_EVIDENCE_PATH, evidenceSha256: process.env.ZENITH_SYSTEMD_EVIDENCE_SHA256,
    runnerExitCode: process.env.ZENITH_SYSTEMD_RUNNER_EXIT_CODE, observedOutcome: process.env.ZENITH_SYSTEMD_RUNNER_OUTCOME };
}
function currentSystemdExecution(root, values) {
  if (!ATTEMPT_ID.test(values.expectedAttemptId ?? "") || values.attemptId !== values.expectedAttemptId
    || values.evidencePath !== systemdEvidencePath(values.expectedAttemptId) || !SHA256.test(values.evidenceSha256 ?? "")
    || !["success", "failure"].includes(values.observedOutcome ?? "")) throw new Error("attempt");
  const read = readSystemdRecord(root, values.expectedAttemptId, "execution.json"); const e = read.value;
  const exit = values.observedOutcome === "success" ? 0 : 1;
  if (values.runnerExitCode !== String(exit) || read.sha256 !== values.evidenceSha256 || e.schemaVersion !== 1 || e.lane !== "linux-systemd"
    || e.attempt?.id !== values.expectedAttemptId || Object.keys(e.attempt).length !== 2 || e.attempt?.runnerExitCode !== exit
    || e.verdict !== (exit === 0 ? "pending-cleanup" : "failed")) throw new Error("attempt");
  return read;
}
function systemdEnvironment(testProcess) {
  if (process.platform !== "linux" || process.version !== "v22.23.3" || !process.getuid || process.getuid() === 0 || process.getgid() === 0
    || process.env.GOTOOLCHAIN !== "local" || process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted"
    || process.env.RUNNER_OS !== "Linux" || fs.readFileSync("/proc/1/comm", "utf8").trim() !== "systemd") throw new Error("prerequisites");
  const status = fs.readFileSync("/proc/self/status", "utf8");
  for (const field of ["CapEff", "CapPrm", "CapInh", "CapAmb"]) if (!new RegExp(`^${field}:\\s+0{16}$`, "m").test(status)) throw new Error("capabilities");
  // Test children require NNP. The separate unprivileged cleanup wrapper needs
  // its existing fixed sudo permission; it never runs Node as root.
  if (!new RegExp(`^NoNewPrivs:\\s+${testProcess ? 1 : 0}$`, "m").test(status)) throw new Error("capabilities");
  const runId = process.env.ZENITH_GUEST_FIXTURE_RUN_ID;
  if (!ATTEMPT_ID.test(runId ?? "")) throw new Error("prerequisites");
  const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "GOCACHE", "GOPATH", "GOROOT", "CC", "GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "RUNNER_OS"].filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
  Object.assign(env, linuxSystemdManifest().env, { ZENITH_GUEST_FIXTURE_RUN_ID: runId });
  process.env.GIT_OPTIONAL_LOCKS = "0";
  return { env, runId, uid: process.getuid(), gid: process.getgid() };
}
function rootSystemdReceipt(root, identity, state, canonicalSha256) {
  const fd = fs.openSync(SYSTEMD_RECEIPT, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== 0 || st.nlink !== 1 || (st.mode & 0o7777) !== 0o444 || st.size === 0 || st.size > 65536) throw new Error("fixture");
    const raw = fs.readFileSync(fd); const p = JSON.parse(raw.toString("utf8"));
    if (JSON.stringify(Object.keys(p).sort()) !== JSON.stringify(["schemaVersion", "runId", "uid", "gid", "username", "state", "pending", "objects", "helperSha256", "canonicalReceiptSha256"].sort())
      || p.schemaVersion !== 1 || p.runId !== identity.runId || p.uid !== identity.uid || p.gid !== identity.gid || p.state !== state || p.pending !== null
      || !/^[a-z_][a-z0-9_-]{0,31}$/.test(p.username ?? "") || p.helperSha256 !== digest(fs.readFileSync(path.join(root, linuxSystemdManifest().helper)))
      || p.canonicalReceiptSha256 !== canonicalSha256 || JSON.stringify(Object.keys(p.objects).sort()) !== JSON.stringify([SYSTEMD_UNIT, SYSTEMD_RULE, SYSTEMD_LEASE].sort())) throw new Error("fixture");
    const named = fs.lstatSync(SYSTEMD_RECEIPT); const after = fs.fstatSync(fd);
    if (st.dev !== named.dev || st.ino !== named.ino || st.dev !== after.dev || st.ino !== after.ino || st.size !== after.size || st.mtimeMs !== after.mtimeMs) throw new Error("fixture");
    return digest(raw);
  } finally { fs.closeSync(fd); }
}
function systemdBinding(root, manifest, identity, canonicalSha256, receiptSha256) {
  return { ...sourceBinding(root), manifestSha256: digest(JSON.stringify(manifest)), helperSha256: digest(fs.readFileSync(path.join(root, manifest.helper))),
    runId: identity.runId, uid: identity.uid, gid: identity.gid, canonicalReceiptSha256: canonicalSha256, systemdReceiptSha256: receiptSha256 };
}
function unchangedSystemdSource(root, binding) {
  process.env.GIT_OPTIONAL_LOCKS = "0";
  const now = sourceBinding(root);
  return now.commit === binding?.commit && now.sourceSha256 === binding.sourceSha256 && now.lockSha256 === binding.lockSha256
    && binding.manifestSha256 === digest(JSON.stringify(linuxSystemdManifest())) && binding.helperSha256 === digest(fs.readFileSync(path.join(root, linuxSystemdManifest().helper)));
}
/** This entry point has no injected runner, commands, identity or fixture paths. */
export async function runSystemdGate(root = process.cwd(), attemptId = process.env.ZENITH_EXPECTED_SYSTEMD_ATTEMPT) {
  root = path.resolve(root); const manifest = linuxSystemdManifest(); let directory; let active; let drained = true; let publication;
  const evidence = { schemaVersion: 1, lane: "linux-systemd", attempt: { id: attemptId, runnerExitCode: 1 }, verdict: "failed", binding: null, tools: null, guestPrerequisite: null, steps: [], problems: [] };
  try {
    directory = createSystemdAttemptDirectory(root, attemptId); const identity = systemdEnvironment(true);
    const guestValues = { expectedAttemptId: process.env.ZENITH_EXPECTED_GUEST_ATTEMPT, attemptId: process.env.ZENITH_GUEST_EVIDENCE_ATTEMPT, evidencePath: process.env.ZENITH_GUEST_EVIDENCE_PATH, evidenceSha256: process.env.ZENITH_GUEST_EVIDENCE_SHA256, runnerExitCode: process.env.ZENITH_GUEST_RUNNER_EXIT_CODE, observedOutcome: process.env.ZENITH_GUEST_RUNNER_OUTCOME };
    if (guestValues.observedOutcome !== "success" || !selectCurrentAttempt(root, guestValues)) throw new Error("guest-prerequisite");
    const guest = readAttemptFile(root, guestValues.expectedAttemptId); const source = sourceBinding(root);
    if (guest.evidence.binding?.commit !== source.commit || guest.evidence.binding.sourceSha256 !== source.sourceSha256 || guest.evidence.binding.lockSha256 !== source.lockSha256
      || guest.evidence.binding.manifestSha256 !== digest(JSON.stringify(linuxGuestManifest())) || guest.evidence.steps.length !== linuxGuestManifest().steps.length
      || guest.evidence.steps.some((step) => step.validation?.verdict !== "passed" || step.exitCode !== 0 || step.termination !== "exit")) throw new Error("guest-prerequisite");
    const checked = await execute(["python3", path.join(root, manifest.helper), "check", String(identity.uid), String(identity.gid), identity.runId], root, identity.env, directory, "fixture-check");
    drained = checked.drained;
    if (checked.observation.status !== 0 || checked.observation.signal || !checked.observation.observed || !drained || checked.interrupted) throw new Error("fixture");
    const canonicalSha256 = digest(fs.readFileSync("/opt/zenith-file-write-mounts/.gate-receipt.json"));
    if (guest.evidence.binding.fixtureReceiptSha256 !== canonicalSha256) throw new Error("guest-prerequisite");
    const receiptSha256 = rootSystemdReceipt(root, identity, "ready", canonicalSha256);
    evidence.binding = systemdBinding(root, manifest, identity, canonicalSha256, receiptSha256); evidence.guestPrerequisite = { attemptId: guestValues.expectedAttemptId, sha256: guest.sha256 };
    const tool = await execute(["go", "env", "-json", "GOVERSION", "GOOS", "GOARCH"], path.join(root, "go"), identity.env, directory, "toolchain");
    drained = drained && tool.drained; const versions = JSON.parse(fs.readFileSync(tool.output, "utf8"));
    if (tool.observation.status !== 0 || tool.observation.signal || !tool.observation.observed || !drained || tool.interrupted || versions.GOVERSION !== "go1.27.1" || versions.GOOS !== "linux" || !["amd64", "arm64"].includes(versions.GOARCH)) throw new Error("toolchain");
    evidence.tools = { node: "22.23.3", go: "1.27.1", GOOS: "linux", GOARCH: versions.GOARCH, uid: identity.uid, gid: identity.gid, capabilities: "zero", noNewPrivs: true };
    const marker = "/opt/zenith-file-write-tests/.gate-active";
    fs.writeFileSync(marker, JSON.stringify({ runId: identity.runId, pid: process.pid }) + "\n", { flag: "wx", mode: 0o600 }); active = marker;
    for (const step of manifest.steps) {
      const command = ["flock", "--shared", "--nonblock", "/opt/zenith-file-write-mounts/.gate-lease", ...step.command];
      const result = await execute(command, path.join(root, "go"), identity.env, directory, step.id); drained = drained && result.drained;
      const raw = fs.readFileSync(result.output, "utf8"); const validation = validateSystemdGoEvents(raw, result.observation, step);
      evidence.steps.push({ id: step.id, command: step.command, exitCode: result.observation.status, termination: result.observation.signal ? "signal" : result.observation.observed ? "exit" : "launch-failed", drained: result.drained, interrupted: result.interrupted, reportSha256: digest(raw), validation });
      if (validation.verdict !== "passed" || !drained || result.interrupted) throw new Error("execution");
    }
    if (!unchangedSystemdSource(root, evidence.binding) || rootSystemdReceipt(root, identity, "ready", canonicalSha256) !== receiptSha256) throw new Error("source");
    evidence.verdict = "pending-cleanup";
  } catch { evidence.problems.push("systemd-refused"); }
  finally {
    if (active && drained) { try { fs.unlinkSync(active); } catch { evidence.verdict = "failed"; evidence.problems.push("active-marker"); } }
    if (!drained) { evidence.verdict = "failed"; evidence.problems.push("children-not-drained"); }
    evidence.attempt.runnerExitCode = evidence.verdict === "pending-cleanup" ? 0 : 1;
    if (directory) try {
      publication = systemdRecord(root, attemptId, "execution.json", evidence);
      emitOutputs({ attempt_id: attemptId, evidence_path: publication.relative, evidence_sha256: publication.sha256, runner_exit_code: String(evidence.attempt.runnerExitCode) });
    } catch { evidence.verdict = "failed"; }
    console.log(`linux-systemd: ${evidence.verdict}; ${evidence.steps.length} observed ordered phases; evidence=${publication?.relative ?? "unavailable"}`);
  }
  return evidence.verdict === "pending-cleanup" ? 0 : 1;
}
/** Root authority is solely the fixed sudo/helper invocation, after known child settlement. */
export async function cleanupSystemdGate(root = process.cwd(), values = currentSystemdValues()) {
  root = path.resolve(root);
  try {
    const execution = currentSystemdExecution(root, values); const e = execution.value; const identity = systemdEnvironment(false); const manifest = linuxSystemdManifest();
    if (!e.binding || e.binding.runId !== identity.runId || e.binding.uid !== identity.uid || e.binding.gid !== identity.gid || !unchangedSystemdSource(root, e.binding)
      || e.problems.includes("children-not-drained") || e.steps.some((step) => !step.drained || step.interrupted)
      || rootSystemdReceipt(root, identity, "ready", e.binding.canonicalReceiptSha256) !== e.binding.systemdReceiptSha256) throw new Error("cleanup");
    const directory = path.dirname(path.join(root, execution.relative));
    const result = await execute(["sudo", "--preserve-env=GITHUB_ACTIONS,RUNNER_ENVIRONMENT,RUNNER_OS", "--", "python3", path.join(root, manifest.helper), "cleanup", String(identity.uid), String(identity.gid), identity.runId], root, identity.env, directory, "cleanup");
    const raw = fs.readFileSync(result.output, "utf8"); let output; try { output = JSON.parse(raw); } catch { throw new Error("cleanup"); }
    if (result.observation.status !== 0 || result.observation.signal || !result.observation.observed || !result.drained || result.interrupted
      || JSON.stringify(output) !== JSON.stringify({ fixture: "mach01-systemd", action: "cleanup", status: "cleaned" })) throw new Error("cleanup");
    const receiptSha256 = rootSystemdReceipt(root, identity, "cleaned", e.binding.canonicalReceiptSha256);
    if (!unchangedSystemdSource(root, e.binding)) throw new Error("source");
    const record = systemdRecord(root, values.expectedAttemptId, "cleanup.json", { schemaVersion: 1, lane: "linux-systemd-cleanup", attemptId: values.expectedAttemptId, executionSha256: execution.sha256, binding: e.binding,
      command: manifest.cleanupCommand, status: "cleaned", exitCode: 0, termination: "exit", observed: true, drained: true, interrupted: false, reportSha256: digest(raw), receiptSha256,
      wrapper: { role: "fixed-fixture-cleanup-transport", uid: identity.uid, gid: identity.gid, capabilities: "E/P/I/A-zero", noNewPrivs: false } });
    emitOutputs({ cleanup_path: record.relative, cleanup_sha256: record.sha256 }); return 0;
  } catch { console.error("linux-systemd: owned cleanup refused; retained fixture requires inspection"); return 1; }
}
/** @param {string} root @param {ReturnType<typeof currentSystemdValues> & { cleanupPath?: string, cleanupSha256?: string, cleanupOutcome?: string, canonicalCleanupOutcome?: string }} values */
export function selectCurrentSystemdAttempt(root, values) {
  try {
    const read = currentSystemdExecution(root, values); const e = read.value; const manifest = linuxSystemdManifest();
    if (values.observedOutcome !== "success" || e.verdict !== "pending-cleanup" || e.problems.length !== 0 || !unchangedSystemdSource(root, e.binding)
      || e.binding.runId !== process.env.ZENITH_GUEST_FIXTURE_RUN_ID || !ATTEMPT_ID.test(e.binding.runId ?? "")
      || e.guestPrerequisite?.attemptId !== process.env.ZENITH_EXPECTED_GUEST_ATTEMPT || e.guestPrerequisite?.sha256 !== process.env.ZENITH_GUEST_EVIDENCE_SHA256
      || !ATTEMPT_ID.test(e.guestPrerequisite?.attemptId ?? "") || !SHA256.test(e.guestPrerequisite?.sha256 ?? "")
      || e.steps.length !== manifest.steps.length || JSON.stringify(e.steps.map((step) => [step.id, step.command])) !== JSON.stringify(manifest.steps.map((step) => [step.id, step.command]))
      || e.steps.some((step, index) => step.exitCode !== 0 || step.termination !== "exit" || !step.drained || step.interrupted || step.validation?.verdict !== "passed"
        || step.validation.problems.length !== 0 || step.validation.counts?.packages !== 1 || step.validation.counts.testEvents !== manifest.steps[index].requiredCases.length || step.validation.counts.parents !== 1
        || step.validation.counts.leaves !== manifest.steps[index].requiredCases.length - 1 || step.validation.counts.passedLeaves !== manifest.steps[index].requiredCases.length - 1
        || step.validation.counts.failedLeaves !== 0 || step.validation.counts.skippedLeaves !== 0
        || JSON.stringify(step.validation.required) !== JSON.stringify(manifest.steps[index].requiredCases.map((item) => ({ id: item.id, status: "passed" }))))
      || e.tools?.node !== "22.23.3" || e.tools.go !== "1.27.1" || e.tools.GOOS !== "linux" || !["amd64", "arm64"].includes(e.tools.GOARCH)
      || e.tools.uid !== e.binding.uid || e.tools.gid !== e.binding.gid || e.tools.uid !== process.getuid() || e.tools.gid !== process.getgid() || e.tools.uid <= 0 || e.tools.gid <= 0 || e.tools.capabilities !== "zero" || e.tools.noNewPrivs !== true
      || values.cleanupOutcome !== "success" || values.canonicalCleanupOutcome !== "success") return null;
    const cleanup = readSystemdRecord(root, values.expectedAttemptId, "cleanup.json"); const c = cleanup.value;
    if (cleanup.relative !== values.cleanupPath || cleanup.sha256 !== values.cleanupSha256 || c.schemaVersion !== 1 || c.lane !== "linux-systemd-cleanup"
      || c.attemptId !== values.expectedAttemptId || c.executionSha256 !== read.sha256 || JSON.stringify(c.binding) !== JSON.stringify(e.binding)
      || JSON.stringify(c.command) !== JSON.stringify(manifest.cleanupCommand) || c.status !== "cleaned" || c.exitCode !== 0 || c.termination !== "exit" || c.observed !== true
      || c.drained !== true || c.interrupted !== false || !SHA256.test(c.reportSha256 ?? "") || !SHA256.test(c.receiptSha256 ?? "")
      || JSON.stringify(c.wrapper) !== JSON.stringify({ role: "fixed-fixture-cleanup-transport", uid: e.binding.uid, gid: e.binding.gid, capabilities: "E/P/I/A-zero", noNewPrivs: false })) return null;
    for (const name of SYSTEMD_ROOTS) { try { fs.lstatSync(name); return null; } catch (error) { if (error.code !== "ENOENT") return null; } }
    const final = systemdRecord(root, values.expectedAttemptId, "final.json", { ...e, verdict: "passed", cleanup: { systemd: "cleaned", canonical: "absent", receiptSha256: c.receiptSha256, wrapper: c.wrapper } });
    return final.relative;
  } catch { return null; }
}

export async function main(args) {
  if (args.length === 1 && args[0] === "--run-systemd") return runSystemdGate();
  if (args.length === 1 && args[0] === "--cleanup-systemd") return cleanupSystemdGate();
  if (args.length === 1 && args[0] === "--select-current-systemd") {
    const selected = selectCurrentSystemdAttempt(process.cwd(), { ...currentSystemdValues(), cleanupPath: process.env.ZENITH_SYSTEMD_CLEANUP_PATH,
      cleanupSha256: process.env.ZENITH_SYSTEMD_CLEANUP_SHA256, cleanupOutcome: process.env.ZENITH_SYSTEMD_CLEANUP_OUTCOME, canonicalCleanupOutcome: process.env.ZENITH_CANONICAL_CLEANUP_OUTCOME });
    if (!selected) { console.error("linux-systemd evidence: current attempt or cleanup unavailable"); return 1; }
    try { emitOutputs({ evidence_path: selected }); } catch { return 1; } return 0;
  }
  if (args.length === 1 && args[0] === "--run") return runNativeGate(process.cwd(), process.env.ZENITH_GUEST_ATTEMPT_ID ?? randomBytes(16).toString("hex"));
  if (args.length === 1 && args[0] === "--select-current") {
    const selected = selectCurrentAttempt(process.cwd(), {
      expectedAttemptId: process.env.ZENITH_EXPECTED_GUEST_ATTEMPT,
      attemptId: process.env.ZENITH_GUEST_EVIDENCE_ATTEMPT,
      evidencePath: process.env.ZENITH_GUEST_EVIDENCE_PATH,
      evidenceSha256: process.env.ZENITH_GUEST_EVIDENCE_SHA256,
      runnerExitCode: process.env.ZENITH_GUEST_RUNNER_EXIT_CODE,
      observedOutcome: process.env.ZENITH_GUEST_RUNNER_OUTCOME,
    });
    if (!selected) { console.error("linux-guest evidence: current attempt unavailable or mismatched"); return 1; }
    try { emitOutputs({ evidence_path: selected }); }
    catch { console.error("linux-guest evidence: selection publication unavailable"); return 1; }
    console.log("linux-guest evidence: current attempt selected"); return 0;
  }
  console.error("usage: node scripts/ci/run-guest-file-write-gate.mjs <--run|--select-current>"); return 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
