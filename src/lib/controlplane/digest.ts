/**
 * The one canonical-JSON and SHA-256 digest rule for the control plane.
 *
 * Every immutable identity the control plane compares — a proposal digest, a
 * policy input digest, an OpenTofu plan digest, a capability grant's bound
 * digest — is `digest(value)` from this file, so two call sites can never
 * disagree about what "the same request" means. The agent-control journal
 * re-exports these two functions rather than keeping its own copy.
 *
 * Canonical form: object keys sorted by UTF-16 code unit order, `undefined`
 * members dropped, arrays kept in order, primitives via `JSON.stringify`.
 * It never throws on a plain JSON value; non-JSON values (functions, symbols)
 * serialize as `null`, exactly as `JSON.stringify` would inside an array.
 */
import { createHash } from "node:crypto";

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}

/** SHA-256 hex of the canonical form. */
export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** SHA-256 hex of raw bytes or a UTF-8 string (file contents, plan files). */
export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
