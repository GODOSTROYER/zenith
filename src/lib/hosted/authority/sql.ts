/**
 * Row readers, a prepared-statement cache and SQLite error classification —
 * the small primitives every repository in this directory shares.
 *
 * Two conventions the whole authority depends on:
 *
 *  - **Every timestamp is an ISO-8601 UTC string** produced by `nowIso()`.
 *    `Date#toISOString()` is fixed width (`YYYY-MM-DDTHH:MM:SS.sssZ`), so
 *    lexicographic comparison in SQL *is* chronological comparison. That is
 *    what lets `expires_at > ?` and `lease_until <= ?` be plain TEXT
 *    comparisons instead of a date function. A timestamp written any other way
 *    breaks those predicates silently, so nothing here formats its own.
 *  - **A row is mapped in exactly one place per table.** The readers below
 *    refuse a column that is missing or of the wrong storage class rather than
 *    coercing it, because a silent `undefined` in a grant or a fence token is
 *    the kind of bug that only shows up as a wrongly admitted request.
 */
import type { DatabaseSync, SQLOutputValue, StatementSync } from "node:sqlite";
import { HostedError } from "@/lib/hosted/contracts";

/** One row as `node:sqlite` hands it back: null, number, bigint, string or bytes. */
export type SqlRow = Record<string, SQLOutputValue>;

/** An ISO-8601 UTC timestamp — the only timestamp format this authority stores. */
export const nowIso = (at: number | Date = Date.now()): string => new Date(at).toISOString();

const bad = (column: string, got: unknown): HostedError =>
  new HostedError(
    "internal",
    `The control database returned ${JSON.stringify(String(got))} for column "${column}", which is not the shape this code reads.`,
    {
      fix: "The stored schema and this build disagree. Check src/lib/hosted/authority/schema.ts for a migration that was edited after it shipped; add a new migration instead of changing an applied one.",
      details: { column },
    }
  );

/** A required TEXT column. */
export function readText(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw bad(column, value);
  return value;
}

/** A nullable TEXT column; SQL NULL becomes `undefined`, never `""`. */
export function readOptionalText(row: SqlRow, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw bad(column, value);
  return value;
}

/** A nullable TEXT column that the contract types as `string | null`. */
export function readNullableText(row: SqlRow, column: string): string | null {
  return readOptionalText(row, column) ?? null;
}

/** A required numeric column. BigInt is accepted and narrowed, never truncated silently. */
export function readNumber(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
      throw bad(column, value);
    return Number(value);
  }
  throw bad(column, value);
}

/** A required INTEGER column holding 0 or 1. */
export function readBoolean(row: SqlRow, column: string): boolean {
  const value = readNumber(row, column);
  if (value !== 0 && value !== 1) throw bad(column, value);
  return value === 1;
}

/** A nullable BLOB column, handed back as the bytes themselves. */
export function readBytes(row: SqlRow, column: string): Uint8Array | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return value;
  throw bad(column, value);
}

/** A required JSON TEXT column. Unparseable content is a schema fault, not a value. */
export function readJson<T>(row: SqlRow, column: string): T {
  const raw = readText(row, column);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw bad(column, raw.slice(0, 40));
  }
}

/** A nullable JSON TEXT column. */
export function readOptionalJson<T>(row: SqlRow, column: string): T | undefined {
  const raw = readOptionalText(row, column);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw bad(column, raw.slice(0, 40));
  }
}

/** JSON for a NOT NULL column. `undefined` becomes the empty object, never the string "undefined". */
export const writeJson = (value: unknown): string => JSON.stringify(value ?? {});

/** JSON for a nullable column: absent stays SQL NULL. */
export const writeOptionalJson = (value: unknown): string | null =>
  value === undefined || value === null ? null : JSON.stringify(value);

/** `undefined` binds as SQL NULL; `null` already does. */
export const writeOptional = (value: string | undefined | null): string | null => value ?? null;

/** Booleans are stored as 0/1 INTEGERs so a CHECK constraint can police them. */
export const writeBoolean = (value: boolean): number => (value ? 1 : 0);

/**
 * A per-connection prepared-statement cache.
 *
 * Statements are prepared on first use rather than at open, so a repository
 * never depends on the order migrations ran in, and every later call reuses
 * the compiled statement. The cache lives as long as its `DatabaseSync`; both
 * are dropped together by `closeAuthority()`.
 */
export type Prepare = (sql: string) => StatementSync;

/** Build the statement cache for one connection. */
export function statements(db: DatabaseSync): Prepare {
  const cache = new Map<string, StatementSync>();
  return (sql: string): StatementSync => {
    const hit = cache.get(sql);
    if (hit) return hit;
    const prepared = db.prepare(sql);
    cache.set(sql, prepared);
    return prepared;
  };
}

/**
 * How many rows a statement changed, as a plain number.
 *
 * `node:sqlite` types `changes` as `number | bigint` because a connection can
 * be switched to BigInt reads. This authority never switches, but normalising
 * here means no call site has to know that.
 */
export const changeCount = (result: { changes: number | bigint }): number => Number(result.changes);

interface SqliteError extends Error {
  code?: string;
  errcode?: number;
  errstr?: string;
}

const sqliteError = (err: unknown): SqliteError | null =>
  err instanceof Error && (err as SqliteError).code === "ERR_SQLITE_ERROR" ? (err as SqliteError) : null;

/** The extended result code SQLite reported, or undefined for anything else. */
export const sqliteErrorCode = (err: unknown): number | undefined => sqliteError(err)?.errcode;

/**
 * True for SQLITE_BUSY (5) and SQLITE_LOCKED (6) and their extended forms
 * (`SQLITE_BUSY_SNAPSHOT` 517, `SQLITE_BUSY_RECOVERY` 261 …). The low byte of
 * an extended result code is the primary code, which is why this masks rather
 * than listing every variant.
 */
export function isBusyError(err: unknown): boolean {
  const code = sqliteErrorCode(err);
  if (code === undefined) return false;
  const primary = code & 0xff;
  return primary === 5 || primary === 6;
}

/** True for a UNIQUE or PRIMARY KEY constraint violation (SQLITE_CONSTRAINT, primary code 19). */
export function isUniqueViolation(err: unknown): boolean {
  const code = sqliteErrorCode(err);
  return code === 2067 || code === 1555;
}

