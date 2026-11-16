/**
 * The platform control store's in-process migrator and schema check.
 *
 *  - **PGlite** (local development, tests) migrates on open (`open.ts`).
 *  - **Postgres** is migrated by the operator: `npx tsx scripts/platform/migrate.ts`
 *    or the emitted `supabase/migrations/0014_platform_core.sql`. The running
 *    application only *checks* (`assertPlatformSchemaCurrent`) and fails closed
 *    with an actionable message when the schema is behind — it never runs DDL
 *    against a production database on its own.
 *
 * Ledger: `platform.schema_migrations(version pk, name, applied_at, checksum)`.
 * Each migration is applied in its own transaction together with its ledger
 * row, so a failure leaves neither. The ledger table is locked
 * (`SHARE ROW EXCLUSIVE`) for the duration of each step and the ledger re-read
 * after taking the lock, so two migrators racing (two deploys, a CI job and an
 * operator) serialise and the loser finds the work already done. No advisory
 * locks — the Supavisor transaction pooler does not support session state.
 *
 * Integrity: an applied migration whose checksum differs from the code is
 * refused (`schema_tampered`) — a shipped migration is never edited. A database
 * that is *ahead* of this build (a newer deploy already migrated) is allowed:
 * migrations are additive, and refusing would break every rolling deploy.
 */
import type { Sql } from "@/lib/controlplane/types";
import { PlatformDbError, PlatformSchemaError } from "./errors";
import type { ExecSql, PlatformDbHandle } from "./executor";
import { BOOTSTRAP_SQL } from "./migrations/bootstrap";
import { PLATFORM_MIGRATIONS, migrationChecksum, type PlatformMigration } from "./migrations/index";
import { assertPendingMigrationsCompatible } from "./compat";

export interface AppliedMigration {
  version: number;
  name: string;
  appliedAt: string;
  checksum: string;
}

export interface PlatformSchemaStatus {
  /** `platform.schema_migrations` exists */
  ledgerPresent: boolean;
  applied: AppliedMigration[];
  /** known to this build, not yet applied */
  pending: PlatformMigration[];
  /** applied, but the recorded checksum differs from this build's */
  tampered: { version: number; name: string; expected: string; actual: string }[];
  /** applied in the database but unknown to this build (a newer deploy migrated) */
  ahead: number[];
  /** ledger present, nothing pending, nothing tampered */
  current: boolean;
}

export const MIGRATE_COMMAND = "npx tsx scripts/platform/migrate.ts";

/** Read the ledger and compare it with `migrations`. Never writes. */
export async function platformSchemaStatus(
  sql: Sql,
  migrations: readonly PlatformMigration[] = PLATFORM_MIGRATIONS
): Promise<PlatformSchemaStatus> {
  const present = await sql.query<{ present: boolean }>("select to_regclass('platform.schema_migrations') is not null as present");
  if (!present[0]?.present) {
    return { ledgerPresent: false, applied: [], pending: [...migrations], tampered: [], ahead: [], current: false };
  }
  const rows = await sql.query<{ version: number; name: string; applied_at: string; checksum: string }>(
    "select version, name, applied_at, checksum from platform.schema_migrations order by version"
  );
  const applied = rows.map((r) => ({ version: r.version, name: r.name, appliedAt: r.applied_at, checksum: r.checksum }));
  const byVersion = new Map(applied.map((a) => [a.version, a]));
  const known = new Set(migrations.map((m) => m.version));
  const pending = migrations.filter((m) => !byVersion.has(m.version));
  const tampered = migrations.flatMap((m) => {
    const row = byVersion.get(m.version);
    const expected = migrationChecksum(m);
    return row && row.checksum !== expected ? [{ version: m.version, name: m.name, expected, actual: row.checksum }] : [];
  });
  const ahead = applied.filter((a) => !known.has(a.version)).map((a) => a.version);
  return { ledgerPresent: true, applied, pending, tampered, ahead, current: pending.length === 0 && tampered.length === 0 };
}

function tamperedError(status: PlatformSchemaStatus): PlatformSchemaError {
  const names = status.tampered.map((t) => `${t.version} ("${t.name}")`).join(", ");
  return new PlatformSchemaError(
    "schema_tampered",
    `The platform schema ledger records a different checksum than this build for migration ${names}. ` +
      "A shipped migration must never be edited: restore its original text and add a new migration for the change. " +
      "Nothing was applied.",
    { versions: status.tampered.map((t) => t.version) }
  );
}

/**
 * Fail closed unless the schema is current. Reads only. The message names the
 * exact command/file to run, because "schema out of date" with nothing to do
 * about it is the error that costs an afternoon.
 */
