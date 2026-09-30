/**
 * Lease service: run a piece of work under a fenced lease.
 *
 *     const result = await withLease(db, { scope: `env:${envId}`, holder, ttlMs: 30_000 },
 *       async (lease, signal) => {
 *         // every fenced write inside a db.tx starts with:
 *         //   await repos.leases.assertFence(tx, lease.scope, lease.fenceToken);
 *         // every external call that can carry a fence carries lease.fenceToken
 *         // and passes `signal` so it stops when the lease is lost
 *       });
 *
 * What `withLease` does:
 *  1. Acquires the lease (`LeaseUnavailableError` if another holder has it).
 *  2. Renews it on an interval (default ttl/3) on the DATABASE's clock, with an
 *     unref'd timer so it never keeps the process alive.
 *  3. If a renewal reports the lease lost (expired, taken over) — or the
 *     database has been unreachable for two thirds of the ttl, so the lease is
 *     about to lapse under us — it aborts `signal` with a `LeaseLostError`.
 *  4. Releases the lease in `finally`.
 *  5. If the lease was lost at any point, it throws `LeaseLostError` even when
 *     `fn` returned normally: the work ran without exclusion for an unknown
 *     interval, so its outcome is uncertain and the caller must reconcile, not
 *     retry.
 *
 * Call it with the top-level store (`PlatformDb`), NOT with a transaction handle:
 * renewals must commit on their own connection to be visible to contenders.
 * `fn` must finish the operation's own status write BEFORE returning, because
 * release happens after `fn` and the reconciler treats a running operation whose
 * lease is gone as uncertain.
 */
import type { Lease, LeaseScope, Principal, Sql } from "@/lib/controlplane/types";
import { LeaseLostError } from "@/lib/controlplane/types";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import { append } from "@/lib/controlplane/db/repos/events";
import { acquire, release, renew } from "@/lib/controlplane/db/repos/leases";

export class LeaseUnavailableError extends ControlStoreError {
  constructor(readonly scope: LeaseScope) {
    super("lease_unavailable", `Another operation currently holds ${scope}. Wait for it to finish or expire; nothing was changed.`, { scope });
    this.name = "LeaseUnavailableError";
  }
}

export interface WithLeaseOptions {
  scope: LeaseScope;
  holder: string;
  /** lease lifetime; default 30 s */
  ttlMs?: number;
  /** renewal period; default ttl / 3 (at least 50 ms) */
  renewEveryMs?: number;
  workspaceId?: string;
  /** an outer signal (e.g. workflow cancellation): aborting it aborts the inner signal */
  signal?: AbortSignal;
  /** when given, best-effort `lease.acquired` / `lease.lost` / `lease.released` events are appended */
  audit?: { workspaceId: string; correlationId: string; actor?: Principal; environmentId?: string; operationId?: string };
}

export async function withLease<T>(
  db: Sql,
  opts: WithLeaseOptions,
  fn: (lease: Lease, signal: AbortSignal) => Promise<T>
): Promise<T> {
  const ttlMs = opts.ttlMs ?? 30_000;
  const renewEveryMs = Math.max(50, opts.renewEveryMs ?? Math.floor(ttlMs / 3));
  const lease = await acquire(db, { scope: opts.scope, holder: opts.holder, ttlMs, workspaceId: opts.workspaceId });
  if (!lease) throw new LeaseUnavailableError(opts.scope);

  const record = async (type: "lease.acquired" | "lease.lost" | "lease.released"): Promise<void> => {
    if (!opts.audit) return;
    try {
      await append(db, {
        type,
        workspaceId: opts.audit.workspaceId,
        environmentId: opts.audit.environmentId,
        operationId: opts.audit.operationId,
        correlationId: opts.audit.correlationId,
        actor: opts.audit.actor,
        data: { scope: lease.scope, holder: lease.holder, fenceToken: lease.fenceToken },
      });
    } catch {
      /* an audit failure must never change lock semantics */
    }
  };
  await record("lease.acquired");

  const controller = new AbortController();
  let lost: LeaseLostError | undefined;
  const fail = (): void => {
    if (lost) return;
    lost = new LeaseLostError(lease.scope, lease.fenceToken);
    controller.abort(lost);
    void record("lease.lost");
  };
  const onOuterAbort = (): void => controller.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) onOuterAbort();
    else opts.signal.addEventListener("abort", onOuterAbort, { once: true });
  }

  let lastRenewed = performance.now();
  let renewing = false;
  const tick = async (): Promise<void> => {
    if (renewing || lost) return;
    renewing = true;
    try {
      const renewed = await renew(db, lease, ttlMs);
      if (renewed) lastRenewed = performance.now();
      else fail();
    } catch {
      // The database is unreachable or erroring. Keep trying — but stop before
      // the lease can lapse under us.
      if (performance.now() - lastRenewed >= (ttlMs * 2) / 3) fail();
    } finally {
      renewing = false;
    }
  };
  const timer = setInterval(() => void tick(), renewEveryMs);
  (timer as unknown as { unref?: () => void }).unref?.();

  try {
    const value = await fn(lease, controller.signal);
    if (lost) throw lost;
    return value;
  } catch (err) {
    throw lost ?? err;
  } finally {
    clearInterval(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
    try {
      if (await release(db, lease)) await record("lease.released");
    } catch {
      /* release failing leaves the lease to expire on its own, which is safe */
    }
  }
}
