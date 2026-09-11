/**
 * Opening, caching and closing per-app tracker databases.
 *
 * Isolation is by construction: an app's data lives in its own file under
 * `appDataDir(appId)`, and nothing in `sql.ts` takes an app id. The only way to
 * reach app B's records is `openAppData("B")` — there is no cross-app query to
 * get wrong, and a broker holding app A's store cannot address app B.
 *
 * Two files per app:
 *   `data.sqlite` — the customer's data. Only the running app writes here.
 *   `test.sqlite` — the disposable database candidate release probes use
 *                   (decision R3-07). `resetTestDatabase()` throws it away and
 *                   makes a fresh one; production data is never touched.
 *
 * The cache lives on `globalThis` so Next's module reloading in development
 * cannot end up with two connections to one file — which under WAL would be
 * correct but would double the write locks for no reason.
 */
import fs from "node:fs";
import path from "node:path";
import { appDataDir, hostedStoreKind } from "@/lib/hosted/config";
import { DEFAULT_LIMITS, HostedError } from "@/lib/hosted/contracts";
import { type AppDataOps, postgresOps, sqliteOps } from "./app-ops";
import { SqliteBackend, type SqliteBackendOptions } from "./backend";
import { PgDataBackend, PgTrackerStore, TEST_NAMESPACE_SUFFIX } from "./pg-backend";
import { applyTrackerMigrations } from "./schema";
import { TrackerDataStore } from "./tracker-store";

/** Which of an app's two databases to open. */
export type AppDataFile = "data" | "test";

/** File names, so nothing else in the codebase has to spell them. */
export const APP_DATA_FILENAMES: Record<AppDataFile, string> = {
  data: "data.sqlite",
  test: "test.sqlite",
};

/** SQLite writes these beside the database under WAL; cleanup has to remove them too. */
const SQLITE_SIDECAR_SUFFIXES = ["", "-wal", "-shm"] as const;

/** Options for {@link openAppData}. */
export interface OpenAppDataOptions {
  /** `data` (default) for customer data, `test` for the disposable probe database. */
  file?: AppDataFile;
  /** Overrides the directory the file lives in. Defaults to `appDataDir(appId)`. */
  dir?: string;
  /** Storage ceiling in logical bytes. Defaults to `DEFAULT_LIMITS.storageBytes`. */
  storageBytes?: number;
  /** Connection tuning; production uses the defaults. */
  backend?: SqliteBackendOptions;
}

/**
 * Whichever backend this app's data is actually reached through.
 *
 * A union rather than one class, and deliberately *not* a lie: before this was
 * widened, postgres mode handed out an object shaped like a `SqliteBackend`
 * that refused every call by name, because three callers used the field for
 * things only SQLite can do. Those three now go through {@link OpenAppData.ops},
 * which is implemented on both stores, so the field can say what it is.
 */
export type AppDataBackend = SqliteBackend | PgDataBackend;

/**
 * An open, migrated app database, the store over it and the whole-database
 * operations beside it.
 *
 * `store` is a union rather than one class because the two stores are the same
 * contract over two very different databases — `TrackerDataStore` over this
 * app's own SQLite file, `PgTrackerStore` over its rows in `hosted.app_records`.
 * Their public methods are signature-for-signature identical, so a caller that
 * only uses the store never has to know which it got, which is the point. The
 * same holds for `ops`.
 */
export interface OpenAppData {
  /**
   * The raw backend. Almost nothing should reach for this: `store` covers
   * request-time work and `ops` covers the rest. `sqliteBackendOf()` is the
   * escape hatch for the genuinely SQLite-only.
   */
  backend: AppDataBackend;
  store: TrackerDataStore | PgTrackerStore;
  /** Integrity, record count and bulk import — available on both stores. */
  ops: AppDataOps;
  /**
   * Absolute path of the database file. In postgres mode there is no file, and
   * this keeps naming the path the SQLite branch would have used so the cache
   * key, `closeAppData` and the callers that only report it are unchanged.
   */
  path: string;
}

interface CacheEntry extends OpenAppData {
  appId: string;
  file: AppDataFile;
}