export async function assertPlatformSchemaCurrent(
  sql: Sql,
  migrations: readonly PlatformMigration[] = PLATFORM_MIGRATIONS
): Promise<void> {
  const status = await platformSchemaStatus(sql, migrations);
  if (status.tampered.length > 0) throw tamperedError(status);
  if (!status.ledgerPresent) {
    throw new PlatformSchemaError(
      "schema_behind",
      "The platform control store has not been created: platform.schema_migrations does not exist. " +
        `Fix: run \`${MIGRATE_COMMAND}\` against ZENITH_PLATFORM_DB_URL (or SUPABASE_DB_URL), or apply ` +
        "supabase/migrations/0014_platform_core.sql with psql or the Supabase SQL editor, then restart. Nothing was read or written.",
      { pending: status.pending.map((m) => m.version) }
    );
  }
  if (status.pending.length > 0) {
    const list = status.pending.map((m) => `${m.version} ("${m.name}")`).join(", ");
    throw new PlatformSchemaError(
      "schema_behind",
      `The platform control store schema is behind this build: migration ${list} has not been applied. ` +
        `Fix: run \`${MIGRATE_COMMAND}\`, or re-apply supabase/migrations/0014_platform_core.sql (idempotent), then restart. ` +
        "Nothing was read or written.",
      { pending: status.pending.map((m) => m.version) }
    );
  }
}

export interface MigrateResult {
  /** versions applied by this call, in order */
  applied: number[];
  /** versions that were already applied */
  alreadyApplied: number[];
}

/** Concurrent `create … if not exists` can lose a catalog race; the loser retries once. */
async function bootstrap(db: PlatformDbHandle): Promise<void> {
  try {
    await db.exec(BOOTSTRAP_SQL);
  } catch (err) {
    if (err instanceof PlatformDbError && ["23505", "42P07", "42710", "42P06"].includes(err.sqlstate ?? "")) {
      await db.exec(BOOTSTRAP_SQL);
      return;
    }
    throw err;
  }
}

/**
 * Apply every pending migration, oldest first, each with its ledger row in one
 * transaction. Safe to call repeatedly and concurrently. Refuses (writing
 * nothing further) when an already-applied migration's checksum has changed.
 */
export async function migratePlatformDb(
  db: PlatformDbHandle,
  migrations: readonly PlatformMigration[] = PLATFORM_MIGRATIONS
): Promise<MigrateResult> {
  await bootstrap(db);
  const before = await platformSchemaStatus(db, migrations);
  if (before.tampered.length > 0) throw tamperedError(before);
  // N-1/N contract (PROD-OPS-03): refuse before applying anything if a pending migration is a
  // contract change without its registered LIFE-10 approval and operator confirmation.
  // Enforced on Postgres (a shared store with a live N-1) or when ZENITH_ENFORCE_EXPAND_ONLY=1; the baseline is the
  // highest version already applied. A fresh database has no N-1, so nothing is held to the rule.
  if (db.kind === "postgres" || process.env.ZENITH_ENFORCE_EXPAND_ONLY === "1") {
    const live = before.applied.length ? Math.max(...before.applied.map((a) => a.version)) : Number.POSITIVE_INFINITY;
    assertPendingMigrationsCompatible(before.pending, { baseline: live });
  }

  const applied: number[] = [];
  const alreadyApplied = before.applied.filter((a) => migrations.some((m) => m.version === a.version)).map((a) => a.version);
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (alreadyApplied.includes(migration.version)) continue;
    const didApply = await db.tx(async (tx) => {
      await (tx as ExecSql).exec("lock table platform.schema_migrations in share row exclusive mode");
      const existing = await tx.query<{ checksum: string }>("select checksum from platform.schema_migrations where version = $1", [migration.version]);
      if (existing.length > 0) {
        if (existing[0].checksum !== migrationChecksum(migration))
          throw tamperedError({
            ...before,
            tampered: [{ version: migration.version, name: migration.name, expected: migrationChecksum(migration), actual: existing[0].checksum }],
          });
        return false; // a concurrent migrator won the race
      }
      await (tx as ExecSql).exec(migration.sql);
      await tx.query("insert into platform.schema_migrations (version, name, checksum) values ($1, $2, $3)", [
        migration.version,
        migration.name,
        migrationChecksum(migration),
      ]);
      return true;
    });
    (didApply ? applied : alreadyApplied).push(migration.version);
  }
  return { applied, alreadyApplied: alreadyApplied.sort((a, b) => a - b) };
}
