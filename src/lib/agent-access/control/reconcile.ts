/**
 * Crash recovery, as a scheduled pass instead of a constructor.
 *
 * `Journal.recover()` marks every `running` row whose `workerId` is not this
 * process's as `uncertain`, and it runs when the journal is opened. On one
 * long-lived host that is exactly right: there is one writer, so a `running`
 * row belonging to anybody else is the wreckage of a previous boot.
 *
 * On Vercel it would be a catastrophe. `workerId` is per-process, instances are
 * created and frozen constantly, and every cold start would declare every other
 * live instance's in-flight operation uncertain. So on Postgres the recovery
 * rule changes from "not my worker id" to **"past its lease"**, the lease is
 * 60 s (longer than any route's `maxDuration`, so a live request is never
 * reclaimed under itself), and the pass runs from the scheduler rather than at
 * construction.
 *
 * **Nothing here re-dispatches anything.** A `running` row past its lease
 * becomes `uncertain` and stays there. The side effect may have happened and
 * this process has no way to find out; a silent retry is the one failure mode
 * the whole design exists to refuse.
 *
 * Every statement is bounded and idempotent: a pass that runs twice reconciles
 * nothing the first one did, and two instances running it at once each change a
 * disjoint set of rows or none.
 */
import { log } from '@/lib/log';
import { isPostgres } from '@/lib/db/store';
import { controlCapabilitiesSync } from './capabilities';
import { SqliteAgentJournal } from './journal';
// Type-only, so nothing of the Postgres journal is loaded on the file store.
import type { AnySql } from './journal-pg';

/** What one pass did. Frozen contract (WORK-GRAPH-2 F6). */
export interface AgentTickResult {
  /** `running` rows past their lease, moved to `uncertain`. */
  reconciled: number;
  /** `prepared`/`approved` rows past `expires_at`, moved to `expired`. */
  expired: number;
  /**
   * Link codes swept: rows moved to `expired` plus rows deleted a day later
   * (LINK-PROTOCOL §3.3). Zero until `0006` is applied.
   */
  links: number;
  /** Uploaded source past its hour, deleted. */
  uploads: number;
  /** Wall clock. */
  ms: number;
}

/** The pass's own budget, well under the route's `maxDuration = 60`. */
export const AGENT_TICK_BUDGET_MS = 10_000;

/** Postgres's "relation does not exist". A table another migration owns, not an error here. */
const UNDEFINED_TABLE = '42P01';

const isUndefinedTable = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === UNDEFINED_TABLE;

/**
 * How long a finished link code is kept before housekeeping deletes it.
 *
 * The same twenty-four hours `PgCredentialAuthority.expireLinks()` keeps, and
 * deliberately not imported from it: this pass must not drag the credential
 * authority (and with it the secret module and its own schema probe) into the
 * tick route just to learn a number.
 */
const LINK_RETENTION_MS = 86_400_000;

/**
 * A link code past `expires_at` is *expired*, and its undelivered secret dies
 * with it. It is not deleted here: an agent still polling deserves
 * `expired_token` rather than `invalid_device_code`, which is what a vanished
 * row would produce. LINK-PROTOCOL §3.3.
 *
 * `agent.agent_link_codes` is keyed on `user_code_hash` and **has no `id`
 * column** (0006). Naming one costs a `42703 undefined_column` — which is not
 * `isUndefinedTable` and so fails the whole pass.
 */
export const sweepLinkCodesStatement = (sql: AnySql, p: { now: string; limit: number }) => sql`
  update agent.agent_link_codes set state = 'expired', secret_ct = null
   where user_code_hash in (
     select user_code_hash from agent.agent_link_codes
      where state in ('pending','approved') and expires_at <= ${p.now}
      order by expires_at limit ${p.limit})
  returning user_code_hash`;

