/**
 * Migrations: apply on a fresh database, re-run is a no-op, tampering is
 * refused, the schema check fails closed with an actionable message, atomicity
 * per migration, concurrent migrators, and the emitted Supabase SQL — which must
 * be byte-identical to what the emitter renders now and must apply cleanly.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PLATFORM_MIGRATIONS,
  PlatformSchemaError,
  assertPlatformSchemaCurrent,
  migrationChecksum,
  migratePlatformDb,
  openPlatformDb,
  platformSchemaStatus,
  type PlatformDbHandle,
  type PlatformMigration,
} from "@/lib/controlplane/db";
import { EMITTED_FILE, EMITTED_RELATIVE_PATH, renderSupabaseMigration } from "@/lib/controlplane/db/migrations/emit";
import { BOOTSTRAP_SQL } from "@/lib/controlplane/db/migrations/bootstrap";
import { PG_URL, withScratchDatabase } from "./_support/harness";
import * as repos from "@/lib/controlplane/db/repos";
import { claimOperation, suspendForApproval } from "@/lib/controlplane/operations";
import { proposalFor, uid, user } from "./_support/harness";

const core = PLATFORM_MIGRATIONS[0];
/** Every shipped version; the suite must not assume how many migrations exist. */
const ALL = PLATFORM_MIGRATIONS.map((m) => m.version);
/** The next free version, for the synthetic migrations some tests append. */
const NEXT = PLATFORM_MIGRATIONS.length + 1;

const EXPECTED_TABLES = [
  "agent_nonces", "approvals", "build_launches", "capability_grants", "cost_estimates", "drift_reports", "environment_settings", "events", "evidence",
  "github_binding_events", "github_install_intents", "github_source_bindings", "github_webhook_deliveries", "github_webhook_installation_epochs", "idempotency_keys", "incidents", "investigations", "leases", "machine_request_logs", "machine_requests", "machines", "operations", "plan_artifact_associations", "plan_artifact_uses", "plan_artifacts", "policy_decisions", "provider_connections",
  "reconcile_state", "resource_observations", "resource_runtime", "resources", "runner_job_logs", "runner_jobs", "runner_registration_tokens", "runners",
  "schema_migrations", "workspace_policy",
];

/** Tables that hold no tenant-visible rows keyed by workspace (see the header of 0001_core.ts). */
// Signed installation events can revoke multiple tenants. These two tables
// are global App-scoped fences/receipts, never tenant-addressable resources.
const NO_WORKSPACE_COLUMN = new Set(["schema_migrations", "agent_nonces", "github_webhook_deliveries", "github_webhook_installation_epochs"]);

interface Lane {
  name: string;
  /** a fresh, empty, un-migrated database */
  withFresh<T>(fn: (open: (migrate: boolean) => Promise<PlatformDbHandle>) => Promise<T>): Promise<T>;
}

const lanes: Lane[] = [
  {
    name: "pglite",
    withFresh: async (fn) => {
      const opened: PlatformDbHandle[] = [];
      try {
        // in-memory PGlite databases are independent, so "reopen" is not possible; tests use one handle
        return await fn(async (migrate) => {
          const db = await openPlatformDb({ kind: "pglite", migrate });
          opened.push(db);
          return db;
        });
      } finally {
        await Promise.all(opened.map((d) => d.close()));
      }
    },
  },
  ...(PG_URL
    ? [
        {
          name: "postgres",
          withFresh: <T>(fn: (open: (migrate: boolean) => Promise<PlatformDbHandle>) => Promise<T>) =>
            withScratchDatabase(async (url) => {
              const opened: PlatformDbHandle[] = [];
              try {
                return await fn(async (migrate) => {
                  const db = await openPlatformDb({ kind: "postgres", url, migrate, max: 3 });
                  opened.push(db);
                  return db;
                });
              } finally {
                await Promise.all(opened.map((d) => d.close()));
              }
            }),
        },
      ]
    : []),
];

