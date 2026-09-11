/**
 * Every SQL statement the per-app tracker store issues, as named constants.
 *
 * Purpose: one file a Cloudflare D1 backend can reuse verbatim. Each statement
 * below is plain SQLite dialect that D1 accepts — no `ATTACH`, no custom
 * functions, no `PRAGMA` at request time, positional `?` parameters only.
 * `RETURNING` is allowed by D1 but is deliberately unused so the same
 * statements work through D1's batch endpoint, which reports `changes` rather
 * than rows for a write.
 *
 * Two sections are explicitly NOT portable and say so: the connection pragmas
 * (local SQLite connection setup, never sent to D1) and the transaction control
 * statements (D1's HTTP API has no interactive transactions — it batches).
 */

/* ------------------------- local SQLite connection ------------------------ */

/**
 * Connection setup for `SqliteBackend` only. Never sent to D1: the hosted rule
 * is that no `PRAGMA` runs at request time, and D1 exposes none of these.
 *
 * `journal_mode=WAL` keeps a reader from blocking the writer, `synchronous=FULL`
 * makes a returned COMMIT durable across a power cut, `foreign_keys=ON` is on
 * for the whole install even though the tracker schema has no foreign keys yet,
 * and `busy_timeout` bounds how long a second writer waits for the lock.
 */
export const SQLITE_CONNECTION_PRAGMAS = [
  "PRAGMA journal_mode=WAL",
  "PRAGMA synchronous=FULL",
  "PRAGMA foreign_keys=ON",
] as const;

/** `busy_timeout` needs its value interpolated, so it is built, not a constant. */
export const sqliteBusyTimeoutPragma = (ms: number): string => `PRAGMA busy_timeout=${Math.trunc(ms)}`;

/** Read-backs used by the backend's own self-check and by tests. */
export const PRAGMA_JOURNAL_MODE = "PRAGMA journal_mode";
/** Read-back of `synchronous`; 2 is FULL. */
export const PRAGMA_SYNCHRONOUS = "PRAGMA synchronous";
/** Read-back of `foreign_keys`; 1 is ON. */
export const PRAGMA_FOREIGN_KEYS = "PRAGMA foreign_keys";
/** Read-back of `busy_timeout`, in milliseconds. */
export const PRAGMA_BUSY_TIMEOUT = "PRAGMA busy_timeout";

/* --------------------------- transaction control -------------------------- */

/**
 * SQLite transaction control. `BEGIN IMMEDIATE` takes the write lock up front,
 * so two writers serialise instead of discovering the conflict at COMMIT.
 *
 * D1's HTTP API has no interactive transactions; `D1HttpBackend.transaction()`
 * collects statements and sends one batch instead of using these.
 */
export const TX_BEGIN_IMMEDIATE = "BEGIN IMMEDIATE";
/** Ends the transaction started by {@link TX_BEGIN_IMMEDIATE}, making it durable. */
export const TX_COMMIT = "COMMIT";
/** Discards the transaction started by {@link TX_BEGIN_IMMEDIATE}. */
export const TX_ROLLBACK = "ROLLBACK";

/* --------------------------------- schema --------------------------------- */

/** Schema version and other single-value rows. Created before any migration runs. */
export const CREATE_META = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

/**
 * The one record type of tracker contract v1.
 *
 * The CHECK constraints repeat the zod limits in `tracker-v1.ts` on purpose:
 * validation is the first line of defence, the database is the second, and a
 * row written by some future code path that forgot to validate is refused here.
 *
 * `length()` counts UTF-8 characters while zod's `.max()` counts UTF-16 code
 * units, so for text outside the basic multilingual plane the database check is
 * the more permissive of the two. It is a backstop, not the contract.
 */
export const CREATE_EQUIPMENT_REQUESTS = `
CREATE TABLE IF NOT EXISTS equipment_requests (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) >= 1 AND length(title) <= 120),
  details TEXT NOT NULL CHECK (length(details) <= 2000),
  category TEXT NOT NULL CHECK (category IN ('laptop','monitor','peripheral','software','furniture','other')),
  quantity INTEGER NOT NULL CHECK (quantity >= 1 AND quantity <= 99),
  priority TEXT NOT NULL CHECK (priority IN ('low','normal','high')),
  status TEXT NOT NULL CHECK (status IN ('requested','approved','ordered','delivered','declined')),
  requested_for TEXT NOT NULL CHECK (length(requested_for) <= 120),
  needed_by TEXT NULL CHECK (needed_by IS NULL OR needed_by GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_by TEXT NOT NULL,
  created_by_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_by_email TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  logical_bytes INTEGER NOT NULL CHECK (logical_bytes >= 0)
)`;

/** Keyset pagination reads this index in reverse insertion order and never uses OFFSET. */
export const CREATE_EQUIPMENT_REQUESTS_ORDER_INDEX = `
CREATE INDEX IF NOT EXISTS equipment_requests_created_at_id
  ON equipment_requests (created_at DESC, id DESC)`;

/**
 * One row per accepted mutation, written in the same transaction as the
 * mutation itself. A retry of the same `write_id` replays `result`; a retry
 * carrying a different intent is refused rather than applied twice.
 */
export const CREATE_WRITES = `
CREATE TABLE IF NOT EXISTS writes (
  write_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('create','update')),
  record_id TEXT NULL,
  intent_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL CHECK (status_code >= 100 AND status_code <= 599),
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
)`;

