/**
 * PROD-OPS-06: persistence minimization on real PGlite SQL. Sealed job results are removed after the retention
 * window; settled-late and non-terminal rows are untouched; expired agent uploads are swept every tick; nothing
 * outside those stores changes. Contract level (PGlite), no live Postgres claim. Secrets are generated at runtime.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import * as repos from "@/lib/controlplane/db/repos";
import { createMachineRequestQueue } from "@/lib/runners/db/machine-requests";
import { createAesResultSealer, isSealedBox } from "@/lib/runners/seal";
import { verifyResultEnvelope } from "@/lib/sensitivedata/at-rest";
import { DEFAULT_RESULT_RETENTION_HOURS, minimizeApplyEnabled, minimizePass, resultRetentionHours } from "@/lib/sensitivedata/minimize";
import { newWorkspace, seedApprovedOperation, uid } from "../controlplane/_support/harness";

const KEY = "A".repeat(43);
const sealer = createAesResultSealer(randomBytes(32), { keyId: "test-key" });
const APPLY = { ZENITH_DATA_MINIMIZE_APPLY: "1", ZENITH_RESULT_RETENTION_HOURS: "72" };
const secretBody = (): string => `opaque-${randomBytes(12).toString("base64url")}`;

let db: PlatformDbHandle;
beforeAll(async () => { db = await openPlatformDb({ kind: "pglite" }); }, 60_000);
afterAll(async () => { await db.close(); });

async function runner(ws: string) {
  const { tokenHash } = repos.runners.generateRegistrationToken("runner");
  await repos.runners.createRegistrationToken(db, { workspaceId: ws, kind: "runner", createdBy: "admin", tokenHash });
  return repos.runners.registerRunner(db, { tokenHash, name: "r", publicKey: KEY, capabilities: ["tofu.run"] });
}

/** A settled runner job whose sealed result holds `body`; `ageHours` old. */
async function settledRunnerJob(ws: string, runnerId: string, ageHours: number, body: string, status: "succeeded" | "failed" = "succeeded"): Promise<string> {
  const { operation } = await seedApprovedOperation(db, ws);
  const id = uid("job");
  await repos.jobs.enqueue(db, { id, workspaceId: ws, runnerId, operationId: operation.id, kind: "tofu.run", capability: "infrastructure.apply", envelope: "eyJhbGciOiJFZERTQSJ9.payload.signature" });
  expect(await repos.jobs.claimNext(db, { workspaceId: ws, runnerId, max: 1 })).toHaveLength(1);
  const result = { sealed: sealer.seal(`${ws}|${id}`, { body }), exitCode: 0, startedAt: "2026-10-01T00:00:00.000Z", finishedAt: "2026-10-01T00:00:01.000Z" };
  expect(await repos.jobs.settle(db, { workspaceId: ws, runnerId, jobId: id, status, result })).toBe(true);
  await db.query("update platform.runner_jobs set settled_at = clock_timestamp() - ($2::int * interval '1 hour') where id = $1", [id, ageHours]);
  return id;
}

const resultOf = async (table: "runner_jobs" | "machine_requests", id: string): Promise<Record<string, unknown> | null> =>
  (await db.query<{ result: Record<string, unknown> | null }>(`select result from platform.${table} where id = $1`, [id]))[0].result;

describe("retention window", () => {
  it("deletion needs the apply flag AND an explicit valid window (DEC-RETENTION is pending)", () => {
    expect(minimizeApplyEnabled({})).toBe(false);
    expect(minimizeApplyEnabled({ ZENITH_DATA_MINIMIZE_APPLY: "1" })).toBe(false);
    expect(minimizeApplyEnabled({ ZENITH_RESULT_RETENTION_HOURS: "24" })).toBe(false);
    expect(minimizeApplyEnabled({ ZENITH_DATA_MINIMIZE_APPLY: "true", ZENITH_RESULT_RETENTION_HOURS: "24" })).toBe(false);
    expect(minimizeApplyEnabled({ ZENITH_DATA_MINIMIZE_APPLY: "1", ZENITH_RESULT_RETENTION_HOURS: "0" })).toBe(false);
    expect(minimizeApplyEnabled({ ZENITH_DATA_MINIMIZE_APPLY: "1", ZENITH_RESULT_RETENTION_HOURS: "24" })).toBe(true);
  });

  it("defaults to 72 hours and ignores an invalid override rather than erasing at once or never", () => {
    expect(DEFAULT_RESULT_RETENTION_HOURS).toBe(72);
    expect(resultRetentionHours({})).toBe(72);
    expect(resultRetentionHours({ ZENITH_RESULT_RETENTION_HOURS: "24" })).toBe(24);
    for (const bad of ["0", "-5", "721", "1.5", "soon", ""]) expect(resultRetentionHours({ ZENITH_RESULT_RETENTION_HOURS: bad })).toBe(72);
  });
});

