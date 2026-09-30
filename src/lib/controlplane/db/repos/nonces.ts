/**
 * Replay protection for signed agent requests (RUNNER-PROTOCOL.md section 3:
 * "a nonce seen within the last 10 minutes for that agent" is rejected).
 *
 * `remember` is one atomic `INSERT … ON CONFLICT DO UPDATE … WHERE stale`:
 * of two racing requests carrying the same nonce exactly one gets `true`. A
 * nonce older than the window is treated as unseen (the request's timestamp
 * skew check, ±60 s, is what makes an old nonce harmless). Time is the
 * database's.
 *
 * Nonces are keyed by agent id, which is globally unique; the table is never
 * read by tenants — there is no list function, only `remember` and `prune`.
 */
import type { Sql } from "@/lib/controlplane/types";
import { requireText } from "../errors";
import { boundedMs } from "../sql";

export const NONCE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Record `(agentId, nonce)`. Returns true when the nonce is fresh (accept the
 * request), false when it was already seen within the window (reject as a replay).
 */
export async function remember(sql: Sql, agentId: string, nonce: string, windowMs: number = NONCE_WINDOW_MS): Promise<boolean> {
  const window = boundedMs("windowMs", windowMs, 1000, 24 * 60 * 60 * 1000);
  const rows = await sql.query<{ nonce: string }>(
    `insert into platform.agent_nonces as n (agent_id, nonce, seen_at)
     values ($1, $2, clock_timestamp())
     on conflict (agent_id, nonce) do update set seen_at = clock_timestamp()
     where n.seen_at <= clock_timestamp() - ($3::bigint * interval '1 millisecond')
     returning nonce`,
    [requireText("agentId", agentId, 128), requireText("nonce", nonce, 128), window]
  );
  return rows.length > 0;
}

/** Delete nonces older than `olderThanMs` (default: twice the window). Returns how many. */
export async function prune(sql: Sql, olderThanMs: number = NONCE_WINDOW_MS * 2, limit = 10_000): Promise<number> {
  const age = boundedMs("olderThanMs", olderThanMs, 1000, 30 * 24 * 60 * 60 * 1000);
  const rows = await sql.query<{ nonce: string }>(
    `delete from platform.agent_nonces
      where (agent_id, nonce) in (
        select agent_id, nonce from platform.agent_nonces
         where seen_at <= clock_timestamp() - ($1::bigint * interval '1 millisecond')
         order by seen_at limit $2::bigint)
      returning nonce`,
    [age, Math.max(1, Math.min(100_000, Math.trunc(limit)))]
  );
  return rows.length;
}