describe("migration set", () => {
  it("has contiguous versions from 1, unique names, and a stable checksum of the SQL text", () => {
    expect(PLATFORM_MIGRATIONS.map((m) => m.version)).toEqual(PLATFORM_MIGRATIONS.map((_, i) => i + 1));
    expect(new Set(PLATFORM_MIGRATIONS.map((m) => m.name)).size).toBe(PLATFORM_MIGRATIONS.length);
    expect(migrationChecksum(core)).toMatch(/^[0-9a-f]{64}$/);
    expect(migrationChecksum(core)).toBe(migrationChecksum({ ...core }));
    expect(migrationChecksum({ ...core, sql: `${core.sql} ` })).not.toBe(migrationChecksum(core));
  });

  it("preserves the checksums of shipped migrations 1 through 5", () => {
    expect(PLATFORM_MIGRATIONS.slice(0, 5).map(migrationChecksum)).toEqual([
      "ec4e2c1a7185e25ea6afa803e87abcc1fe8a06cb65651773f573f0b66de13764",
      "af708ba78998ba35b05966afc4f037bacec9b38905853e6f43c8fdab92cb47f0",
      "e1eccac97c7852592bcad8cd0e441b67a442c7405735ee9e2619e9e9b100bec6",
      "1e5d84e018bd35c3638bbd23bab8e5b0e7d9b6c3173a430259480508aca6f311",
      "e8349e5ddf50a5396304850bd84bbffe81be1f4b0b7189677c1c1ad36ad4a387",
    ]);
  });

  it("the emitted Supabase file is byte-identical to what the emitter renders now", () => {
    const committed = fs.readFileSync(path.join(process.cwd(), EMITTED_RELATIVE_PATH), "utf8");
    expect(committed).toBe(renderSupabaseMigration());
    expect(EMITTED_RELATIVE_PATH).toBe(`supabase/migrations/${EMITTED_FILE}`);
    // and it carries this build's checksum for every migration (so the TS migrator recognises it)
    for (const m of PLATFORM_MIGRATIONS) expect(committed).toContain(migrationChecksum(m));
    expect(committed).toContain("enable row level security");
    expect(committed).toMatch(/revoke all on schema platform from %I/);
    expect(committed).toMatch(/grant usage on schema platform to service_role/);
    expect(committed).not.toMatch(/create policy/i);
  });

  it("rendering is deterministic", () => {
    expect(renderSupabaseMigration()).toBe(renderSupabaseMigration());
  });
});

