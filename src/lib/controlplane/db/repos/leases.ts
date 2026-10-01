/**
 * Leases with fence tokens — the mutual-exclusion primitive (invariant 3 of
 * `controlplane/types.ts`).
 *
 * A lease is one row per scope, kept forever so `fence_token` is strictly
 * increasing per scope for the life of the database (a released or expired
 * lease keeps its row and its counter; it is never deleted). Every (re)acquire
 * increments the fence, so a stale holder's writes — which carry the fence it
 * was granted — can be recognised and refused by `assertFence`.
 *
 * Time is the DATABASE's: `clock_timestamp()` in SQL, never a client clock. A
 * lease is valid iff `expires_at > clock_timestamp()` and it has not been
 * released; expiry is inclusive (`<=`) so a released lease is immediately free.
 *
 * No advisory locks and no session state: this works unchanged through the
 * Supavisor transaction pooler. Mutual exclusion is one atomic
 * `INSERT … ON CONFLICT (scope) DO UPDATE … WHERE <free or mine> RETURNING`.
 *
 * Holders must renew before `expires_at`; a holder that cannot renew must stop
 * (see `controlplane/leases` `withLease`) and any operation it was running is
 * reconciled to `uncertain`, never retried.
 */
import { LeaseLostError, type Lease, type LeaseScope, type Sql } from "@/lib/controlplane/types";
import { boundedMs } from "../sql";
import { optionalText, requireText } from "../errors";

interface LeaseRow {
  scope: string;
  holder: string;
  fence_token: number;
  acquired_at: string;
  expires_at: string;
}

const COLUMNS = "scope, holder, fence_token, acquired_at, expires_at";
const TTL_MIN_MS = 1;
const TTL_MAX_MS = 24 * 60 * 60 * 1000;

const toLease = (row: LeaseRow): Lease => ({
  scope: row.scope,
  holder: row.holder,
  fenceToken: row.fence_token,
  acquiredAt: row.acquired_at,
  expiresAt: row.expires_at,
});

export interface AcquireLeaseInput {
  scope: LeaseScope;
  holder: string;
  ttlMs: number;
  /**
   * Tenant the scope belongs to, when known (`env:<id>` leases). Recorded on
   * first acquire; a later acquire naming a different workspace is refused
   * (returns null) so one tenant can never take another's lease.
   */
  workspaceId?: string;
}

/**
 * Try to take `scope`. Returns the lease, or `null` when another holder has it
 * unexpired. The same holder re-acquiring an unexpired lease succeeds and
 * increments the fence (the old `Lease` value becomes stale).
 */
export async function acquire(sql: Sql, input: AcquireLeaseInput): Promise<Lease | null> {
  const scope = requireText("scope", input.scope, 256);
  const holder = requireText("holder", input.holder, 256);
  const ttl = boundedMs("ttlMs", input.ttlMs, TTL_MIN_MS, TTL_MAX_MS);
  const workspaceId = optionalText("workspaceId", input.workspaceId) ?? null;
  const rows = await sql.query<LeaseRow>(
    `insert into platform.leases as l (scope, workspace_id, holder, fence_token, acquired_at, renewed_at, expires_at, released_at)
     values ($1, $4, $2, 1, clock_timestamp(), clock_timestamp(), clock_timestamp() + ($3::bigint * interval '1 millisecond'), null)
     on conflict (scope) do update
       set holder       = excluded.holder,
           workspace_id = coalesce(l.workspace_id, excluded.workspace_id),
           fence_token  = l.fence_token + 1,
           acquired_at  = excluded.acquired_at,
           renewed_at   = excluded.renewed_at,
           expires_at   = excluded.expires_at,
           released_at  = null
     where (l.expires_at <= clock_timestamp() or l.holder = excluded.holder)
       and (l.workspace_id is null or excluded.workspace_id is null or l.workspace_id = excluded.workspace_id)
     returning ${COLUMNS}`,
    [scope, holder, ttl, workspaceId]
  );
  return rows.length ? toLease(rows[0]) : null;
}

/**
 * Extend a lease this holder still owns: same holder, same fence, not yet
 * expired, not released. Returns the renewed lease, or `null` when the lease is
 * lost (expired, taken over, released) — the caller must stop.
 */
export async function renew(sql: Sql, lease: Pick<Lease, "scope" | "holder" | "fenceToken">, ttlMs: number): Promise<Lease | null> {
  const ttl = boundedMs("ttlMs", ttlMs, TTL_MIN_MS, TTL_MAX_MS);
  const rows = await sql.query<LeaseRow>(
    `update platform.leases
        set expires_at = greatest(expires_at, clock_timestamp() + ($4::bigint * interval '1 millisecond')),
            renewed_at = clock_timestamp()
      where scope = $1 and holder = $2 and fence_token = $3::bigint
        and expires_at > clock_timestamp() and released_at is null
      returning ${COLUMNS}`,
    [lease.scope, lease.holder, lease.fenceToken, ttl]
  );
  return rows.length ? toLease(rows[0]) : null;
}

/** Release a lease this holder owns (same holder and fence). Idempotent; true when a lease was released. */
export async function release(sql: Sql, lease: Pick<Lease, "scope" | "holder" | "fenceToken">): Promise<boolean> {
  const rows = await sql.query<{ scope: string }>(
    `update platform.leases
        set expires_at = clock_timestamp(), released_at = clock_timestamp()
      where scope = $1 and holder = $2 and fence_token = $3::bigint and released_at is null
      returning scope`,
    [lease.scope, lease.holder, lease.fenceToken]
  );
  return rows.length > 0;
}

/** The currently valid lease for `scope`, or null (never acquired, expired or released). */
export async function current(sql: Sql, scope: LeaseScope): Promise<Lease | null> {
  const rows = await sql.query<LeaseRow>(
    `select ${COLUMNS} from platform.leases
      where scope = $1 and expires_at > clock_timestamp() and released_at is null`,
    [requireText("scope", scope, 256)]
  );
  return rows.length ? toLease(rows[0]) : null;
}

/** Valid leases recorded for a workspace (scopes acquired with `workspaceId`). */
export async function listActive(sql: Sql, workspaceId: string): Promise<Lease[]> {
  const rows = await sql.query<LeaseRow>(
    `select ${COLUMNS} from platform.leases
      where workspace_id = $1 and expires_at > clock_timestamp() and released_at is null
      order by scope`,
    [requireText("workspaceId", workspaceId)]
  );
  return rows.map(toLease);
}

/**
 * Assert, inside the caller's write transaction, that `fenceToken` is still the
 * live fence of `scope`; throw `LeaseLostError` otherwise. The row is locked
 * `FOR SHARE` for the rest of the transaction, so a takeover cannot commit
 * between this check and the writes that follow it — the check and the write
 * are one atomic step. Call it FIRST in every fenced write transaction.
 *
 * Must run inside `sql.tx(...)`: outside a transaction the lock is released
 * immediately and only the check remains.
 */
export async function assertFence(sql: Sql, scope: LeaseScope, fenceToken: number): Promise<void> {
  const rows = await sql.query<{ fence_token: number }>(
    `select fence_token from platform.leases
      where scope = $1 and fence_token = $2::bigint and expires_at > clock_timestamp() and released_at is null
      for share`,
    [requireText("scope", scope, 256), fenceToken]
  );
  if (rows.length === 0) throw new LeaseLostError(scope, fenceToken);
}
