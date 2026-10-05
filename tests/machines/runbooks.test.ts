/**
 * PROD-MACH-03: signed, versioned runbooks; bounded targets/windows/cancellation;
 * approval binding; audit chain; raw exec stays an approved high-risk escape hatch.
 * Real Ed25519 signatures and the real service/runner over the in-memory store; the
 * machine layer is the injected step executor.
 */
import { describe, expect, it } from "vitest";
import { generateSigningJwk, LocalJwkSigner } from "@/lib/credentials/signing";
import type { Principal } from "@/lib/controlplane/types";
import { MachineOperationError } from "@/lib/machines/errors";
import type { MachineRequest, MachineResult } from "@/lib/machines/types";
import {
  MemoryRunbookStore,
  RunbookError,
  adHocDeadline,
  bindingDigestOf,
  classifyRunbook,
  createRunbookService,
  decideSlot,
  definitionDigest,
  executeRunbookRun,
  nextSlotInWindow,
  parseRunbookDefinition,
  parseRunbookTargets,
  parseScheduleSpec,
  signRunbookVersion,
  stepOperationId,
  verifyAuditChain,
  verifyRunbookVersion,
  windowAt,
  type RunbookStepExecutor,
} from "@/lib/machines/runbooks";

const WS = "ws-1";
const T0 = Date.UTC(2026, 9, 5, 2, 0, 0); // Monday 2026-10-05 02:00 UTC
const user = (id: string): Principal => ({ kind: "user", id, name: id });
const TARGET = { transport: "zenithd" as const, targetId: "mach-1", resourceId: "res-1", environmentId: "env-1" };
const TARGET2 = { transport: "zenithd" as const, targetId: "mach-2", resourceId: "res-2", environmentId: "env-1" };

const readOnly = { schemaVersion: 1, name: "inspect", steps: [{ id: "status", title: "Status", operation: "service.status", args: { unit: "nginx.service" } }] };
const mutating = { schemaVersion: 1, name: "restart", steps: [{ id: "restart", title: "Restart", operation: "machine.service.restart", args: { unit: "nginx.service" } }, { id: "check", title: "Check", operation: "service.status", args: { unit: "nginx.service" } }] };
const rawExec = { schemaVersion: 1, name: "exec", steps: [{ id: "run", title: "Run", operation: "machine.exec", args: { argv: ["echo", "hi"], timeoutSec: 10 }, timeoutSec: 10 }] };

async function fixture(opts: { clock?: { t: number } } = {}) {
  const clock = opts.clock ?? { t: T0 };
  const key = await generateSigningJwk("EdDSA");
  const signer = LocalJwkSigner.fromJwk("test", key.privateJwk, { alg: "EdDSA" });
  const store = new MemoryRunbookStore();
  const keys = [signer.publicJwk()];
  const denied = new Set<string>();
  const service = createRunbookService({
    store,
    signer,
    verificationKeys: async () => keys,
    authorize: async (p, _ws, action) => !denied.has(`${p.id}:${action}`),
    now: () => new Date(clock.t),
  });
  return { clock, store, signer, keys, service, denied };
}

function okResult(req: MachineRequest): MachineResult {
  return { ok: true, operation: req.operation, data: {}, startedAt: "x", finishedAt: "y", transport: req.target.transport, simulated: true, evidenceId: `ev-${req.operationId.slice(0, 8)}` };
}

