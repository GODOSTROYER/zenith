/**
 * The platform-store-backed `EnvironmentGuard` and deploy-signal source.
 *
 * Guard: one reconciliation pass per environment at a time, and none while a
 * mutation holds the environment.
 *
 *  - `env:<environmentId>` held (deploy, apply, restart, scale, remediation)
 *    → `mutation_in_flight`: reading mid-apply would report the change's own
 *    half-finished state as drift, so the pass is skipped and brought forward.
 *  - `reconcile:<environmentId>` is taken with `withLease` (renewed on the
 *    database clock; released in `finally`). The holder is DISTINCT from the
 *    Temporal reconcile workflow's (`reconcile-<environmentId>`), so the cron
 *    pass and the workflow exclude each other on the same scope.
 *  - The lease's fence and abort signal are handed to the work: the commit
 *    asserts the fence, and a lost lease aborts outstanding reads.
 *
 * The `env:` check is a read followed by an acquire, not one atomic step: a
 * deploy that starts in between is observed mid-flight. That window is narrow,
 * the observation is read-only, and any repair it provokes still goes through
 * the broker and, when executed, takes the `env:` lease itself — so the worst
 * case is one spurious, approval-gated proposal, not a wrong write.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "@/lib/controlplane/types";
import { current } from "@/lib/controlplane/db/repos/leases";
import { LeaseUnavailableError, withLease } from "@/lib/controlplane/leases";
import type { EnvironmentGuard, ReconcileSignalsPort } from "../pass-types";

export interface PlatformGuardOptions {
  /** lease lifetime; must exceed the longest environment pass (default 90 s; renewed every third) */
  ttlMs?: number;
}

export function createPlatformGuard(db: Sql, options: PlatformGuardOptions = {}): EnvironmentGuard {
  const ttlMs = options.ttlMs ?? 90_000;
  return {
    async run(environment, fn) {
      if (await current(db, `env:${environment.environmentId}`)) return { ran: false, reason: "mutation_in_flight" };
      try {
        const value = await withLease(
          db,
          { scope: `reconcile:${environment.environmentId}`, holder: `reconcile-pass:${randomUUID()}`, ttlMs, workspaceId: environment.workspaceId },
          (lease, signal) => fn({ fence: { scope: lease.scope, token: lease.fenceToken }, signal })
        );
        return { ran: true, value };
      } catch (err) {
        if (err instanceof LeaseUnavailableError) return { ran: false, reason: "reconcile_lease_held" };
        // A lost lease (LeaseLostError) means this pass's view is untrustworthy: it wrote nothing (the fence) and the caller records a failed run.
        throw err;
      }
    },
  };
}

/** Deploys that finished since `since`, from the operations ledger (backed by the partial index of migration 0002). */
export function createPlatformSignals(db: Sql): ReconcileSignalsPort {
  return {
    async deploysSince({ since, limit }) {
      const rows = await db.query<{ workspace_id: string; environment_id: string; at: string }>(
        `select workspace_id, environment_id, max(finished_at) as at
           from platform.operations
          where status = 'succeeded' and capability in ('deployment.deploy', 'deployment.rollback', 'infrastructure.apply')
            and finished_at >= $1::timestamptz and environment_id is not null
          group by workspace_id, environment_id
          order by max(finished_at) desc
          limit $2::bigint`,
        [since.toISOString(), Math.max(1, Math.trunc(limit))]
      );
      return rows.map((r) => ({ workspaceId: r.workspace_id, environmentId: r.environment_id, at: new Date(r.at).toISOString() }));
    },
  };
}
