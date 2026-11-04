/**
 * Idempotency service for requests that are not operation creates (those use
 * `operations.create`, which reserves its key itself).
 *
 *     const { replayed, value } = await withIdempotency(db,
 *       { workspaceId, key: request.header("Idempotency-Key"), requestHash: digest(body) },
 *       async (tx) => { …database work…; return jsonSerializableResult; });
 *
 * First call: `fn` runs in a transaction together with the key reservation and
 * the stored response, so either all three commit or none do (a failing `fn`
 * leaves the key unclaimed and the client may retry). A repeat with the same
 * hash replays the stored response without running `fn`. A repeat with a
 * different hash throws `IdempotencyConflictError`. Because `fn` runs inside the
 * transaction it must be database-only, and its result must be JSON.
 */
import type { Sql } from "@/lib/controlplane/types";
import { complete, reserve, type ReserveInput } from "@/lib/controlplane/db/repos/idempotency";

export { IdempotencyConflictError } from "@/lib/controlplane/db/errors";
export { complete, prune, reserve, DEFAULT_IDEMPOTENCY_TTL_MS } from "@/lib/controlplane/db/repos/idempotency";
export type { IdempotencyReservation, ReserveInput } from "@/lib/controlplane/db/repos/idempotency";

export type IdempotentResult<T> = { replayed: false; value: T } | { replayed: true; value: T };

export async function withIdempotency<T>(db: Sql, input: ReserveInput, fn: (tx: Sql) => Promise<T>): Promise<IdempotentResult<T>> {
  return db.tx(async (tx) => {
    const reservation = await reserve(tx, input);
    if (reservation.state === "replay") return { replayed: true, value: reservation.response as T };
    const value = await fn(tx);
    await complete(tx, input.workspaceId, input.key, value);
    return { replayed: false, value };
  });
}