describe("definition and classification", () => {
  it("normalises args with the executor's own schema and rejects invalid or duplicate steps", () => {
    const def = parseRunbookDefinition(readOnly);
    expect(def.steps[0].timeoutSec).toBe(30);
    expect(() => parseRunbookDefinition({ ...readOnly, steps: [{ id: "a", title: "A", operation: "service.status", args: { unit: "nginx.service", extra: 1 } }] })).toThrow(RunbookError);
    expect(() => parseRunbookDefinition({ ...readOnly, steps: [...readOnly.steps, ...readOnly.steps] })).toThrow(/invalid/);
    expect(() => parseRunbookDefinition({ ...readOnly, steps: [{ ...readOnly.steps[0], operation: "file.read" }] })).toThrow(RunbookError);
  });

  it("refuses credential-looking material in step arguments", () => {
    const secret = `AKIA${"A".repeat(16)}`;
    const bad = { ...rawExec, steps: [{ ...rawExec.steps[0], args: { argv: ["echo", secret], timeoutSec: 10 } }] };
    expect(() => parseRunbookDefinition(bad)).toThrow(RunbookError);
  });

  it("classifies by operation: read-only needs no approval, mutating does, raw exec is critical and never safe", () => {
    const ro = classifyRunbook(parseRunbookDefinition(readOnly));
    expect(ro).toMatchObject({ risk: "low", requiresApproval: false, escapeHatchSteps: [] });
    const mut = classifyRunbook(parseRunbookDefinition(mutating));
    expect(mut.requiresApproval).toBe(true);
    expect(mut.mutatingSteps).toEqual(["restart"]);
    const raw = classifyRunbook(parseRunbookDefinition(rawExec));
    expect(raw).toMatchObject({ risk: "critical", requiresApproval: true, escapeHatchSteps: ["run"], argvClassification: "never_classified_safe" });
  });

  it("a harmless-looking argv is classified exactly like a dangerous one", () => {
    const benign = parseRunbookDefinition(rawExec);
    const dangerous = parseRunbookDefinition({ ...rawExec, steps: [{ ...rawExec.steps[0], args: { argv: ["rm", "-rf", "/"], timeoutSec: 10 } }] });
    expect(classifyRunbook(benign)).toEqual(classifyRunbook(dangerous));
  });

  it("targets must be resource-scoped, unique and bounded; order does not change the digest", () => {
    expect(() => parseRunbookTargets([{ transport: "zenithd", targetId: "m" }])).toThrow(RunbookError);
    expect(() => parseRunbookTargets([TARGET, TARGET])).toThrow(/unique/);
    expect(() => parseRunbookTargets(Array.from({ length: 26 }, (_, i) => ({ ...TARGET, targetId: `m${i}` })))).toThrow(RunbookError);
    expect(parseRunbookTargets([TARGET2, TARGET])).toEqual(parseRunbookTargets([TARGET, TARGET2]));
  });
});

describe("signing", () => {
  it("verifies, and refuses a tampered definition, wrong version, wrong key and malformed tokens", async () => {
    const { signer, keys } = await fixture();
    const def = parseRunbookDefinition(mutating);
    const signed = await signRunbookVersion(signer, { workspaceId: WS, runbookId: "rb", version: 1, definition: def, now: new Date(T0) });
    expect(signed.digest).toBe(definitionDigest(def));
    const subject = { workspaceId: WS, runbookId: "rb", version: 1, definition: def, signature: signed.signature };
    await expect(verifyRunbookVersion(subject, keys)).resolves.toMatchObject({ ver: 1, dig: signed.digest });

    const tampered = parseRunbookDefinition({ ...mutating, steps: [{ ...mutating.steps[0], args: { unit: "sshd-other.service" } }, mutating.steps[1]] });
    await expect(verifyRunbookVersion({ ...subject, definition: tampered }, keys)).rejects.toMatchObject({ code: "signature_invalid" });
    await expect(verifyRunbookVersion({ ...subject, version: 2 }, keys)).rejects.toMatchObject({ code: "signature_invalid" });
    await expect(verifyRunbookVersion({ ...subject, workspaceId: "other" }, keys)).rejects.toMatchObject({ code: "signature_invalid" });
    const other = await generateSigningJwk("EdDSA");
    await expect(verifyRunbookVersion(subject, [other.publicJwk])).rejects.toMatchObject({ code: "signature_invalid" });
    await expect(verifyRunbookVersion({ ...subject, signature: "a.b" }, keys)).rejects.toMatchObject({ code: "signature_invalid" });
    await expect(verifyRunbookVersion({ ...subject, signature: `${subject.signature}x` }, keys)).rejects.toMatchObject({ code: "signature_invalid" });
  });

  it("a signature of a different typ (a capability grant) is not accepted as a runbook", async () => {
    const { signer, keys } = await fixture();
    const def = parseRunbookDefinition(readOnly);
    const jws = await signer.sign({ typ: "zenith-grant+jwt" }, { iss: "zenith-control", ws: WS, rb: "rb", ver: 1, dig: definitionDigest(def), iat: 1 });
    await expect(verifyRunbookVersion({ workspaceId: WS, runbookId: "rb", version: 1, definition: def, signature: jws }, keys)).rejects.toMatchObject({ code: "signature_invalid" });
  });
});

