/**
 * Persistence minimization (PROD-OPS-06): the `data-minimize` critical job. DEC-RETENTION is approved (2026-10-13): sensitive
 * execution payloads are deleted within 72 hours after an operation settles. Approved does not mean running: sealed
 * results are only REPORTED (dry run) until the operator sets ZENITH_DATA_MINIMIZE_APPLY=1 AND the retention policy in force
 * carries a DEC-RETENTION approval (the built-in default does; an operator policy needs its own). The window is
 * ZENITH_RESULT_RETENTION_HOURS (1..720) when set, else the approved 72. Only the sealed result body goes, never a row that
 * receipts, the effect ledger, approvals or audit evidence depend on. A legal hold (same shapes as retention holds) stops
 * the scrub of the held job or request. The upload sweep stays on: uploads are one-hour temporary copies with no receipts.
 *
 * Two stores kept sensitive material longer than anything needs it. This pass removes it, in bounded batches, on
 * the durable critical-maintenance schedule (cron fallback shares the same lease and record):
 *
 *  1. `platform.runner_jobs.result` and `platform.machine_requests.result`: the sealed result body is a
 *     rendezvous between the agent that reported it and the activity that awaits it. Once the job settled and the
 *     retention window passed, the sealed body is removed and a `minimized` marker is left. The non-secret
 *     envelope fields (exit code, timestamps), the job row, its status, the evidence digests and the operation
 *     ledger are untouched, so audit and replay prevention are unaffected.
 *  2. `agent.agent_uploads`: uploaded source archives live one hour but were only swept when another upload
 *     happened. They are now swept on every tick.
 *
 * What it does not do: it never touches `agent_effect_receipts` (immutable by trigger), plan custody tables,
 * `runner_job_logs`, evidence, events or the operation ledger; their retention belongs to PROD-OPS-07. Counts
 * only leave this module.
 */
import type { Sql } from "@/lib/controlplane/types";
import { productSql } from "@/lib/keycustody/product-db";
import { APPROVED_PAYLOAD_RETENTION_HOURS, loadRetentionPolicy, type PolicyLoad } from "@/lib/retention/policy";
import { acquireHoldLock, parentHeldSql } from "@/lib/retention/store";

export const DEFAULT_RESULT_RETENTION_HOURS = APPROVED_PAYLOAD_RETENTION_HOURS;
export const MINIMIZE_LIMIT = 200;

export interface MinimizeOptions {
  env?: Readonly<Record<string, string | undefined>>;
  now?: Date;
  limit?: number;
  product?: () => Promise<Sql | undefined>;
  /** inject a loaded retention policy (tests); otherwise loaded from the environment */
  load?: PolicyLoad;
}

export interface MinimizeResult {
  runnerResults: number;
  machineResults: number;
  /** settled results past the window left alone because a legal hold covers them (reported on every tick) */
  held: number;
  agentUploads: number;
  retentionHours: number;
  /** true only when deletion was explicitly enabled; otherwise the counts above are candidates and nothing changed */
  applied: boolean;
  /** a store was unavailable this tick; it is retried next tick */
  retry: number;
}

export interface MinimizeGate { enabled: boolean; reason: string; hours: number }

/** ZENITH_RESULT_RETENTION_HOURS as a whole number of hours 1..720; undefined when unset, null when set but invalid. */
function configuredHours(env: Readonly<Record<string, string | undefined>>): number | null | undefined {
  const raw = env.ZENITH_RESULT_RETENTION_HOURS?.trim();
  if (!raw) return undefined;
  const hours = Number(raw);
  return Number.isInteger(hours) && hours >= 1 && hours <= 720 ? hours : null;
}

/**
 * May this process delete sealed results? Needs ALL of: ZENITH_DATA_MINIMIZE_APPLY=1, a valid retention policy carrying
 * a DEC-RETENTION approval, and a valid window (explicit hours, or the approved default).
 */
export function minimizeGate(env: Readonly<Record<string, string | undefined>> = process.env, load: PolicyLoad = loadRetentionPolicy(env)): MinimizeGate {
  const configured = configuredHours(env);
  const hours = typeof configured === "number" ? configured : DEFAULT_RESULT_RETENTION_HOURS;
  if (env.ZENITH_DATA_MINIMIZE_APPLY !== "1") return { enabled: false, hours, reason: "Dry run: ZENITH_DATA_MINIMIZE_APPLY=1 is not set, so no sealed result is removed." };
  if (configured === null) return { enabled: false, hours, reason: "Dry run: ZENITH_RESULT_RETENTION_HOURS must be a whole number of hours from 1 to 720." };
  if (!load.ok) return { enabled: false, hours, reason: "Dry run: the retention policy is invalid, so no sealed result is removed." };
  if (!load.policy.approval) return { enabled: false, hours, reason: "Dry run: the retention policy has no DEC-RETENTION approval record, so no sealed result is removed." };
  return { enabled: true, hours, reason: `Removal enabled by ${load.policy.approval.approvedBy} (DEC-RETENTION): sealed results go ${hours} hours after settlement.` };
}

