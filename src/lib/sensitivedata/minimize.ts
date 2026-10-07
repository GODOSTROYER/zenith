/**
 * Persistence minimization (PROD-OPS-06): the `data-minimize` critical job.
 *
 * Three stores kept sensitive material longer than anything needs it. This pass removes it, in bounded batches, on
 * the durable critical-maintenance schedule (cron fallback shares the same lease and record):
 *
 *  1. `platform.runner_jobs.result` and `platform.machine_requests.result`: the sealed result body is a
 *     rendezvous between the agent that reported it and the activity that awaits it. Once the job settled and the
 *     retention window passed, the sealed body is removed and a `minimized` marker is left. The non-secret
 *     envelope fields (exit code, timestamps), the job row, its status, the evidence digests and the operation
 *     ledger are untouched, so audit and replay prevention are unaffected. Window:
 *     `ZENITH_RESULT_RETENTION_HOURS` (1..720, default 72).
 *  2. `agent.agent_uploads`: uploaded source archives live one hour but were only swept when another upload
 *     happened. They are now swept on every tick.
 *
 * What it does not do: it never touches `agent_effect_receipts` (immutable by trigger), plan custody tables,
 * `runner_job_logs`, evidence, events or the operation ledger; their retention belongs to PROD-OPS-07. Counts
 * only leave this module.
 */
import type { Sql } from "@/lib/controlplane/types";
import { productSql } from "@/lib/keycustody/product-db";

export const DEFAULT_RESULT_RETENTION_HOURS = 72;
export const MINIMIZE_LIMIT = 200;

export interface MinimizeOptions {
  env?: Readonly<Record<string, string | undefined>>;
  now?: Date;
  limit?: number;
  product?: () => Promise<Sql | undefined>;
}

export interface MinimizeResult {
  runnerResults: number;
  machineResults: number;
  agentUploads: number;
  retentionHours: number;
  /** a store was unavailable this tick; it is retried next tick */
  retry: number;
}

export function resultRetentionHours(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env.ZENITH_RESULT_RETENTION_HOURS?.trim();
  if (!raw) return DEFAULT_RESULT_RETENTION_HOURS;
  const hours = Number(raw);
  // An invalid value keeps the default: a typo must not silently stop minimization or erase results at once.
  return Number.isInteger(hours) && hours >= 1 && hours <= 720 ? hours : DEFAULT_RESULT_RETENTION_HOURS;
}

const TERMINAL = "('succeeded','failed','rejected','timed_out','expired','cancelled')";

async function scrubResults(db: Sql, table: "runner_jobs" | "machine_requests", hours: number, limit: number): Promise<number> {
  // System maintenance across tenants: candidates come from the database, never from caller input.
  const rows = await db.query(
    `update platform.${table} set result = (result - 'sealed') || '{"minimized":true}'::jsonb
     where id in (
       select id from platform.${table}
        where status in ${TERMINAL} and result is not null and jsonb_typeof(result) = 'object' and jsonb_exists(result, 'sealed')
          and settled_at < clock_timestamp() - make_interval(hours => $1)
        order by settled_at, id limit $2 for update skip locked)
     returning id`,
    [hours, limit]);
  return rows.length;
}

export async function minimizePass(db: Sql, options: MinimizeOptions = {}): Promise<MinimizeResult> {
  const env = options.env ?? process.env;
  const limit = Math.max(1, Math.min(1000, Math.trunc(options.limit ?? MINIMIZE_LIMIT)));
  const retentionHours = resultRetentionHours(env);
  const out: MinimizeResult = { runnerResults: 0, machineResults: 0, agentUploads: 0, retentionHours, retry: 0 };
  try {
    out.runnerResults = await scrubResults(db, "runner_jobs", retentionHours, limit);
    out.machineResults = await scrubResults(db, "machine_requests", retentionHours, limit);
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