describe("schedule math", () => {
  const window = { days: [1], startMinute: 120, endMinute: 180 }; // Mondays 02:00-03:00 UTC
  it("windows are UTC, day-bound and do not cross midnight", () => {
    expect(windowAt([window], T0)?.endMs).toBe(Date.UTC(2026, 9, 5, 3, 0, 0));
    expect(windowAt([window], T0 + 3600_000)).toBeUndefined();
    expect(windowAt([window], T0 - 86_400_000)).toBeUndefined();
    expect(() => parseScheduleSpec({ cadence: { kind: "once", at: new Date(T0).toISOString().replace(".000Z", "Z") }, windows: [{ days: [1], startMinute: 100, endMinute: 100 }] })).toThrow(RunbookError);
    expect(() => parseScheduleSpec({ cadence: { kind: "once", at: "2026-10-05T02:00:00Z" }, windows: [] })).toThrow(RunbookError);
  });

  it("interval slots only land inside a window; the search is bounded", () => {
    const spec = parseScheduleSpec({ cadence: { kind: "interval", everySec: 1800, anchor: "2026-10-01T00:00:00Z" }, windows: [window] });
    expect(nextSlotInWindow(spec, T0 - 1)).toBe(T0);
    expect(nextSlotInWindow(spec, T0)).toBe(T0 + 1800_000);
    expect(nextSlotInWindow(spec, T0 + 1800_000)).toBe(Date.UTC(2026, 9, 12, 2, 0, 0));
    const never = parseScheduleSpec({ cadence: { kind: "once", at: "2026-10-06T02:00:00Z" }, windows: [window] });
    expect(nextSlotInWindow(never, T0)).toBeUndefined();
  });

  it("a slot never runs late or past its window, and notAfter caps the deadline", () => {
    const spec = parseScheduleSpec({ cadence: { kind: "interval", everySec: 1800, anchor: "2026-10-01T00:00:00Z" }, windows: [window], maxRunDurationSec: 7200, notAfter: "2026-10-05T02:40:00Z" });
    const run = decideSlot(spec, T0, T0 + 5_000);
    expect(run).toMatchObject({ action: "run", deadlineMs: Date.UTC(2026, 9, 5, 2, 40, 0) });
    expect(decideSlot(spec, T0, T0 + 6 * 60_000)).toMatchObject({ action: "missed", reason: "late" });
    expect(decideSlot(spec, T0 + 3600_000, T0 + 3600_000)).toMatchObject({ action: "missed", reason: "outside_window" });
  });

  it("ad-hoc runs outside their window are refused", () => {
    expect(() => adHocDeadline({ nowMs: T0 + 3600_000, windows: [window], maxRunDurationSec: 600 })).toThrow(RunbookError);
    expect(adHocDeadline({ nowMs: T0, windows: [window], maxRunDurationSec: 7200 })).toBe(Date.UTC(2026, 9, 5, 3, 0, 0));
  });

  it("the binding digest changes with any bound field", () => {
    const def = parseRunbookDefinition(mutating);
    const base = { workspaceId: WS, runbookId: "rb", version: 1, definitionDigest: definitionDigest(def), targets: parseRunbookTargets([TARGET]), maxRunDurationSec: 600, maxParallelTargets: 1 };
    const d = bindingDigestOf(base);
    expect(bindingDigestOf({ ...base, targets: parseRunbookTargets([TARGET, TARGET2]) })).not.toBe(d);
    expect(bindingDigestOf({ ...base, maxParallelTargets: 2 })).not.toBe(d);
    expect(bindingDigestOf({ ...base, windows: [window] })).not.toBe(d);
    expect(bindingDigestOf({ ...base, version: 2 })).not.toBe(d);
    expect(bindingDigestOf({ ...base })).toBe(d);
  });
});

