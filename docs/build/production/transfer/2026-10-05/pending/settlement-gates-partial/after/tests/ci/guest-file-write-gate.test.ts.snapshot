/** Synthetic parser regressions prove admission rules, never Linux filesystem execution. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
type AclMetadata = { bytes:number;entries:number;sha256:string;modeBits:number };
const emptyAcl = () => ({ access:null as AclMetadata|null, default:null as AclMetadata|null });
const emptyXattrNamesSha256 = createHash("sha256").update("[]").digest("hex");
const hostSnapshot = (optMode = 0o777) => ({
  root: { device: 8, inode: 2, mount: 40, uid: 0, gid: 0, mode: 0o755, directory: true, noAcl: true, acl:emptyAcl(), otherXattrNamesSha256:emptyXattrNamesSha256 },
  opt: { device: 8, inode: 90, mount: 40, uid: 0, gid: 0, mode: optMode, directory: true, noAcl: true, acl:emptyAcl(), otherXattrNamesSha256:emptyXattrNamesSha256 },
  rootFilesystem: "ext4", sysAdmin: true, toolsPresent: true, fixtureRootsAbsent: true,
});
type HostSnapshot = ReturnType<typeof hostSnapshot>;
type HostContractInput = { snapshot?: HostSnapshot; runId?: string; sequence?: HostSnapshot[]; environment?: Record<string, string>; system?: string; effectiveUid?: number; failObservation?: number; failRemoval?:"access"|"default"; removalNoop?:boolean; failChmod?:boolean; chmodNoop?:boolean; args?: string[] };
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
        self.removals = []
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
        if case.get('failChmod'):
            raise OSError('inert-private-chmod-error')
        if not case.get('chmodNoop'):
            self.current['opt']['mode'] = 0o755
    def remove_opt_acl(self, kind):
        if case.get('failRemoval') == kind:
            module.refuse('opt_acl_removal_failed')
        self.removals.append(kind)
        if not case.get('removalNoop'):
            self.current['opt']['acl'][kind] = None
            self.current['opt']['noAcl'] = all(v is None for v in self.current['opt']['acl'].values())
host = Host()
environment = {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux'}
environment.update(case.get('environment', {}))
output, errors = io.StringIO(), io.StringIO()
with patch.object(module, 'SystemHost', return_value=host), patch.object(module.platform, 'system', return_value=case.get('system', 'Linux')), patch.object(module.os, 'geteuid', return_value=case.get('effectiveUid', 0)), patch.dict(os.environ, environment, clear=True), contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
    status = module.main(case.get('args', ['--github-hosted-disposable', '1001', '1001', case['runId']]))
print(json.dumps({'status': status, 'stdout': output.getvalue(), 'stderr': errors.getvalue(), 'observations': host.observations, 'chmods': host.chmods, 'removals':host.removals, 'entries': host.entries}))
`;
function hostContract(input: HostContractInput = {}) {
  const child = spawnSync("python3", ["-B", "-c", hostModel, hostHelper, JSON.stringify({ snapshot: hostSnapshot(), runId: hostRun, ...input })], {
    encoding: "utf8", env: { PATH: process.env.PATH, NODE_ENV: "test" }, maxBuffer: 1024 * 1024,
  });
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe("");
  return JSON.parse(child.stdout) as { status: number; stdout: string; stderr: string; observations: number; chmods: number; removals:string[]; entries: number };
}

// These are synthetic Linux-UAPI bytes, not the hosted runner's unknown ACL.
type AclEntry = [number,number,number];
const aclBytes = (entries:AclEntry[],version=2) => {
  const bytes=Buffer.alloc(4+entries.length*8);bytes.writeUInt32LE(version);
  entries.forEach(([tag,perm,id],i)=>{bytes.writeUInt16LE(tag,4+i*8);bytes.writeUInt16LE(perm,6+i*8);bytes.writeUInt32LE(id,8+i*8);});
  return bytes;
};
const syntheticAcl = (mode=0o777) => aclBytes([[1,(mode>>6)&7,0xffffffff],[2,7,1001],[4,7,0xffffffff],[16,(mode>>3)&7,0xffffffff],[32,mode&7,0xffffffff]]);
function hostAclSnapshot(mode=0o777, access=true, defaultAcl=true):HostSnapshot {
  const snapshot=hostSnapshot(mode),raw=syntheticAcl(mode);
  const metadata={bytes:raw.length,entries:5,sha256:createHash("sha256").update(raw).digest("hex"),modeBits:mode};
  snapshot.opt.acl={access:access?metadata:null,default:defaultAcl?metadata:null};snapshot.opt.noAcl=!access&&!defaultAcl;
  return snapshot;
}
// Adapter models provide Linux-only xattr names explicitly on every host.
// Actual Linux acceptance runs the unpatched CLI against real kernel syscalls.
const aclProbeModel=String.raw`
import errno, importlib.util, json, stat, sys
from types import SimpleNamespace
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('native_host',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
case=json.loads(sys.argv[2])
calls=[]
def read(fd,name):
    if fd != 71: raise AssertionError('not the model descriptor')
    error=case.get('readErrors',{}).get(name)
    if error: raise OSError(getattr(errno,error),'inert-private-xattr-error')
    value=case.get('values',{}).get(name)
    if value is None: raise OSError(errno.ENODATA,'inert-private-absent')
    return bytes.fromhex(value)
try:
    if 'raw' in case:
        result=module.acl_metadata(bytes.fromhex(case['raw']))
    elif 'remove' in case:
        host=module.SystemHost();host.opt_fd=71
        def remove(fd,name):
            calls.append([fd,name])
            if case.get('removeError'):
                raise OSError(getattr(errno,case['removeError']),'inert-private-remove-error')
        with patch.object(module.os,'removexattr',side_effect=remove,create=True):
            host.remove_opt_acl(case['remove'])
        result={'calls':calls}
    else:
        with patch.object(module.os,'listxattr',side_effect=OSError(errno.ENOTSUP,'inert-private-list-error') if case.get('listError') else None,return_value=case.get('names',[]),create=True),patch.object(module.os,'getxattr',side_effect=read,create=True):
            if 'inodeMode' in case:
                item=SimpleNamespace(st_dev=8,st_ino=90,st_uid=0,st_gid=0,st_mode=stat.S_IFDIR|case['inodeMode'])
                with patch.object(module.os,'fstat',return_value=item),patch.object(module,'mount_id',return_value=40):
                    result=module.identity(71)
            else:
                result=module.acl_state(71)
    print(json.dumps({'verdict':'ready','metadata':result}))
except module.Refusal as error:
    print(json.dumps({'verdict':'refused','reason':str(error),**({'calls':calls} if 'remove' in case else {})}))
`;
function aclProbe(input:Record<string,unknown>):{verdict:string;reason?:string;metadata?:unknown} {
  const child=spawnSync("python3",["-B","-c",aclProbeModel,hostHelper,JSON.stringify(input)],{encoding:"utf8",env:{PATH:process.env.PATH,NODE_ENV:"test"},maxBuffer:1024*1024});
  expect(child.error).toBeUndefined();expect(child.status).toBe(0);expect(child.stderr).toBe("");
  expect(child.stdout).not.toContain("inert-private");
  return JSON.parse(child.stdout);
}

describe("GUEST-NATIVE-HOST-01 disposable hosted ancestor preparation model", () => {
  it.each([0o755, 0o777])("admits supported root-owned %o and only hardens the pinned opt inode", (mode) => {
    const result = hostContract({ snapshot: hostSnapshot(mode) });
    const report = JSON.parse(result.stdout);
    expect(result.status).toBe(0); expect(result.stderr).toBe("");
    expect(result.chmods).toBe(mode === 0o777 ? 1 : 0); expect(result.observations).toBe(mode === 0o777 ? 5 : 4);
    expect(report).toEqual({ schemaVersion: 1, kind: "native-guest-host-prerequisites", fixtureRunId: hostRun,
      testUid: 1001, testGid: 1001, verdict: "ready", hardenedOpt: mode === 0o777, removedOptAcls:[],
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
    ["inconsistent-opt-acl", (s: HostSnapshot) => { s.opt.noAcl = false; }, "acl_identity_changed"],
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
    const result = hostContract({ sequence: [before, before, before, changed] });
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
      const result = hostContract({ sequence: [before, before, before, after, changed] });
      expect(result.status).toBe(1); expect(result.chmods).toBe(1);
      expect(JSON.parse(result.stdout).reason).toBe("ancestor_identity_changed");
    }
  });

  it.each([[true,false],[false,true],[true,true]] as const)("removes only observed access=%s/default=%s attributes and retains all other metadata",(access,defaultAcl)=>{
    for(const mode of [0o755,0o777]) {
      const before=hostAclSnapshot(mode,access,defaultAcl),result=hostContract({snapshot:before}),report=JSON.parse(result.stdout);
      const expected=[...(access?["access"]:[]),...(defaultAcl?["default"]:[])];
      expect(result.status).toBe(0);expect(result.removals).toEqual(expected);expect(result.chmods).toBe(1);
      expect(report.removedOptAcls).toEqual(expected);expect(report.after).toEqual(hostSnapshot(0o755));
      expect(report.before).toEqual(before);expect(report.after.root).toEqual(before.root);
      expect(report.hardenedOpt).toBe(true);
      expect(result.stdout).not.toContain(syntheticAcl(mode).toString("hex"));
    }
  });

  it.each(["access","default"] as const)("refuses failed %s removal and reports actual partial hardening without retry or chmod",kind=>{
    const result=hostContract({snapshot:hostAclSnapshot(),failRemoval:kind}),report=JSON.parse(result.stdout);
    expect(result.status).toBe(1);expect(result.chmods).toBe(0);expect(report.reason).toBe("opt_acl_removal_failed");
    expect(result.removals).toEqual(kind==="access"?[]:["access"]);expect(report.removedOptAcls).toEqual(result.removals);
    expect(report.hardenedOpt).toBe(false);
  });
  it.each([{removalNoop:true,reason:"ancestor_identity_changed",chmods:0},{failChmod:true,reason:"opt_mode_hardening_failed",chmods:1},{chmodNoop:true,reason:"ancestor_identity_changed",chmods:1}])("refuses incomplete hardening: %j",testCase=>{
    const result=hostContract({snapshot:hostAclSnapshot(),...testCase}),report=JSON.parse(result.stdout);
    expect(result.status).toBe(1);expect(result.chmods).toBe(testCase.chmods);expect(report.reason).toBe(testCase.reason);
    expect(report.verdict).toBe("refused");expect(result.stdout).not.toContain("inert-private");
  });
  it("refuses a lost attribute or name/digest race before any removal",()=>{
    const before=hostAclSnapshot();
    for(const change of [(s:HostSnapshot)=>{s.opt.acl.access=null;s.opt.noAcl=false;},(s:HostSnapshot)=>{s.opt.acl.access!.sha256="e".repeat(64);},(s:HostSnapshot)=>{s.opt.inode++;},(s:HostSnapshot)=>{s.opt.otherXattrNamesSha256="f".repeat(64);}]) {
      const changed=structuredClone(before);change(changed);
      const result=hostContract({sequence:[before,before,changed]});expect(result.status).toBe(1);expect(result.removals).toEqual([]);expect(result.chmods).toBe(0);
      expect(JSON.parse(result.stdout).reason).toBe("ancestor_identity_changed");
    }
  });
  it("refuses observation failure after a partial ACL removal and never imports an earlier pass",()=>{
    const result=hostContract({snapshot:hostAclSnapshot(),failObservation:4,runId:"d".repeat(32)}),report=JSON.parse(result.stdout);
    expect(result.status).toBe(1);expect(result.removals).toEqual(["access"]);expect(result.chmods).toBe(0);
    expect(report.removedOptAcls).toEqual(["access"]);expect(report.reason).toBe("system_observation_failed");expect(report.fixtureRunId).toBe("d".repeat(32));
    expect(result.stdout).not.toContain(hostRun);
  });
  it("refuses a changed remaining ACL before the second removal, retaining the first removal receipt",()=>{
    const before=hostAclSnapshot(),partial=hostAclSnapshot(0o777,false,true),changed=structuredClone(partial);
    changed.opt.acl.default!.sha256="e".repeat(64);
    const result=hostContract({sequence:[before,before,before,partial,changed]}),report=JSON.parse(result.stdout);
    expect(result.status).toBe(1);expect(result.removals).toEqual(["access"]);expect(result.chmods).toBe(0);
    expect(report.removedOptAcls).toEqual(["access"]);expect(report.reason).toBe("ancestor_identity_changed");
  });
  it("refuses an ACL reappearing during the final name check after hardening, without another mutation",()=>{
    const before=hostAclSnapshot(),partial=hostAclSnapshot(0o777,false,true),clean=hostSnapshot(),after=hostSnapshot(0o755),changed=hostAclSnapshot(0o755,true,false);
    const result=hostContract({sequence:[before,before,before,partial,partial,clean,clean,after,changed]}),report=JSON.parse(result.stdout);
    expect(result.status).toBe(1);expect(result.removals).toEqual(["access","default"]);expect(result.chmods).toBe(1);
    expect(report.removedOptAcls).toEqual(["access","default"]);expect(report.reason).toBe("ancestor_identity_changed");
  });
  it("refuses a canonical root ACL summary before removing any opt ACL",()=>{
    const snapshot=hostAclSnapshot();snapshot.root.acl=hostAclSnapshot(0o755).opt.acl;snapshot.root.noAcl=false;
    const result=hostContract({snapshot});
    expect(result.status).toBe(1);expect(result.removals).toEqual([]);expect(result.chmods).toBe(0);
    expect(JSON.parse(result.stdout).reason).toBe("ancestor_acl_present");
  });

  it("parses canonical bounded Linux v2 entries without disclosing named IDs or raw bytes",()=>{
    const raw=syntheticAcl(),parsed=aclProbe({raw:raw.toString("hex")});
    expect(parsed).toEqual({verdict:"ready",metadata:{bytes:44,entries:5,modeBits:0o777,sha256:createHash("sha256").update(raw).digest("hex")}});
    const basic=aclBytes([[1,7,0xffffffff],[4,5,0xffffffff],[32,5,0xffffffff]]);
    expect(aclProbe({raw:basic.toString("hex")}).verdict).toBe("ready");
    const grouped=aclBytes([[1,7,0xffffffff],[2,4,1001],[2,6,1002],[4,2,0xffffffff],[8,5,1001],[8,4,1002],[16,5,0xffffffff],[32,0,0xffffffff]]);
    expect(aclProbe({raw:grouped.toString("hex")})).toEqual({verdict:"ready",metadata:{bytes:68,entries:8,modeBits:0o750,sha256:createHash("sha256").update(grouped).digest("hex")}});
  });
  it.each([
    ["old-version",aclBytes([[1,7,0xffffffff],[4,7,0xffffffff],[32,7,0xffffffff]],1)],
    ["truncated",syntheticAcl().subarray(0,43)],["empty",Buffer.alloc(4)],
    ["unknown-tag",aclBytes([[1,7,0xffffffff],[64,7,0xffffffff],[32,7,0xffffffff]])],
    ["permission-bits",aclBytes([[1,8,0xffffffff],[4,7,0xffffffff],[32,7,0xffffffff]])],
    ["base-id",aclBytes([[1,7,1001],[4,7,0xffffffff],[32,7,0xffffffff]])],
    ["missing-mask",aclBytes([[1,7,0xffffffff],[2,7,1001],[4,7,0xffffffff],[32,7,0xffffffff]])],
    ["duplicate-user",aclBytes([[1,7,0xffffffff],[2,7,1001],[2,7,1001],[4,7,0xffffffff],[16,7,0xffffffff],[32,7,0xffffffff]])],
    ["unsorted-group",aclBytes([[1,7,0xffffffff],[4,7,0xffffffff],[8,7,1002],[8,7,1001],[16,7,0xffffffff],[32,7,0xffffffff]])],
    ["undefined-named-id",aclBytes([[1,7,0xffffffff],[2,7,0xffffffff],[4,7,0xffffffff],[16,7,0xffffffff],[32,7,0xffffffff]])],
    ["oversize",Buffer.alloc(4100)],
  ] as const)("refuses malformed %s before physical mutation",(_,raw)=>{expect(aclProbe({raw:raw.toString("hex")})).toEqual({verdict:"refused",reason:"malformed_posix_acl"});});
  it.each([
    [{listError:true},"acl_observation_unavailable"],
    [{readErrors:{"system.posix_acl_access":"ENOTSUP"}},"acl_observation_unavailable"],
    [{readErrors:{"system.posix_acl_access":"EIO"}},"acl_observation_unavailable"],
    [{names:["system.posix_acl_access"]},"acl_identity_changed"],
    [{values:{"system.posix_acl_access":syntheticAcl().toString("hex")}},"acl_identity_changed"],
    [{names:["system.nfs4_acl"]},"unsupported_acl_attribute"],
    [{names:["system.posix_acl_unknown"]},"unsupported_acl_attribute"],
    [{names:[""]},"unsupported_xattr_metadata"],
    [{names:["user."+"x".repeat(251)]},"unsupported_xattr_metadata"],
    [{names:["user.inert\u0000"]},"unsupported_xattr_metadata"],
    [{names:[1]},"unsupported_xattr_metadata"],
    [{names:["user.\ud800"]},"unsupported_xattr_metadata"],
    [{names:["user.test","user.test"]},"unsupported_xattr_metadata"],
    [{names:Array(65).fill("user.test")},"unsupported_xattr_metadata"],
  ] as const)("refuses unavailable/lost/unknown attribute metadata: %j",(input,reason)=>{expect(aclProbe(input)).toEqual({verdict:"refused",reason});});
  it("observes both exact known ACL attributes and preserves unrelated attribute names only as a digest",()=>{
    const raw=syntheticAcl().toString("hex"),names=["system.posix_acl_access","system.posix_acl_default","user.inert-model"];
    const result=aclProbe({names,values:{"system.posix_acl_access":raw,"system.posix_acl_default":raw}});
    expect(result.verdict).toBe("ready");expect(JSON.stringify(result)).not.toContain("user.inert-model");expect(JSON.stringify(result)).not.toContain(raw);
  });
  it("refuses access ACL mode disagreement and admits a different default ACL mode",()=>{
    const names=["system.posix_acl_access","system.posix_acl_default"],values={"system.posix_acl_access":syntheticAcl(0o755).toString("hex"),"system.posix_acl_default":syntheticAcl(0o777).toString("hex")};
    expect(aclProbe({inodeMode:0o777,names,values})).toEqual({verdict:"refused",reason:"acl_mode_mismatch"});
    const accepted=aclProbe({inodeMode:0o755,names,values});
    expect(accepted.verdict).toBe("ready");expect(JSON.stringify(accepted)).not.toContain(values["system.posix_acl_access"]);
  });
  it.each(["access","default"] as const)("uses the pinned descriptor and only the fixed %s attribute in the mutator adapter model",kind=>{
    expect(aclProbe({remove:kind})).toEqual({verdict:"ready",metadata:{calls:[[71,`system.posix_acl_${kind}`]]}});
    for(const removeError of ["ENODATA","ENOTSUP","EIO"]) {
      expect(aclProbe({remove:kind,removeError})).toEqual({verdict:"refused",reason:"opt_acl_removal_failed",calls:[[71,`system.posix_acl_${kind}`]]});
    }
  });
  it("refuses a caller-selected removal attribute before the adapter is called",()=>{
    expect(aclProbe({remove:"user.inert-model"})).toEqual({verdict:"refused",reason:"unsupported_acl_attribute",calls:[]});
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
      testUid: 1001, testGid: 1001, verdict: "refused", hardenedOpt: false, removedOptAcls:[], reason: "system_observation_failed" });
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
    expect(helper).toContain("os.removexattr(self.opt_fd, ACL_NAMES[kind])");
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


// These report/parser and syscall metadata models establish refusal contracts.
// They do not replace the actual unprivileged Linux writer or fixture lifecycle.
describe("upload native requirement admission", () => {
  const nativeUpload = () => linuxGuestManifest().requiredCases.filter((item) => /^(?:TestUpload|TestE2ESignedUpload)/.test(item.test));
  it("pins exact upload events and preserves all historical native IDs", () => {
    const manifest = linuxGuestManifest(); const upload = nativeUpload();
    expect(upload).toHaveLength(49); expect(manifest.raceCases).toHaveLength(123);
    expect(new Set(manifest.raceCases.map((item) => item.id)).size).toBe(123);
    expect(createHash("sha256").update(JSON.stringify(upload)).digest("hex")).toBe("4cb4a001976b864b82a7820d771b47272f8aedb73249183fbcf54a35f41cc4e0");
    const historical = manifest.raceCases.filter((item) => !upload.includes(item));
    expect(historical).toHaveLength(74);
    expect(createHash("sha256").update(JSON.stringify(historical)).digest("hex")).toBe("2a2e0b9b7c1cb061fe7862075edae6d633c7f63320adfe37e80fa13262e7f1d4");
    expect(manifest.allowedSkips.map((item: { package: string; test: string; reason: string }) => item.test)).toEqual(["TestRealSystemctlAndJournalctl", "TestRealOpenTofuPlanShowApply", "TestRealOpenTofuWithProviderAndLockfile"]);
    expect(manifest.goldenCases.map((item: { package: string; test: string }) => item.test)).toEqual(["TestResultGoldens/file.write-filesystem"]);
    expect(manifest.steps).toEqual([
      { id: "race", command: ["go", "test", "-json", "-race", "-count=1", "./...", "-skip", "^(TestPackageHelperNativeNoFollowAndCustody|TestPackageFrontendLockIndependentProcess|TestPackageNativeSignedFirstInstallAndNonReplay|TestPackageNativeDeclaredMountAndACLRefusals)$"] },
      { id: "package-native", command: ["python3", "scripts/ci/guest-package-fixtures.py", "--root", "{sourceRoot}", "--attempt", "{attemptId}", "--arch", "{nativeArch}"] },
      { id: "goldens", command: ["go", "test", "-json", "-count=1", "./internal/machine/ops", "-run", "^TestResultGoldens$"] },
      { id: "golden-diff", command: ["git", "diff", "--exit-code", "--", "internal/machine/testdata/results"] },
      { id: "golden-status", command: ["git", "--no-optional-locks", "status", "--porcelain", "--", "internal/machine/testdata/results"] },
    ]);
  });

  it("binds exact Linux source declarations including both signed daemon parents", () => {
    const files = [
      ["go/internal/machine/ops/fileupload_linux_test.go", "f7a033bc206436e51e53b1b39d74f13f717704e34e786338c2627d585e0e89d9"],
      ["go/internal/machine/e2e_test.go", "cdceff5a2dccecb9e04a4e35e5716376589604b6a6033be5acd2279518fc323e"],
    ];
    const source = files.map(([file, sha]) => {
      const raw = fs.readFileSync(file); expect(createHash("sha256").update(raw).digest("hex")).toBe(sha); return raw.toString("utf8");
    });
    const declared: Array<{ package: string; test: string; id: string }> = [];
    const add = (packageName: string, test: string) => declared.push({ package: packageName, test, id: `linux-guest:${packageName}:${test}` });
    const functions = [...source[0].matchAll(/^func (Test\w+)\(t \*testing\.T\)/gm)];
    functions.forEach((match, index) => {
      const body = source[0].slice(match.index, functions[index + 1]?.index);
      const labels = /for _, \w+ := range \[\]string\{([^}]+)\}/.exec(body);
      add(pkg, match[1]);
      if (labels) {
        expect(body).toMatch(/t\.Run\((?:kind|phase),/);
        for (const label of labels[1].matchAll(/"([^"]+)"/g)) add(pkg, `${match[1]}/${label[1]}`);
      }
    });
    const machine = "github.com/GODOSTROYER/zenith/go/internal/machine";
    const signed = source[1].slice(source[1].indexOf("func runSignedUploadFixture"));
    const faults = [...signed.matchAll(/^\s*\{"([^"]+)", protocol\.Code\w+,/gm)].map((match) => match[1].replaceAll(" ", "_"));
    expect(faults).toEqual(["foreign_audience", "foreign_capability", "foreign_operation", "foreign_workspace", "missing_resource", "foreign_path_constraint", "inline_bytes"]);
    for (const parent of ["TestE2ESignedUploadNativeCustodyAndGrantRefusal", "TestE2ESignedUploadResultGolden"]) {
      expect(source[1]).toContain(`func ${parent}(t *testing.T)`); add(machine, parent);
      for (const fault of faults) add(machine, `${parent}/${fault}`);
    }
    expect(nativeUpload()).toEqual(declared);
    expect(signed).toContain('if t.Failed() {');
    expect(signed).toContain('intent["operation"] != ops.OpFileUpload');
    expect(signed).toContain('normalized["transactionRef"] = "fw_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
    expect(signed).toContain('os.Getenv("ZENITH_UPDATE_MACHINE_GOLDENS") == "1"');
    expect(signed).toContain('!bytes.Equal(expected, encoded)');
    expect(linuxGuestManifest().prerequisites).toContain("Integrated frozen writer/upload source, five actual Linux-generated committed file.write goldens and authentic signed-daemon file.upload.json captured only by the root verification owner");
  });

  it("refuses each missing upload event despite all remaining observations passing", () => {
    const manifest = linuxGuestManifest(); const items = fullRequiredStream();
    expect(validateGoEvents(stream(items), goodExit, manifest).verdict).toBe("passed");
    for (const required of nativeUpload()) {
      const missing = items.filter((item) => item.Package !== required.package || item.Test !== required.test);
      const result = validateGoEvents(stream(missing), goodExit, manifest);
      expect(result.verdict, required.id).toBe("failed");
      expect(result.required.find((item) => item.id === required.id)?.status, required.id).not.toBe("passed");
    }
  });

  it.each(["fail", "skip"])("refuses each upload %s while parent and package observations otherwise pass", (action) => {
    const manifest = linuxGuestManifest(); const items = fullRequiredStream();
    for (const required of nativeUpload()) {
      const modified = items.map((item) => item.Action === "pass" && item.Package === required.package && item.Test === required.test ? { ...item, Action: action } : item);
      expect(validateGoEvents(stream(modified), goodExit, manifest).verdict, required.id).toBe("failed");
    }
  });

  it("does not substitute foreign upload identities or output claims for missing native events", () => {
    const manifest = linuxGuestManifest(); const items = fullRequiredStream();
    for (const required of nativeUpload()) {
      const substituted = items.map((item) => item.Package === required.package && item.Test === required.test ? { ...item, Test: `${required.test}_foreign` } : item);
      substituted.splice(-1, 0, { Action: "output", Package: required.package, Output: JSON.stringify({ id: required.id, status: "passed" }) });
      expect(validateGoEvents(stream(substituted), goodExit, manifest).verdict, required.id).toBe("failed");
    }
  });
});

// Execute only the actual helper's read-only receipt/check functions against
// independent syscall metadata. No /opt path is opened, provisioned or removed.
const uploadFixtureModel = String.raw`
import ast, json, pathlib, stat, sys, types
case = json.loads(sys.argv[2])
source = pathlib.Path(sys.argv[1]).read_text().split("<<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]
program = ast.parse(source)
names = {'TESTS', 'MOUNTS', 'GOLDEN', 'UPLOAD_GOLDEN', 'ROOTS', 'RECEIPT', 'LEASE', 'MOUNT_PAIRS'}
nodes = [node for node in program.body if (isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id in names for target in node.targets)) or (isinstance(node, ast.FunctionDef) and node.name in {'refuse', 'load', 'check'})]
namespace = {'json': json, 'stat': stat, 'UID': 1001, 'GID': 1001, 'RUN': 'a' * 32}
exec(compile(ast.Module(body=nodes, type_ignores=[]), 'fixed-fixture-read-model', 'exec'), namespace)
roots = ['/opt/zenith-file-write-tests', '/opt/zenith-file-write-mounts', '/opt/zenith-file-write-golden', '/opt/zenith-file-upload-golden']
assert namespace['ROOTS'] == roots
identity = {root: {'device': 8, 'inode': 80 + index, 'mount': 40, 'uid': 0 if index == 1 else 1001, 'gid': 0 if index == 1 else 1001, 'mode': 0o755 if index == 1 else 0o700, 'directory': True} for index, root in enumerate(roots)}
receipt = {'schemaVersion': 1, 'runId': 'a' * 32, 'uid': 1001, 'gid': 1001, 'rootMount': 40, 'state': 'ready', 'roots': json.loads(json.dumps(identity)), 'nodes': {}, 'mounts': []}
for index, (source, target) in enumerate(namespace['MOUNT_PAIRS']):
    item = {'device': 8, 'inode': 100 + index, 'mount': 41 + index, 'uid': 1001, 'gid': 1001, 'mode': 0o600 if index == 3 else 0o700, 'directory': index != 3}
    identity[target] = item
    receipt['mounts'].append({'source': source, 'target': target, 'identity': item.copy()})
if case.get('oldReceipt'):
    del receipt['roots'][roots[3]]
if case.get('foreignReceipt'):
    receipt['roots']['/opt/foreign-fixture'] = receipt['roots'][roots[3]]
identity[roots[3]].update(case.get('uploadIdentity', {}))
raw = json.dumps(receipt).encode()
observed_mounts = [{'target': item['target'], 'id': item['identity']['mount']} for item in receipt['mounts']]
if case.get('unexpectedMount'):
    observed_mounts.append({'target': roots[3] + '/foreign', 'id': 99})
reads = []
def listing(path):
    reads.append(path)
    return ['inert-entry'] if path == roots[3] and case.get('nonemptyUpload') else []
os_model = types.SimpleNamespace(lstat=lambda _: types.SimpleNamespace(st_mode=stat.S_IFREG | 0o444, st_uid=0, st_nlink=1, st_size=len(raw)), open=lambda *_: 7, read=lambda *_: raw, close=lambda _: None, O_RDONLY=0, O_NOFOLLOW=0, geteuid=lambda: 1001, getegid=lambda: 1001, listdir=listing, path=types.SimpleNamespace(lexists=lambda _: False))
namespace.update({'os': os_model, 'identity': lambda path: identity[path].copy(), 'no_acl': lambda _: None, 'mounts': lambda: observed_mounts})
try:
    namespace['check'](namespace['load'](40))
    accepted = True
except RuntimeError:
    accepted = False
print(json.dumps({'accepted': accepted, 'uploadListed': roots[3] in reads}))
`;
function uploadFixtureMetadata(input: Record<string, unknown>) {
  const child = spawnSync("python3", ["-B", "-c", uploadFixtureModel, path.resolve("scripts/ci/guest-file-write-fixtures.sh"), JSON.stringify(input)], { encoding: "utf8", env: { PATH: process.env.PATH, NODE_ENV: "test" }, maxBuffer: 1024 * 1024 });
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe("");
  return JSON.parse(child.stdout) as { accepted: boolean; uploadListed: boolean };
}
describe("fixed upload golden fixture ownership models", () => {
  it("requires an empty fourth root with the captured native ownership metadata", () => {
    expect(uploadFixtureMetadata({})).toEqual({ accepted: true, uploadListed: true });
    const source = fs.readFileSync("scripts/ci/guest-file-write-fixtures.sh", "utf8");
    expect(source).toContain("ROOTS = [TESTS, MOUNTS, GOLDEN, UPLOAD_GOLDEN]");
    expect(source).toContain("for p in [UPLOAD_GOLDEN, GOLDEN, TESTS, MOUNTS]:");
    expect(source).toContain("if any(value == p or value.startswith(p + '/') for p in ROOTS):");
    expect(source).toContain("if current != expected:");
    expect(source).not.toContain("umount', '--lazy");
  });
  it("refuses old three-root and foreign extra-root receipts", () => {
    expect(uploadFixtureMetadata({ oldReceipt: true }).accepted).toBe(false);
    expect(uploadFixtureMetadata({ foreignReceipt: true }).accepted).toBe(false);
  });
  it("refuses changed fourth-root owner group mode inode device and mount", () => {
    for (const changed of [{ uid: 1002 }, { gid: 1002 }, { mode: 0o755 }, { inode: 999 }, { device: 9 }, { mount: 99 }]) {
      expect(uploadFixtureMetadata({ uploadIdentity: changed }).accepted).toBe(false);
    }
  });
  it("refuses a nonempty fourth root and any unowned nested mount", () => {
    expect(uploadFixtureMetadata({ nonemptyUpload: true }).accepted).toBe(false);
    expect(uploadFixtureMetadata({ unexpectedMount: true }).accepted).toBe(false);
  });
});


// Synthetic reports and isolated mutation bookkeeping models do not execute
// Docker/dpkg or replace the four mandatory root-owned Debian observations.
const nativePackageNames = [
  "TestPackageHelperNativeNoFollowAndCustody", "TestPackageFrontendLockIndependentProcess",
  "TestPackageNativeSignedFirstInstallAndNonReplay", "TestPackageNativeDeclaredMountAndACLRefusals",
];
const nativePackage = "github.com/GODOSTROYER/zenith/go/internal/machine";
function packageRecords(): Event[] {
  const items: Event[] = [{ Action: "start", Package: nativePackage }];
  for (const name of nativePackageNames) {
    items.push({ Action: "run", Package: nativePackage, Test: name });
    if (name === "TestPackageNativeSignedFirstInstallAndNonReplay") for (const suffix of ["foreign_audience", "foreign_operation", "foreign_workspace", "missing_resource", "unknown_constraint"]) {
      items.push({ Action: "run", Package: nativePackage, Test: `${name}/${suffix}` }, { Action: "pass", Package: nativePackage, Test: `${name}/${suffix}` });
    }
    items.push({ Action: "pass", Package: nativePackage, Test: name });
  }
  items.push({ Action: "pass", Package: nativePackage });
  return items;
}
const packageMutationModel = String.raw`
import ast, json, pathlib, sys
case = json.loads(sys.argv[2])
program = ast.parse(pathlib.Path(sys.argv[1]).read_text())
main = next(n for n in program.body if isinstance(n, ast.FunctionDef) and n.name == 'main')
mutation = next(n for n in main.body if isinstance(n, ast.FunctionDef) and n.name == 'mutate')
mutation.body = [ast.Global(names=['pending'])] + [n for n in mutation.body if not isinstance(n, ast.Nonlocal)]
ast.fix_missing_locations(mutation)
namespace = {'MIB': 1024**2, 'counter': 1, 'pending': 'prior' if case.get('prior') else None,
             'scope': {'delivery': None}, 'context_identity': 'own'}
observations = {'commands': 0, 'saved': [], 'contexts': 0}
def context():
    observations['contexts'] += 1
    return 'foreign' if case.get('contextAt') == observations['contexts'] else 'own'
def inspect():
    return {'ExecIDs': ['unfinished'] if case.get('activeExec') else []}
def save(name):
    observations['saved'].append(name)
    if case.get('saveFailure') and name.endswith(case['saveFailure']):
        raise RuntimeError('model write failure')
def command(*argv, **kwargs):
    observations['commands'] += 1
    if case.get('deliveryFailure'):
        raise RuntimeError('model unconfirmed delivery')
    return b'fixed bounded success'
namespace.update(safe_context=context, inspect_container=inspect, save=save, docker=command)
exec(compile(ast.Module(body=[mutation], type_ignores=[]), 'isolated-mutation-model', 'exec'), namespace)
try:
    namespace['mutate'](case.get('argv', ['cp', 'fixed-source', 'own:/tmp/fixed']), exec_command=case.get('exec', False))
    accepted = True
except RuntimeError:
    accepted = False
print(json.dumps({'accepted': accepted, 'pending': namespace['pending'] is not None,
                  'commands': observations['commands'], 'saved': observations['saved']}))
`;
function packageMutation(input: Record<string, unknown>) {
  const child = spawnSync("python3", ["-B", "-c", packageMutationModel, path.resolve("scripts/ci/guest-package-fixtures.py"), JSON.stringify(input)], { encoding: "utf8", env: { PATH: process.env.PATH, NODE_ENV: "test" }, maxBuffer: 1024 * 1024 });
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe("");
  return JSON.parse(child.stdout) as { accepted: boolean; pending: boolean; commands: number; saved: string[] };
}


const packageLoopModel = String.raw`
import ast, json, pathlib, re, sys
reply = json.loads(sys.argv[2])
main = next(n for n in ast.parse(pathlib.Path(sys.argv[1]).read_text()).body if isinstance(n, ast.FunctionDef) and n.name == 'main')
reader = next(n for n in main.body if isinstance(n, ast.FunctionDef) and n.name == 'loop_record')
backing = {'inode': 12, 'deviceInode': '8:12', 'majorMinor': '8:1'}
namespace = {'json': json, 're': re, 'loop': '/dev/loop7', 'backing': backing,
             'backing_identity': lambda: backing.copy(), 'execute': lambda _: json.dumps(reply).encode()}
exec(compile(ast.Module(body=[reader], type_ignores=[]), 'isolated-loop-reply-model', 'exec'), namespace)
try:
    value = namespace['loop_record']()
    result = 'unbound' if value is None else 'owned'
except RuntimeError:
    result = 'refused'
print(json.dumps({'result': result}))
`;
function packageLoop(reply: Record<string, unknown>) {
  const child = spawnSync("python3", ["-B", "-c", packageLoopModel, path.resolve("scripts/ci/guest-package-fixtures.py"), JSON.stringify(reply)], { encoding: "utf8", env: { PATH: process.env.PATH, NODE_ENV: "test" }, maxBuffer: 1024 * 1024 });
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe("");
  return (JSON.parse(child.stdout) as { result: string }).result;
}

describe("mandatory direct native package phase admission", () => {
  it("preserves all123 original obligations and routes exactly four root cases to required native execution", () => {
    const manifest = linuxGuestManifest();
    expect(manifest.raceCases).toHaveLength(123); expect(manifest.requiredCases).toHaveLength(127);
    expect(manifest.requiredCases).toEqual([...manifest.raceCases, ...manifest.packagePhase.requiredCases]);
    expect(manifest.packagePhase.requiredCases).toEqual(nativePackageNames.map(test => ({ package: nativePackage, test, id: `linux-guest:${nativePackage}:${test}` })));
    expect(manifest.packagePhase.requiredPackages).toEqual([nativePackage]);
    expect(manifest.packagePhase.noTestPackages).toEqual([]); expect(manifest.packagePhase.allowedSkips).toEqual([]);
    expect(manifest.packagePhase.env).toEqual({ ZENITH_TEST_PACKAGE_INSTALL_REQUIRED: "1" });
    const pattern = `^(${nativePackageNames.join("|")})$`;
    expect(manifest.steps.find(item => item.id === "race")?.command).toEqual(["go", "test", "-json", "-race", "-count=1", "./...", "-skip", pattern]);
    for (const name of [...manifest.raceCases.map(item => item.test), "TestPackageNativeReadbackPreservesRegistryAndIdentity", "TestPackageNativeSignedFirstInstallAndNonReplay_foreign"]) expect(new RegExp(pattern).test(name), name).toBe(false);
    expect(validateGoEvents(stream(packageRecords()), goodExit, manifest.packagePhase).verdict).toBe("passed");
  });
  it("pins the genuine native4 declarations and refuses deletion or substituted source names", () => {
    const source = fs.readFileSync("go/internal/machine/package_helper_linux_test.go", "utf8");
    expect(createHash("sha256").update(source).digest("hex")).toBe("b7b2d7cbb6d21baef5b39ce8f2eab14f80fff245cc03e633cfb53f5bf3ce6331");
    const declared = (text: string) => nativePackageNames.filter(name => new RegExp(`^func ${name}\\(t \\*testing\\.T\\)`, "m").test(text));
    expect(declared(source)).toEqual(nativePackageNames);
    for (const name of nativePackageNames) expect(declared(source.replace(`func ${name}(`, `func ${name}_foreign(`))).not.toContain(name);
    expect(source).toContain('os.Getenv("ZENITH_TEST_PACKAGE_INSTALL_REQUIRED") != "1"');
    expect(source).toContain('"zenith-owned-disposable-package-install-v1\\n"');
  });
  it("refuses each missing root case while the other actual report observations pass", () => {
    const phase = linuxGuestManifest().packagePhase;
    for (const required of phase.requiredCases) {
      const items = packageRecords().filter(item => item.Test !== required.test && !item.Test?.startsWith(required.test + "/"));
      const result = validateGoEvents(stream(items), goodExit, phase);
      expect(result.verdict, required.id).toBe("failed");
      expect(result.required.find(item => item.id === required.id)?.status).toBe("missing");
    }
  });
  it.each(["fail", "skip"])("refuses every package root %s without optional allowance", action => {
    const phase = linuxGuestManifest().packagePhase;
    for (const required of phase.requiredCases) {
      const items = packageRecords().map(item => item.Test === required.test && item.Action === "pass" ? { ...item, Action: action } : item);
      expect(validateGoEvents(stream(items), goodExit, phase).verdict, required.id).toBe("failed");
    }
  });
  it("refuses zero malformed duplicate truncated foreign and output-only package observations", () => {
    const phase = linuxGuestManifest().packagePhase, items = packageRecords();
    for (const raw of ["", "{}\n", stream(items).slice(0, -1), stream(items.slice(0, -1)), stream([...items.slice(0, -1), items[2], items.at(-1)!]), stream(items.map(item => ({ ...item, Package: pkg }))), stream([{ Action: "start", Package: nativePackage }, { Action: "output", Package: nativePackage, Output: JSON.stringify({ nativeCases: nativePackageNames, verdict: "passed", cleanupComplete: true }) }, { Action: "pass", Package: nativePackage }])]) expect(validateGoEvents(raw, goodExit, phase).verdict).toBe("failed");
    for (const required of phase.requiredCases) {
      const substituted = items.map(item => {
        const test = item.Test;
        return typeof test === "string" && (test === required.test || test.startsWith(required.test + "/"))
          ? { ...item, Test: test.replace(required.test, required.test + "_foreign") } : item;
      });
      expect(validateGoEvents(stream(substituted), goodExit, phase).verdict).toBe("failed");
    }
    for (const observation of [{ status: 1, signal: null, observed: true }, { status: null, signal: "SIGTERM", observed: true }, { status: 0, signal: null, observed: false }]) expect(validateGoEvents(stream(items), observation, phase).verdict).toBe("failed");
  });
  it("uses source/current-attempt-bound native setup and only publishes fixed completed fixture scalars", () => {
    const helper = fs.readFileSync("scripts/ci/guest-package-fixtures.py", "utf8"), runner = fs.readFileSync("scripts/ci/run-guest-file-write-gate.mjs", "utf8");
    expect(helper).toContain("INDEX = 'sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251'");
    for (const guard of ["arch != args.arch", "daemon_arch != arch", "native pinned Go prerequisite refused", "copied toolchain refused", "actual dpkg architecture refused", "native metadata changed during copy", "native config or registry changed", "source changed during native attempt", "foreign loop mount; preserve backing", "backing association unresolved", "unrelated baseline changed", "new image cleanup unconfirmed"]) expect(helper).toContain(guard);
    expect(helper).toContain("return run(['docker', '--config', str(docker_config), '--host', socket_host, *argv], timeout, limit)");
    expect(helper).toContain("socket_host is not None and socket_host != host");
    expect(helper).toContain("private unauthenticated registry config changed");
    expect(helper).not.toContain("urllib"); expect(helper).not.toContain("apt-get"); expect(helper).not.toContain("--privileged");
    expect(helper).toContain("container + ':/guest/go.tar.gz'");
    expect(helper).toContain("container + ':/guest/source.tar.gz'");
    expect(helper).toContain("tar --no-same-owner -xzf /guest/go.tar.gz -C /guest/rootfs/usr/local");
    expect(helper).toContain("tar --no-same-owner -xzf /guest/source.tar.gz -C /guest/rootfs/root/source; rm /guest/source.tar.gz /guest/go.tar.gz");
    expect(helper).not.toContain("/tmp/go.tar.gz"); expect(helper).not.toContain("/tmp/source.tar.gz");
    const staging = helper.slice(helper.indexOf("STAGE_PUBLIC = "), helper.indexOf("\n\nINSTALL_PROBE = "));
    for (const guard of ["/guest/go.tar.gz", "/guest/source.tar.gz", "/guest/probe.go", "regular file:1:$2", "test ! -L", "%d:%i:%F:%h:%s", "chown --no-dereference 0:0", "chmod 0600", "0:0:600:1:$2", "sha256sum", "${actual%% *}"]) expect(staging).toContain(guard);
    expect(staging.indexOf("chown --no-dereference 0:0")).toBeLessThan(staging.indexOf("chmod 0600"));
    expect(staging.indexOf("chmod 0600")).toBeLessThan(staging.indexOf("actual=$(sha256sum"));
    expect(helper.indexOf("stage_public(tool, '/guest/go.tar.gz', scope['toolArchiveSha256'])")).toBeLessThan(helper.indexOf("execute(['bash', '-c', COPY"));
    expect(helper.indexOf("stage_public(out / 'probe.go', '/guest/probe.go', digest(PROBE_GO.encode()))")).toBeLessThan(helper.indexOf("'build', '-p=1', '-o'"));
    expect(helper.indexOf("stage_public(archive, '/guest/source.tar.gz', archive_sha)")).toBeLessThan(helper.indexOf("execute(['bash', '-c', 'mkdir -m0700"));
    const probeInstall = helper.slice(helper.indexOf("INSTALL_PROBE = "), helper.indexOf("\n\nCOPY = "));
    for (const guard of ["/guest/rootfs/root/probe.go", "directory:0:0:755", "test ! -L", "parent_identity", "source_identity", "test ! -e /guest/rootfs/root/probe.go", "cp --no-clobber --no-dereference --preserve=mode", "regular file:0:0:600:1:$1", "sha256sum"]) expect(probeInstall).toContain(guard);
    expect(probeInstall.indexOf("test ! -e /guest/rootfs/root/probe.go")).toBeLessThan(probeInstall.indexOf("cp --no-clobber"));
    expect(helper).toContain("container + ':/guest/probe.go'");
    expect(helper).not.toContain("container + ':/guest/rootfs/root/probe.go'");
    expect(helper.indexOf("stage_public(out / 'probe.go', '/guest/probe.go', digest(PROBE_GO.encode()))")).toBeLessThan(helper.indexOf("execute(['bash', '-c', INSTALL_PROBE"));
    expect(helper.indexOf("execute(['bash', '-c', INSTALL_PROBE")).toBeLessThan(helper.indexOf("'build', '-p=1', '-o'"));
    const stageModel = String.raw`
import ast, hashlib, json, pathlib, re, sys, types
case = json.loads(sys.argv[2])
module = ast.parse(pathlib.Path(sys.argv[1]).read_text())
main = next(n for n in module.body if isinstance(n, ast.FunctionDef) and n.name == 'main')
stage = next(n for n in main.body if isinstance(n, ast.FunctionDef) and n.name == 'stage_public')
script = ast.literal_eval(next(n.value for n in module.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'STAGE_PUBLIC' for t in n.targets)))
raw = b'fixed public fixture bytes'
digest = lambda data: hashlib.sha256(data).hexdigest()
class File:
    def lstat(self): return types.SimpleNamespace(st_nlink=case.get('links', 1), st_size=case.get('size', len(raw)))
    def is_file(self): return case.get('regular', True)
    def is_symlink(self): return case.get('symlink', False)
    def read_bytes(self): return raw
commands = []
namespace = {'MIB': 1024**2, 're': re, 'digest': digest, 'STAGE_PUBLIC': script,
             'execute': lambda argv: commands.append(argv)}
exec(compile(ast.Module(body=[stage], type_ignores=[]), 'isolated-public-stage-model', 'exec'), namespace)
try:
    namespace['stage_public'](File(), case.get('target', '/guest/go.tar.gz'), case.get('expected', digest(raw)))
    accepted = True
except RuntimeError:
    accepted = False
print(json.dumps({'accepted': accepted, 'commands': len(commands),
                  'exactCommand': not commands or commands == [['bash', '-c', script, 'fixed-public-staging', case.get('target', '/guest/go.tar.gz'), str(len(raw)), digest(raw)]]}))
`;
    const stage = (input: Record<string, unknown>) => {
      const child = spawnSync("python3", ["-B", "-c", stageModel, path.resolve("scripts/ci/guest-package-fixtures.py"), JSON.stringify(input)], { encoding: "utf8", env: { PATH: process.env.PATH, NODE_ENV: "test" }, maxBuffer: 1024 * 1024 });
      expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe("");
      return JSON.parse(child.stdout) as { accepted: boolean; commands: number; exactCommand: boolean };
    };
    for (const target of ["/guest/go.tar.gz", "/guest/source.tar.gz", "/guest/probe.go"]) expect(stage({ target })).toEqual({ accepted: true, commands: 1, exactCommand: true });
    for (const fault of [{ target: "/etc/dpkg/dpkg.cfg" }, { target: "/guest/rootfs/var/lib/dpkg/status" }, { target: "/tmp/go.tar.gz" }, { target: "/guest/rootfs/root/probe.go" }, { regular: false }, { symlink: true }, { links: 2 }, { size: 0 }, { size: 192 * 1024 ** 2 + 1 }, { target: "/guest/source.tar.gz", size: 32 * 1024 ** 2 + 1 }, { target: "/guest/probe.go", size: 1024 ** 2 + 1 }, { expected: "0".repeat(64) }, { expected: "unknown" }]) expect(stage(fault)).toEqual({ accepted: false, commands: 0, exactCommand: true });
    expect(helper).not.toContain("--force"); expect(helper).not.toContain("--lazy"); expect(helper).not.toContain("-v /:");
    expect(helper).toContain("CAPS = ('SYS_ADMIN', 'SYS_CHROOT', 'MKNOD', 'CHOWN', 'SETUID', 'SETGID')");
    expect(helper).toContain("apparmor = 'name=apparmor' in info.get('SecurityOptions', [])");
    expect(helper).toContain("security_args = ['--security-opt', 'apparmor=unconfined'] if apparmor else []");
    expect(helper).toContain("h.get('SecurityOpt') not in ([['apparmor=unconfined']] if apparmor else [None, []])");
    expect(helper.indexOf("save('terminal')")).toBeLessThan(helper.indexOf("sys.stdout.buffer.write(raw_events)"));
    expect(helper.indexOf("scope['cleanupComplete'] = True")).toBeGreaterThan(helper.indexOf("unrelated baseline changed"));
    expect(runner).toContain('step.id === "package-native" ? manifest.packagePhase : { ...manifest, requiredCases: manifest.raceCases }');
    expect(runner).toContain('fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW');
    expect(runner).toContain('proof.cleanupComplete !== true || proof.delivery !== null');
    expect(runner).toContain('proof.attempt !== attemptId'); expect(runner).toContain('proof.emulated !== false');
    expect(runner).toContain('ownedDirectory(path.dirname(file))');
    expect(runner).not.toContain("run_guest_package_native_linux.py");
  });

  it("accepts only the actual pinned singleton unbound reply and exact owning loop attachment", () => {
    const free = { name: "/dev/loop7", "back-ino": null, "back-maj:min": null, offset: null, sizelimit: null, ro: false };
    const owned = { ...free, "back-ino": 12, "back-maj:min": "8:1", offset: 0, sizelimit: 0 };
    expect(packageLoop({ loopdevices: [free] })).toBe("unbound");
    expect(packageLoop({ loopdevices: [owned] })).toBe("owned");
    expect(packageLoop({ loopdevices: [{ ...owned, "back-maj:min": "     8:1  " }] })).toBe("owned");
    for (const device of ["\t8:1", "8:1\n", "8:1\r", "8 :1", "08:1", "8:01", " 9:1 ", " 8:2 ", "8:1x", "", " ", null, 81]) expect(packageLoop({ loopdevices: [{ ...owned, "back-maj:min": device }] })).toBe("refused");
    const { "back-ino": _omitted, ...partial } = free;
    expect(_omitted).toBeNull();
    for (const reply of [{}, { loopdevices: [] }, { loopdevices: [free], unknown: true }, { loopdevices: [free, free] }, { loopdevices: [partial] }, { loopdevices: [{ ...free, name: "/dev/loop8" }] }, { loopdevices: [{ ...free, ro: true }] }, { loopdevices: [{ ...free, offset: 0 }] }, { loopdevices: [{ ...owned, "back-ino": 13 }] }, { loopdevices: [{ ...owned, "back-maj:min": "9:1" }] }, { loopdevices: [{ ...owned, offset: false }] }, { loopdevices: [{ ...owned, sizelimit: 1 }] }, { loopdevices: [{ ...owned, extra: null }] }]) expect(packageLoop(reply)).toBe("refused");
    const helper = fs.readFileSync("scripts/ci/guest-package-fixtures.py", "utf8");
    expect(helper).toContain("execute(['losetup', loop, '/guest/rootfs.ext4'])");
    expect(helper).not.toContain("losetup', '--find', '--show");
  });
  it("retains an uncertainty pin through launch timeout daemon delivery and completion bookkeeping failure", () => {
    expect(packageMutation({})).toEqual({ accepted: true, pending: false, commands: 1, saved: ["002-intent", "002-complete"] });
    expect(packageMutation({ prior: true })).toEqual({ accepted: false, pending: true, commands: 0, saved: [] });
    expect(packageMutation({ argv: ["system", "prune"] })).toEqual({ accepted: false, pending: false, commands: 0, saved: [] });
    for (const fault of [{ deliveryFailure: true }, { saveFailure: "intent" }, { saveFailure: "complete" }, { contextAt: 2 }, { exec: true, activeExec: true }]) {
      const result = packageMutation(fault);
      expect(result.accepted).toBe(false); expect(result.pending).toBe(true);
    }
    expect(packageMutation({ contextAt: 1 })).toEqual({ accepted: false, pending: false, commands: 0, saved: [] });
    const helper = fs.readFileSync("scripts/ci/guest-package-fixtures.py", "utf8");
    expect(helper.indexOf("pending = '%03d'")).toBeLessThan(helper.indexOf("raw = docker(*argv"));
    expect(helper.indexOf("save(pending + '-complete')")).toBeLessThan(helper.indexOf("pending = None\n        return raw"));
    expect(helper).toContain("if pending is not None:\n            raise RuntimeError('daemon delivery unconfirmed; preserve owned resources')");
    expect(helper).toContain("os.killpg(proc.pid, 0)");
  });
});
