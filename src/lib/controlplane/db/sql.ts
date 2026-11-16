/**
 * Small helpers every repository shares: JSON parameters, list parameters,
 * ids, cursors and bounded limits.
 *
 * None of these builds SQL from data. Anything interpolated into SQL text in
 * this directory is a literal from a closed, code-defined set; everything else
 * is a `$n` parameter.
 */
import { randomUUID } from "node:crypto";
import { ControlStoreError } from "./errors";

/** JSON for a `$n::text::jsonb` slot. `undefined` is stored as JSON `null`. */
export function json(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

/** JSON for a nullable `$n::text::jsonb` slot: `undefined`/`null` → SQL NULL. */
export function jsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/**
 * A Postgres array literal for a `$n::text[]` slot: `{"a","b"}`. Elements are
 * quoted and escaped, so any string is safe. Works identically on both engines
 * (an actual JS array parameter would not).
 */
export function textArray(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

/** `prefix_<uuid>` — the id shape used across the store. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/** A bounded page size: default `fallback`, clamped to 1..`max`. */
export function clampLimit(limit: number | undefined, fallback = 50, max = 500): number {
  if (limit === undefined) return fallback;
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(limit)));
}

/** Milliseconds as a whole, bounded number for `$n::bigint * interval '1 millisecond'`. */
export function boundedMs(name: string, ms: number, min: number, max: number): number {
  if (!Number.isFinite(ms) || ms < min || ms > max)
    throw new ControlStoreError("invalid_input", `${name} must be between ${min} and ${max} milliseconds.`, { field: name });
  return Math.trunc(ms);
}

export const HEX64 = /^[0-9a-f]{64}$/;

export function requireDigest(name: string, value: unknown): string {
  if (typeof value !== "string" || !HEX64.test(value))
    throw new ControlStoreError("invalid_input", `${name} must be a lowercase 64-character hex SHA-256 digest.`, { field: name });
  return value;
}

/** Opaque, forward-only cursor over a bigint sequence: the last seq returned. */
export function encodeCursor(seq: number): string {
  return Buffer.from(String(seq), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined || cursor === "") return undefined;
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^[0-9]{1,16}$/.test(text)) throw new ControlStoreError("invalid_input", "Invalid pagination cursor.", { field: "cursor" });
  return Number(text);
}

/** Drop `undefined` members (used when mapping optional row columns). */
export function opt<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}
