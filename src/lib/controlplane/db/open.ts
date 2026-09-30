/**
 * Opening the platform control store: configuration, the process-wide handle,
 * and the schema policy.
 *
 * Environment (read in exactly one place, `platformDbConfigFromEnv`):
 *   ZENITH_PLATFORM_DB       `pglite` | `postgres`. Default: `postgres` when a
 *                            URL below is set, otherwise `pglite`.
 *   ZENITH_PLATFORM_DB_URL   Postgres URI (the Supavisor pooler URI in
 *                            production). Falls back to SUPABASE_DB_URL.
 *   ZENITH_PLATFORM_DB_MAX   pool size, default 5.
 *   ZENITH_DATA              PGlite data lives in `<ZENITH_DATA>/platform-pg`
 *                            (default data dir `<cwd>/.data`, as `env.ts`).
 *
 * Schema policy:
 *   - PGlite auto-migrates on open (it is a private, disposable-or-local store).
 *   - Postgres is never migrated by the application. `platformDb()` calls
 *     `assertPlatformSchemaCurrent` once and fails closed with the exact command
 *     to run. `openPlatformDb({ kind: "postgres", migrate: true })` exists for
 *     the migration script and the test lane.
 *
 * A persistent PGlite directory belongs to ONE process at a time (PGlite has no
 * cross-process locking). It is a development convenience; anything shared or
 * hosted uses Postgres.
 */
import path from "node:path";
import { ControlStoreError } from "./errors";
import {
  assertPostgresUrl,
  createPlatformDbHandle,
  openPgliteDriver,
  openPostgresDriver,
  type PlatformDbHandle,
  type TxRetryOptions,
} from "./executor";
import { assertPlatformSchemaCurrent, migratePlatformDb } from "./migrator";

export type PlatformDbKind = "pglite" | "postgres";

export interface PlatformDbConfig {
  kind: PlatformDbKind;
  /** postgres only */
  url?: string;
  /** pglite only; undefined = in-memory */
  dataDir?: string;
  /** postgres pool size */
  max?: number;
  /** how `kind` was decided */
  source: "explicit" | "url" | "default";
}

/** The ONE place the platform store reads the environment. */
export function platformDbConfigFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): PlatformDbConfig {
  const explicit = env.ZENITH_PLATFORM_DB?.trim().toLowerCase();
  if (explicit !== undefined && explicit !== "" && explicit !== "pglite" && explicit !== "postgres")
    throw new ControlStoreError("invalid_input", `ZENITH_PLATFORM_DB must be "pglite" or "postgres" (got "${explicit}").`, {
      variable: "ZENITH_PLATFORM_DB",
    });
  const url = env.ZENITH_PLATFORM_DB_URL?.trim() || env.SUPABASE_DB_URL?.trim() || undefined;
  const kind: PlatformDbKind = explicit ? (explicit as PlatformDbKind) : url ? "postgres" : "pglite";
  const source: PlatformDbConfig["source"] = explicit ? "explicit" : url ? "url" : "default";

  if (kind === "postgres") {
    if (!url)
      throw new ControlStoreError(
        "invalid_input",
        'The platform control store is set to Postgres (ZENITH_PLATFORM_DB=postgres) but no connection URL is configured. Set ZENITH_PLATFORM_DB_URL (or SUPABASE_DB_URL) to the Postgres URI — the Supavisor transaction-pooler URI in production — or set ZENITH_PLATFORM_DB=pglite for local development.',
        { variable: "ZENITH_PLATFORM_DB_URL" }
      );
    assertPostgresUrl(url);
    const maxRaw = env.ZENITH_PLATFORM_DB_MAX?.trim();
    const max = maxRaw ? Number(maxRaw) : undefined;
    if (max !== undefined && (!Number.isInteger(max) || max < 1 || max > 100))
      throw new ControlStoreError("invalid_input", "ZENITH_PLATFORM_DB_MAX must be an integer from 1 to 100.", { variable: "ZENITH_PLATFORM_DB_MAX" });
    return { kind, url, max, source };
  }
  const dataRoot = env.ZENITH_DATA?.trim() || path.join(process.cwd(), ".data");
  return { kind, dataDir: path.join(dataRoot, "platform-pg"), source };
}

export interface OpenPlatformDbOptions {
  kind: PlatformDbKind;
  url?: string;
  dataDir?: string;
  max?: number;
  /** default: true for pglite, false for postgres (the operator migrates) */
  migrate?: boolean;
  txRetry?: TxRetryOptions;
}

/** Open a store. The caller owns it and must `close()` it. */
export async function openPlatformDb(opts: OpenPlatformDbOptions): Promise<PlatformDbHandle> {
  if (opts.kind === "postgres" && !opts.url)
    throw new ControlStoreError("invalid_input", "openPlatformDb({ kind: 'postgres' }) requires a url.");
  const driver =
    opts.kind === "pglite" ? await openPgliteDriver({ dataDir: opts.dataDir }) : await openPostgresDriver({ url: opts.url as string, max: opts.max });
  const db = createPlatformDbHandle(driver, opts.txRetry);
  try {
    if (opts.migrate ?? opts.kind === "pglite") await migratePlatformDb(db);
  } catch (err) {
    await db.close();
    throw err;
  }
  return db;
}

/* ------------------------- the process-wide handle -------------------------- */

type G = typeof globalThis & { __zenithPlatformDb?: Promise<PlatformDbHandle> };

/**
 * The process-wide store, opened on first use and held on `globalThis` (Next.js
 * re-evaluates modules on hot reload; a module-scoped variable would leak a
 * second pool or a second PGlite on every edit). Postgres additionally asserts
 * the schema is current, once, and a failure is not cached — fix the schema and
 * the next call retries.
 */
export function platformDb(): Promise<PlatformDbHandle> {
  const g = globalThis as G;
  if (g.__zenithPlatformDb) return g.__zenithPlatformDb;
  const opening = (async () => {
    const config = platformDbConfigFromEnv();
    const db = await openPlatformDb({ kind: config.kind, url: config.url, dataDir: config.dataDir, max: config.max, migrate: config.kind === "pglite" });
    if (config.kind === "postgres") {
      try {
        await assertPlatformSchemaCurrent(db);
      } catch (err) {
        await db.close();
        throw err;
      }
    }
    return db;
  })();
  g.__zenithPlatformDb = opening;
  opening.catch(() => {
    if (g.__zenithPlatformDb === opening) delete g.__zenithPlatformDb;
  });
  return opening;
}

/** Close and forget the process-wide store. Tests and scripts; a server exits. */
export async function resetPlatformDbForTests(): Promise<void> {
  const g = globalThis as G;
  const existing = g.__zenithPlatformDb;
  delete g.__zenithPlatformDb;
  if (!existing) return;
  try {
    await (await existing).close();
  } catch {
    /* a store that never opened has nothing to close */
  }
}
