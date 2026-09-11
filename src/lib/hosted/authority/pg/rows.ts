/**
 * Row readers for Postgres, matching `authority/sql.ts` reader for reader.
 *
 * Same contract as the SQLite ones: **a column that is missing or of the wrong
 * shape is refused, never coerced.** A silent `undefined` in a grant or a fence
 * token is the kind of bug that only shows up as a wrongly admitted request,
 * and it is worth exactly as little here as it is there.
 *
 * Three differences from `sql.ts`, all of them the driver's:
 *
 *  - **`bigint` columns arrive as strings.** postgres.js returns `int8` as a
 *    decimal string rather than a JavaScript number, because not every int8
 *    fits in one. `readNumber` therefore accepts a numeric string and refuses
 *    anything past `Number.MAX_SAFE_INTEGER` instead of rounding it — the same
 *    refusal `sql.ts` makes for a `bigint`.
 *  - **Flags are real booleans.** `hosted_events.assisted` is `boolean` in
 *    Postgres where SQLite stored 0/1 under a CHECK, so `readBoolean` reads a
 *    boolean and `writeBoolean` writes one. Nothing above this file notices:
 *    both repositories hand their caller a `boolean`.
 *  - **`bytea` arrives as a Node `Buffer`.** Which is a `Uint8Array`, so
 *    `readBytes` needs no conversion — but it is worth knowing that the bytes a
 *    caller gets back may be a `Buffer` view, not a plain array.
 *
 * **Timestamps are text on both stores** (see the migration's header), so there
 * is no date reader here and `nowIso()` from `authority/sql.ts` is still the
 * only thing that formats one.
 */
import { HostedError } from "@/lib/hosted/contracts";

/** One row as postgres.js hands it back. */
export type PgRow = Record<string, unknown>;

const bad = (column: string, got: unknown): HostedError =>
  new HostedError(
    "internal",
    `The control database returned ${JSON.stringify(String(got))} for column "${column}", which is not the shape this code reads.`,
    {
      fix: "The stored schema and this build disagree. Check that supabase/migrations/0002_hosted_authority.sql was applied in full, and that it matches MIGRATIONS in src/lib/hosted/authority/schema.ts.",
      details: { column },
    }
  );

/** A required `text` column. */
export function readText(row: PgRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw bad(column, value);
  return value;
}

/** A nullable `text` column; SQL NULL becomes `undefined`, never `""`. */
export function readOptionalText(row: PgRow, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw bad(column, value);
  return value;
}

/** A nullable `text` column that the contract types as `string | null`. */
export function readNullableText(row: PgRow, column: string): string | null {
  return readOptionalText(row, column) ?? null;
}

/**
 * A required numeric column: `integer`, `double precision`, or a `bigint` the
 * driver handed back as a decimal string. Never silently truncated.
 */
export function readNumber(row: PgRow, column: string): number {
  const value = row[column];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw bad(column, value);
    return value;
  }
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
      throw bad(column, value);
    return Number(value);
  }
  // int8, which postgres.js returns as a string so that values past 2^53 are
  // not quietly rounded on the way in. Refuse rather than round on the way out.
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !Number.isSafeInteger(Math.trunc(parsed))) throw bad(column, value);
    return parsed;
  }
  throw bad(column, value);
}

/** A required `boolean` column. */
export function readBoolean(row: PgRow, column: string): boolean {
  const value = row[column];
  if (typeof value !== "boolean") throw bad(column, value);
  return value;
}

/** A nullable `bytea` column, handed back as the bytes themselves. */
export function readBytes(row: PgRow, column: string): Uint8Array | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return value;
  throw bad(column, value);
}

/** A required JSON `text` column. Unparseable content is a schema fault, not a value. */
export function readJson<T>(row: PgRow, column: string): T {
  const raw = readText(row, column);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw bad(column, raw.slice(0, 40));
  }
}

/** A nullable JSON `text` column. */
export function readOptionalJson<T>(row: PgRow, column: string): T | undefined {
  const raw = readOptionalText(row, column);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw bad(column, raw.slice(0, 40));
  }
}

/** JSON for a NOT NULL column. `undefined` becomes the empty object. */
export const writeJson = (value: unknown): string => JSON.stringify(value ?? {});

/** JSON for a nullable column: absent stays SQL NULL. */
export const writeOptionalJson = (value: unknown): string | null =>
  value === undefined || value === null ? null : JSON.stringify(value);

/** `undefined` binds as SQL NULL; `null` already does. */
export const writeOptional = (value: string | undefined | null): string | null => value ?? null;

/** A flag, as a real Postgres boolean. */
export const writeBoolean = (value: boolean): boolean => value;

/**
 * How many rows a statement changed.
 *
 * postgres.js puts the count on the result list as `count`, where the SQLite
 * driver returns a `changes` field. Normalised here so a repository body reads
 * the same on both sides.
 */
export const changeCount = (result: { count: number }): number => Number(result.count);