/** And a day after that the row itself goes, whatever state it reached. */
export const deleteLinkCodesStatement = (sql: AnySql, p: { cutoff: string; limit: number }) => sql`
  delete from agent.agent_link_codes
   where user_code_hash in (
     select user_code_hash from agent.agent_link_codes
      where expires_at <= ${p.cutoff} order by expires_at limit ${p.limit})
  returning user_code_hash`;

/**
 * One reconciliation pass.
 *
 * Called from `POST /api/internal/tick/agent`, which `cronRoute()` builds — so
 * the constant-time `CRON_SECRET` check, the 503-when-unset rule and the
 * request scope all come from there and none of them is reimplemented here.
 */
export async function agentTickPass(budgetMs = AGENT_TICK_BUDGET_MS): Promise<AgentTickResult> {
  const started = Date.now();
  const out: AgentTickResult = { reconciled: 0, expired: 0, links: 0, uploads: 0, ms: 0 };
  const deadline = started + Math.max(0, budgetMs);
  const capabilities = controlCapabilitiesSync();

  // Not enabled at all: a pass that does nothing, and says so by doing nothing.
  // The scheduler is not a way to turn the feature on.
  if (capabilities.journal === 'file' && !capabilities.control) {
    out.ms = Date.now() - started;
    return out;
  }

  if (!isPostgres()) {
    // The single-host premise holds here: this process is the only writer, so
    // the construction-time `recover()` in `runtime.ts` is still where an
    // interrupted dispatch is resolved. All the pass adds is the sweep that
    // used to happen only on the next write.
    try {
      const { control } = await import('./runtime');
      const journal = (await control()).journal;
      // `recover()` and `expire()` are the single-writer journal's own, not part
      // of the `AgentJournal` surface both stores answer — a Postgres journal
      // recovers by lease, below, and must never be asked to do this.
      if (journal instanceof SqliteAgentJournal) {
        out.reconciled = await journal.recover();
        const swept = await journal.expire();
        out.expired = swept.expired;
        out.uploads = swept.uploads;
      }
    } catch (error) {
      // A pass that cannot open the journal is not a reason to fail the tick
      // route; the other four passes still have work to do.
      log.warn('agent tick pass failed', { scope: 'agent-control', error });
    }
    out.ms = Date.now() - started;
    return out;
  }

  const { pgAgentJournal, reconcileStatement, expireStatement, sweepUploadsStatement, SCAN_LIMIT } = await import('./journal-pg');
  const journal = pgAgentJournal();
  await journal.ready();
  const { pgAuthorityClient } = await import('@/lib/hosted/authority/pg/client');
  const sql = pgAuthorityClient();
  const now = new Date().toISOString();

  // Each statement is `limit SCAN_LIMIT` and `returning id`, so a backlog is
  // drained a pass at a time rather than in one unbounded transaction that
  // would outlive the function.
  out.reconciled = ((await reconcileStatement(sql, { now, limit: SCAN_LIMIT })) as unknown as unknown[]).length;
  if (Date.now() < deadline)
    out.expired = ((await expireStatement(sql, { now, limit: SCAN_LIMIT })) as unknown as unknown[]).length;
  if (Date.now() < deadline)
    out.uploads = ((await sweepUploadsStatement(sql, { now, limit: SCAN_LIMIT })) as unknown as unknown[]).length;

  // Link codes live in `0006_agent_link.sql`, which a different packet owns. A
  // deployment that has applied only `0007` is a legitimate intermediate state,
  // and "that table is not there yet" is not a failed tick.
  if (Date.now() < deadline)
    try {
      const cutoff = new Date(Date.now() - LINK_RETENTION_MS).toISOString();
      const expiredCodes = (await sweepLinkCodesStatement(sql, { now, limit: SCAN_LIMIT })) as unknown as unknown[];
      const deleted = (await deleteLinkCodesStatement(sql, { cutoff, limit: SCAN_LIMIT })) as unknown as unknown[];
      out.links = expiredCodes.length + deleted.length;
    } catch (error) {
      if (!isUndefinedTable(error)) throw error;
    }

  out.ms = Date.now() - started;
  return out;
}