describe.each(lanes)("migrator [$name]", (lane) => {
  it("upgrades existing approvals without dropping their audit history, permitting a fresh plan round", async () => {
    await lane.withFresh(async (open) => {
      const db = await open(false);
      const legacy = PLATFORM_MIGRATIONS.filter((m) => m.version < 4);
      await migratePlatformDb(db, legacy);
      const workspaceId = uid("ws");
      const approver = user();
      const { operation: op } = await repos.operations.create(db, { workspaceId, principal: user(), proposal: proposalFor(workspaceId), status: "awaiting_approval" });
      const approvalId = uid("approval");
      await db.query(`insert into platform.approvals
        (id, workspace_id, operation_id, proposal_digest, decision, approver, approver_id, approver_role, policy_version, expires_at)
        values ($1,$2,$3,$4,'approve',$5::text::jsonb,$6,'editor','legacy',clock_timestamp() + interval '1 hour')`,
      [approvalId, workspaceId, op.id, op.proposalDigest, JSON.stringify(approver), approver.id]);
      await db.query("update platform.operations set status = 'approved' where workspace_id = $1 and id = $2", [workspaceId, op.id]);
      expect((await migratePlatformDb(db)).applied).toEqual(PLATFORM_MIGRATIONS.filter((m) => m.version >= 4).map((m) => m.version));
      expect(await db.query("select approval_round from platform.approvals where workspace_id = $1 and id = $2", [workspaceId, approvalId])).toEqual([{ approval_round: 0 }]);
      await claimOperation(db, { workspaceId, id: op.id, expectedDigest: op.proposalDigest, holder: "worker" });
      await suspendForApproval(db, { workspaceId, id: op.id });
      await repos.approvals.record(db, { workspaceId, operationId: op.id, approver, approverRole: "editor", decision: "approve", proposalDigest: op.proposalDigest, policyVersion: "plan" });
      expect(await db.query("select approval_round from platform.approvals where workspace_id = $1 and operation_id = $2 order by approval_round", [workspaceId, op.id])).toEqual([{ approval_round: 0 }, { approval_round: 1 }]);
      expect((await repos.approvals.listForOperation(db, workspaceId, op.id))[0].id).toBe(approvalId);
    });
  }, 60_000);

  it("applies on a fresh database, records the ledger with checksums, and re-running is a no-op", async () => {
    await lane.withFresh(async (open) => {
      const db = await open(false);
      const before = await platformSchemaStatus(db);
      expect(before).toMatchObject({ ledgerPresent: false, current: false });
      expect(before.pending.map((m) => m.version)).toEqual(ALL);

      const first = await migratePlatformDb(db);
      expect(first).toEqual({ applied: ALL, alreadyApplied: [] });
      const status = await platformSchemaStatus(db);
      expect(status).toMatchObject({ ledgerPresent: true, current: true, pending: [], tampered: [], ahead: [] });
      expect(status.applied[0]).toMatchObject({ version: 1, name: "core", checksum: migrationChecksum(core) });
      expect(status.applied[0].appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

      const second = await migratePlatformDb(db);
      expect(second).toEqual({ applied: [], alreadyApplied: ALL });
      await assertPlatformSchemaCurrent(db);

      const tables = await db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'platform' order by table_name");
      expect(tables.map((t) => t.table_name)).toEqual(EXPECTED_TABLES);
      // Explicit isolated PGlite fixtures have no Supabase roles; guarded migration-7 hardening must still apply.
      if(lane.name==="pglite")expect(await db.query("select rolname from pg_roles where rolname in ('anon','authenticated','service_role')")).toEqual([]);
      expect(await db.query(`select c.relname as name,c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='platform' and c.relname in ('plan_artifacts','plan_artifact_associations','plan_artifact_uses') order by c.relname`)).toEqual([
          {name:"plan_artifact_associations",rls:true},{name:"plan_artifact_uses",rls:true},{name:"plan_artifacts",rls:true},
        ]);
    });
  }, 60_000);

  it("every tenant table has a NOT NULL workspace_id and an index that leads with it", async () => {
    await lane.withFresh(async (open) => {
      const db = await open(true);
      const columns = await db.query<{ table_name: string; is_nullable: string }>(
        "select table_name, is_nullable from information_schema.columns where table_schema = 'platform' and column_name = 'workspace_id'"
      );
      const withWorkspace = new Map(columns.map((c) => [c.table_name, c.is_nullable]));
      const tables = EXPECTED_TABLES.filter((t) => !NO_WORKSPACE_COLUMN.has(t));
      for (const t of tables) expect(withWorkspace.has(t), `${t} has workspace_id`).toBe(true);
      // leases carry an OPTIONAL workspace id (scopes such as env:<id> are globally unique); everything else is NOT NULL
      for (const t of tables.filter((x) => x !== "leases")) expect(withWorkspace.get(t), `${t}.workspace_id nullable`).toBe("NO");
      expect(withWorkspace.get("leases")).toBe("YES");

      const indexed = await db.query<{ table_name: string }>(
        `select distinct c.relname as table_name
           from pg_index i
           join pg_class c on c.oid = i.indrelid
           join pg_namespace n on n.oid = c.relnamespace
           join pg_attribute a on a.attrelid = c.oid and a.attnum = i.indkey[0]
          where n.nspname = 'platform' and a.attname = 'workspace_id'`
      );
      const leading = new Set(indexed.map((r) => r.table_name));
      for (const t of tables) expect(leading.has(t), `${t} has an index leading with workspace_id`).toBe(true);

      for (const [table, keys] of [
        ["github_webhook_installation_epochs", ["app_id", "installation_id"]],
        ["github_webhook_deliveries", ["app_id", "delivery_id"]],
      ] as const) {
        expect(withWorkspace.has(table), `${table} is explicitly App-scoped`).toBe(false);
        const columns = await db.query<{ column_name: string; is_nullable: string }>(
          "select column_name, is_nullable from information_schema.columns where table_schema='platform' and table_name=$1", [table]);
        for (const key of keys) expect(columns.find(column => column.column_name === key)?.is_nullable, `${table}.${key} cannot be unscoped`).toBe("NO");
        const primary = await db.query<{ column_name: string }>(`select k.column_name from information_schema.table_constraints c
          join information_schema.key_column_usage k on k.constraint_schema=c.constraint_schema and k.constraint_name=c.constraint_name
          where c.table_schema='platform' and c.table_name=$1 and c.constraint_type='PRIMARY KEY' order by k.ordinal_position`, [table]);
        expect(primary.map(column => column.column_name)).toEqual(keys);
        const [security] = await db.query<{ rls: boolean }>(`select c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='platform' and c.relname=$1`, [table]);
        expect(security.rls).toBe(true);
      }
    });
  }, 60_000);

  it("refuses to proceed when an applied migration's checksum no longer matches the code", async () => {
    await lane.withFresh(async (open) => {
      const db = await open(true);
      const tampered: PlatformMigration = { ...core, sql: `${core.sql}\n-- edited after release\n` };
      const err = await migratePlatformDb(db, [tampered]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PlatformSchemaError);
      expect((err as PlatformSchemaError).code).toBe("schema_tampered");
      expect((err as PlatformSchemaError).message).toMatch(/never be edited/);
      await expect(assertPlatformSchemaCurrent(db, [tampered])).rejects.toMatchObject({ code: "schema_tampered" });
      expect((await platformSchemaStatus(db, [tampered])).tampered).toEqual([
        { version: 1, name: "core", expected: migrationChecksum(tampered), actual: migrationChecksum(core) },
      ]);
      // and a pending second migration in the same call is NOT applied behind a tampered first
      const extra: PlatformMigration = { version: NEXT, name: "extra", sql: "create table platform.zz_never (id int);" };
      await expect(migratePlatformDb(db, [tampered, ...PLATFORM_MIGRATIONS.slice(1), extra])).rejects.toMatchObject({ code: "schema_tampered" });
      expect(await db.query("select 1 from information_schema.tables where table_schema = 'platform' and table_name = 'zz_never'")).toEqual([]);
    });
  }, 60_000);

  it("fails closed when behind, naming the command and the file; migrating then satisfies it", async () => {
    await lane.withFresh(async (open) => {
      const db = await open(false);
      const missingLedger = await assertPlatformSchemaCurrent(db).catch((e: unknown) => e);
      expect(missingLedger).toBeInstanceOf(PlatformSchemaError);
      expect((missingLedger as PlatformSchemaError).code).toBe("schema_behind");
      expect((missingLedger as Error).message).toContain("npx tsx scripts/platform/migrate.ts");
      expect((missingLedger as Error).message).toContain("supabase/migrations/0014_platform_core.sql");

      await migratePlatformDb(db);
      const second: PlatformMigration = { version: NEXT, name: "second", sql: "create table if not exists platform.zz_second (id int primary key);" };
      const behind = await assertPlatformSchemaCurrent(db, [...PLATFORM_MIGRATIONS, second]).catch((e: unknown) => e);
      expect((behind as PlatformSchemaError).code).toBe("schema_behind");
      expect((behind as Error).message).toContain(`${NEXT} ("second")`);

      expect(await migratePlatformDb(db, [...PLATFORM_MIGRATIONS, second])).toEqual({ applied: [NEXT], alreadyApplied: ALL });
      await assertPlatformSchemaCurrent(db, [...PLATFORM_MIGRATIONS, second]);
    });
  }, 60_000);

  it("tolerates a database that is ahead of this build (a newer deploy already migrated)", async () => {
    await lane.withFresh(async (open) => {
      const db = await open(true);
      const newer: PlatformMigration = { version: NEXT, name: "newer", sql: "create table if not exists platform.zz_newer (id int primary key);" };
      await migratePlatformDb(db, [...PLATFORM_MIGRATIONS, newer]);
      const status = await platformSchemaStatus(db); // this build does not know the newest version
      expect(status).toMatchObject({ current: true, ahead: [NEXT], pending: [], tampered: [] });
      await assertPlatformSchemaCurrent(db);
    });
  }, 60_000);

  it("applies each migration atomically with its ledger row: a failing migration leaves nothing behind", async () => {
    await lane.withFresh(async (open) => {
      const db = await open(true);
      const ok: PlatformMigration = { version: NEXT, name: "ok", sql: "create table platform.zz_ok (id int primary key);" };
      const broken: PlatformMigration = {
        version: NEXT + 1,
        name: "broken",
        sql: "create table platform.zz_half (id int primary key);\ncreate table platform.zz_bad (id int references platform.does_not_exist (id));",
      };
      await expect(migratePlatformDb(db, [...PLATFORM_MIGRATIONS, ok, broken])).rejects.toMatchObject({ code: "db_error" });
      const status = await platformSchemaStatus(db, [...PLATFORM_MIGRATIONS, ok, broken]);
      expect(status.applied.map((a) => a.version)).toEqual([...ALL, NEXT]); // `ok` stays applied, `broken` left no trace
      expect(await db.query("select 1 from information_schema.tables where table_schema = 'platform' and table_name = 'zz_half'")).toEqual([]);
    });
  }, 60_000);

  it("the emitted SQL applies on a fresh database, is idempotent, and is recognised by the TypeScript migrator", async () => {
    await lane.withFresh(async (open) => {
      const db = await open(false);
      const emitted = renderSupabaseMigration();
      await db.exec(emitted);
      await db.exec(emitted); // re-applying is a no-op
      const status = await platformSchemaStatus(db);
      expect(status).toMatchObject({ ledgerPresent: true, current: true, tampered: [] });
      expect(status.applied.map((a) => ({ v: a.version, n: a.name, c: a.checksum }))).toEqual(
        PLATFORM_MIGRATIONS.map((m) => ({ v: m.version, n: m.name, c: migrationChecksum(m) }))
      );
      expect(await migratePlatformDb(db)).toEqual({ applied: [], alreadyApplied: ALL });
      const tables = await db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'platform' order by table_name");
      expect(tables.map((t) => t.table_name)).toEqual(EXPECTED_TABLES);
      // Explicit isolated PGlite fixtures have no Supabase roles; guarded migration-7 hardening must still apply.
      if(lane.name==="pglite")expect(await db.query("select rolname from pg_roles where rolname in ('anon','authenticated','service_role')")).toEqual([]);
      expect(await db.query(`select c.relname as name,c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='platform' and c.relname in ('plan_artifacts','plan_artifact_associations','plan_artifact_uses') order by c.relname`)).toEqual([
          {name:"plan_artifact_associations",rls:true},{name:"plan_artifact_uses",rls:true},{name:"plan_artifacts",rls:true},
        ]);

      // hardening: RLS is on for every table, and there are NO policies
      const unprotected = await db.query<{ relname: string }>(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'platform' and c.relkind = 'r' and not c.relrowsecurity`
      );
      expect(unprotected).toEqual([]);
      expect(await db.query("select 1 from pg_policies where schemaname = 'platform'")).toEqual([]);
    });
  }, 60_000);

  it("the emitted SQL grants only service_role and revokes anon/authenticated when the Supabase roles exist", async () => {
    await lane.withFresh(async (open) => {
      const db = await open(false);
      const rollback = new Error("rollback the role creation");
      // Roles are cluster-wide; create them inside a transaction that is always rolled back.
      const result = await db
        .tx(async (tx) => {
          await tx.query("create role anon nologin noinherit");
          await tx.query("create role authenticated nologin noinherit");
          await tx.query("create role service_role nologin noinherit bypassrls");
          await (tx as unknown as { exec(t: string): Promise<void> }).exec(renderSupabaseMigration());
          const rows = await tx.query<Record<string, boolean>>(
            `select has_schema_privilege('service_role', 'platform', 'USAGE') as service_usage,
                    has_table_privilege('service_role', 'platform.operations', 'SELECT,INSERT,UPDATE,DELETE') as service_dml,
                    has_sequence_privilege('service_role', 'platform.events_seq_seq', 'USAGE') as service_seq,
                    has_schema_privilege('anon', 'platform', 'USAGE') as anon_usage,
                    has_schema_privilege('authenticated', 'platform', 'USAGE') as auth_usage,
                    has_table_privilege('anon', 'platform.operations', 'SELECT') as anon_select,
                    has_table_privilege('authenticated', 'platform.events', 'SELECT') as auth_select,
                    has_table_privilege('service_role', 'platform.github_source_bindings', 'SELECT,INSERT,UPDATE,DELETE') as github_binding_dml,
                    has_table_privilege('service_role', 'platform.github_install_intents', 'SELECT,INSERT,UPDATE,DELETE') as github_intent_dml,
                    has_table_privilege('anon', 'platform.github_source_bindings', 'SELECT') as anon_github_select,
                    has_table_privilege('authenticated', 'platform.github_install_intents', 'SELECT') as auth_github_select`
          );
          throw Object.assign(rollback, { rows });
        })
        .catch((e: unknown) => e);
      expect(result).toBe(rollback);
      expect((result as unknown as { rows: Record<string, boolean>[] }).rows[0]).toEqual({
        service_usage: true,
        service_dml: true,
        service_seq: true,
        anon_usage: false,
        auth_usage: false,
        anon_select: false,
        auth_select: false,
        github_binding_dml: true,
        github_intent_dml: true,
        anon_github_select: false,
        auth_github_select: false,
      });
      // the rollback left no roles and no schema behind
      expect(await db.query("select 1 from pg_roles where rolname = 'service_role'")).toEqual([]);
      expect(await db.query("select 1 from information_schema.schemata where schema_name = 'platform'")).toEqual([]);
    });
  }, 60_000);
});

describe.skipIf(!PG_URL)("migrator [postgres] concurrency and fail-closed open", () => {
  it("schema 6 emitted hardening upgrades through the canonical migrator under a distinct owner with RLS, role isolation and immutable artifacts",async()=>{
    await withScratchDatabase(async url=>{
      const db=await openPlatformDb({kind:"postgres",url,migrate:false,max:1});
      const rollback=new Error("Deliberate private upgrade fixture rollback");
      try {
        const result=await db.tx(async tx=>{
          // Test roles are transaction-local DDL and roll back; existing roles are never altered.
          await db.exec(`do $$ begin
            if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
            if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
            if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
          end $$;`);
          const emitted=renderSupabaseMigration();
          const seventh=emitted.indexOf("-- ============================ migration 7: plan_artifacts");
          const hardening=emitted.indexOf("-- ============================ hardening (Supabase roles)");
          if(seventh<0 || hardening<seventh)throw new Error("Canonical emitted migration boundaries are unavailable.");
          // Exact shipped 1–6 text/checksums plus existing emitted hardening.
          await db.exec(emitted.slice(0,seventh)+emitted.slice(hardening));
          const pending = PLATFORM_MIGRATIONS.filter(m => m.version > 6).map(m => m.version);
          expect((await platformSchemaStatus(db)).pending.map(m=>m.version)).toEqual(pending);
          await expect(assertPlatformSchemaCurrent(db)).rejects.toMatchObject({code:"schema_behind"});
          const originalUser=(await tx.query<{name:string}>("select current_user as name"))[0].name;
          const migrationOwner=uid("zt_plan_migration").replace(/-/g,"");
          const legacySourceOwner=uid("zt_source_owner").replace(/-/g,"");
          // A distinct authorized migration owner has schema-create, ledger DML/RLS bypass, and FK references.
          const databaseName=(await tx.query<{name:string}>("select current_database() as name"))[0].name;
          await db.exec(`create role ${migrationOwner} nologin bypassrls;
            create role ${legacySourceOwner} nologin;
            grant usage on schema platform to ${legacySourceOwner};
            alter table platform.github_source_bindings owner to ${legacySourceOwner};
            alter table platform.github_install_intents owner to ${legacySourceOwner};
            grant ${legacySourceOwner} to ${migrationOwner};
            grant create on database "${databaseName.replace(/"/g,'""')}" to ${migrationOwner};
            grant usage,create on schema platform to ${migrationOwner} with grant option;
            grant select,insert,update,delete on all tables in schema platform to ${migrationOwner};
            grant references on table platform.operations,platform.github_source_bindings to ${migrationOwner};`);
          await tx.query(`set local role ${migrationOwner}`);
          expect((await tx.query<{name:string}>("select current_user as name"))[0].name).toBe(migrationOwner);
          expect(migrationOwner).not.toBe(originalUser);
          expect(await migratePlatformDb(db)).toEqual({applied:pending,alreadyApplied:[1,2,3,4,5,6]});
          await assertPlatformSchemaCurrent(db);
          const ledger=(await platformSchemaStatus(db)).applied.find(m=>m.version===7);
          expect(ledger?.checksum).toBe(migrationChecksum(PLATFORM_MIGRATIONS[6]));
          expect(await migratePlatformDb(db)).toEqual({applied:[],alreadyApplied:ALL});
          await tx.query("reset role");
          const tables=await tx.query<{name:string;rls:boolean;owner:string}>(`select c.relname as name,c.relrowsecurity as rls,pg_get_userbyid(c.relowner) as owner
            from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='platform'
            and c.relname in ('plan_artifacts','plan_artifact_associations','plan_artifact_uses','build_launches','github_binding_events','github_webhook_deliveries','github_webhook_installation_epochs') order by c.relname`);
          expect(tables).toHaveLength(7);
          for(const table of tables) {
            expect(table.rls).toBe(true);expect(table.owner).toBe(migrationOwner);
            for(const role of ["anon","authenticated"]) {
              for(const privilege of ["SELECT","INSERT","UPDATE","DELETE"])
                expect((await tx.query<{allowed:boolean}>("select has_table_privilege($1,$2,$3) as allowed",[role,`platform.${table.name}`,privilege]))[0].allowed).toBe(false);
              await expect(db.tx(async denied=>{await denied.query(`set local role ${role}`);await denied.query(`select count(*) from platform.${table.name}`);})).rejects.toMatchObject({sqlstate:"42501"});
            }
            // Canonical migration-specific grants do not replay aggregate emitted hardening.
            // A distinct creator role also has its own default-privilege namespace.
            const grants: Record<string, readonly string[]> = {
              plan_artifacts: ["SELECT", "INSERT", "UPDATE", "DELETE"],
              plan_artifact_associations: ["SELECT", "INSERT", "UPDATE", "DELETE"],
              plan_artifact_uses: ["SELECT", "INSERT", "UPDATE", "DELETE"],
              build_launches: ["SELECT", "INSERT", "UPDATE"],
              github_binding_events: ["SELECT", "INSERT"],
              github_webhook_deliveries: ["SELECT", "INSERT", "UPDATE"],
              github_webhook_installation_epochs: ["SELECT", "INSERT", "UPDATE"],
            };
            for(const privilege of ["SELECT","INSERT","UPDATE","DELETE"])
              expect((await tx.query<{allowed:boolean}>("select has_table_privilege('service_role',$1,$2) as allowed",[`platform.${table.name}`,privilege]))[0].allowed).toBe(grants[table.name].includes(privilege));
          }
          for(const role of ["anon","authenticated"])
            expect((await tx.query<{allowed:boolean}>("select has_schema_privilege($1,'platform','USAGE') as allowed",[role]))[0].allowed).toBe(false);
          expect((await tx.query<{allowed:boolean}>("select has_schema_privilege('service_role','platform','USAGE') as allowed"))[0].allowed).toBe(true);
          expect(await tx.query("select policyname from pg_policies where schemaname='platform' and tablename in ('plan_artifacts','plan_artifact_associations','plan_artifact_uses')")).toEqual([]);
          const ws=uid("ws_upgrade"),planDigest="d".repeat(64);
          const source=await repos.operations.create(tx,{workspaceId:ws,principal:user(),proposal:proposalFor(ws,{capability:"infrastructure.plan",planDigest})});
          const destination=await repos.operations.create(tx,{workspaceId:ws,principal:user(),proposal:proposalFor(ws,{capability:"infrastructure.destroy",planDigest})});
          // Synthetic ciphertext exercises upgrade triggers/ACLs only; this is not producer or dispatch evidence.
          await tx.query(`insert into platform.plan_artifacts(workspace_id,operation_id,manifest,manifest_digest,plan_digest,iv,auth_tag,ciphertext,expires_at)
            values($1,$2,$3::jsonb,$4,$4,$5,$6,'synthetic-ciphertext',clock_timestamp()+interval '1 hour')`,
            [ws,source.operation.id,JSON.stringify({workspaceId:ws,operationId:source.operation.id,planDigest}),planDigest,"A".repeat(16),"A".repeat(24)]);
          await tx.query(`insert into platform.plan_artifact_associations(workspace_id,operation_id,source_operation_id,source_evidence_id,source_manifest_digest,source_raw_sha256,proposal_digest,input_digest,expires_at)
            values($1,$2,$3,'synthetic-evidence',$4,$4,$5,$6,clock_timestamp()+interval '1 hour')`,[ws,destination.operation.id,source.operation.id,planDigest,destination.operation.proposalDigest,destination.operation.inputDigest]);
          for(const table of ["plan_artifacts","plan_artifact_associations"]) {
            await expect(db.tx(inner=>inner.query(`update platform.${table} set expires_at=clock_timestamp() where workspace_id=$1`,[ws]))).rejects.toMatchObject({sqlstate:"23514"});
            await expect(db.tx(inner=>inner.query(`delete from platform.${table} where workspace_id=$1`,[ws]))).rejects.toMatchObject({sqlstate:"23514"});
          }
          // No inferred custom runtime grants: the existing service-role RLS bypass is an explicit prerequisite.
          expect((await tx.query<{bypass:boolean}>("select rolbypassrls as bypass from pg_roles where rolname='service_role'"))[0].bypass).toBe(true);
          await db.tx(async service=>{await service.query("set local role service_role");expect(await service.query("select operation_id from platform.plan_artifacts where workspace_id=$1",[ws])).toEqual([{operation_id:source.operation.id}]);});
          await tx.query("reset role");
          await db.exec(renderSupabaseMigration());await assertPlatformSchemaCurrent(db);
          expect(await migratePlatformDb(db)).toEqual({applied:[],alreadyApplied:ALL});
          throw rollback;
        }).catch((error:unknown)=>error);
        expect(result).toBe(rollback);
      } finally {await db.close();}
    });
  },60000);

  it("two migrators racing on an empty database converge: one applies, the other finds it done", async () => {
    await withScratchDatabase(async (url) => {
      const a = await openPlatformDb({ kind: "postgres", url, migrate: false, max: 2 });
      const b = await openPlatformDb({ kind: "postgres", url, migrate: false, max: 2 });
      try {
        const results = await Promise.all([migratePlatformDb(a), migratePlatformDb(b), migratePlatformDb(a), migratePlatformDb(b)]);
        expect(results.flatMap((r) => r.applied)).toEqual(ALL);
        expect(await platformSchemaStatus(a)).toMatchObject({ current: true });
        const ledger = await a.query<{ n: number }>("select count(*)::int as n from platform.schema_migrations");
        expect(ledger[0].n).toBe(ALL.length);
      } finally {
        await a.close();
        await b.close();
      }
    });
  }, 60_000);

  it("openPlatformDb({ kind: 'postgres' }) does not migrate unless asked, and a bare open sees the schema as behind", async () => {
    await withScratchDatabase(async (url) => {
      const db = await openPlatformDb({ kind: "postgres", url, max: 1 });
      try {
        expect((await platformSchemaStatus(db)).ledgerPresent).toBe(false);
        await expect(assertPlatformSchemaCurrent(db)).rejects.toMatchObject({ code: "schema_behind" });
      } finally {
        await db.close();
      }
    });
  }, 60_000);

  it("BOOTSTRAP_SQL is idempotent", async () => {
    await withScratchDatabase(async (url) => {
      const db = await openPlatformDb({ kind: "postgres", url, max: 1 });
      try {
        await db.exec(BOOTSTRAP_SQL);
        await db.exec(BOOTSTRAP_SQL);
        expect((await platformSchemaStatus(db)).ledgerPresent).toBe(true);
      } finally {
        await db.close();
      }
    });
  }, 60_000);
});
