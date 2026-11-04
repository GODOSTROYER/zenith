/**
 * Last-run / health storage for the critical periodic jobs (PROD-OBS-04).
 *
 * System maintenance state, keyed by a fixed job name; nothing tenant-owned is read or
 * written. Time is the database's clock. `beginRun` stamps the lease fence of the holder
 * that started the run and `finishRun` only applies for that same fence, so a holder
 * whose lease was taken over cannot overwrite the new holder's record.
 */
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError, requireText } from "../errors";
import { json } from "../sql";

export type JobSource = "temporal" | "fallback";
export type JobStatus = "running" | "ok" | "failed" | "skipped";

export interface ScheduledJobRow {
  job: string;
  cadenceMs: number;
  lastSource: JobSource;
  lastStatus: JobStatus;
  lastStartedAt: string;
  lastFinishedAt: string | null;
  lastSuccessAt: string | null;
  lastSuccessSource: JobSource | null;
  /** age of the last success on the database clock; null if it never succeeded */
  lastSuccessAgeMs: number | null;
  lastErrorCode: string | null;
  lastCounts: Record<string, number>;
  consecutiveFailures: number;
  runsTotal: number;
  missedTicksTotal: number;
  skippedTotal: number;
}

interface Row {
  job: string; cadence_ms: number; last_source: JobSource; last_status: JobStatus;
  last_started_at: string; last_finished_at: string | null; last_success_at: string | null;
  last_success_source: JobSource | null; success_age_ms: string | number | null; last_error_code: string | null;
  last_counts: Record<string, number> | string; consecutive_failures: number;
  runs_total: string | number; missed_ticks_total: string | number; skipped_total: string | number;
}
const COLUMNS = `job, cadence_ms, last_source, last_status, last_started_at::text as last_started_at,
  last_finished_at::text as last_finished_at, last_success_at::text as last_success_at, last_success_source,
  case when last_success_at is null then null else floor(extract(epoch from (clock_timestamp() - last_success_at)) * 1000) end as success_age_ms,
  last_error_code, last_counts, consecutive_failures, runs_total, missed_ticks_total, skipped_total`;
const num = (v: string | number): number => Number(v);
const toRow = (r: Row): ScheduledJobRow => ({
  job: r.job, cadenceMs: r.cadence_ms, lastSource: r.last_source, lastStatus: r.last_status,
  lastStartedAt: r.last_started_at, lastFinishedAt: r.last_finished_at, lastSuccessAt: r.last_success_at,
  lastSuccessSource: r.last_success_source, lastSuccessAgeMs: r.success_age_ms === null ? null : num(r.success_age_ms),
  lastErrorCode: r.last_error_code,
  lastCounts: typeof r.last_counts === "string" ? JSON.parse(r.last_counts) as Record<string, number> : r.last_counts,
  consecutiveFailures: r.consecutive_failures, runsTotal: num(r.runs_total), missedTicksTotal: num(r.missed_ticks_total), skippedTotal: num(r.skipped_total),
});

const JOB = /^[a-z][a-z0-9-]{0,63}$/;
function jobName(job: string): string {
  const name = requireText("job", job);
  if (!JOB.test(name)) throw new ControlStoreError("value_out_of_range", "job must be a lowercase identifier.");
  return name;
}

export async function getScheduledJob(sql: Sql, job: string): Promise<ScheduledJobRow | null> {
  const rows = await sql.query<Row>(`select ${COLUMNS} from platform.scheduled_job_runs where job = $1`, [jobName(job)]);
  return rows.length ? toRow(rows[0]) : null;
}

export async function listScheduledJobs(sql: Sql): Promise<ScheduledJobRow[]> {
  return (await sql.query<Row>(`select ${COLUMNS} from platform.scheduled_job_runs order by job`)).map(toRow);
}

export interface BeginRunInput { job: string; source: JobSource; cadenceMs: number; fenceToken: number }