/**
 * The SQLite connection behind an open app database.
 *
 * The escape hatch for the handful of things that are SQLite facts and admit as
 * much — the same shape as `sqliteConnection()` in the control authority. In
 * postgres mode it refuses by name rather than handing back something that
 * would answer plausibly and wrongly.
 */
export function sqliteBackendOf(open: OpenAppData): SqliteBackend {
  if (open.backend instanceof SqliteBackend) return open.backend;
  throw new HostedError(
    "internal",
    "This app keeps its data in Postgres, so it has no SQLite connection to run this against.",
    {
      fix: "Use openAppData(appId).store for records and .ops for integrity, counts and imports; both are backed on either store.",
    }
  );
}

const CACHE_KEY = Symbol.for("zenith.hosted.data.openAppData");

type CacheHost = typeof globalThis & { [CACHE_KEY]?: Map<string, CacheEntry> };

function cache(): Map<string, CacheEntry> {
  const host = globalThis as CacheHost;
  const existing = host[CACHE_KEY];
  if (existing) return existing;
  const created = new Map<string, CacheEntry>();
  host[CACHE_KEY] = created;
  return created;
}

/**
 * Opens (or returns the already open) database for one app, applying every
 * pending migration.
 *
 * Idempotent per resolved file path: calling it twice for the same app and file
 * hands back the same backend and the same store. A path is the cache key
 * rather than the app id alone, so a test pointing `dir` somewhere else gets
 * its own connection instead of silently reusing another one.
 *
 * On a cache hit `storageBytes` and `backend` are ignored — the store that is
 * already open keeps the limits it was built with. Call `closeAppData(appId)`
 * first if a different limit has to take effect.
 */
export function openAppData(appId: string, options: OpenAppDataOptions = {}): OpenAppData {
  const id = assertAppId(appId);
  const file = options.file ?? "data";
  const directory = options.dir ?? appDataDir(id);
  const filePath = path.join(directory, APP_DATA_FILENAMES[file]);

  const hit = cache().get(filePath);
  if (hit && !hit.backend.isClosed)
    return { backend: hit.backend, store: hit.store, ops: hit.ops, path: hit.path };

  if (hostedStoreKind() === "postgres") return openPostgres(id, file, filePath, options);

  fs.mkdirSync(directory, { recursive: true });
  const backend = new SqliteBackend(filePath, options.backend ?? {});
  try {
    applyTrackerMigrations(backend);
  } catch (error) {
    // Never leave a half-opened handle behind on Windows: an unclosed file
    // cannot be deleted, and the caller is about to see the failure anyway.
    backend.close();
    throw error;
  }
  const store = new TrackerDataStore({
    backend,
    appId: id,
    limits: { storageBytes: options.storageBytes ?? DEFAULT_LIMITS.storageBytes },
  });
  const ops = sqliteOps(backend, store);
  const entry: CacheEntry = { appId: id, file, backend, store, ops, path: filePath };
  cache().set(filePath, entry);
  return { backend, store, ops, path: filePath };
}

/**
 * The postgres branch of {@link openAppData}: no file, no migration, one
 * `PgDataBackend` bound to this app and the store over it.
 *
 * The cache is still keyed by the path the SQLite branch would have used, so
 * `closeAppData`/`closeAllAppData` reach these entries by app id exactly as they
 * reach SQLite ones, and `path` keeps naming the same thing for the callers that
 * only report it.
 *
 * The disposable probe database (decision R3-07) becomes an app-id namespace
 * rather than a second file: `<appId>::test` shares the tables but not a single
 * row with `<appId>`, because `app_id` is the first column of every hosted
 * primary key and a control-authority app id never contains `::`.
 */
function openPostgres(
  appId: string,
  file: AppDataFile,
  filePath: string,
  options: OpenAppDataOptions
): OpenAppData {
  const scope = file === "test" ? `${appId}${TEST_NAMESPACE_SUFFIX}` : appId;
  const backend = new PgDataBackend({ appId: scope });
  const store = new PgTrackerStore({
    backend,
    appId,
    limits: { storageBytes: options.storageBytes ?? DEFAULT_LIMITS.storageBytes },
  });
  const ops = postgresOps(backend, store);
  const entry: CacheEntry = { appId, file, backend, store, ops, path: filePath };
  cache().set(filePath, entry);
  return { backend, store, ops, path: filePath };
}

