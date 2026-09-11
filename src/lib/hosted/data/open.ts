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
import { SqliteBackend, type SqliteBackendOptions } from "./backend";
import { PgDataBackend, PgTrackerStore } from "./pg-backend";
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
 * An open, migrated app database and the store over it.
 *
 * `store` is a union rather than one class because the two stores are the same
 * contract over two very different databases — `TrackerDataStore` over this
 * app's own SQLite file, `PgTrackerStore` over its rows in `hosted.app_records`.
 * Their public methods are signature-for-signature identical, so a caller that
 * only uses the store never has to know which it got, which is the point.
 */
export interface OpenAppData {
  backend: SqliteBackend;
  store: TrackerDataStore | PgTrackerStore;
  /** Absolute path of the database file. */
  path: string;
}

interface CacheEntry extends OpenAppData {
  appId: string;
  file: AppDataFile;
}

/**
 * The stand-in for `backend` when an app's data lives in Postgres.
 *
 * TODO(ceiling): `OpenAppData.backend` is a *synchronous* SQLite connection, and
 * three callers use it directly for things only SQLite can do — `PRAGMA
 * quick_check` (`hosted/health`, `hosted/backup/reopen`) and a synchronous
 * import transaction (`hosted/export`). None of those has a Postgres equivalent
 * yet, and none of them is in this wave's scope, so in postgres mode this object
 * takes the field and refuses every call by name rather than answering something
 * plausible and wrong. The `store` — which is what the gateway, the broker and
 * the release runner actually use — is fully backed.
 *
 * The cast is deliberate and contained: `SqliteBackend` has private fields, so
 * nothing can structurally satisfy it, and widening the field to a union would
 * break the three call sites above at compile time without giving them anything
 * to do instead.
 */
function postgresModeBackend(appId: string): SqliteBackend {
  const refuse = (): never => {
    throw new HostedError(
      "internal",
      `App ${appId} keeps its data in Postgres, so it has no SQLite connection to run this against.`,
      {
        fix: "Reach this app's data through openAppData(appId).store, which is backed on both stores. Integrity checks (PRAGMA quick_check) and the synchronous export/import path are SQLite-only and still have to be given Postgres equivalents.",
      }
    );
  };
  const shim = {
    path: `postgres:hosted.app_records?app_id=${appId}`,
    busyTimeoutMs: 0,
    isClosed: false,
    inTransaction: false,
    pragmas: refuse,
    run: refuse,
    get: refuse,
    all: refuse,
    transaction: refuse,
    exec: refuse,
    close: () => {
      /* nothing is held open */
    },
  };
  return shim as unknown as SqliteBackend;
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
  if (hit && !hit.backend.isClosed) return { backend: hit.backend, store: hit.store, path: hit.path };

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
  const entry: CacheEntry = { appId: id, file, backend, store, path: filePath };
  cache().set(filePath, entry);
  return { backend, store, path: filePath };
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
  const scope = file === "test" ? `${appId}::test` : appId;
  const backend = new PgDataBackend({ appId: scope });
  const store = new PgTrackerStore({
    backend,
    appId,
    limits: { storageBytes: options.storageBytes ?? DEFAULT_LIMITS.storageBytes },
  });
  const entry: CacheEntry = {
    appId,
    file,
    backend: postgresModeBackend(scope),
    store,
    path: filePath,
  };
  cache().set(filePath, entry);
  return { backend: entry.backend, store, path: filePath };
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
 * Deletes and recreates an app's `test.sqlite`, returning the fresh, migrated
 * database.
 *
 * This is what a candidate release probes against (decision R3-07). It touches
 * only the test file — `data.sqlite` and its WAL sidecars are never opened,
 * never renamed and never removed by this function.
 */
export function resetTestDatabase(appId: string, options: Omit<OpenAppDataOptions, "file"> = {}): OpenAppData {
  const id = assertAppId(appId);
  const directory = options.dir ?? appDataDir(id);
  if (hostedStoreKind() === "postgres") {
    // TODO(ceiling): throwing away the probe namespace is a DELETE over
    // `hosted.app_records`/`app_writes`/`app_storage` for `<appId>::test`, and
    // that is a network round trip — this function is synchronous and every
    // caller expects a ready database on return. Refusing by name is the honest
    // answer until the release runner's probe path is made async; answering with
    // a namespace that still holds the last probe's rows would make a candidate
    // pass on stale data.
    throw new HostedError(
      "internal",
      `App ${id} keeps its data in Postgres, where the disposable probe database cannot be replaced synchronously.`,
      {
        fix: "Probe this candidate with ZENITH_HOSTED_STORE=sqlite, or make the release runner's probe path await an async reset of the <appId>::test namespace. Production rows were not touched.",
      }
    );
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
