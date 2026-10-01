/**
 * Bounded system maintenance of the control store; never executes cloud work.
 * Repository constants own expiry windows; the operation service owns status
 * transitions. Cleanup locks candidates and rechecks expiry on the DELETE so a
 * concurrent reservation/nonce refresh cannot lose a newly live replay record.
 * A lapsed executor becomes uncertain, with grant revocation and audit committed
 * together. Counts only leave this module, never rows or error input.
 *
 * The global maintenance lease is committed before work. Its fence is locked
 * for the write transaction, preventing a takeover even if a slow transaction
 * outlives the TTL. Each invocation has a distinct holder (including retries
 * within one process). This is deliberately cross-tenant system work.
 */
import { randomUUID } from "node:crypto";
import { repos } from "@/lib/controlplane/db";
import { reconcileOperations } from "@/lib/controlplane/operations";
import { NONCE_WINDOW_MS } from "@/lib/controlplane/db/repos/nonces";
import type { Lease, Sql } from "@/lib/controlplane/types";

export const HOUSEKEEPING_LEASE_SCOPE = "system:platform-housekeeping";
export const HOUSEKEEPING_LIMIT = 100;

export interface HousekeepingResult {
  ran: boolean;
  idempotencyKeys: number;
  nonces: number;
  uncertain: number;
  expired: number;
}

export async function housekeepingPass(db: Sql, options: { limit?: number } = {}): Promise<HousekeepingResult> {
  const limit = options.limit ?? HOUSEKEEPING_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("Housekeeping limit must be an integer from 1 to 1000.");
  let lease: Lease | null = null;
  try {
    lease = await repos.leases.acquire(db, {
      scope: HOUSEKEEPING_LEASE_SCOPE, holder: `housekeeping:${randomUUID()}`, ttlMs: 30_000,
    });
    if (!lease) return { ran: false, idempotencyKeys: 0, nonces: 0, uncertain: 0, expired: 0 };
    const fence = lease;
    return await db.tx(async (tx) => {
      await repos.leases.assertFence(tx, fence.scope, fence.fenceToken);
      // Locked, expiry-rechecked prunes live in the repositories (system maintenance,
      // reviewed in tests/security/controlplane-sql-scoping.test.ts).
      const idempotencyKeys = await repos.idempotency.prune(tx, limit);
      const nonces = await repos.nonces.prune(tx, NONCE_WINDOW_MS * 2, limit);
      const operations = await reconcileOperations(tx, { limit });
      return { ran: true, idempotencyKeys, nonces, uncertain: operations.uncertain.length, expired: operations.expired.length };
    });
  } catch {
    throw new Error("Platform housekeeping could not complete; check control store connectivity and schema.");
  } finally {
    // If the connection is lost, the committed lease expires and permits retry.
    if (lease) await repos.leases.release(db, lease).catch(() => undefined);
  }
}