/**
 * Closes one app's open databases and forgets them.
 *
 * With no `file`, both the data and the test database are closed. Returns how
 * many connections were closed, so a caller can tell "closed it" from "it was
 * not open".
 */
export function closeAppData(appId: string, file?: AppDataFile): number {
  const id = assertAppId(appId);
  let closed = 0;
  for (const [key, entry] of [...cache()]) {
    if (entry.appId !== id) continue;
    if (file !== undefined && entry.file !== file) continue;
    entry.backend.close();
    cache().delete(key);
    closed += 1;
  }
  return closed;
}

/**
 * Closes every open app database in this process. Tests call it before deleting
 * their data directory; Windows refuses to remove a file with a live handle.
 */
export function closeAllAppData(): number {
  let closed = 0;
  for (const [key, entry] of [...cache()]) {
    entry.backend.close();
    cache().delete(key);
    closed += 1;
  }
  return closed;
}

/**
 * Throws away an app's disposable probe database and hands back a fresh, empty
 * one.
 *
 * This is what a candidate release probes against (decision R3-07). On SQLite
 * it deletes and recreates `test.sqlite`, touching only that file —
 * `data.sqlite` and its WAL sidecars are never opened, never renamed and never
 * removed here. On Postgres it empties the `<appId>::test` namespace, which is
 * disjoint from the app's own rows because `app_id` is the first column of
 * every hosted primary key.
 *
 * Async because one of the two is a round trip. Every caller of it is already
 * async — the release runner's probe (`runtime/local.ts`) among them — so
 * awaiting a ready database is the same guarantee the synchronous version gave.
 */
export async function resetTestDatabase(
  appId: string,
  options: Omit<OpenAppDataOptions, "file"> = {}
): Promise<OpenAppData> {
  const id = assertAppId(appId);
  const directory = options.dir ?? appDataDir(id);
  if (hostedStoreKind() === "postgres") {
    // There is no file to throw away: the probe database is the app-id
    // namespace `<appId>::test`, and emptying it is a DELETE over
    // `hosted.app_records`, `hosted.app_writes` and `hosted.app_storage` for
    // that id alone. `purgeTestNamespace()` refuses any id that does not end in
    // `::test`, and a control-authority app id never contains `::`, so
    // production rows are out of this path's reach by construction.
    const opened = openAppData(id, { ...options, file: "test" });
    const backend = opened.backend;
    if (!(backend instanceof PgDataBackend)) {
      throw new HostedError("internal", `App ${id} opened a probe database that is not the Postgres one.`, {
        fix: "Report this: ZENITH_HOSTED_STORE=postgres and openAppData() answered a SQLite connection. Nothing was deleted.",
      });
    }
    await backend.purgeTestNamespace();
    return opened;
  }
  closeAppData(id, "test");

  const base = path.join(directory, APP_DATA_FILENAMES.test);
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    try {
      fs.rmSync(`${base}${suffix}`, { force: true });
    } catch (error) {
      throw new HostedError(
        "internal",
        `The app's test database could not be replaced: ${(error as Error).message}`,
        { fix: "Stop anything else holding test.sqlite open and try the probe again. Customer data in data.sqlite was not touched." }
      );
    }
  }
  return openAppData(id, { ...options, file: "test" });
}

/** The absolute path of one of an app's databases, without opening it. */
export function appDataPath(appId: string, file: AppDataFile = "data", dir?: string): string {
  const id = assertAppId(appId);
  return path.join(dir ?? appDataDir(id), APP_DATA_FILENAMES[file]);
}

function assertAppId(appId: string): string {
  const id = typeof appId === "string" ? appId.trim() : "";
  if (id.length === 0 || id.length > 200) {
    throw new HostedError("invalid_input", "An app id is required to open an app's data store.", {
      fix: "Pass the app's id from the control authority, not its slug or name.",
      details: { issues: [{ path: "appId", code: "custom", message: "must be 1–200 characters" }] },
    });
  }
  return id;
}