describe("sealed result minimization", () => {
  it("removes the sealed body of settled jobs past the window, and only those", async () => {
    const ws = newWorkspace();
    const { id: runnerId } = await runner(ws);
    const old = await settledRunnerJob(ws, runnerId, 100, secretBody());
    const failedOld = await settledRunnerJob(ws, runnerId, 200, secretBody(), "failed");
    const recent = await settledRunnerJob(ws, runnerId, 1, secretBody());
    // an unsettled job has no result and must be left exactly as it is
    const { operation } = await seedApprovedOperation(db, ws);
    const queued = uid("job");
    await repos.jobs.enqueue(db, { id: queued, workspaceId: ws, runnerId, operationId: operation.id, kind: "tofu.run", capability: "infrastructure.apply", envelope: "eyJhbGciOiJFZERTQSJ9.payload.signature" });

    const beforeOld = await resultOf("runner_jobs", old);
    expect(isSealedBox((beforeOld as { sealed: unknown }).sealed)).toBe(true);
    const dry = await minimizePass(db, { env: {} });
    expect(dry).toMatchObject({ applied: false, retry: 0 });
    expect(dry.runnerResults).toBeGreaterThanOrEqual(2);
    expect(isSealedBox(((await resultOf("runner_jobs", old)) as { sealed: unknown }).sealed)).toBe(true);
    // apply without an explicit window, or the window without the apply flag, still deletes nothing
    expect((await minimizePass(db, { env: { ZENITH_DATA_MINIMIZE_APPLY: "1" } })).applied).toBe(false);
    expect((await minimizePass(db, { env: { ZENITH_RESULT_RETENTION_HOURS: "72" } })).applied).toBe(false);
    expect(isSealedBox(((await resultOf("runner_jobs", old)) as { sealed: unknown }).sealed)).toBe(true);
    const outcome = await minimizePass(db, { env: APPLY });
    expect(outcome).toMatchObject({ retentionHours: 72, applied: true, retry: 0 });
    expect(outcome.runnerResults).toBeGreaterThanOrEqual(2);

    for (const id of [old, failedOld]) {
      const after = await resultOf("runner_jobs", id);
      expect(after).toEqual({ exitCode: 0, startedAt: "2026-10-01T00:00:00.000Z", finishedAt: "2026-10-01T00:00:01.000Z", minimized: true });
      expect(verifyResultEnvelope(after)).toEqual({ ok: true });
    }
    expect(isSealedBox(((await resultOf("runner_jobs", recent)) as { sealed: unknown }).sealed)).toBe(true);
    expect(await resultOf("runner_jobs", queued)).toBeNull();
    // the job row itself, its status and its signed assignment are untouched
    const rows = await db.query<{ status: string; envelope: string }>("select status, envelope from platform.runner_jobs where id = $1", [old]);
    expect(rows[0]).toEqual({ status: "succeeded", envelope: "eyJhbGciOiJFZERTQSJ9.payload.signature" });
    // idempotent
    expect((await minimizePass(db, { env: APPLY })).runnerResults).toBe(0);
  });

  it("honours ZENITH_RESULT_RETENTION_HOURS and the batch limit", async () => {
    const ws = newWorkspace();
    const { id: runnerId } = await runner(ws);
    const ids = [await settledRunnerJob(ws, runnerId, 5, secretBody()), await settledRunnerJob(ws, runnerId, 6, secretBody()), await settledRunnerJob(ws, runnerId, 7, secretBody())];
    expect((await minimizePass(db, { env: { ...APPLY, ZENITH_RESULT_RETENTION_HOURS: "24" } })).runnerResults).toBe(0);
    const first = await minimizePass(db, { env: { ...APPLY, ZENITH_RESULT_RETENTION_HOURS: "4" }, limit: 2 });
    expect(first.runnerResults).toBe(2);
    expect(first.retentionHours).toBe(4);
    expect((await minimizePass(db, { env: { ...APPLY, ZENITH_RESULT_RETENTION_HOURS: "4" }, limit: 2 })).runnerResults).toBe(1);
    for (const id of ids) expect((await resultOf("runner_jobs", id))?.minimized).toBe(true);
  });

  it("minimizes zenithd request results the same way", async () => {
    const ws = newWorkspace();
    const { tokenHash } = repos.runners.generateRegistrationToken("machine");
    await repos.runners.createRegistrationToken(db, { workspaceId: ws, kind: "machine", createdBy: "admin", tokenHash, binding: { environmentId: "env_1", address: "compute_instance/worker-1" } });
    const machine = await repos.machines.registerMachine(db, { tokenHash, name: "worker-1", publicKey: KEY, capabilities: ["service.status"] });
    const queue = createMachineRequestQueue(db);
    const { operation } = await seedApprovedOperation(db, ws);
    const id = uid("mreq");
    await queue.enqueue({ id, workspaceId: ws, agentId: machine.id, operationId: operation.id, kind: "service.status", capability: "service.status", envelope: "eyJhbGciOiJFZERTQSJ9.payload.signature" });
    expect(await queue.claimNext({ workspaceId: ws, agentId: machine.id, max: 1, leaseMs: 60_000 })).toHaveLength(1);
    expect(await queue.settle({ workspaceId: ws, agentId: machine.id, jobId: id, status: "succeeded", result: { sealed: sealer.seal(`${ws}|${id}`, { out: secretBody() }), exitCode: 0 } })).toBe(true);
    await db.query("update platform.machine_requests set settled_at = clock_timestamp() - interval '100 hours' where id = $1", [id]);
    expect((await minimizePass(db, { env: APPLY })).machineResults).toBeGreaterThanOrEqual(1);
    expect(await resultOf("machine_requests", id)).toEqual({ exitCode: 0, minimized: true });
  });

  it("leaves the immutable effect receipts alone (their retention is PROD-OPS-07)", async () => {
    const before = await db.query<{ n: number }>("select count(*)::int as n from platform.agent_effect_receipts");
    await minimizePass(db, { env: APPLY });
    const after = await db.query<{ n: number }>("select count(*)::int as n from platform.agent_effect_receipts");
    expect(after[0].n).toBe(before[0].n);
  });
});

