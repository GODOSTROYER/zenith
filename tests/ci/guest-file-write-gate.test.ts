/** Synthetic parser regressions prove admission rules, never Linux filesystem execution. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linuxGuestManifest } from "../../scripts/ci/gate-manifest.mjs";
import { attemptEvidencePath, createAttemptDirectory, publishAttemptEvidence, runNativeGate, selectCurrentAttempt, validateGoEvents } from "../../scripts/ci/run-guest-file-write-gate.mjs";

const pkg = "github.com/GODOSTROYER/zenith/go/internal/machine/ops";
const goodExit = { status: 0, signal: null, observed: true };
const contract = {
  requiredCases: [
    { package: pkg, test: "TestWriteCreateReplaceNoop", id: "required-create" },
    { package: pkg, test: "TestWriteFaultAndCancelPhases/after_renametrue", id: "required-cancel" },
  ],
  requiredPackages: [pkg], noTestPackages: [] as string[],
  allowedSkips: [{ package: pkg, test: "TestRealSystemctlAndJournalctl" }],
};
type Event = { Action: string; Package: string; Test?: string; Output?: unknown; Elapsed?: unknown };
const event = (Action: string, Test?: string): Event => ({ Action, Package: pkg, ...(Test ? { Test } : {}) });
const records = (): Event[] => [
  event("start"), event("run", "TestWriteCreateReplaceNoop"), event("pass", "TestWriteCreateReplaceNoop"),
  event("run", "TestWriteFaultAndCancelPhases"), event("run", "TestWriteFaultAndCancelPhases/after_renametrue"),
  event("pass", "TestWriteFaultAndCancelPhases/after_renametrue"), event("pass", "TestWriteFaultAndCancelPhases"), event("pass"),
];
const stream = (items = records()) => items.map((item) => JSON.stringify(item)).join("\n") + "\n";
const verdict = (items: Event[]) => validateGoEvents(stream(items), goodExit, contract);

// Emit complete lifecycles from a test-only tree, then remove independently
// selected required observations. Reports do not discover the required list.
function fullRequiredStream() {
  const manifest = linuxGuestManifest();
  const items: Event[] = [];
  for (const packageName of manifest.requiredPackages) {
    items.push({ Action: "start", Package: packageName });
    const names = manifest.requiredCases.filter((item) => item.package === packageName).map((item) => item.test);
    const tree = new Map<string, Set<string>>();
    for (const name of names.length ? names : ["TestExistingPackage"]) {
      const parts = name.split("/");
      for (let i = 0; i < parts.length; i++) {
        const parent = parts.slice(0, i).join("/");
        if (!tree.has(parent)) tree.set(parent, new Set());
        tree.get(parent)!.add(parts.slice(0, i + 1).join("/"));
      }
    }
    const visit = (name: string) => {
      items.push({ Action: "run", Package: packageName, Test: name });
      for (const child of tree.get(name) ?? []) visit(child);
      items.push({ Action: "pass", Package: packageName, Test: name });
    };
    for (const name of tree.get("") ?? []) visit(name);
    items.push({ Action: "pass", Package: packageName });
  }
  for (const packageName of manifest.noTestPackages) items.push({ Action: "start", Package: packageName }, { Action: "skip", Package: packageName });
  return items;
}

describe("native Go evidence admission", () => {
  it("counts parent/subtest/package observations separately and exports only trusted IDs", () => {
    const result = validateGoEvents(stream(), goodExit, contract);
    expect(result.verdict).toBe("passed");
    expect(result.counts).toEqual({ packages: 1, testEvents: 3, parents: 1, leaves: 2, passedLeaves: 2, failedLeaves: 0, skippedLeaves: 0 });
    expect(result.required).toEqual([{ id: "required-create", status: "passed" }, { id: "required-cancel", status: "passed" }]);
  });

  it.each([
    { status: 1, signal: null, observed: true }, { status: null, signal: "SIGTERM", observed: true },
    { status: null, signal: null, observed: false }, { status: 0, signal: null, observed: false },
  ])("requires an independently observed successful process exit: %j", (observation) => {
    expect(validateGoEvents(stream(), observation, contract).verdict).toBe("failed");
  });

  it.each(["", "\n", "{}\n", "null\n", "not-json\n", stream().trimEnd(), stream() + "truncated", stream() + "\n"])("rejects malformed, zero and truncated streams", (raw) => {
    expect(validateGoEvents(raw, goodExit, contract).verdict).toBe("failed");
  });

  it.each(["fail", "skip"])("refuses required %s even when its parent/package pass", (action) => {
    const items = records(); items[5].Action = action;
    expect(verdict(items).verdict).toBe("failed");
  });

  it("refuses a missing required child despite all reported cases passing", () => {
    expect(verdict(records().filter((item) => item.Test !== contract.requiredCases[1].test)).verdict).toBe("failed");
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7])("refuses duplicate lifecycle record %i", (index) => {
    const items = records(); items.splice(index, 0, { ...items[index] });
    expect(verdict(items).verdict).toBe("failed");
  });

  it("refuses unfinished cases/packages and child-before-parent or parent-before-child completion", () => {
    for (const items of [records().slice(0, -1), records().filter((item) => item.Action !== "pass"), [records()[0], records()[4], ...records().slice(1)], [...records().slice(0, 5), records()[6], records()[5], records()[7]]]) {
      expect(verdict(items).verdict).toBe("failed");
    }
  });

  it("checks pause/continue state and rejects terminal events on paused tests", () => {
    const items = records(); items.splice(2, 0, event("pause", "TestWriteCreateReplaceNoop"), event("cont", "TestWriteCreateReplaceNoop"));
    expect(verdict(items).verdict).toBe("passed");
    expect(verdict(items.filter((item) => item.Action !== "cont")).verdict).toBe("failed");
  });

  it("allows only specifically named non-required skips and explicit no-test packages", () => {
    const items = records(); items.splice(-1, 0, event("run", "TestRealSystemctlAndJournalctl"), event("skip", "TestRealSystemctlAndJournalctl"));
    items.push({ Action: "start", Package: "no-tests" }, { Action: "skip", Package: "no-tests" });
    expect(validateGoEvents(stream(items), goodExit, { ...contract, noTestPackages: ["no-tests"] }).verdict).toBe("passed");
    items[items.length - 5].Test = "TestUnexpectedSkip"; items[items.length - 4].Test = "TestUnexpectedSkip";
    expect(validateGoEvents(stream(items), goodExit, { ...contract, noTestPackages: ["no-tests"] }).verdict).toBe("failed");
    expect(verdict([...records(), { Action: "start", Package: "new-package" }, { Action: "pass", Package: "new-package" }]).verdict).toBe("failed");
  });

  it("refuses failure of non-required tests and build/package failures", () => {
    for (const extra of [[event("run", "TestOther"), event("fail", "TestOther")], [event("build-fail")]]) {
      const items = records(); items.splice(-1, 0, ...extra); expect(verdict(items).verdict).toBe("failed");
    }
    const items = records(); items[7].Action = "fail"; expect(verdict(items).verdict).toBe("failed");
  });

  it("does not export raw outputs, arbitrary names, package labels or exceptions", () => {
    const secret = "inert-output-marker-do-not-publish";
    const items = records(); items.splice(2, 0, { ...event("output", "TestWriteCreateReplaceNoop"), Output: secret });
    items.splice(-1, 0, event("run", "TestUntrustedName"), event("pass", "TestUntrustedName"));
    const serialized = JSON.stringify(verdict(items));
    expect(serialized).not.toContain(secret); expect(serialized).not.toContain("TestUntrustedName"); expect(serialized).not.toContain(pkg);
    for (const bad of [{ ...event("output"), Output: { secret } }, { ...event("pass"), Elapsed: -1 }, { ...event("output"), Package: secret }]) {
      expect(JSON.stringify(verdict([...records(), bad]))).not.toContain(secret);
      expect(verdict([...records(), bad]).verdict).toBe("failed");
    }
  });

  it("does not let report-supplied IDs or a zero/duplicate requirement contract define success", () => {
    expect(validateGoEvents(stream(), goodExit, { ...contract, requiredCases: [] }).verdict).toBe("failed");
    expect(validateGoEvents(stream(), goodExit, { ...contract, requiredCases: [...contract.requiredCases, contract.requiredCases[0]] }).verdict).toBe("failed");
  });

  it("requires every committed write behavior independently, including the exact generic golden subtest", () => {
    const manifest = linuxGuestManifest(); const items = fullRequiredStream();
    expect(validateGoEvents(stream(items), goodExit, manifest).verdict).toBe("passed");
    for (const required of manifest.requiredCases) {
      const missing = items.filter((item) => item.Package !== required.package || item.Test !== required.test);
      expect(validateGoEvents(stream(missing), goodExit, manifest).verdict, required.id).toBe("failed");
    }
  });

  it("rejects a required package represented only by a no-test skip", () => {
    const items = records(); items[7].Action = "skip";
    expect(verdict(items).verdict).toBe("failed");
  });

  it("helper refuses invalid argument/root authority before touching fixture roots", () => {
    for (const args of [[], ["setup", "0", "1", "a".repeat(32)], ["cleanup", "1", "1", "../../"], ["delete", "1", "1", "a".repeat(32)]]) {
      const result = spawnSync("bash", ["scripts/ci/guest-file-write-fixtures.sh", ...args], { encoding: "utf8" });
      expect(result.status).toBe(2); expect(result.stdout).toBe(""); expect(result.stderr).toBe("fixture helper: invalid invocation\n");
    }
  });
});


// A stdlib Python observation contract model checks the narrow hosted-VM preparation
// contract. No root filesystem is opened or mutated by these fixtures. Real
// hosted prerequisite/ACL/bind-mount/native acceptance must pass separately.
const hostHelper = path.resolve("scripts/ci/prepare-native-guest-host.py");
const hostRun = "c".repeat(32);
const hostSnapshot = (optMode = 0o777) => ({
  root: { device: 8, inode: 2, mount: 40, uid: 0, gid: 0, mode: 0o755, directory: true, noAcl: true },
  opt: { device: 8, inode: 90, mount: 40, uid: 0, gid: 0, mode: optMode, directory: true, noAcl: true },
  rootFilesystem: "ext4", sysAdmin: true, toolsPresent: true, fixtureRootsAbsent: true,
});
type HostSnapshot = ReturnType<typeof hostSnapshot>;
type HostContractInput = { snapshot?: HostSnapshot; runId?: string; sequence?: HostSnapshot[]; environment?: Record<string, string>; system?: string; effectiveUid?: number; failObservation?: number; args?: string[] };
const hostModel = String.raw`
import contextlib, copy, importlib.util, io, json, os, sys
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('native_host', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
case = json.loads(sys.argv[2])
class Host:
    def __init__(self):
        self.current = copy.deepcopy(case['snapshot'])
        self.observations = 0
        self.chmods = 0
        self.entries = 0
    def __enter__(self):
        self.entries += 1
        return self
    def __exit__(self, *_):
        return False
    def observe(self):
        self.observations += 1
        if self.observations == case.get('failObservation'):
            raise OSError('inert-private-system-error-must-not-leak')
        sequence = case.get('sequence')
        return copy.deepcopy(sequence[min(self.observations - 1, len(sequence) - 1)] if sequence else self.current)
    def harden_opt(self):
        self.chmods += 1
        self.current['opt']['mode'] = 0o755
host = Host()
environment = {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux'}
environment.update(case.get('environment', {}))
output, errors = io.StringIO(), io.StringIO()
with patch.object(module, 'SystemHost', return_value=host), patch.object(module.platform, 'system', return_value=case.get('system', 'Linux')), patch.object(module.os, 'geteuid', return_value=case.get('effectiveUid', 0)), patch.dict(os.environ, environment, clear=True), contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
    status = module.main(case.get('args', ['--github-hosted-disposable', '1001', '1001', case['runId']]))
print(json.dumps({'status': status, 'stdout': output.getvalue(), 'stderr': errors.getvalue(), 'observations': host.observations, 'chmods': host.chmods, 'entries': host.entries}))
`;
function hostContract(input: HostContractInput = {}) {
  const child = spawnSync("python3", ["-B", "-c", hostModel, hostHelper, JSON.stringify({ snapshot: hostSnapshot(), runId: hostRun, ...input })], {
    encoding: "utf8", env: { PATH: process.env.PATH }, maxBuffer: 1024 * 1024,
  });
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe("");
  return JSON.parse(child.stdout) as { status: number; stdout: string; stderr: string; observations: number; chmods: number; entries: number };
}

describe("GUEST-NATIVE-HOST-01 disposable hosted ancestor preparation model", () => {
  it.each([0o755, 0o777])("admits supported root-owned %o and only hardens the pinned opt inode", (mode) => {
    const result = hostContract({ snapshot: hostSnapshot(mode) });
    const report = JSON.parse(result.stdout);
    expect(result.status).toBe(0); expect(result.stderr).toBe("");
    expect(result.chmods).toBe(mode === 0o777 ? 1 : 0); expect(result.observations).toBe(4);
    expect(report).toEqual({ schemaVersion: 1, kind: "native-guest-host-prerequisites", fixtureRunId: hostRun,
      testUid: 1001, testGid: 1001, verdict: "ready", hardenedOpt: mode === 0o777,
      before: hostSnapshot(mode), after: hostSnapshot(0o755), reason: "prerequisites_observed" });
    expect(report.after.root).toEqual(report.before.root);
    expect({ ...report.after.opt, mode }).toEqual(report.before.opt);
  });

  it.each(["ext2", "ext3", "ext4", "xfs", "btrfs"])("admits only an already supported %s root without remounting", (rootFilesystem) => {
    const result = hostContract({ snapshot: { ...hostSnapshot(0o755), rootFilesystem } });
    expect(result.status).toBe(0); expect(result.chmods).toBe(0);
  });

  it.each(["overlay", "tmpfs", "fuse", "nfs", "cifs", "", "unknown"])("refuses unsupported %s before chmod", (rootFilesystem) => {
    const result = hostContract({ snapshot: { ...hostSnapshot(), rootFilesystem } });
    expect(result.status).toBe(1); expect(result.chmods).toBe(0);
    expect(JSON.parse(result.stdout).reason).toBe("unsupported_root_filesystem");
  });

  it.each([
    ["unsafe-root-owner", (s: HostSnapshot) => { s.root.uid = 1001; }, "unsafe_root_ancestor"],
    ["unsafe-root-mode", (s: HostSnapshot) => { s.root.mode = 0o777; }, "unsafe_root_ancestor"],
    ["root-special-bit", (s: HostSnapshot) => { s.root.mode = 0o1755; }, "unsafe_root_ancestor"],
    ["opt-owner", (s: HostSnapshot) => { s.opt.uid = 1001; }, "unsafe_opt_ownership"],
    ["opt-nondirectory", (s: HostSnapshot) => { s.opt.directory = false; }, "unsafe_opt_ownership"],
    ["root-acl", (s: HostSnapshot) => { s.root.noAcl = false; }, "ancestor_acl_present"],
    ["opt-acl", (s: HostSnapshot) => { s.opt.noAcl = false; }, "ancestor_acl_present"],
    ["opt-special-bit", (s: HostSnapshot) => { s.opt.mode = 0o1777; }, "unexpected_opt_mode"],
    ["opt-other-mode", (s: HostSnapshot) => { s.opt.mode = 0o775; }, "unexpected_opt_mode"],
    ["opt-mount", (s: HostSnapshot) => { s.opt.mount += 1; }, "opt_not_on_root_mount"],
    ["opt-device", (s: HostSnapshot) => { s.opt.device += 1; }, "opt_not_on_root_mount"],
    ["mount-capability", (s: HostSnapshot) => { s.sysAdmin = false; }, "bind_mount_authority_unavailable"],
    ["tools", (s: HostSnapshot) => { s.toolsPresent = false; }, "required_mount_tool_unavailable"],
    ["preexisting-namespace", (s: HostSnapshot) => { s.fixtureRootsAbsent = false; }, "fixture_namespace_preexists"],
  ] as const)("refuses %s without physical mutation", (_, change, reason) => {
    const snapshot = hostSnapshot(); change(snapshot);
    const result = hostContract({ snapshot });
    expect(result.status).toBe(1); expect(result.chmods).toBe(0); expect(result.observations).toBe(1);
    expect(JSON.parse(result.stdout).reason).toBe(reason);
  });

  it.each(["device", "inode", "mount", "uid", "gid", "mode"] as const)("refuses a pre-chmod %s race", (field) => {
    const before = hostSnapshot(); const changed = hostSnapshot(); changed.opt[field] += 1;
    const result = hostContract({ sequence: [before, changed] });
    expect(result.status).toBe(1); expect(result.chmods).toBe(0);
    expect(JSON.parse(result.stdout).reason).toBe("ancestor_identity_changed");
  });

  it.each(["device", "inode", "mount", "uid", "gid", "mode"] as const)("refuses a post-chmod %s race without a second chmod", (field) => {
    const before = hostSnapshot(); const changed = hostSnapshot(0o755); changed.opt[field] += 1;
    const result = hostContract({ sequence: [before, before, changed] });
    expect(result.status).toBe(1); expect(result.chmods).toBe(1);
    expect(JSON.parse(result.stdout).verdict).toBe("refused");
    expect(JSON.parse(result.stdout).reason).toBe("ancestor_identity_changed");
  });

  it("refuses a final namespace replacement and root/ACL races", () => {
    for (const mutate of [
      (s: HostSnapshot) => { s.opt.inode += 1; },
      (s: HostSnapshot) => { s.root.inode += 1; },
      (s: HostSnapshot) => { s.opt.noAcl = false; },
    ]) {
      const before = hostSnapshot(); const after = hostSnapshot(0o755); const changed = hostSnapshot(0o755); mutate(changed);
      const result = hostContract({ sequence: [before, before, after, changed] });
      expect(result.status).toBe(1); expect(result.chmods).toBe(1);
      expect(JSON.parse(result.stdout).reason).toBe("ancestor_identity_changed");
    }
  });

  const authorizationCases: HostContractInput[] = [
    { environment: { GITHUB_ACTIONS: "false" } }, { environment: { RUNNER_ENVIRONMENT: "self-hosted" } },
    { environment: { RUNNER_OS: "Windows" } }, { effectiveUid: 1001 }, { system: "Darwin" },
  ];
  it.each(authorizationCases)("requires the explicit root disposable hosted Linux context: %j", (input) => {
    const result = hostContract(input);
    expect(result.status).toBe(1); expect(result.entries).toBe(0); expect(result.chmods).toBe(0);
    expect(JSON.parse(result.stdout).reason).toBe("disposable_host_authorization_absent");
  });

  it.each([
    { args: [] }, { args: ["--prepare", "1001", "1001", hostRun] },
    { args: ["--github-hosted-disposable", "0", "1001", hostRun] },
    { args: ["--github-hosted-disposable", "1001", "0", hostRun] },
    { args: ["--github-hosted-disposable", "1001", "1001", "../old"] },
  ])("refuses invalid scope arguments before opening any host: %j", ({ args }) => {
    const result = hostContract({ args });
    expect(result.status).toBe(2); expect(result.entries).toBe(0); expect(result.stdout).toBe("");
    expect(result.stderr).toBe("native guest host: invalid invocation\n");
  });

  it("reports only this invocation after an observation failure, with no imported prior pass or raw exception", () => {
    expect(JSON.parse(hostContract().stdout).verdict).toBe("ready");
    const runId = "d".repeat(32); const failed = hostContract({ runId, failObservation: 1 });
    expect(failed.status).toBe(1); expect(failed.chmods).toBe(0);
    expect(JSON.parse(failed.stdout)).toEqual({ schemaVersion: 1, kind: "native-guest-host-prerequisites", fixtureRunId: runId,
      testUid: 1001, testGid: 1001, verdict: "refused", hardenedOpt: false, reason: "system_observation_failed" });
    expect(failed.stdout).not.toContain(hostRun); expect(failed.stdout).not.toContain("inert-private-system-error");
  });

  it("wires preparation only before native fixture setup and preserves the production fixture guards", () => {
    const workflow = fs.readFileSync(".github/workflows/ci.yml", "utf8");
    const goJob = workflow.slice(workflow.indexOf("\n  go:\n"), workflow.indexOf("\n  workflows:\n"));
    expect(workflow.match(/prepare-native-guest-host\.py/g)).toHaveLength(1);
    expect(goJob.indexOf('echo "ZENITH_GUEST_FIXTURE_RUN_ID=')).toBeLessThan(goJob.indexOf("prepare-native-guest-host.py"));
    expect(goJob.indexOf("prepare-native-guest-host.py")).toBeLessThan(goJob.indexOf("guest-file-write-fixtures.sh setup"));
    expect(goJob).toContain("sudo --preserve-env=GITHUB_ACTIONS,RUNNER_ENVIRONMENT,RUNNER_OS -- python3");
    expect(goJob).toContain('"$(id -u)" "$(id -g)" "$fixture_run_id"');
    expect(goJob).toContain("sudo -- bash scripts/ci/guest-file-write-fixtures.sh cleanup");
    const fixture = fs.readFileSync("scripts/ci/guest-file-write-fixtures.sh", "utf8");
    expect(fixture).toContain("stat.S_IMODE(st.st_mode) & 0o7022");
    expect(fixture).toContain("['ext2', 'ext3', 'ext4', 'xfs', 'btrfs']");
    const helper = fs.readFileSync(hostHelper, "utf8");
    expect(helper).toContain("os.fchmod(self.opt_fd, 0o755)");
    expect(helper).toContain("os.O_NOFOLLOW");
    expect(helper).not.toMatch(/os\.(?:chmod|chown|fchown)\(/);
    expect(helper).not.toContain("subprocess");
  });
});


// These are actual temporary-file publication checks with synthetic metadata.
// They do not execute Go or supply Linux filesystem/deployment acceptance.
const artifactRoots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of artifactRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const oldAttempt = "a".repeat(32);
const newAttempt = "b".repeat(32);
function artifactRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guest-artifact-")); artifactRoots.push(root);
  fs.mkdirSync(path.join(root, ".data-ci-guest"), { mode: 0o700 });
  // Historical fixed-path success must survive unchanged and never be selected.
  fs.writeFileSync(path.join(root, ".data-ci-guest/evidence.json"), '{"verdict":"passed","historical":true}\n', { mode: 0o600 });
  return root;
}
function syntheticEvidence(id: string, verdict: "passed" | "failed") {
  return { schemaVersion: 1, lane: "linux-guest", attempt: { id, runnerExitCode: verdict === "passed" ? 0 : 1 }, verdict, binding: null, tools: null, steps: [], problems: ["synthetic-publication-fixture"] };
}
function publishedFixture(root: string, id: string, verdict: "passed" | "failed") {
  createAttemptDirectory(root, id);
  let output: Record<string, string> = {};
  const published = publishAttemptEvidence(root, id, syntheticEvidence(id, verdict), { emit: (values) => { output = values; } });
  return { published, output, values: { expectedAttemptId: id, attemptId: output.attempt_id, evidencePath: output.evidence_path, evidenceSha256: output.evidence_sha256, runnerExitCode: output.runner_exit_code, observedOutcome: verdict === "passed" ? "success" : "failure" } };
}
function previousBytes(root: string) {
  return { fixed: fs.readFileSync(path.join(root, ".data-ci-guest/evidence.json"), "utf8"), attempt: fs.readFileSync(path.join(root, attemptEvidencePath(oldAttempt)), "utf8") };
}

describe("GUEST-LINUX-STALE-01 current-attempt artifact selection", () => {
  it("leaves an old pass ineligible after actual early private-directory refusal", async () => {
    const root = artifactRoot(); const old = publishedFixture(root, oldAttempt, "passed"); const before = previousBytes(root);
    const outputFile = path.join(root, "step-output"); fs.writeFileSync(outputFile, "", { mode: 0o600 }); vi.stubEnv("GITHUB_OUTPUT", outputFile);
    fs.chmodSync(path.join(root, ".data-ci-guest"), 0o755);
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runNativeGate(root, newAttempt)).toBe(1);
    expect(fs.readFileSync(outputFile, "utf8")).toBe("");
    expect(fs.existsSync(path.join(root, ".data-ci-guest", `attempt-${newAttempt}`))).toBe(false);
    expect(previousBytes(root)).toEqual(before);
    fs.chmodSync(path.join(root, ".data-ci-guest"), 0o700);
    expect(selectCurrentAttempt(root, { ...old.values, expectedAttemptId: newAttempt, observedOutcome: "failure" })).toBeNull();
    expect(selectCurrentAttempt(root, { expectedAttemptId: newAttempt, observedOutcome: "failure" })).toBeNull();
  });

  it.each(["write", "rename"])("releases no output and cannot reuse an old pass after %s failure", (stage) => {
    const root = artifactRoot(); const old = publishedFixture(root, oldAttempt, "passed"); const before = previousBytes(root);
    const directory = createAttemptDirectory(root, newAttempt); const emit = vi.fn();
    const refuse = () => { throw new Error("inert I/O fault"); };
    expect(() => publishAttemptEvidence(root, newAttempt, syntheticEvidence(newAttempt, "passed"), { emit, ...(stage === "write" ? { writeFile: refuse } : { rename: refuse }) })).toThrow("inert I/O fault");
    expect(emit).not.toHaveBeenCalled(); expect(previousBytes(root)).toEqual(before);
    expect(fs.existsSync(path.join(directory, "sanitized.json"))).toBe(false);
    if (stage === "rename") expect(fs.statSync(path.join(directory, ".sanitized.tmp")).mode & 0o777).toBe(0o600);
    expect(selectCurrentAttempt(root, { ...old.values, expectedAttemptId: newAttempt, observedOutcome: "failure" })).toBeNull();
    expect(selectCurrentAttempt(root, { expectedAttemptId: newAttempt, observedOutcome: "failure" })).toBeNull();
  });

  it("rejects a partial output publication of a pass when the runner actually failed", () => {
    const root = artifactRoot(); publishedFixture(root, oldAttempt, "passed"); const before = previousBytes(root); createAttemptDirectory(root, newAttempt);
    let partial: Record<string, string> = {};
    expect(() => publishAttemptEvidence(root, newAttempt, syntheticEvidence(newAttempt, "passed"), { emit: (values) => { partial = values; throw new Error("inert output fault"); } })).toThrow("inert output fault");
    expect(previousBytes(root)).toEqual(before);
    expect(selectCurrentAttempt(root, { expectedAttemptId: newAttempt, attemptId: partial.attempt_id, evidencePath: partial.evidence_path, evidenceSha256: partial.evidence_sha256, runnerExitCode: partial.runner_exit_code, observedOutcome: "failure" })).toBeNull();
    expect(selectCurrentAttempt(root, { expectedAttemptId: newAttempt, observedOutcome: "failure" })).toBeNull();
  });

  it("verifies post-rename bytes before releasing evidence outputs", () => {
    const root = artifactRoot(); publishedFixture(root, oldAttempt, "passed"); const before = previousBytes(root); createAttemptDirectory(root, newAttempt); const emit = vi.fn();
    expect(() => publishAttemptEvidence(root, newAttempt, syntheticEvidence(newAttempt, "passed"), { emit, rename: (source, destination) => { fs.renameSync(source, destination); fs.writeFileSync(destination, "{}\n"); } })).toThrow();
    expect(emit).not.toHaveBeenCalled(); expect(previousBytes(root)).toEqual(before);
  });

  it.each(["passed", "failed"] as const)("selects a fresh %s only when the observed runner outcome matches", (verdict) => {
    const root = artifactRoot(); publishedFixture(root, oldAttempt, "passed"); const before = previousBytes(root);
    const current = publishedFixture(root, newAttempt, verdict);
    expect(current.published.path).toBe(`.data-ci-guest/attempt-${newAttempt}/sanitized.json`);
    expect(selectCurrentAttempt(root, current.values)).toBe(current.published.path);
    expect(selectCurrentAttempt(root, { ...current.values, observedOutcome: verdict === "passed" ? "failure" : "success" })).toBeNull();
    expect(previousBytes(root)).toEqual(before);
    expect(fs.statSync(path.join(root, current.published.path)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(path.join(root, current.published.path))).mode & 0o777).toBe(0o700);
  });

  it("rejects missing output fields, wrong IDs/digests, fixed/raw paths and unobserved exits", () => {
    const root = artifactRoot(); const current = publishedFixture(root, newAttempt, "passed");
    for (const missing of Object.keys(current.values)) {
      const incomplete: Partial<typeof current.values> = { ...current.values }; delete incomplete[missing as keyof typeof incomplete];
      expect(selectCurrentAttempt(root, incomplete)).toBeNull();
    }
    for (const changed of [
      { expectedAttemptId: oldAttempt }, { attemptId: oldAttempt }, { evidenceSha256: "0".repeat(64) }, { runnerExitCode: "1" },
      { evidencePath: ".data-ci-guest/evidence.json" }, { evidencePath: ".data-ci-guest/attempt-" + newAttempt + "/race.jsonl" },
      { evidencePath: "../../other-file" }, { observedOutcome: "cancelled" }, { observedOutcome: "skipped" }, { observedOutcome: "" },
    ]) expect(selectCurrentAttempt(root, { ...current.values, ...changed })).toBeNull();
  });

  it("refuses reused attempts and a second publication without unlinking an existing receipt", () => {
    const root = artifactRoot(); const old = publishedFixture(root, oldAttempt, "passed"); const before = previousBytes(root); const emit = vi.fn();
    expect(() => createAttemptDirectory(root, oldAttempt)).toThrow();
    expect(() => publishAttemptEvidence(root, oldAttempt, syntheticEvidence(oldAttempt, "failed"), { emit })).toThrow();
    expect(emit).not.toHaveBeenCalled(); expect(previousBytes(root)).toEqual(before); expect(selectCurrentAttempt(root, old.values)).toBe(old.published.path);
    for (const id of ["../escape", "A".repeat(32), "a".repeat(31)]) expect(() => attemptEvidencePath(id)).toThrow();
  });

  it("refuses tampered, linked, symlinked or nonprivate current artifacts", () => {
    for (const mutation of ["bytes", "hardlink", "symlink", "file-mode", "directory-mode"] as const) {
      const root = artifactRoot(); const current = publishedFixture(root, newAttempt, "passed"); const file = path.join(root, current.published.path);
      if (mutation === "bytes") fs.writeFileSync(file, "{}\n");
      if (mutation === "hardlink") fs.linkSync(file, path.join(root, "alias"));
      if (mutation === "symlink") { fs.renameSync(file, path.join(root, "saved")); fs.symlinkSync(path.join(root, "saved"), file); }
      if (mutation === "file-mode") fs.chmodSync(file, 0o644);
      if (mutation === "directory-mode") fs.chmodSync(path.dirname(file), 0o755);
      expect(selectCurrentAttempt(root, current.values)).toBeNull();
    }
  });
});