export function minimizeApplyEnabled(env: Readonly<Record<string, string | undefined>> = process.env, load?: PolicyLoad): boolean {
  return minimizeGate(env, load).enabled;
}

export function resultRetentionHours(env: Readonly<Record<string, string | undefined>> = process.env): number {
  // An invalid value keeps the default for reporting: a typo must not silently stop minimization or erase results at once.
  const configured = configuredHours(env);
  return typeof configured === "number" ? configured : DEFAULT_RESULT_RETENTION_HOURS;
}

const TERMINAL = "('succeeded','failed','rejected','timed_out','expired','cancelled')";
const LOG_CLASS = { runner_jobs: "runner_job_logs", machine_requests: "machine_request_logs" } as const;

export interface ScrubCount { scrubbed: number; held: number }

/** Count what a pass would scrub and what a legal hold protects (read only, bounded by `limit`). */
export async function countScrubbable(db: Sql, table: "runner_jobs" | "machine_requests", hours: number, limit: number): Promise<ScrubCount> {
  const held = parentHeldSql(LOG_CLASS[table]);
  const rows = await db.query<{ eligible: number; held: number }>(
    `select (count(*) filter (where not h))::int as eligible, (count(*) filter (where h))::int as held from (
       select ${held} as h from platform.${table} t
        where t.status in ${TERMINAL} and t.result is not null and jsonb_typeof(t.result) = 'object' and jsonb_exists(t.result, 'sealed')
          and t.settled_at < clock_timestamp() - make_interval(hours => $1) limit $2) c`,
    [hours, limit]);
  return { scrubbed: rows[0]?.eligible ?? 0, held: rows[0]?.held ?? 0 };
}

async function scrubResults(db: Sql, table: "runner_jobs" | "machine_requests", hours: number, limit: number, apply: boolean): Promise<ScrubCount> {
  const counted = await countScrubbable(db, table, hours, limit);
  if (!apply) return counted;
  const held = parentHeldSql(LOG_CLASS[table]);
  // System maintenance across tenants: candidates come from the database, never from caller input. The holds lock is taken
  // in the same transaction as the update, so a hold is either seen or waits for the update.
  const rows = await db.tx(async (tx) => {
    await acquireHoldLock(tx);
    return tx.query(
      `update platform.${table} set result = (result - 'sealed') || '{"minimized":true}'::jsonb
       where id in (
         select t.id from platform.${table} t
          where t.status in ${TERMINAL} and t.result is not null and jsonb_typeof(t.result) = 'object' and jsonb_exists(t.result, 'sealed')
            and t.settled_at < clock_timestamp() - make_interval(hours => $1) and not ${held}
          order by t.settled_at, t.id limit $2 for update skip locked)
       returning id`,
      [hours, limit]);
  });
  return { scrubbed: rows.length, held: counted.held };
}

export async function minimizePass(db: Sql, options: MinimizeOptions = {}): Promise<MinimizeResult> {
  const env = options.env ?? process.env;
  const limit = Math.max(1, Math.min(1000, Math.trunc(options.limit ?? MINIMIZE_LIMIT)));
  const gate = minimizeGate(env, options.load);
  const retentionHours = gate.hours;
  const apply = gate.enabled;
  const out: MinimizeResult = { runnerResults: 0, machineResults: 0, held: 0, agentUploads: 0, retentionHours, applied: apply, retry: 0 };
  try {
    const runner = await scrubResults(db, "runner_jobs", retentionHours, limit, apply);
    const machine = await scrubResults(db, "machine_requests", retentionHours, limit, apply);
    out.runnerResults = runner.scrubbed;
    out.machineResults = machine.scrubbed;
    out.held = runner.held + machine.held;
  } catch { out.retry++; }
  try {
    const product = await (options.product ?? (() => productSql(db, env)))();
    if (product) {
      const exists = await product.query<{ t: string | null }>("select to_regclass('agent.agent_uploads')::text as t");
      if (exists[0]?.t) {
        const swept = await product.query(
          `delete from agent.agent_uploads where id in (select id from agent.agent_uploads where expires_at <= $1 order by expires_at limit $2) returning id`,
          [(options.now ?? new Date()).toISOString(), limit]);
        out.agentUploads = swept.length;
      }
    }
  } catch { out.retry++; }
  return out;
}
