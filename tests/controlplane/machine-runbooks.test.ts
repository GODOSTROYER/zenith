/**
 * PROD-MACH-03 on the real SQL store: signed versions are immutable, slots are
 * unique, claims and cancellation are conditional, step custody is at-most-once,
 * the audit chain is append-only and tenant scoped. PGlite always; real PostgreSQL
 * when ZENITH_TEST_PLATFORM_PG_URL is set (see `_support/harness.ts`).
 * The end-to-end service/runner run over the SQL store at the bottom.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSigningJwk, LocalJwkSigner } from "@/lib/credentials/signing";
import { createPlatformRunbookStore } from "@/lib/controlplane/db/repos/machine-runbooks";
import { PLATFORM_MIGRATIONS } from "@/lib/controlplane/db";
import type { MachineRequest, MachineResult } from "@/lib/machines/types";
import { RunbookError, createRunbookService, executeRunbookRun, parseRunbookDefinition, parseRunbookTargets, signRunbookVersion, verifyAuditChain, type RunbookRunRecord, type RunbookStore } from "@/lib/machines/runbooks";
import { LANES, newWorkspace, openLane, uid } from "./_support/harness";

const TARGET = { transport: "zenithd" as const, targetId: "mach-1", resourceId: "res-1" };
const DEF = { schemaVersion: 1, name: "restart", steps: [{ id: "restart", title: "Restart", operation: "machine.service.restart", args: { unit: "nginx.service" } }, { id: "check", title: "Check", operation: "service.status", args: { unit: "nginx.service" } }] };
const user = (id: string) => ({ kind: "user" as const, id, name: id });

describe("migration inventory", () => {
  it("0017 creates the runbook tables in the platform schema", () => {
    const m = PLATFORM_MIGRATIONS.find((x) => x.name === "machine_runbooks");
    expect(m?.version).toBe(17);
    for (const table of ["machine_runbook_versions", "machine_runbook_approvals", "machine_runbook_schedules", "machine_runbook_runs", "machine_runbook_run_steps", "machine_runbook_audit"]) {
      expect(m!.sql).toContain(`platform.${table}`);
      expect(m!.sql).toContain(`alter table platform.${table} enable row level security`);
    }
  });
});

describe.each(LANES)("machine runbook store [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  let store: RunbookStore;
  let store2: RunbookStore;
  beforeAll(async () => {
    ctx = await openLane(lane);
    store = createPlatformRunbookStore(ctx.db);
    store2 = createPlatformRunbookStore(ctx.db2);
  }, 60_000);
  afterAll(async () => {
    await ctx.close();
  });

  async function seeded(ws = newWorkspace()) {
    const key = await generateSigningJwk("EdDSA");
    const signer = LocalJwkSigner.fromJwk("test", key.privateJwk, { alg: "EdDSA" });
    const definition = parseRunbookDefinition(DEF);
    const signed = await signRunbookVersion(signer, { workspaceId: ws, runbookId: "rb", version: 1, definition, now: new Date() });
    await store.insertVersion({ workspaceId: ws, runbookId: "rb", version: 1, name: definition.name, definition, definitionDigest: signed.digest, signature: signed.signature, signingKid: signed.kid, publishedBy: "user:alice", createdAt: new Date().toISOString() });
    return { ws, signer, definition, signed };
  }
  const runFor = (ws: string, signed: { digest: string }, over: Partial<RunbookRunRecord> = {}): RunbookRunRecord => ({
    id: uid("rbr"), workspaceId: ws, runbookId: "rb", version: 1, definitionDigest: signed.digest, bindingDigest: "b".repeat(64), targets: parseRunbookTargets([TARGET]), maxParallelTargets: 1,
    status: "approved", requestedBy: "user:bob", requester: user("bob"), deadlineAt: new Date(Date.now() + 600_000).toISOString(), createdAt: new Date().toISOString(), ...over,
  });

  it("versions are immutable: duplicates conflict and rows cannot be updated or deleted", async () => {
    const s = await seeded();
    await expect(store.insertVersion({ ...(await store.getVersion(s.ws, "rb", 1))! })).rejects.toMatchObject({ code: "conflict" });
    await expect(ctx.db.query("update platform.machine_runbook_versions set name='x' where workspace_id=$1", [s.ws])).rejects.toThrow(/cannot be changed/);
    await expect(ctx.db.query("delete from platform.machine_runbook_versions where workspace_id=$1", [s.ws])).rejects.toThrow(/cannot be changed/);
    expect((await store.latestVersion(s.ws, "rb"))?.definitionDigest).toBe(s.signed.digest);
    expect(await store.getVersion(newWorkspace(), "rb", 1)).toBeNull();
  });

  it("an approver cannot be the requester (database check) and approvals are immutable", async () => {
    const ws = newWorkspace();
    const base = { id: uid("rba"), workspaceId: ws, bindingDigest: "c".repeat(64), requestedBy: "user:a", approverId: "user:a", expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: new Date().toISOString() };
    await expect(store.insertApproval(base)).rejects.toThrow();
    await store.insertApproval({ ...base, approverId: "user:b" });
    expect(await store.findValidApproval(ws, "c".repeat(64), new Date())).toMatchObject({ approverId: "user:b" });
    expect(await store.findValidApproval(ws, "c".repeat(64), new Date(Date.now() + 120_000))).toBeNull();
    expect(await store.findValidApproval(newWorkspace(), "c".repeat(64), new Date())).toBeNull();
    await expect(ctx.db.query("update platform.machine_runbook_approvals set expires_at=now() where workspace_id=$1", [ws])).rejects.toThrow();
  });

  it("a schedule slot becomes at most one run, even from two independent connections", async () => {
    const s = await seeded();
    const sched = { id: uid("rbs"), workspaceId: s.ws, runbookId: "rb", version: 1, spec: { cadence: { kind: "once" as const, at: "2026-10-05T02:00:00Z" }, windows: [{ days: [1], startMinute: 120, endMinute: 180 }], maxRunDurationSec: 900, maxParallelTargets: 1 }, targets: parseRunbookTargets([TARGET]), bindingDigest: "d".repeat(64), status: "active" as const, nextDueAt: "2026-10-05T02:00:00.000Z", createdBy: "user:alice", creator: user("alice"), createdAt: new Date().toISOString() };
    await store.insertSchedule(sched);
    const dueAt = "2026-10-05T02:00:00.000Z";
    const [a, b] = await Promise.all([store.insertRun(runFor(s.ws, s.signed, { scheduleId: sched.id, dueAt })), store2.insertRun(runFor(s.ws, s.signed, { scheduleId: sched.id, dueAt }))]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.run.id).toBe(b.run.id);
    const due = await store.listDueSchedules(new Date("2026-10-05T02:05:00Z"), 100);
    expect(due.some((d) => d.id === sched.id)).toBe(true);
    const [x, y] = await Promise.all([store.advanceSchedule(s.ws, sched.id, dueAt, null), store2.advanceSchedule(s.ws, sched.id, dueAt, null)]);
    expect([x, y].sort()).toEqual([false, true]);
    expect((await store.getSchedule(s.ws, sched.id))).toMatchObject({ status: "completed", nextDueAt: null });
    expect(await store.getSchedule(newWorkspace(), sched.id)).toBeNull();
  });

  it("claim is exclusive, a lease can be reclaimed after expiry, cancel is conditional", async () => {
    const s = await seeded();
    const run = (await store.insertRun(runFor(s.ws, s.signed))).run;
    const now = new Date();
    const claims = await Promise.all([store.claimRun(s.ws, run.id, now, 60_000), store2.claimRun(s.ws, run.id, now, 60_000)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await store.claimRun(s.ws, run.id, now, 60_000)).toBeUndefined();
    expect(await store.claimRun(s.ws, run.id, new Date(now.getTime() + 61_000), 60_000)).toMatchObject({ status: "running" });
    const flagged = await store.requestCancel(s.ws, run.id, "stop", new Date());
    expect(flagged).toMatchObject({ status: "running", cancelReason: "stop" });
    expect(await store.finishRun(s.ws, run.id, "cancelled", "cancel_requested", new Date())).toBe(true);
    expect(await store.finishRun(s.ws, run.id, "succeeded", undefined, new Date())).toBe(false);
    expect(await store.requestCancel(s.ws, run.id, "again", new Date())).toBeNull();
    expect(await store.claimRun(newWorkspace(), run.id, new Date(), 1000)).toBeUndefined();
    const pending = (await store.insertRun(runFor(s.ws, s.signed, { status: "pending_approval" }))).run;
    expect(await store.requestCancel(s.ws, pending.id, "no", new Date())).toMatchObject({ status: "cancelled" });
    expect(await store.approveRun(s.ws, pending.id)).toBe(false);
  });

  it("step custody is at-most-once across connections", async () => {
    const s = await seeded();
    const run = (await store.insertRun(runFor(s.ws, s.signed))).run;
    const rec = { workspaceId: s.ws, runId: run.id, targetIndex: 0, stepId: "restart", operationId: "rbs_x", status: "started" as const, startedAt: new Date().toISOString() };
    const [a, b] = await Promise.all([store.beginStep(rec), store2.beginStep(rec)]);
    expect([a.inserted, b.inserted].sort()).toEqual([false, true]);
    await store.finishStep(s.ws, run.id, 0, "restart", { status: "succeeded", evidenceId: "ev-1", finishedAt: new Date().toISOString() });
    await store.finishStep(s.ws, run.id, 0, "restart", { status: "failed", finishedAt: new Date().toISOString() });
    expect((await store.listSteps(s.ws, run.id))[0]).toMatchObject({ status: "succeeded", evidenceId: "ev-1" });
  });

  it("concurrent audit appends keep one unbroken hash chain; entries are immutable", async () => {
    const ws = newWorkspace();
    const subject = `run:${uid("r")}`;
    const append = (count: number, offset: number) => Promise.all(Array.from({ length: count }, (_, i) => (i % 2 ? store : store2).appendAudit(ws, subject, "run.step", "system:test", { i: offset + i }, new Date())));
    await append(8, 0);
    const chain = await store.listAudit(ws, subject);
    expect(chain).toHaveLength(8);
    expect(verifyAuditChain(chain)).toBe(true);
    // More concurrent writers than the retry budget must extend, never fork, the retained prefix.
    await append(12, 8);
    const extended = await store.listAudit(ws, subject);
    expect(extended).toHaveLength(20);
    expect(extended.slice(0, 8)).toEqual(chain);
    expect(extended.map(entry => entry.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(extended.map(entry => entry.entryDigest)).size).toBe(20);
    expect(verifyAuditChain(extended)).toBe(true);
    const foreignWorkspace = newWorkspace(), otherSubject = `run:${uid("r")}`;
    await Promise.all([
      store.appendAudit(foreignWorkspace, subject, "run.step", "system:test", { independent: "workspace" }, new Date()),
      store2.appendAudit(ws, otherSubject, "run.step", "system:test", { independent: "subject" }, new Date()),
    ]);
    for (const independent of [await store.listAudit(foreignWorkspace, subject), await store2.listAudit(ws, otherSubject)]) {
      expect(independent).toHaveLength(1);
      expect(independent[0].seq).toBe(1);
      expect(verifyAuditChain(independent)).toBe(true);
    }
    await expect(ctx.db.query("delete from platform.machine_runbook_audit where workspace_id=$1", [ws])).rejects.toThrow(/cannot be changed/);
    expect(await store2.listAudit(ws, subject)).toEqual(extended);
    expect(await store.listAudit(newWorkspace(), subject)).toEqual([]);
  });

  it("list functions are tenant scoped and the executor sees only claimable runs", async () => {
    const a = await seeded();
    const b = await seeded();
    const approved = (await store.insertRun(runFor(a.ws, a.signed))).run;
    const pending = (await store.insertRun(runFor(a.ws, a.signed, { status: "pending_approval" }))).run;
    expect((await store.listRunbooks(a.ws, 10)).map((v) => v.runbookId)).toEqual(["rb"]);
    expect((await store.listRuns(a.ws, 10)).map((r) => r.id).sort()).toEqual([approved.id, pending.id].sort());
    expect((await store.listRuns(a.ws, 10, "pending_approval")).map((r) => r.id)).toEqual([pending.id]);
    expect(await store.listRuns(b.ws, 10)).toEqual([]);
    expect(await store.listSchedules(b.ws, 10)).toEqual([]);
    const claimable = (await store.listClaimableRuns(new Date(), 100)).map((r) => r.id);
    expect(claimable).toContain(approved.id);
    expect(claimable).not.toContain(pending.id);
  });

  it("service and runner work end to end over the SQL store", async () => {
    const ws = newWorkspace();
    const key = await generateSigningJwk("EdDSA");
    const signer = LocalJwkSigner.fromJwk("test", key.privateJwk, { alg: "EdDSA" });
    const keys = [signer.publicJwk()];
    const service = createRunbookService({ store, signer, verificationKeys: async () => keys, authorize: async () => true });
    await service.publish({ workspaceId: ws, runbookId: "rb", definition: DEF, principal: user("alice") });
    const run = await service.requestRun({ workspaceId: ws, runbookId: "rb", targets: [TARGET], principal: user("bob") });
    expect(run.status).toBe("pending_approval");
    await expect(service.approveRun({ workspaceId: ws, runId: run.id, principal: user("bob") })).rejects.toBeInstanceOf(RunbookError);
    await service.approveRun({ workspaceId: ws, runId: run.id, principal: user("carol") });
    const calls: string[] = [];
    const done = await executeRunbookRun(
      { store, verificationKeys: async () => keys, executeStep: async (req: MachineRequest): Promise<MachineResult> => { calls.push(req.operation); return { ok: true, operation: req.operation, data: {}, startedAt: "a", finishedAt: "b", transport: req.target.transport, simulated: true }; } },
      { workspaceId: ws, runId: run.id }
    );
    expect(done.status).toBe("succeeded");
    expect(calls).toEqual(["machine.service.restart", "service.status"]);
    expect(verifyAuditChain(await service.listAudit(ws, `run:${run.id}`))).toBe(true);
    expect(await service.getRun(newWorkspace(), run.id)).toBeNull();
  });
});
