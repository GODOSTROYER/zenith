/**
 * Versioned migrations for a per-app tracker database, and the two functions
 * that apply and read them.
 *
 * Contract v1 is frozen (decision R3-08). An additive change ships as a new
 * entry in `TRACKER_MIGRATIONS` that only adds nullable columns; a destructive
 * change is rejected at publish intake, not applied here.
 *
 * Every statement lives in `sql.ts` so a D1 backend runs the same DDL.
 */
import { TRACKER_SCHEMA_VERSION } from "@/lib/hosted/contracts";
import type { DataBackend } from "./backend";
import {
  CREATE_EQUIPMENT_REQUESTS,
  CREATE_EQUIPMENT_REQUESTS_ORDER_INDEX,
  CREATE_META,
  CREATE_STORAGE,
  CREATE_WRITES,
  CREATE_WRITES_CREATED_AT_INDEX,
  SEED_STORAGE,
  SELECT_META,
  UPSERT_META,
} from "./sql";

/** The `meta` key holding the applied schema version. */
export const SCHEMA_VERSION_KEY = "schema_version";

/** One numbered step. Statements run in order, all inside one transaction. */
export interface TrackerMigration {
  version: number;
  /** What this step is for, in one sentence — it ends up in nothing but the source. */
  description: string;
  statements: readonly string[];
}

/**
 * Every migration for a per-app tracker database, oldest first.
 *
 * v1 creates the three tables of contract v1 plus the `meta` bookkeeping table.
 * Each statement is `IF NOT EXISTS` so re-running the list over a database that
 * is already at that version changes nothing.
 */
export const TRACKER_MIGRATIONS: readonly TrackerMigration[] = [
  {
    version: 1,
    description: "Equipment requests, write-id ledger and the logical-byte counter.",
    statements: [
      CREATE_EQUIPMENT_REQUESTS,
      CREATE_EQUIPMENT_REQUESTS_ORDER_INDEX,
      CREATE_WRITES,
      CREATE_WRITES_CREATED_AT_INDEX,
      CREATE_STORAGE,
      SEED_STORAGE,
    ],
  },
];

/**
 * The version a freshly migrated database reports. Typed as the frozen contract
 * version so the two cannot drift apart silently; a test asserts that the
 * highest entry in {@link TRACKER_MIGRATIONS} matches it.
 */
export const LATEST_TRACKER_SCHEMA_VERSION: typeof TRACKER_SCHEMA_VERSION = TRACKER_SCHEMA_VERSION;

/**
 * Applies every migration the database has not seen yet and returns the version
 * it ends up at.
 *
 * Idempotent: a second call over the same database applies nothing and returns
 * the same number. Each migration runs inside one transaction, so a failure
 * part-way through leaves the database at its previous version rather than half
 * migrated.
 */
export function applyTrackerMigrations(backend: DataBackend): number {
  // `meta` has to exist before its own version can be read, so it is created
  // outside the version gate. `IF NOT EXISTS` keeps that safe to repeat.
  backend.run(CREATE_META);

  let current = readSchemaVersion(backend);
  for (const migration of TRACKER_MIGRATIONS) {
    if (migration.version <= current) continue;
    backend.transaction(() => {
      for (const statement of migration.statements) backend.run(statement);
      backend.run(UPSERT_META, [SCHEMA_VERSION_KEY, String(migration.version)]);
    });
    current = migration.version;
  }
  return current;
}

/**
 * The schema version recorded in `meta`, or 0 for a database no migration has
 * touched. Never throws for a missing table: `applyTrackerMigrations` creates
 * `meta` first and this is only called after that.
 */
export function readSchemaVersion(backend: DataBackend): number {
  const row = backend.get<{ value: string }>(SELECT_META, [SCHEMA_VERSION_KEY]);
  if (!row) return 0;
  const parsed = Number.parseInt(row.value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