/** The retention sweep deletes by age, so the age column is indexed. */
export const CREATE_WRITES_CREATED_AT_INDEX = `
CREATE INDEX IF NOT EXISTS writes_created_at ON writes (created_at)`;

/**
 * The running total of logical bytes. A single row, so the quota decision is one
 * comparison inside the mutation's own statement rather than a table scan.
 */
export const CREATE_STORAGE = `
CREATE TABLE IF NOT EXISTS storage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  logical_bytes INTEGER NOT NULL CHECK (logical_bytes >= 0)
)`;

/** Seeds the single storage row; a re-run of the migration leaves the count alone. */
export const SEED_STORAGE = "INSERT OR IGNORE INTO storage (id, logical_bytes) VALUES (1, 0)";

/** Reads one `meta` value by key. */
export const SELECT_META = "SELECT value FROM meta WHERE key = ?";

/** Writes one `meta` value by key, replacing any previous value. */
export const UPSERT_META = `
INSERT INTO meta (key, value) VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value`;

/* -------------------------------- requests -------------------------------- */

/** Column list shared by every request read, so row shapes cannot drift apart. */
const REQUEST_COLUMNS = `id, title, details, category, quantity, priority, status,
  requested_for, needed_by, version, created_by, created_by_email, created_at,
  updated_by, updated_by_email, updated_at, logical_bytes`;

/** Reads one request by id. Parameter: id. */
export const SELECT_REQUEST_BY_ID = `SELECT ${REQUEST_COLUMNS} FROM equipment_requests WHERE id = ?`;

/**
 * One statement for every filter combination: a `NULL` bind means "no filter"
 * and a `NULL` cursor means "first page". Keeping it static — rather than
 * concatenating a WHERE clause — is what lets a D1 backend prepare it once and
 * what keeps the parameter list auditable.
 *
 * Parameters, in order:
 *   1,2   status filter (NULL for none)
 *   3,4   category filter (NULL for none)
 *   5,6,7 cursor `created_at` (NULL for the first page)
 *   8     cursor `id`
 *   9     row limit (callers pass limit + 1 to detect a next page)
 */
export const SELECT_REQUESTS_PAGE = `
SELECT ${REQUEST_COLUMNS}
FROM equipment_requests
WHERE (? IS NULL OR status = ?)
  AND (? IS NULL OR category = ?)
  AND (? IS NULL OR (created_at < ? OR (created_at = ? AND id < ?)))
ORDER BY created_at DESC, id DESC
LIMIT ?`;

/**
 * Conditional insert: the quota comparison is part of the statement, so the
 * decision and the write are one atomic step and `changes === 0` means, and
 * only means, "this row would take the app past its storage quota". This is the
 * shape a D1 batch can execute without an interactive transaction.
 *
 * Parameters: the 17 column values in {@link SELECT_REQUEST_BY_ID} order, then
 * the row's logical bytes, then the storage limit in bytes.
 */
export const INSERT_REQUEST_WITHIN_QUOTA = `
INSERT INTO equipment_requests (${REQUEST_COLUMNS})
SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
WHERE (SELECT logical_bytes FROM storage WHERE id = 1) + ? <= ?`;

/**
 * Compare-and-swap update. `changes === 1` is the only success; `changes === 0`
 * means another writer moved the record on, which is answered as `stale_version`
 * after re-reading the current row. No `RETURNING`, so a D1 batch reports the
 * same thing this does.
 *
 * Parameters: title, details, category, quantity, priority, status,
 * requested_for, needed_by, updated_by, updated_by_email, updated_at,
 * logical_bytes, id, expected version.
 */
export const UPDATE_REQUEST_CAS = `
UPDATE equipment_requests
SET title = ?, details = ?, category = ?, quantity = ?, priority = ?, status = ?,
    requested_for = ?, needed_by = ?,
    version = version + 1,
    updated_by = ?, updated_by_email = ?, updated_at = ?, logical_bytes = ?
WHERE id = ? AND version = ?`;

/** Total of the stored rows' logical bytes — the reconciliation read for `storage`. */
export const SELECT_REQUESTS_LOGICAL_BYTES_SUM =
  "SELECT COALESCE(SUM(logical_bytes), 0) AS total FROM equipment_requests";

/** Row count, for reconciliation and tests. */
export const COUNT_REQUESTS = "SELECT COUNT(*) AS total FROM equipment_requests";

/* --------------------------------- storage -------------------------------- */

/** Reads the running logical-byte total. */
export const SELECT_STORAGE_BYTES = "SELECT logical_bytes FROM storage WHERE id = 1";

/** Applies a signed delta: a create adds, an update that shrinks a record subtracts. */
export const UPDATE_STORAGE_ADD =
  "UPDATE storage SET logical_bytes = logical_bytes + ? WHERE id = 1";

/* --------------------------------- writes --------------------------------- */

/** Reads one write-id row, for replay and conflict detection. Parameter: write id. */
export const SELECT_WRITE_BY_ID = `
SELECT write_id, subject, op, record_id, intent_hash, status_code, result, created_at
FROM writes WHERE write_id = ?`;

/** Records an accepted mutation in the same transaction that applied it. */
export const INSERT_WRITE = `
INSERT INTO writes (write_id, subject, op, record_id, intent_hash, status_code, result, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

/** Retention sweep: everything stamped before the cutoff stops being replayable. */
export const DELETE_WRITES_BEFORE = "DELETE FROM writes WHERE created_at < ?";

/** Write-row count, for reconciliation and tests. */
export const COUNT_WRITES = "SELECT COUNT(*) AS total FROM writes";
