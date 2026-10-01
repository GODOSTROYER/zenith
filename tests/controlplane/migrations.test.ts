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

const core = PLATFORM_MIGRATIONS[0];
/** Every shipped version; the suite must not assume how many migrations exist. */
const ALL = PLATFORM_MIGRATIONS.map((m) => m.version);
/** The next free version, for the synthetic migrations some tests append. */
const NEXT = PLATFORM_MIGRATIONS.length + 1;

const EXPECTED_TABLES = [
  "agent_nonces", "approvals", "capability_grants", "cost_estimates", "drift_reports", "environment_settings", "events", "evidence",
  "idempotency_keys", "incidents", "investigations", "leases", "machine_request_logs", "machine_requests", "machines", "operations", "policy_decisions", "provider_connections",
  "reconcile_state", "resource_observations", "resource_runtime", "resources", "runner_job_logs", "runner_jobs", "runner_registration_tokens", "runners",
  "schema_migrations", "workspace_policy",
];

/** Tables that hold no tenant-visible rows keyed by workspace (see the header of 0001_core.ts). */
const NO_WORKSPACE_COLUMN = new Set(["schema_migrations", "agent_nonces"]);

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
                    has_table_privilege('authenticated', 'platform.events', 'SELECT') as auth_select`
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
      });
      // the rollback left no roles and no schema behind
      expect(await db.query("select 1 from pg_roles where rolname = 'service_role'")).toEqual([]);
      expect(await db.query("select 1 from information_schema.schemata where schema_name = 'platform'")).toEqual([]);
    });
  }, 60_000);
});

describe.skipIf(!PG_URL)("migrator [postgres] concurrency and fail-closed open", () => {
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