describe("service: publish, request, approve, cancel", () => {
  it("publishes immutable monotonically numbered versions with an audit entry", async () => {
    const f = await fixture();
    const v1 = await f.service.publish({ workspaceId: WS, runbookId: "rb", definition: mutating, principal: user("alice") });
    const v2 = await f.service.publish({ workspaceId: WS, runbookId: "rb", definition: mutating, principal: user("alice") });
    expect([v1.version, v2.version]).toEqual([1, 2]);
    await expect(f.store.insertVersion(v1)).rejects.toMatchObject({ code: "conflict" });
    const audit = await f.service.listAudit(WS, "runbook:rb");
    expect(audit.map((a) => a.event)).toEqual(["runbook.published", "runbook.published"]);
    expect(verifyAuditChain(audit)).toBe(true);
    f.denied.add("mallory:publish");
    await expect(f.service.publish({ workspaceId: WS, runbookId: "rb", definition: mutating, principal: user("mallory") })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("read-only runs need no approval; mutating and raw exec runs wait for an independent approver", async () => {
    const f = await fixture();
    await f.service.publish({ workspaceId: WS, runbookId: "ro", definition: readOnly, principal: user("alice") });
    await f.service.publish({ workspaceId: WS, runbookId: "mut", definition: mutating, principal: user("alice") });
    await f.service.publish({ workspaceId: WS, runbookId: "raw", definition: rawExec, principal: user("alice") });
    const ro = await f.service.requestRun({ workspaceId: WS, runbookId: "ro", targets: [TARGET], principal: user("bob") });
    expect(ro.status).toBe("approved");
    const mut = await f.service.requestRun({ workspaceId: WS, runbookId: "mut", targets: [TARGET], principal: user("bob") });
    expect(mut.status).toBe("pending_approval");
    await expect(f.service.approveRun({ workspaceId: WS, runId: mut.id, principal: user("bob") })).rejects.toMatchObject({ code: "forbidden" });
    await expect(f.service.approveRun({ workspaceId: WS, runId: mut.id, principal: { kind: "integration", id: "ci", name: "ci" } })).rejects.toMatchObject({ code: "forbidden" });
    const approved = await f.service.approveRun({ workspaceId: WS, runId: mut.id, principal: user("carol") });
    expect(approved.status).toBe("approved");
    const raw = await f.service.requestRun({ workspaceId: WS, runbookId: "raw", targets: [TARGET], principal: user("bob") });
    expect(raw.status).toBe("pending_approval");
    await expect(f.service.approveRun({ workspaceId: WS, runId: raw.id, principal: user("carol"), ttlSec: 7 * 86_400 })).resolves.toBeDefined();
    const approval = await f.store.findValidApproval(WS, raw.bindingDigest, new Date(f.clock.t));
    // a run approval never outlives the run's own window
    expect(approval!.expiresAt).toBe(raw.deadlineAt);
  });

  it("an approval for one binding does not satisfy a different target set", async () => {
    const f = await fixture();
    await f.service.publish({ workspaceId: WS, runbookId: "mut", definition: mutating, principal: user("alice") });
    const a = await f.service.requestRun({ workspaceId: WS, runbookId: "mut", targets: [TARGET], principal: user("bob") });
    await f.service.approveRun({ workspaceId: WS, runId: a.id, principal: user("carol") });
    const wider = await f.service.requestRun({ workspaceId: WS, runbookId: "mut", targets: [TARGET, TARGET2], principal: user("bob") });
    expect(wider.status).toBe("pending_approval");
    const same = await f.service.requestRun({ workspaceId: WS, runbookId: "mut", targets: [TARGET], principal: user("bob") });
    expect(same.status).toBe("approved");
  });

  it("refuses to request or approve when the stored version no longer verifies", async () => {
    const f = await fixture();
    await f.service.publish({ workspaceId: WS, runbookId: "mut", definition: mutating, principal: user("alice") });
    const run = await f.service.requestRun({ workspaceId: WS, runbookId: "mut", targets: [TARGET], principal: user("bob") });
    const rec = (await f.store.getVersion(WS, "mut", 1))!;
    rec.definition.steps[0].args = { unit: "other.service" }; // the memory store returns clones; mutate via a fresh insert path below
    const forged = new MemoryRunbookStore();
    await forged.insertVersion({ ...rec });
    const svc = createRunbookService({ store: forged, signer: f.signer, verificationKeys: async () => f.keys, authorize: async () => true, now: () => new Date(f.clock.t) });
    await expect(svc.requestRun({ workspaceId: WS, runbookId: "mut", targets: [TARGET], principal: user("bob") })).rejects.toMatchObject({ code: "signature_invalid" });
    expect(run.status).toBe("pending_approval");
  });

  it("cancel moves a pending run to cancelled immediately; a finished run cannot be cancelled", async () => {
    const f = await fixture();
    await f.service.publish({ workspaceId: WS, runbookId: "mut", definition: mutating, principal: user("alice") });
    const run = await f.service.requestRun({ workspaceId: WS, runbookId: "mut", targets: [TARGET], principal: user("bob") });
    const cancelled = await f.service.cancelRun({ workspaceId: WS, runId: run.id, principal: user("bob"), reason: "no longer needed" });
    expect(cancelled.status).toBe("cancelled");
    await expect(f.service.cancelRun({ workspaceId: WS, runId: run.id, principal: user("bob"), reason: "again" })).rejects.toMatchObject({ code: "conflict" });
    await expect(f.service.approveRun({ workspaceId: WS, runId: run.id, principal: user("carol") })).rejects.toMatchObject({ code: "conflict" });
  });

  it("other tenants cannot see or act on a run", async () => {
    const f = await fixture();
    await f.service.publish({ workspaceId: WS, runbookId: "ro", definition: readOnly, principal: user("alice") });
    const run = await f.service.requestRun({ workspaceId: WS, runbookId: "ro", targets: [TARGET], principal: user("bob") });
    expect(await f.service.getRun("ws-2", run.id)).toBeNull();
    await expect(f.service.cancelRun({ workspaceId: "ws-2", runId: run.id, principal: user("bob"), reason: "x" })).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("runner", () => {
  async function approvedRun(f: Awaited<ReturnType<typeof fixture>>, id: string, def: unknown, targets: unknown[] = [TARGET], over: { maxParallelTargets?: number } = {}) {
    await f.service.publish({ workspaceId: WS, runbookId: id, definition: def, principal: user("alice") });
    let run = await f.service.requestRun({ workspaceId: WS, runbookId: id, targets, principal: user("bob"), ...over });
    if (run.status === "pending_approval") run = await f.service.approveRun({ workspaceId: WS, runId: run.id, principal: user("carol") });
    return run;
  }
  const deps = (f: Awaited<ReturnType<typeof fixture>>, executeStep: RunbookStepExecutor, extra: { pollMs?: number } = {}) => ({ store: f.store, verificationKeys: async () => f.keys, executeStep, now: () => new Date(f.clock.t), ...extra });

  it("runs every step on every target, records custody and a verifiable audit chain", async () => {
    const f = await fixture();
    const run = await approvedRun(f, "mut", mutating, [TARGET, TARGET2], { maxParallelTargets: 2 });
    const seen: string[] = [];
    const done = await executeRunbookRun(deps(f, async (req) => { seen.push(`${req.target.targetId}:${req.operation}`); return okResult(req); }), { workspaceId: WS, runId: run.id });
    expect(done.status).toBe("succeeded");
    expect(seen.sort()).toEqual(["mach-1:machine.service.restart", "mach-1:service.status", "mach-2:machine.service.restart", "mach-2:service.status"]);
    const steps = await f.store.listSteps(WS, run.id);
    expect(steps).toHaveLength(4);
    expect(steps.every((s) => s.status === "succeeded" && s.operationId === stepOperationId(run.id, s.targetIndex, s.stepId))).toBe(true);
    const audit = await f.service.listAudit(WS, `run:${run.id}`);
    expect(verifyAuditChain(audit)).toBe(true);
    expect(audit.at(-1)).toMatchObject({ event: "run.finished", detail: { status: "succeeded" } });
    expect(JSON.stringify(audit)).not.toContain("nginx");
  });

  it("a request carries the exact signed args and a resource-scoped target", async () => {
    const f = await fixture();
    const run = await approvedRun(f, "mut", mutating);
    const reqs: MachineRequest[] = [];
    await executeRunbookRun(deps(f, async (req) => { reqs.push(req); return okResult(req); }), { workspaceId: WS, runId: run.id });
    expect(reqs[0]).toMatchObject({ operation: "machine.service.restart", args: { unit: "nginx.service" }, target: { workspaceId: WS, resourceId: "res-1", transport: "zenithd" } });
  });

  it("does not run when the stored definition no longer matches its signature", async () => {
    const f = await fixture();
    const run = await approvedRun(f, "mut", mutating);
    const rec = (await f.store.getVersion(WS, "mut", 1))!;
    const forged = new MemoryRunbookStore();
    await forged.insertVersion({ ...rec, definition: parseRunbookDefinition({ ...mutating, steps: [{ ...mutating.steps[0], args: { unit: "evil.service" } }, mutating.steps[1]] }) });
    // reuse the run row in the forged store
    await forged.insertRun(run);
    let called = false;
    const done = await executeRunbookRun({ ...deps(f, async (req) => { called = true; return okResult(req); }), store: forged }, { workspaceId: WS, runId: run.id });
    expect(done).toMatchObject({ status: "failed", failureCode: "signature_invalid" });
    expect(called).toBe(false);
  });

  it("fails closed without a valid approval for a mutating run", async () => {
    const f = await fixture();
    const run = await approvedRun(f, "mut", mutating);
    f.clock.t += 8 * 86_400_000; // approval expired; deadline also long past, but the gate is checked first
    let called = false;
    const done = await executeRunbookRun(deps(f, async (req) => { called = true; return okResult(req); }), { workspaceId: WS, runId: run.id });
    expect(done).toMatchObject({ status: "failed", failureCode: "approval_invalid" });
    expect(called).toBe(false);
  });

  it("aborts a target on failure but continues other targets; skipped steps are recorded", async () => {
    const f = await fixture();
    const run = await approvedRun(f, "mut", mutating, [TARGET, TARGET2], { maxParallelTargets: 1 });
    const done = await executeRunbookRun(deps(f, async (req) => (req.target.targetId === "mach-1" && req.operation === "machine.service.restart" ? { ...okResult(req), ok: false } : okResult(req))), { workspaceId: WS, runId: run.id });
    expect(done.status).toBe("failed");
    const steps = await f.store.listSteps(WS, run.id);
    expect(steps.find((s) => s.targetIndex === 0 && s.stepId === "check")).toMatchObject({ status: "skipped", errorCode: "previous_step_failed" });
    expect(steps.filter((s) => s.targetIndex === 1).every((s) => s.status === "succeeded")).toBe(true);
  });

  it("an uncertain step halts its target, marks the run uncertain and is never re-dispatched on replay", async () => {
    const f = await fixture();
    const run = await approvedRun(f, "mut", mutating);
    let calls = 0;
    const done = await executeRunbookRun(deps(f, async () => { calls += 1; throw new MachineOperationError("uncertain", "unknown outcome"); }), { workspaceId: WS, runId: run.id });
    expect(done.status).toBe("uncertain");
    expect(calls).toBe(1);
    const again = await executeRunbookRun(deps(f, async (req) => { calls += 1; return okResult(req); }), { workspaceId: WS, runId: run.id });
    expect(again.status).toBe("uncertain");
    expect(calls).toBe(1);
  });

  it("a crashed run reclaimed after its lease marks the in-flight step uncertain and does not redispatch it", async () => {
    const f = await fixture();
    const run = await approvedRun(f, "mut", mutating);
    await f.store.claimRun(WS, run.id, new Date(f.clock.t), 1000); // a worker that died mid-run
    await f.store.beginStep({ workspaceId: WS, runId: run.id, targetIndex: 0, stepId: "restart", operationId: stepOperationId(run.id, 0, "restart"), status: "started", startedAt: new Date(f.clock.t).toISOString() });
    f.clock.t += 5_000;
    let calls = 0;
    const done = await executeRunbookRun(deps(f, async (req) => { calls += 1; return okResult(req); }), { workspaceId: WS, runId: run.id });
    expect(done.status).toBe("uncertain");
    expect(calls).toBe(0);
    expect((await f.store.listSteps(WS, run.id)).find((s) => s.stepId === "restart")).toMatchObject({ status: "uncertain", errorCode: "interrupted_in_flight" });
  });

  it("cancellation aborts the in-flight step and skips the rest", async () => {
    const f = await fixture();
    const run = await approvedRun(f, "mut", mutating);
    let started!: () => void;
    const inFlight = new Promise<void>((r) => { started = r; });
    const exec: RunbookStepExecutor = (req, ctx) =>
      new Promise((resolve, reject) => {
        started();
        ctx.signal.addEventListener("abort", () => reject(new MachineOperationError("aborted", "aborted")), { once: true });
        void req;
        void resolve;
      });
    const pending = executeRunbookRun(deps(f, exec, { pollMs: 10 }), { workspaceId: WS, runId: run.id });
    await inFlight;
    await f.service.cancelRun({ workspaceId: WS, runId: run.id, principal: user("bob"), reason: "stop" });
    const done = await pending;
    expect(done).toMatchObject({ status: "cancelled", failureCode: "cancel_requested" });
    const steps = await f.store.listSteps(WS, run.id);
    expect(steps.find((s) => s.stepId === "restart")).toMatchObject({ status: "failed", errorCode: "aborted" });
    expect(steps.find((s) => s.stepId === "check")).toMatchObject({ status: "skipped" });
  });

  it("the deadline stops further steps and the run expires", async () => {
    const f = await fixture();
    await f.service.publish({ workspaceId: WS, runbookId: "ro", definition: readOnly, principal: user("alice") });
    const run = await f.service.requestRun({ workspaceId: WS, runbookId: "ro", targets: [TARGET], principal: user("bob"), maxRunDurationSec: 10 });
    f.clock.t += 11_000;
    let called = false;
    const done = await executeRunbookRun(deps(f, async (req) => { called = true; return okResult(req); }), { workspaceId: WS, runId: run.id });
    expect(done.status).toBe("expired");
    expect(called).toBe(false);
  });

  it("only one worker claims a run", async () => {
    const f = await fixture();
    const run = await approvedRun(f, "ro", readOnly);
    let calls = 0;
    const exec: RunbookStepExecutor = async (req) => { calls += 1; await new Promise((r) => setTimeout(r, 20)); return okResult(req); };
    const [a, b] = await Promise.all([executeRunbookRun(deps(f, exec), { workspaceId: WS, runId: run.id }), executeRunbookRun(deps(f, exec), { workspaceId: WS, runId: run.id })]);
    expect(calls).toBe(1);
    expect([a.status, b.status].sort()).toEqual(["running", "succeeded"].sort());
  });
});

describe("durable schedule tick", () => {
  const spec = { cadence: { kind: "interval", everySec: 1800, anchor: "2026-10-01T00:00:00Z" }, windows: [{ days: [1], startMinute: 120, endMinute: 180 }], maxRunDurationSec: 900 };

  it("a read-only schedule is active immediately and creates exactly one run per slot, however often it ticks", async () => {
    const f = await fixture({ clock: { t: T0 - 60_000 } });
    await f.service.publish({ workspaceId: WS, runbookId: "ro", definition: readOnly, principal: user("alice") });
    const sched = await f.service.createSchedule({ workspaceId: WS, runbookId: "ro", targets: [TARGET], spec, principal: user("alice") });
    expect(sched).toMatchObject({ status: "active", nextDueAt: new Date(T0).toISOString() });
    f.clock.t = T0 + 5_000;
    const [a, b] = await Promise.all([f.service.tickSchedules(), f.service.tickSchedules()]);
    expect(a.created + b.created).toBe(1);
    expect((await f.service.tickSchedules()).created).toBe(0);
    const after = await f.store.getSchedule(WS, sched.id);
    expect(after!.nextDueAt).toBe(new Date(T0 + 1800_000).toISOString());
  });

  it("a mutating schedule stays inactive until an independent approver binds the exact schedule", async () => {
    const f = await fixture({ clock: { t: T0 - 60_000 } });
    await f.service.publish({ workspaceId: WS, runbookId: "mut", definition: mutating, principal: user("alice") });
    const sched = await f.service.createSchedule({ workspaceId: WS, runbookId: "mut", targets: [TARGET], spec, principal: user("alice") });
    expect(sched.status).toBe("pending_approval");
    f.clock.t = T0 + 5_000;
    expect((await f.service.tickSchedules()).created).toBe(0);
    await expect(f.service.approveSchedule({ workspaceId: WS, scheduleId: sched.id, principal: user("alice") })).rejects.toMatchObject({ code: "forbidden" });
    f.clock.t = T0 - 30_000;
    const approved = await f.service.approveSchedule({ workspaceId: WS, scheduleId: sched.id, principal: user("carol") });
    expect(approved.status).toBe("active");
    f.clock.t = T0 + 5_000;
    expect((await f.service.tickSchedules()).created).toBe(1);
    expect((await f.store.getSchedule(WS, sched.id))!.nextDueAt).toBe(new Date(T0 + 1800_000).toISOString());
  });

  it("a raw-exec schedule only runs inside its 24 h approval, then blocks until re-approved", async () => {
    const f = await fixture({ clock: { t: T0 - 60_000 } });
    await f.service.publish({ workspaceId: WS, runbookId: "raw", definition: rawExec, principal: user("alice") });
    const sched = await f.service.createSchedule({ workspaceId: WS, runbookId: "raw", targets: [TARGET], spec: { ...spec, windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 1440 }], cadence: { kind: "interval", everySec: 3600, anchor: "2026-10-01T00:00:00Z" } }, principal: user("alice") });
    await f.service.approveSchedule({ workspaceId: WS, scheduleId: sched.id, principal: user("carol"), ttlSec: 30 * 86_400 });
    f.clock.t = T0 + 5_000;
    expect((await f.service.tickSchedules()).created).toBe(1);
    f.clock.t = T0 + 25 * 3600_000 + 5_000; // past the 24 h cap
    const tick = await f.service.tickSchedules();
    expect(tick.created).toBe(0);
    expect(tick.blocked + tick.missed).toBeGreaterThan(0);
    const events = (await f.service.listAudit(WS, `schedule:${sched.id}`)).map((e) => e.event);
    expect(events).toContain("schedule.slot_blocked");
  });

  it("slots missed while nothing ticked are recorded as missed, never run late", async () => {
    const f = await fixture({ clock: { t: T0 - 60_000 } });
    await f.service.publish({ workspaceId: WS, runbookId: "ro", definition: readOnly, principal: user("alice") });
    const sched = await f.service.createSchedule({ workspaceId: WS, runbookId: "ro", targets: [TARGET], spec, principal: user("alice") });
    f.clock.t = T0 + 45 * 60_000; // 02:45, two slots late
    const tick = await f.service.tickSchedules();
    expect(tick.created).toBe(0);
    expect(tick.missed).toBeGreaterThanOrEqual(2);
    const events = (await f.service.listAudit(WS, `schedule:${sched.id}`)).map((e) => e.event);
    expect(events).toContain("schedule.slot_missed");
  });

  it("paused schedules do not tick and resuming never replays what passed", async () => {
    const f = await fixture({ clock: { t: T0 - 60_000 } });
    await f.service.publish({ workspaceId: WS, runbookId: "ro", definition: readOnly, principal: user("alice") });
    const sched = await f.service.createSchedule({ workspaceId: WS, runbookId: "ro", targets: [TARGET], spec, principal: user("alice") });
    await f.service.setScheduleState({ workspaceId: WS, scheduleId: sched.id, state: "paused", principal: user("alice") });
    f.clock.t = T0 + 5_000;
    expect((await f.service.tickSchedules()).created).toBe(0);
    await f.service.setScheduleState({ workspaceId: WS, scheduleId: sched.id, state: "active", principal: user("alice") });
    expect((await f.store.getSchedule(WS, sched.id))!.nextDueAt).toBe(new Date(T0 + 1800_000).toISOString());
    await f.service.setScheduleState({ workspaceId: WS, scheduleId: sched.id, state: "cancelled", principal: user("alice") });
    await expect(f.service.setScheduleState({ workspaceId: WS, scheduleId: sched.id, state: "active", principal: user("alice") })).rejects.toMatchObject({ code: "conflict" });
  });

  it("a schedule whose runbook version fails verification blocks its slot instead of running", async () => {
    const f = await fixture({ clock: { t: T0 - 60_000 } });
    await f.service.publish({ workspaceId: WS, runbookId: "ro", definition: readOnly, principal: user("alice") });
    const sched = await f.service.createSchedule({ workspaceId: WS, runbookId: "ro", targets: [TARGET], spec, principal: user("alice") });
    f.keys.length = 0; // rotated away: nothing verifies
    f.clock.t = T0 + 5_000;
    const tick = await f.service.tickSchedules();
    expect(tick).toMatchObject({ created: 0, blocked: 1 });
    expect((await f.service.listAudit(WS, `schedule:${sched.id}`)).some((e) => e.event === "schedule.slot_blocked" && (e.detail as { reason?: string }).reason === "signature_invalid")).toBe(true);
  });

  it("unbounded schedules (no window) are rejected", async () => {
    const f = await fixture();
    await f.service.publish({ workspaceId: WS, runbookId: "ro", definition: readOnly, principal: user("alice") });
    await expect(f.service.createSchedule({ workspaceId: WS, runbookId: "ro", targets: [TARGET], spec: { ...spec, windows: [] }, principal: user("alice") })).rejects.toMatchObject({ code: "invalid_binding" });
  });
});
