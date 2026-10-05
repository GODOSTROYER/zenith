/** Native Linux gate. Untrusted Go output never reaches stdout or published evidence. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { linuxGuestManifest } from "./gate-manifest.mjs";

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
export async function main(args) {
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