describe("agent upload sweep", () => {
  const product = async () => {
    await db.exec(`create schema if not exists agent;
      create table if not exists agent.agent_uploads (id text primary key, subject text not null, workspace_id text not null, project_id text not null, app_id text not null,
        sha256 text not null, expires_at text not null, bytes bytea not null)`);
    return db;
  };
  const insert = (id: string, expires: string) => db.query(
    "insert into agent.agent_uploads (id, subject, workspace_id, project_id, app_id, sha256, expires_at, bytes) values ($1,'u','w','p','a',$2,$3,$4)",
    [id, "0".repeat(64), expires, Buffer.from(secretBody())]);

  it("sweeps expired uploads on every tick, keeps live ones, and does nothing without a product store or the table", async () => {
    const now = new Date("2026-10-07T12:00:00.000Z");
    expect((await minimizePass(db, { env: {}, now, product: async () => undefined })).agentUploads).toBe(0);
    expect((await minimizePass(db, { env: {}, now, product: async () => db })).agentUploads).toBe(0);
    await product();
    await insert("up_expired_1", "2026-10-07T11:00:00.000Z");
    await insert("up_expired_2", "2026-10-07T12:00:00.000Z");
    await insert("up_live", "2026-10-07T13:00:00.000Z");
    const swept = await minimizePass(db, { env: {}, now, product });
    expect(swept.agentUploads).toBe(2);
    expect((await db.query<{ id: string }>("select id from agent.agent_uploads")).map((r) => r.id)).toEqual(["up_live"]);
  });

  it("a store failure is counted as a retry and never thrown or echoed", async () => {
    const result = await minimizePass(db, { env: {}, product: async () => { throw new Error("password=hunter2 postgres://u:p@h/db"); } });
    expect(result.retry).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });
});
