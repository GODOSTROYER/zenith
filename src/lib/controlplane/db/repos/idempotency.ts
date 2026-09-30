/**
 * Durable idempotency keys.
 *
 * A key is scoped to a workspace. The first request with a key claims it
 * (`INSERT … ON CONFLICT DO UPDATE … WHERE expired`, one atomic statement, so
 * two racing requests produce exactly one claimant); a repeat with the same
 * request hash is a replay and gets the recorded operation/response back; a
 * repeat with a different hash is an `IdempotencyConflictError`. Expired keys
 * are transparently reclaimed by the next request that uses them.
 *
 * Callers that create an operation use `operations.create`, which reserves the
 * key in the same transaction as the operation insert (the foreign key to the
 * operation is deferred, so the key is claimed first and the operation second).
 */
import type { Sql } from "@/lib/controlplane/types";
import { IdempotencyConflictError, requireText } from "../errors";
import { boundedMs } from "../sql";

export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export type IdempotencyReservation =
  | { state: "new" }
  | { state: "replay"; operationId?: string; response?: unknown };

export interface ReserveInput {
  workspaceId: string;
  key: string;
  /** digest of the request this key is bound to */
  requestHash: string;
  operationId?: string;
  ttlMs?: number;
}

/** Claim `key`, or report the earlier claim. Run inside the transaction that acts on the result. */
export async function reserve(sql: Sql, input: ReserveInput): Promise<IdempotencyReservation> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const key = requireText("idempotencyKey", input.key, 200);
  const requestHash = requireText("requestHash", input.requestHash, 128);
  const ttl = boundedMs("ttlMs", input.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS, 1000, 30 * 24 * 60 * 60 * 1000);

  for (let attempt = 0; attempt < 3; attempt++) {
    const claimed = await sql.query<{ key: string }>(
      `insert into platform.idempotency_keys as k (workspace_id, key, request_hash, operation_id, expires_at)
       values ($1, $2, $3, $4, clock_timestamp() + ($5::bigint * interval '1 millisecond'))
       on conflict (workspace_id, key) do update
         set request_hash = excluded.request_hash,
             operation_id = excluded.operation_id,
             response     = null,
             created_at   = clock_timestamp(),
             expires_at   = excluded.expires_at
       where k.expires_at <= clock_timestamp()
       returning key`,
      [workspaceId, key, requestHash, input.operationId ?? null, ttl]
    );
    if (claimed.length > 0) return { state: "new" };

    const existing = await sql.query<{ request_hash: string; operation_id: string | null; response: unknown }>(
      "select request_hash, operation_id, response from platform.idempotency_keys where workspace_id = $1 and key = $2",
      [workspaceId, key]
    );
    if (existing.length === 0) continue; // pruned between the two statements: claim again
    if (existing[0].request_hash !== requestHash) throw new IdempotencyConflictError(key);
    return {
      state: "replay",
      operationId: existing[0].operation_id ?? undefined,
      response: existing[0].response ?? undefined,
    };
  }
  throw new IdempotencyConflictError(key);
}

/** Record the response for a claimed key so a replay can return it verbatim. */
export async function complete(sql: Sql, workspaceId: string, key: string, response: unknown): Promise<boolean> {
  const rows = await sql.query<{ key: string }>(
    `update platform.idempotency_keys set response = $3::text::jsonb
      where workspace_id = $1 and key = $2 returning key`,
    [workspaceId, key, JSON.stringify(response === undefined ? null : response)]
  );
  return rows.length > 0;
}

/** Delete expired keys (bounded). Returns how many were removed. */
export async function prune(sql: Sql, limit = 1000): Promise<number> {
  const rows = await sql.query<{ key: string }>(
    `delete from platform.idempotency_keys
      where (workspace_id, key) in (
        select workspace_id, key from platform.idempotency_keys
         where expires_at <= clock_timestamp() order by expires_at limit $1)
      returning key`,
    [Math.max(1, Math.min(10_000, Math.trunc(limit)))]
  );
  return rows.length;
}
