/**
 * The write-id intent hash: what makes a retried mutation replay its original
 * result and a *different* mutation sent under the same write id a refusal
 * rather than a second effect (decision R3-08).
 *
 * The hash covers the canonical intent from `tracker-v1.ts` — contract version,
 * operation, app, subject, record id and the parsed body — serialised with a
 * key order that does not depend on how the caller happened to build the
 * object. Two requests that mean the same write hash the same; anything else
 * does not.
 *
 * Workstream W3 (hosted R3).
 */
import { createHash } from "node:crypto";
import { canonicalWriteIntent } from "@/lib/hosted/contracts";

/**
 * `JSON.stringify` with object keys sorted at every depth. Arrays keep their
 * order; `undefined` inside an object drops out exactly as `JSON.stringify`
 * would drop it.
 *
 * Needed because the intent hash has to be stable across a client that sends
 * `{title, status}` and one that sends `{status, title}` — after validation
 * both mean the same write.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    sorted[key] = sortDeep(source[key]);
  }
  return sorted;
}

/**
 * SHA-256 hex of the canonical intent for one mutation.
 *
 * `body` is the *parsed* request body, so two requests that differ only by an
 * omitted field with a default are correctly treated as the same intent.
 */
export function writeIntentHash(
  op: "create" | "update",
  appId: string,
  subject: string,
  recordId: string | null,
  body: unknown
): string {
  const intent = canonicalWriteIntent(op, appId, subject, recordId, body);
  return createHash("sha256").update(stableStringify(intent), "utf8").digest("hex");
}
