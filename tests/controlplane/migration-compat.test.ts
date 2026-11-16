/**
 * PROD-OPS-03: API N-1 / N schema compatibility contract (src/lib/controlplane/db/compat.ts).
 *
 * Pure classification tests, plus a PGlite upgrade rehearsal: an "N-1 build" (the
 * migration list it knows) keeps working against a schema an "N build" has already
 * migrated, an N build fails closed against an N-1 schema, and a contract migration
 * is refused before anything is applied. PGlite is the real Postgres engine
 * in-process; the same rehearsal against a networked Postgres is the
 * ZENITH_TEST_PLATFORM_PG_URL lane of tests/controlplane/migrations.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PLATFORM_MIGRATIONS,
  PlatformSchemaError,
  assertPlatformSchemaCurrent,
  migratePlatformDb,
  openPlatformDb,
  platformSchemaStatus,
  type PlatformMigration,
} from "@/lib/controlplane/db";
import {
  compatBaseline,
  ContractMigrationRefusedError,
  assertPendingMigrationsCompatible,
  assessPlatformMigration,
  contractViolations,
  parseAllowedContractVersions,
  type ContractMigrationApproval,
} from "@/lib/controlplane/db/compat";
import { sha256Hex } from "@/lib/controlplane/digest";

const V = compatBaseline() + 1;
const m = (version: number, sql: string, name = `synthetic_${version}`): PlatformMigration => ({ version, name, sql });

const EXPAND = m(V, `
create table if not exists platform.rehearsal_new (id text primary key, workspace_id text not null);
alter table platform.rehearsal_new enable row level security;
create index if not exists rehearsal_new_ws on platform.rehearsal_new (workspace_id);
alter table platform.operations add column if not exists rehearsal_note text;
`);
const DROP_COLUMN = m(V + 1, "alter table platform.operations drop column rehearsal_note;");
const RENAME = m(V + 2, "alter table platform.operations rename column rehearsal_note to note;");
const SET_NOT_NULL = m(V + 3, "alter table platform.operations alter column rehearsal_note set not null;");
const NOT_NULL_NO_DEFAULT = m(V + 4, "alter table platform.operations add column strict_col text not null;");
const DROP_TABLE = m(V + 5, "drop table platform.events;");
const RLS_EXISTING = m(V + 6, "alter table platform.operations disable row level security;");
const UNKNOWN = m(V + 7, "reindex table platform.operations;");

describe("migration compatibility classification", () => {
  it("accepts only bounded whole numeric compatibility baseline versions", () => {
    expect(compatBaseline({ ZENITH_COMPAT_BASELINE_VERSION: " 41 " })).toBe(41);
    expect(compatBaseline({ ZENITH_COMPAT_BASELINE_VERSION: "0" })).toBe(0);
    expect(compatBaseline({ ZENITH_COMPAT_BASELINE_VERSION: "999999" })).toBe(999999);
    for (const value of ["d", "ddd", "-1", "1.5", "1e2", "1000000", "41,42"])
      expect(() => compatBaseline({ ZENITH_COMPAT_BASELINE_VERSION: value })).toThrow(ContractMigrationRefusedError);
  });
  it("binds the authorized external-effect repair to exact SQL and an explicit drained-writer version", () => {
    const repair = PLATFORM_MIGRATIONS.find((migration) => migration.version === 42)!;
    expect(assessPlatformMigration(repair, 41).class).toBe("contract");
    expect(contractViolations([repair], { baseline: 41 })).toEqual([]);
    expect(() => assertPendingMigrationsCompatible([repair], { baseline: 41, allowed: new Set() })).toThrow("previous release is drained");
    expect(() => assertPendingMigrationsCompatible([repair], { baseline: 41, allowed: new Set([41]) })).toThrow("previous release is drained");
    expect(() => assertPendingMigrationsCompatible([repair], { baseline: 41, allowed: new Set([42]) })).not.toThrow();
    expect(() => assertPendingMigrationsCompatible([{ ...repair, sql: repair.sql + " " }], { baseline: 41, allowed: new Set([42]) })).toThrow("SQL changed after approval");
    expect(() => assertPendingMigrationsCompatible([repair], { baseline: 41, approvals: [], allowed: new Set([42]) })).toThrow("no LIFE-10 approval");
  });

  it("accepts an expand migration, including RLS/index on a table created in the same migration", () => {
    const a = assessPlatformMigration(EXPAND);
    expect(a.class).toBe("expand");
    expect(a.localStatements).toBeGreaterThanOrEqual(2);
    expect(contractViolations([EXPAND])).toEqual([]);
  });

  it.each([
    ["dropping a column", DROP_COLUMN],
    ["renaming a column", RENAME],
    ["adding NOT NULL to an existing column", SET_NOT_NULL],
    ["adding a NOT NULL column without a default", NOT_NULL_NO_DEFAULT],
    ["dropping a table", DROP_TABLE],
    ["changing RLS on an existing table", RLS_EXISTING],
  ])("classifies %s as contract", (_name, migration) => {
    expect(assessPlatformMigration(migration).class).toBe("contract");
    expect(contractViolations([migration])).toHaveLength(1);
  });

  it("treats an unrecognised statement as unclassified (refused), never as expand", () => {
    expect(assessPlatformMigration(UNKNOWN).class).toBe("unclassified");
    expect(contractViolations([UNKNOWN])).toHaveLength(1);
  });

  it("a destructive statement cannot hide next to a new-table statement", () => {
    const mixed = m(V + 8, "create table platform.fresh (id text primary key); alter table platform.operations drop column rehearsal_note;");
    expect(assessPlatformMigration(mixed).class).toBe("contract");
  });

  it("grandfathers the baseline: migrations up to compatBaseline() are never refused", () => {
    expect(contractViolations([m(compatBaseline(), "drop table platform.events;")])).toEqual([]);
    expect(assessPlatformMigration(m(1, "drop table x;")).baseline).toBe(true);
  });

  it("every shipped migration past the baseline is expand-only (vacuous until the first release cut)", () => {
    const past = PLATFORM_MIGRATIONS.filter((x) => x.version > compatBaseline());
    expect(contractViolations(past), "a post-baseline migration is contract/unclassified without a registered approval").toEqual([]);
  });

  it("assesses every real migration without throwing (classification is total)", () => {
    for (const migration of PLATFORM_MIGRATIONS) expect(() => assessPlatformMigration(migration)).not.toThrow();
  });
});

describe("contract migrations need a registered approval AND operator confirmation", () => {
  const approval = (migration: PlatformMigration, overrides: Partial<ContractMigrationApproval> = {}): ContractMigrationApproval => ({
    version: migration.version, sqlSha256: sha256Hex(migration.sql), approvalRef: "release-approval-test", rationale: "test", ...overrides,
  });

  it("refuses an unregistered contract migration even when the operator names it", () => {
    expect(() => assertPendingMigrationsCompatible([DROP_COLUMN], { approvals: [], allowed: new Set([DROP_COLUMN.version]) })).toThrow(ContractMigrationRefusedError);
  });

  it("refuses a registered one without the operator confirmation, and names the variable", () => {
    expect(() => assertPendingMigrationsCompatible([DROP_COLUMN], { approvals: [approval(DROP_COLUMN)], allowed: new Set() })).toThrow(/ZENITH_ALLOW_CONTRACT_MIGRATIONS=\d+/);
  });

  it("allows it only with both", () => {
    expect(() => assertPendingMigrationsCompatible([DROP_COLUMN], { approvals: [approval(DROP_COLUMN)], allowed: new Set([DROP_COLUMN.version]) })).not.toThrow();
  });

  it("voids the approval when the SQL changes after approval", () => {
    const edited = { ...DROP_COLUMN, sql: `${DROP_COLUMN.sql}\n-- edited` };
    const violations = contractViolations([edited], { approvals: [approval(DROP_COLUMN)] });
    expect(violations).toMatchObject([{ reason: "sql_changed_since_approval" }]);
  });

  it("parses the confirmation list strictly", () => {
    expect([...parseAllowedContractVersions("46, 47")]).toEqual([46, 47]);
    expect(parseAllowedContractVersions(undefined).size).toBe(0);
    expect(() => parseAllowedContractVersions("46;drop")).toThrow(ContractMigrationRefusedError);
  });
});

describe("upgrade rehearsal on a real Postgres engine (PGlite): N-1 build vs N schema and back", () => {
  const A = m(9001, "create table if not exists platform.rehearsal_t (id text primary key, a text);", "rehearsal_a");
  const B = m(9002, "alter table platform.rehearsal_t add column if not exists b text; create table if not exists platform.rehearsal_u (id text primary key);", "rehearsal_b");
  const NMINUS1 = [...PLATFORM_MIGRATIONS, A];
  const N = [...NMINUS1, B];

  it("an N-1 build keeps running against the N schema (database ahead is allowed) and its writes stay valid", async () => {
    const db = await openPlatformDb({ kind: "pglite", migrate: false });
    try {
      await migratePlatformDb(db, NMINUS1);
      await db.query("insert into platform.rehearsal_t (id, a) values ('old-1', 'written by N-1')");
      // Roll N out: the migration runs first (expand), then the new code.
      const result = await migratePlatformDb(db, N);
      expect(result.applied).toEqual([9002]);
      const n1 = await platformSchemaStatus(db, NMINUS1);
      expect(n1.ahead).toEqual([9002]);
      await expect(assertPlatformSchemaCurrent(db, NMINUS1), "N-1 must run against schema N").resolves.toBeUndefined();
      // N-1 code (no knowledge of column b / table rehearsal_u) still reads and writes.
      await db.query("insert into platform.rehearsal_t (id, a) values ('old-2', 'written by N-1 after N migrated')");
      const rows = await db.query<{ id: string; a: string; b: string | null }>("select id, a, b from platform.rehearsal_t order by id");
      expect(rows.map((r) => r.id)).toEqual(["old-1", "old-2"]);
      // Rollback to N-1 after N wrote its new column: rows N wrote are readable by N-1's query shape.
      await db.query("insert into platform.rehearsal_t (id, a, b) values ('new-1', 'written by N', 'extra')");
      const n1View = await db.query<{ id: string; a: string }>("select id, a from platform.rehearsal_t order by id");
      expect(n1View.map((r) => r.id)).toEqual(["new-1", "old-1", "old-2"]);
    } finally {
      await db.close();
    }
  });

  it("an N build fails closed against an N-1 schema until the migration step has run", async () => {
    const db = await openPlatformDb({ kind: "pglite", migrate: false });
    try {
      await migratePlatformDb(db, NMINUS1);
      const error = await assertPlatformSchemaCurrent(db, N).then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(PlatformSchemaError);
      expect((error as PlatformSchemaError).code).toBe("schema_behind");
    } finally {
      await db.close();
    }
  });

  it("a contract migration is refused before anything is applied, leaving the ledger unchanged", async () => {
    const db = await openPlatformDb({ kind: "pglite", migrate: false });
    try {
      await migratePlatformDb(db, NMINUS1);
      const contract = m(9003, "alter table platform.rehearsal_t drop column a;", "rehearsal_contract");
      await expect(migratePlatformDb(db, [...NMINUS1, B, contract])).rejects.toBeInstanceOf(ContractMigrationRefusedError);
      const status = await platformSchemaStatus(db, N);
      expect(status.applied.map((a) => a.version)).not.toContain(9002);
      expect(status.applied.map((a) => a.version)).not.toContain(9003);
      const cols = await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'platform' and table_name = 'rehearsal_t' order by 1");
      expect(cols.map((c) => c.column_name)).toEqual(["a", "id"]);
    } finally {
      await db.close();
    }
  });
});

// The rehearsal runs on PGlite, where enforcement is opt-in; the live baseline is the highest applied version.
const priorEnforce = process.env.ZENITH_ENFORCE_EXPAND_ONLY;
beforeAll(() => { process.env.ZENITH_ENFORCE_EXPAND_ONLY = "1"; });
afterAll(() => { if (priorEnforce === undefined) delete process.env.ZENITH_ENFORCE_EXPAND_ONLY; else process.env.ZENITH_ENFORCE_EXPAND_ONLY = priorEnforce; });