/**
 * Record that a run started under `fenceToken`. Returns how many whole cadence ticks
 * elapsed since the previous finish beyond the one expected (the catch-up gap), computed
 * on the database clock; the run itself is the single catch-up pass, never a replay.
 */
export async function beginRun(sql: Sql, input: BeginRunInput): Promise<{ missedTicks: number }> {
  const job = jobName(input.job);
  if (!Number.isInteger(input.cadenceMs) || input.cadenceMs < 1000) throw new ControlStoreError("value_out_of_range", "cadenceMs must be an integer of at least 1000.");
  if (!Number.isInteger(input.fenceToken) || input.fenceToken < 1) throw new ControlStoreError("value_out_of_range", "fenceToken must be a positive integer.");
  return sql.tx(async (tx) => {
    const prior = await tx.query<{ gap_ms: string | number | null }>(
      `select floor(extract(epoch from (clock_timestamp() - coalesce(last_finished_at, last_started_at))) * 1000) as gap_ms
         from platform.scheduled_job_runs where job = $1 for update`, [job]);
    const gap = prior.length && prior[0].gap_ms !== null ? num(prior[0].gap_ms) : 0;
    const missedTicks = prior.length ? Math.max(0, Math.floor(gap / input.cadenceMs) - 1) : 0;
    await tx.query(
      `insert into platform.scheduled_job_runs(job, cadence_ms, last_source, last_status, last_started_at, last_fence, runs_total, missed_ticks_total, updated_at)
       values ($1, $2, $3, 'running', clock_timestamp(), $4, 1, $5, clock_timestamp())
       on conflict (job) do update set cadence_ms = excluded.cadence_ms, last_source = excluded.last_source, last_status = 'running',
         last_started_at = clock_timestamp(), last_fence = excluded.last_fence, runs_total = platform.scheduled_job_runs.runs_total + 1,
         missed_ticks_total = platform.scheduled_job_runs.missed_ticks_total + excluded.missed_ticks_total, updated_at = clock_timestamp()`,
      [job, input.cadenceMs, input.source, input.fenceToken, missedTicks]);
    return { missedTicks };
  });
}

export interface FinishRunInput {
  job: string; fenceToken: number;
  /** skipped: the run found another holder of its own inner lock; success and failure state are untouched */
  outcome: "ok" | "failed" | "skipped";
  /** fixed lowercase code; never an error message */
  errorCode?: string;
  counts?: Record<string, number>;
}

/** Fenced: returns false (and writes nothing) if another holder has begun a later run. */
export async function finishRun(sql: Sql, input: FinishRunInput): Promise<boolean> {
  const job = jobName(input.job);
  const code = input.outcome !== "failed" ? null : (input.errorCode && /^[a-z_]{1,64}$/.test(input.errorCode) ? input.errorCode : "job_failed");
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(input.counts ?? {})) if (/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(k) && Number.isSafeInteger(v)) counts[k] = v;
  const rows = await sql.query<{ job: string }>(
    `update platform.scheduled_job_runs set
       last_status = $3::text, last_finished_at = clock_timestamp(), last_error_code = $4, last_counts = $5::text::jsonb,
       last_success_at = case when $3::text = 'ok' then clock_timestamp() else last_success_at end,
       last_success_source = case when $3::text = 'ok' then last_source else last_success_source end,
       consecutive_failures = case when $3::text = 'ok' then 0 when $3::text = 'failed' then consecutive_failures + 1 else consecutive_failures end,
       updated_at = clock_timestamp()
     where job = $1 and last_fence = $2 and last_status = 'running' returning job`,
    [job, input.fenceToken, input.outcome, code, json(counts)]);
  return rows.length === 1;
}

/** Count a fallback trigger that deferred to a current durable run. Never moves success/failure state. */
export async function recordSkip(sql: Sql, job: string): Promise<void> {
  await sql.query(`update platform.scheduled_job_runs set skipped_total = skipped_total + 1, updated_at = clock_timestamp() where job = $1`, [jobName(job)]);
}
