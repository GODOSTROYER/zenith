/** PROD-OPS-03: additive schema43 preserves schema42 stream custody and history. */
import { describe, expect, it } from "vitest";
import {
  PLATFORM_MIGRATIONS, assertPlatformSchemaCurrent, migratePlatformDb,
  openPlatformDb, type PlatformDbHandle,
} from "@/lib/controlplane/db";
import { assessPlatformMigration, assertPendingMigrationsCompatible } from "@/lib/controlplane/db/compat";
import { PG_URL, withScratchDatabase } from "./_support/harness";

const previous = PLATFORM_MIGRATIONS.filter(m => m.version <= 42);
const repair = PLATFORM_MIGRATIONS.find(m => m.version === 43)!;
const indexDefinition = "CREATE INDEX mcp_stream_events_workspace_stream ON platform.mcp_stream_events USING btree (workspace_id, stream_id, seq)";

it("schema43 is expand-only and needs no contract admission", () => {
  expect(assessPlatformMigration(repair, 42).class).toBe("expand");
  expect(() => assertPendingMigrationsCompatible([repair], { baseline: 42, approvals: [], allowed: new Set() })).not.toThrow();
  const contract42 = previous.at(-1)!;
  expect(() => assertPendingMigrationsCompatible([contract42, repair], { baseline: 41, allowed: new Set() })).toThrow("previous release is drained");
  expect(() => assertPendingMigrationsCompatible([contract42, repair], { baseline: 41, allowed: new Set([43]) })).toThrow("previous release is drained");
  expect(() => assertPendingMigrationsCompatible([contract42, repair], { baseline: 41, allowed: new Set([42]) })).not.toThrow();
});

async function upgrade(db: PlatformDbHandle) {
  await migratePlatformDb(db, previous);
  await assertPlatformSchemaCurrent(db, previous);
  const history = await db.query("select * from platform.schema_migrations order by version");
  const tenants = [["tenant-index-a", "a".repeat(32)], ["tenant-index-b", "b".repeat(32)]] as const;
  for (const [workspaceId, streamId] of tenants) {
    await db.query("insert into platform.mcp_streams(id,workspace_id,principal_key,request_id,protocol_version,status,expires_at) values($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '1 hour')",
      [streamId, workspaceId, "c".repeat(64), "tenant-index-request", "2025-11-25", "completed"]);
    await db.query("insert into platform.mcp_stream_events(stream_id,workspace_id,seq,payload) values($1,$2,$3,$4::text::jsonb)",
      [streamId, workspaceId, 1, JSON.stringify({ jsonrpc: "2.0", id: workspaceId, result: { retained: true } })]);
  }
  const payloadFacts = () => db.query("select workspace_id,stream_id,seq,pg_typeof(payload)::text as sql_type,jsonb_typeof(payload) as json_type,payload from platform.mcp_stream_events order by workspace_id,stream_id,seq");
  const expectedPayloads = tenants.map(([workspaceId, streamId]) => ({
    workspace_id: workspaceId, stream_id: streamId, seq: 1, sql_type: "jsonb", json_type: "object",
    payload: { jsonrpc: "2.0", id: workspaceId, result: { retained: true } },
  }));
  expect(await payloadFacts()).toEqual(expectedPayloads);
  const streamRows = () => db.query("select * from platform.mcp_streams order by workspace_id,id");
  const eventRows = () => db.query("select * from platform.mcp_stream_events order by workspace_id,stream_id,seq");
  const custody = () => db.query("select c.relname,c.relowner,c.relrowsecurity,c.relforcerowsecurity,coalesce(c.relacl::text,'') as acl from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='platform' and c.relname in ('mcp_streams','mcp_stream_events') order by c.relname");
  const constraints = () => db.query("select c.conname,pg_get_constraintdef(c.oid) as definition from pg_constraint c where c.conrelid='platform.mcp_stream_events'::regclass order by c.conname");
  const policies = () => db.query("select * from pg_policies where schemaname='platform' and tablename in ('mcp_streams','mcp_stream_events') order by tablename,policyname");
  const before = { streams: await streamRows(), events: await eventRows(), custody: await custody(), constraints: await constraints(), policies: await policies() };
  expect(await db.query("select indexdef from pg_indexes where schemaname='platform' and indexname='mcp_stream_events_workspace_stream'")).toEqual([]);
  // The only pending migration is43:42's existing contract admission is untouched.
  const enforcement = process.env.ZENITH_ENFORCE_EXPAND_ONLY;
  const admission = process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS;
  try {
    process.env.ZENITH_ENFORCE_EXPAND_ONLY = "1";
    delete process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS;
    expect((await migratePlatformDb(db)).applied).toEqual([43]);
  } finally {
    if (enforcement === undefined) delete process.env.ZENITH_ENFORCE_EXPAND_ONLY;
    else process.env.ZENITH_ENFORCE_EXPAND_ONLY = enforcement;
    if (admission === undefined) delete process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS;
    else process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS = admission;
  }
  await assertPlatformSchemaCurrent(db);
  expect(await db.query("select * from platform.schema_migrations where version<=42 order by version")).toEqual(history);
  expect(await db.query("select indexdef from pg_indexes where schemaname='platform' and indexname='mcp_stream_events_workspace_stream'")).toEqual([{ indexdef: indexDefinition }]);
  expect({ streams: await streamRows(), events: await eventRows(), custody: await custody(), constraints: await constraints(), policies: await policies() }).toEqual(before);
  expect(await payloadFacts()).toEqual(expectedPayloads);
  expect(await db.query("select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='platform.mcp_stream_events'::regclass and contype='p'")).toEqual([{ definition: "PRIMARY KEY (stream_id, seq)" }]);
  expect(await db.query("select seq,payload from platform.mcp_stream_events where workspace_id=$1 and stream_id=$2 and seq>$3 order by seq limit $4",
    ["tenant-index-a", "a".repeat(32), 0, 10])).toEqual([{ seq: 1, payload: { jsonrpc: "2.0", id: "tenant-index-a", result: { retained: true } } }]);
  expect((await migratePlatformDb(db)).applied).toEqual([]);
}

it("schema42 to43 preserves stream rows, ledger, primary key, RLS and ACL [pglite]", async () => {
  const db = await openPlatformDb({ kind: "pglite", migrate: false });
  try { await upgrade(db); } finally { await db.close(); }
}, 60_000);

describe.skipIf(!PG_URL)("MCP stream tenant index [postgres]", () => {
  it("schema42 to43 preserves stream rows, ledger, primary key, RLS and ACL", async () => {
    await withScratchDatabase(async url => {
      const db = await openPlatformDb({ kind: "postgres", url, migrate: false, max: 1 });
      try { await upgrade(db); } finally { await db.close(); }
    });
  }, 60_000);
});
