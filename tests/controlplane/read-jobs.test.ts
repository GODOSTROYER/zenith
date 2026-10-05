/** Operation-less reads on production SQL (PGlite; real Postgres only when opted in). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CAPABILITIES } from "@/lib/capabilities/catalog";
import { migratePlatformDb, openPlatformDb, PLATFORM_MIGRATIONS } from "@/lib/controlplane/db";
import { migration0005ReadJobs, READ_JOB_CAPABILITIES } from "@/lib/controlplane/db/migrations/0005_read_jobs";
import { repos } from "@/lib/controlplane/db";
import type { EnqueueJobInput } from "@/lib/controlplane/db/repos/jobs";
import { LANES, newWorkspace, openLane, seedApprovedOperation, uid } from "./_support/harness";

it("freezes exactly the current catalog's non-mutating capabilities", () => {
  expect([...READ_JOB_CAPABILITIES].sort()).toEqual(Object.values(CAPABILITIES).filter((c) => !c.mutates).map((c) => c.name).sort());
});

it("upgrades migration 4 without changing existing operation jobs and reapplies safely", async () => {
  const db = await openPlatformDb({ kind: "pglite", migrate: false });
  try {
    await migratePlatformDb(db, PLATFORM_MIGRATIONS.slice(0, 4));
    const workspaceId = newWorkspace();
    // Seed the actual schema-4 row shape; current registration also returns migration-25 lifecycle fields.
    const runnerId = uid("runner");
    await db.query("insert into platform.runners (id, workspace_id, name, public_key) values ($1, $2, 'upgrade', $3)", [runnerId, workspaceId, "A".repeat(43)]);
    expect(await db.query("select column_name from information_schema.columns where table_schema = 'platform' and table_name = 'runners' and column_name in ('lifecycle', 'lifecycle_reported_at')")).toEqual([]);
    const { operation } = await seedApprovedOperation(db, workspaceId);
    const job = await repos.jobs.enqueue(db, { id: uid("job"), workspaceId, runnerId, operationId: operation.id, kind: "tofu.run", capability: "infrastructure.apply", envelope: "signed-test-envelope" });
    expect((await migratePlatformDb(db)).applied).toEqual(PLATFORM_MIGRATIONS.filter((migration) => migration.version > 4).map((migration) => migration.version));
    await db.exec(migration0005ReadJobs.sql);
    expect((await migratePlatformDb(db)).applied).toEqual([]);
    expect(await repos.jobs.get(db, workspaceId, job.id)).toEqual(job);
    const read = await repos.jobs.enqueue(db, { id: uid("job"), workspaceId, runnerId, kind: "probe.tcp", capability: "infrastructure.observe", envelope: "signed-test-envelope" });
    expect(read.operationId).toBe("");
  } finally {
    await db.close();
  }
}, 60_000);

describe.each(LANES)("operation-less read jobs [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  let workspaceId: string;
  let runnerId: string;
  beforeAll(async () => { ctx = await openLane(lane); }, 60_000);
  afterAll(async () => { await ctx.close(); });
  beforeEach(async () => {
    workspaceId = newWorkspace();
    const token = repos.runners.generateRegistrationToken("runner");
    await repos.runners.createRegistrationToken(ctx.db, { workspaceId, kind: "runner", createdBy: "admin", tokenHash: token.tokenHash });
    runnerId = (await repos.runners.registerRunner(ctx.db, { tokenHash: token.tokenHash, name: "reader", publicKey: "A".repeat(43), capabilities: ["oci.http", "probe.tcp"] })).id;
  });
  const input = (over: Partial<EnqueueJobInput> = {}): EnqueueJobInput => ({ id: uid("job"), workspaceId, runnerId, kind: "probe.tcp", capability: "infrastructure.observe", envelope: "signed-test-envelope", ...over });
  const queue = (over: Partial<EnqueueJobInput> = {}) => repos.jobs.enqueue(ctx.db, input(over));
  const claim = (jobWorkspace = workspaceId, jobRunner = runnerId) => repos.jobs.claimNext(ctx.db, { workspaceId: jobWorkspace, runnerId: jobRunner });
  async function insertRaw(capability: string, expiry = "5 minutes", targetWorkspace = workspaceId, operationId: string | null = null) {
    return ctx.db.query(`insert into platform.runner_jobs (id, workspace_id, runner_id, operation_id, kind, capability, envelope, expires_at)
      values ($1, $2, $3, $4, 'probe.tcp', $5, 'signed-test-envelope', clock_timestamp() + $6::interval)`,
    [uid("job"), targetWorkspace, runnerId, operationId, capability, expiry]);
  }

  it("queues every read capability with a NULL FK and creates no operation", async () => {
    for (const capability of READ_JOB_CAPABILITIES) {
      const job = await queue({ capability });
      expect(job).toMatchObject({ workspaceId, runnerId, operationId: "", status: "queued" });
      const [row] = await ctx.db.query<{ operation_id: string | null }>("select operation_id from platform.runner_jobs where workspace_id = $1 and id = $2", [workspaceId, job.id]);
      expect(row.operation_id).toBeNull();
    }
    expect(await ctx.db.query("select id from platform.operations where workspace_id = $1", [workspaceId])).toEqual([]);
  });

  it("accepts explicit null and the broker's read reference, without treating either as an FK", async () => {
    expect((await queue({ operationId: null })).operationId).toBe("");
    expect((await queue({ operationId: "read:grd_1" })).operationId).toBe("");
    await expect(queue({ operationId: "" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it.each(["infrastructure.apply", "infrastructure.destroy", "secret.write", "provider.native", "unknown.read"])("guards operation-less %s in the repository and database", async (capability) => {
    await expect(queue({ capability })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(queue({ capability, operationId: "read:grd_1" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(insertRaw(capability)).rejects.toMatchObject({ sqlstate: "23514" });
  });

  it("bounds read expiry independently and refuses direct SQL beyond an hour", async () => {
    const job = await queue({ ttlMs: 1000 });
    expect(Date.parse(job.expiresAt) - Date.parse(job.createdAt)).toBeLessThanOrEqual(1000);
    await expect(queue({ ttlMs: 3_600_001 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(insertRaw("infrastructure.observe", "2 hours")).rejects.toMatchObject({ sqlstate: "23514" });
    await queue({ ttlMs: 3_600_000 });
  });

  it("preserves operation FK enforcement, including tenant boundaries", async () => {
    await expect(queue({ operationId: uid("missing") })).rejects.toMatchObject({ code: "not_found" });
    const foreign = await seedApprovedOperation(ctx.db);
    await expect(queue({ operationId: foreign.operation.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(insertRaw("infrastructure.apply", "5 minutes", workspaceId, foreign.operation.id)).rejects.toMatchObject({ sqlstate: "23503" });
    const own = await seedApprovedOperation(ctx.db, workspaceId);
    expect((await queue({ capability: "infrastructure.apply", operationId: own.operation.id })).operationId).toBe(own.operation.id);
  });

  it("scopes enqueue, get, claim, settle, cancel and logs to the runner's workspace", async () => {
    const other = newWorkspace();
    await expect(queue({ workspaceId: other })).rejects.toMatchObject({ code: "not_found" });
    await expect(insertRaw("infrastructure.observe", "5 minutes", other)).rejects.toMatchObject({ sqlstate: "23503" });
    const job = await queue();
    expect(await repos.jobs.get(ctx.db, other, job.id)).toBeNull();
    expect(await claim(other)).toEqual([]);
    expect(await repos.jobs.cancel(ctx.db, other, job.id)).toBeNull();
    expect(await repos.jobs.appendLogs(ctx.db, { workspaceId: other, runnerId, jobId: job.id, batchSeq: 0, lines: [] })).toBeNull();
    expect(await repos.jobs.listLogs(ctx.db, { workspaceId: other, jobId: job.id })).toEqual([]);
    await claim();
    expect(await repos.jobs.markRunning(ctx.db, { workspaceId: other, runnerId, jobId: job.id, leaseMs: 1000 })).toBe(false);
    expect(await repos.jobs.settle(ctx.db, { workspaceId: other, runnerId, jobId: job.id, status: "succeeded" })).toBe(false);
  });

  it("claims once across concurrent pollers and settles only the first result", async () => {
    const job = await queue();
    const claimed = await Promise.all([claim(), repos.jobs.claimNext(ctx.db2, { workspaceId, runnerId })]);
    expect(claimed.flat().map((j) => j.id)).toEqual([job.id]);
    const results = await Promise.all([ctx.db, ctx.db2].map((db) => repos.jobs.settle(db, { workspaceId, runnerId, jobId: job.id, status: "succeeded", result: { count: 1 } })));
    expect(results.sort()).toEqual([false, true]);
    expect(await repos.jobs.listForOperation(ctx.db, workspaceId, "read:grd_1")).toEqual([]);
  });

  it("refuses duplicate ids and inactive runners", async () => {
    const job = await queue();
    await expect(queue({ id: job.id })).rejects.toMatchObject({ sqlstate: "23505" });
    await repos.runners.revokeRunner(ctx.db, workspaceId, runnerId);
    await expect(queue()).rejects.toMatchObject({ code: "not_found" });
    expect(await claim()).toEqual([]);
  });

  it("expires queued reads, times out leased reads, and rejects late results", async () => {
    const expired = await queue();
    await ctx.db.query("update platform.runner_jobs set expires_at = clock_timestamp() - interval '1 second' where workspace_id = $1 and id = $2", [workspaceId, expired.id]);
    expect(await claim()).toEqual([]);
    const timedOut = await queue();
    await claim();
    await ctx.db.query("update platform.runner_jobs set lease_until = clock_timestamp() - interval '1 second' where workspace_id = $1 and id = $2", [workspaceId, timedOut.id]);
    const reaped = await repos.jobs.expireStale(ctx.db);
    expect(reaped.find((j) => j.id === expired.id)?.status).toBe("expired");
    expect(reaped.find((j) => j.id === timedOut.id)?.status).toBe("timed_out");
    expect(await repos.jobs.settle(ctx.db, { workspaceId, runnerId, jobId: timedOut.id, status: "succeeded" })).toBe(false);
    expect(await claim()).toEqual([]);
  });

  it("keeps the existing secret-value guards on results and logs", async () => {
    const job = await queue();
    await claim();
    await expect(repos.jobs.settle(ctx.db, { workspaceId, runnerId, jobId: job.id, status: "failed", error: "AKIAIOSFODNN7EXAMPLE" })).rejects.toMatchObject({ code: "secret_material" });
    await repos.jobs.appendLogs(ctx.db, { workspaceId, runnerId, jobId: job.id, batchSeq: 0, lines: [{ ts: new Date().toISOString(), stream: "stdout", line: "AKIAIOSFODNN7EXAMPLE" }] });
    expect(JSON.stringify(await repos.jobs.listLogs(ctx.db, { workspaceId, jobId: job.id }))).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
