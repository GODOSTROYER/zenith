/** Real in-memory Postgres dialect; the database clock is a deterministic fixture. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPlatformDb, repos } from "@/lib/controlplane/db";
import { HOUSEKEEPING_LEASE_SCOPE, housekeepingPass } from "@/lib/platform/housekeeping";
import { TERMINAL_OPERATION_STATUSES, type Sql } from "@/lib/controlplane/types";
import { proposalFor, user } from "../controlplane/_support/harness";

let db: Awaited<ReturnType<typeof openPlatformDb>>;
const NOW = "2026-10-01T12:00:00.000Z";
beforeEach(async () => {
  db = await openPlatformDb({ kind: "pglite" });
  // Put the test clock before pg_catalog for dynamically parsed repository SQL.
  await db.query(`create function platform.clock_timestamp() returns timestamptz language sql as $$ select '${NOW}'::timestamptz $$`);
  await db.query("set search_path = platform, pg_catalog");
});
afterEach(async () => { await db.close(); });

async function operation(workspaceId: string, status = "proposed") {
  const { operation: op } = await repos.operations.create(db, { workspaceId, principal: user(), proposal: proposalFor(workspaceId) });
  await db.query("update platform.operations set status = $3 where workspace_id = $1 and id = $2", [workspaceId, op.id, status]);
  return op;
}
async function expiredKey(workspaceId: string, key: string, offsetMs = 0) {
  await db.query("insert into platform.idempotency_keys(workspace_id, key, request_hash, expires_at) values ($1,$2,'test-hash',clock_timestamp() + ($3::bigint * interval '1 millisecond'))", [workspaceId, key, offsetMs]);
}

describe("platform housekeeping", () => {
  it("prunes only elapsed windows across workspaces, at inclusive expiry, and is idempotent", async () => {
    await expiredKey("ws-a", "expired"); await expiredKey("ws-b", "expired"); await expiredKey("ws-a", "live", 1);
    await db.query("insert into platform.agent_nonces(agent_id,nonce,seen_at) values ('a','old',clock_timestamp()-interval '20 minutes'),('b','recent',clock_timestamp()-interval '9 minutes')");
    expect(await housekeepingPass(db)).toEqual({ ran: true, idempotencyKeys: 2, nonces: 1, uncertain: 0, expired: 0 });
    expect(await housekeepingPass(db)).toEqual({ ran: true, idempotencyKeys: 0, nonces: 0, uncertain: 0, expired: 0 });
    expect(await db.query("select key from platform.idempotency_keys")).toEqual([{ key: "live" }]);
    expect(await repos.nonces.remember(db, "b", "recent")).toBe(false);
    expect(await repos.leases.current(db, HOUSEKEEPING_LEASE_SCOPE)).toBeNull();
  });

  it("marks lapsed claims uncertain, expires every pre-execution status, revokes grants and audits once", async () => {
    const running = await operation("ws-a", "running");
    await db.query("update platform.operations set lease_until = clock_timestamp() where workspace_id = $1 and id = $2", [running.workspaceId, running.id]);
    const overdue = [];
    for (const status of ["proposed", "awaiting_approval", "approved", "queued"]) overdue.push(await operation("ws-b", status));
    for (const op of overdue) await db.query("update platform.operations set expires_at = clock_timestamp() where workspace_id = $1 and id = $2", [op.workspaceId, op.id]);
    for (const op of [running, ...overdue]) await repos.grants.insert(db, { jti: `grant-${op.id}`, workspaceId: op.workspaceId, operationId: op.id, capability: op.capability, audience: "worker", issuedAt: NOW, expiresAt: "2026-10-01T12:30:00.000Z" });
    expect(await housekeepingPass(db)).toMatchObject({ uncertain: 1, expired: 4 });
    expect((await repos.operations.get(db, "ws-a", running.id))?.status).toBe("uncertain");
    const grants = await db.query<{ revoked_at: unknown }>("select revoked_at from platform.capability_grants");
    expect(grants).toHaveLength(5); expect(grants.every((grant) => grant.revoked_at !== null)).toBe(true);
    const events = await repos.events.list(db, "ws-a");
    expect(events.map((e) => e.type)).toEqual(["operation.uncertain"]);
    expect(await housekeepingPass(db)).toMatchObject({ uncertain: 0, expired: 0 });
    expect(await repos.events.list(db, "ws-a")).toHaveLength(1);
    expect(await repos.events.list(db, "ws-b")).toHaveLength(4);
  });

  it("preserves healthy running claims even with overdue proposals, and all terminal outcomes", async () => {
    const live = await operation("ws-live", "running");
    await db.query("update platform.operations set expires_at = clock_timestamp(), lease_until = clock_timestamp()+interval '1 hour' where workspace_id=$1 and id=$2", [live.workspaceId, live.id]);
    const terminal = [];
    for (const status of TERMINAL_OPERATION_STATUSES) terminal.push({ op: await operation("ws-terminal", status), status });
    expect(await housekeepingPass(db)).toMatchObject({ uncertain: 0, expired: 0 });
    expect((await repos.operations.get(db, live.workspaceId, live.id))?.status).toBe("running");
    for (const { op, status } of terminal) expect((await repos.operations.get(db, op.workspaceId, op.id))?.status).toBe(status);
  });

  it("recognizes a lost environment fence even while the operation heartbeat is live", async () => {
    const op = await operation("ws-lost", "running");
    await db.query("update platform.operations set lease_until=clock_timestamp()+interval '1 hour', lease_scope='env:lost', fence_token=1 where workspace_id=$1 and id=$2", [op.workspaceId, op.id]);
    expect(await housekeepingPass(db)).toMatchObject({ uncertain: 1 });
    expect((await repos.operations.get(db, op.workspaceId, op.id))?.status).toBe("uncertain");
  });

  it("bounds each category and advances the remaining backlog on the next run", async () => {
    for (let i = 0; i < 3; i++) {
      await expiredKey("ws-backlog", `key-${i}`);
      const op = await operation("ws-backlog");
      await db.query("update platform.operations set expires_at=clock_timestamp() where workspace_id=$1 and id=$2", [op.workspaceId, op.id]);
    }
    expect(await housekeepingPass(db, { limit: 2 })).toMatchObject({ idempotencyKeys: 2, expired: 2 });
    expect(await housekeepingPass(db, { limit: 2 })).toMatchObject({ idempotencyKeys: 1, expired: 1 });
  });

  it("skips a competing invocation in the same process while the first holds its lease", async () => {
    const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    const paused: Sql = { query: db.query.bind(db), tx: async (fn) => { entered.resolve(); await resume.promise; return db.tx(fn); } };
    const first = housekeepingPass(paused);
    await entered.promise;
    try { expect(await housekeepingPass(db)).toMatchObject({ ran: false }); }
    finally { resume.resolve(); }
    expect(await first).toMatchObject({ ran: true });
  });

  it("rolls back pruning and status writes if an audit append fails, and releases the lease", async () => {
    await expiredKey("ws-rollback", "keep");
    const op = await operation("ws-rollback", "running");
    // A database trigger is real failure injection, not a fake repository.
    await db.query("create function platform.reject_test_event() returns trigger language plpgsql as $$ begin raise exception 'synthetic audit outage'; end $$");
    await db.query("create trigger reject_test_event before insert on platform.events for each row execute function platform.reject_test_event()");
    await expect(housekeepingPass(db)).rejects.toThrow("Platform housekeeping could not complete");
    expect((await repos.operations.get(db, op.workspaceId, op.id))?.status).toBe("running");
    expect(await db.query("select key from platform.idempotency_keys")).toEqual([{ key: "keep" }]);
    expect(await repos.leases.current(db, HOUSEKEEPING_LEASE_SCOPE)).toBeNull();
  });

  it("refuses a stale fence after takeover and cannot release the new holder's lease", async () => {
    await expiredKey("ws-takeover", "keep");
    const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    const paused: Sql = { query: db.query.bind(db), tx: async (fn) => { entered.resolve(); await resume.promise; return db.tx(fn); } };
    const first = housekeepingPass(paused); const refused = expect(first).rejects.toThrow("could not complete");
    await entered.promise;
    await db.query("update platform.leases set expires_at=clock_timestamp() where scope=$1", [HOUSEKEEPING_LEASE_SCOPE]);
    const replacement = await repos.leases.acquire(db, { scope: HOUSEKEEPING_LEASE_SCOPE, holder: "replacement", ttlMs: 60_000 });
    resume.resolve(); await refused;
    expect(await repos.leases.current(db, HOUSEKEEPING_LEASE_SCOPE)).toEqual(replacement);
    expect(await db.query("select key from platform.idempotency_keys")).toEqual([{ key: "keep" }]);
  });

  it.each([0, -1, 1.5, 1001, NaN, Infinity])("rejects invalid batch size %s before taking a lease", async (limit) => {
    await expect(housekeepingPass(db, { limit })).rejects.toThrow("limit");
    expect(await db.query("select scope from platform.leases")).toHaveLength(0);
  });
});
