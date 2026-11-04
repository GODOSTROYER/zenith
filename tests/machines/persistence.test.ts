/** Durable dispatch, isolation and sealed replay contracts over local PGlite. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDataDir } from "../_support/data-dir";
import { grantFor, okResult, requestFor, sessions, T0 } from "./_helpers";
import { createMachineEvidenceSink, machineResultSealer } from "@/lib/machines/persistence";
import { createMachineDrivers, executeMachineOperation, MachineOperationError, type MachineDriver } from "@/lib/machines";
tempDataDir("zenith-machine-persistence-", { fast: true });
const { openPlatformDb, repos } = await import("@/lib/controlplane/db");
let db: Awaited<ReturnType<typeof openPlatformDb>>;
const SECRET_KEY = "1".repeat(64);
const req = requestFor("machine.service.restart", { unit: "nginx.service" });
const sink = () => createMachineEvidenceSink(db, machineResultSealer(SECRET_KEY));
beforeEach(async () => {
  db = await openPlatformDb({ kind: "pglite" });
  const { operation } = await repos.operations.create(db, { id: req.operationId, workspaceId: req.target.workspaceId, status: "approved", principal: { kind: "user", id: "operator", name: "Mock operator" }, proposal: { capability: req.operation, scope: { workspaceId: req.target.workspaceId }, input: {}, risk: "medium", summary: "Mocked restart", details: [] } });
  await repos.operations.claimForExecution(db, { workspaceId: operation.workspaceId, id: operation.id, expectedDigest: operation.proposalDigest, holder: "machine-contract" });
});
afterEach(async () => { vi.restoreAllMocks(); await db.close(); });

describe("machine dispatch persistence", () => {
  it("allows one concurrent dispatcher and replays across port recreation", async () => {
    let started!: () => void;
    let finish!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const hold = new Promise<void>((resolve) => { finish = resolve; });
    const execute = vi.fn(async () => { started(); await hold; return okResult(req, { transport: "aws_ssm" }); });
    const first = sink().runOnce!(req, execute);
    await began;
    await expect(sink().runOnce!(req, execute)).rejects.toMatchObject({ code: "uncertain" });
    finish();
    const result = await first;
    expect(await sink().runOnce!(req, execute)).toEqual(result);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("never re-dispatches an interrupted mutation", async () => {
    const execute = vi.fn(async () => { throw new MachineOperationError("uncertain", "mocked delivery was interrupted"); });
    await expect(sink().runOnce!(req, execute)).rejects.toMatchObject({ code: "uncertain" });
    await expect(sink().runOnce!(req, execute)).rejects.toMatchObject({ code: "uncertain" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(["pruned", "rotated", "tampered"])("refuses replay when the completed cache is %s", async (reason) => {
    const execute = vi.fn(async () => okResult(req, { transport: "aws_ssm" }));
    await sink().runOnce!(req, execute);
    if (reason === "pruned") await db.query("delete from platform.idempotency_keys where workspace_id = $1", [req.target.workspaceId]);
    if (reason === "tampered") await db.query("update platform.idempotency_keys set response = $2::text::jsonb where workspace_id = $1", [req.target.workspaceId, JSON.stringify({ invalid: true })]);
    const next = reason === "rotated" ? createMachineEvidenceSink(db, machineResultSealer("2".repeat(64))) : sink();
    await expect(next.runOnce!(req, execute)).rejects.toMatchObject({ code: "uncertain" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(["arguments", "target", "budget", "simulation"])("refuses changed %s under the same operation id", async (change) => {
    const execute = vi.fn(async () => okResult(req, { transport: "aws_ssm" }));
    await sink().runOnce!(req, execute);
    const changed = change === "arguments" ? { ...req, args: { unit: "other.service" } } : change === "target" ? { ...req, target: { ...req.target, targetId: "i-00000000000000000" } } : change === "budget" ? { ...req, maxOutputBytes: 1024 } : req;
    await expect(sink().runOnce!(changed, execute, change === "simulation")).rejects.toMatchObject({ code: "grant_mismatch" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("refuses a foreign operation before writing a dispatch marker", async () => {
    const execute = vi.fn();
    await expect(sink().runOnce!({ ...req, target: { ...req.target, workspaceId: "foreign" } }, execute)).rejects.toMatchObject({ code: "denied" });
    expect(execute).not.toHaveBeenCalled();
    expect(await repos.evidence.list(db, "foreign")).toEqual([]);
  });

  it("revalidates the grant and constraints before returning a replay", async () => {
    const driver: MachineDriver = { transport: "aws_ssm", supports: [req.operation], execute: vi.fn(async (r) => okResult(r, { transport: "aws_ssm" })) };
    const evidence = sink();
    const session = sessions();
    const ctx = { grant: grantFor(req.operation), drivers: { aws_ssm: driver }, sessions: session, evidence, signal: new AbortController().signal, now: () => new Date(T0) };
    await executeMachineOperation(req, ctx);
    await expect(executeMachineOperation(req, { ...ctx, grant: grantFor(req.operation, { exp: Math.floor(T0 / 1000) }) })).rejects.toMatchObject({ code: "grant_expired" });
    await expect(executeMachineOperation(req, { ...ctx, grant: grantFor(req.operation, { res: "foreign" }) })).rejects.toMatchObject({ code: "grant_mismatch" });
    await expect(executeMachineOperation(req, { ...ctx, grant: grantFor(req.operation, { constraints: { maxOutputBytes: 1024 } }) })).rejects.toMatchObject({ code: "grant_mismatch" });
    expect(driver.execute).toHaveBeenCalledTimes(1);
    expect(session.opened).toBe(1);
  });

  it("does not repeat a completed mutation after evidence storage failed", async () => {
    const evidence = sink();
    const record = vi.spyOn(evidence, "record").mockRejectedValue(new Error("mocked evidence outage"));
    const driver: MachineDriver = { transport: "aws_ssm", supports: [req.operation], execute: vi.fn(async (r) => okResult(r, { transport: "aws_ssm" })) };
    const ctx = { grant: grantFor(req.operation), drivers: { aws_ssm: driver }, sessions: sessions(), evidence, signal: new AbortController().signal, now: () => new Date(T0) };
    await expect(executeMachineOperation(req, ctx)).rejects.toMatchObject({ code: "evidence_failed" });
    record.mockRestore();
    await expect(executeMachineOperation(req, { ...ctx, evidence: sink() })).rejects.toMatchObject({ code: "uncertain" });
    expect(driver.execute).toHaveBeenCalledTimes(1);
  });

  it("labels sandbox dispatch and result evidence as simulated", async () => {
    const request = requestFor("machine.inspect");
    const evidence = sink();
    const result = await executeMachineOperation(request, { grant: grantFor(request.operation), drivers: createMachineDrivers({ sandbox: true }), sessions: sessions(), evidence, signal: new AbortController().signal, now: () => new Date(T0) });
    expect(result.simulated).toBe(true);
    const rows = await repos.evidence.list(db, request.target.workspaceId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.simulated)).toBe(true);
  });

  it("caps structured transport output before caching or returning it", async () => {
    const request = requestFor("machine.inspect", {}, { maxOutputBytes: 100 });
    const driver: MachineDriver = { transport: "aws_ssm", supports: [request.operation], execute: vi.fn(async (r) => okResult(r, { transport: "aws_ssm" }, { hostname: "web", disks: Array.from({ length: 200 }, () => ({ mount: "/srv/data", totalBytes: 10, usedBytes: 2 })) })) };
    const result = await executeMachineOperation(request, { grant: grantFor(request.operation), drivers: { aws_ssm: driver }, sessions: sessions(), evidence: sink(), signal: new AbortController().signal, now: () => new Date(T0) });
    expect(result).toMatchObject({ ok: false, data: { error: "output_limit" } });
    expect(JSON.stringify(await repos.evidence.list(db, request.target.workspaceId))).not.toContain("/srv/data");
  });
});
