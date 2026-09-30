/**
 * Runner jobs (RUNNER-PROTOCOL.md section 4): signed job envelopes queued for a
 * customer-network runner, claimed by poll, settled exactly once.
 *
 *  - **Claim** is `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT n)`:
 *    concurrent pollers of one runner never receive the same job, and never
 *    block each other. A revoked runner's jobs are never claimable.
 *  - **Settle** is a conditional UPDATE from `claimed`/`running`: the first
 *    result wins (`true`); a duplicate — same runner retrying, or a stale
 *    result after the control plane timed the job out — gets `false` and the
 *    HTTP layer answers `409 already_settled`.
 *  - **Nothing is re-dispatched.** A job whose lease lapses becomes
 *    `timed_out` and an unclaimed one past its expiry becomes `expired`;
 *    callers reconcile the owning operation to `uncertain` and never re-queue.
 *  - The `envelope` is the compact JWS the control plane signed (it embeds a
 *    capability grant, deliberately, for the runner to verify); it is stored as
 *    opaque text, never logged and never returned to a model. Results, errors
 *    and log lines are scanned for literal secret shapes (defence in depth; the
 *    runner redacts first).
 */
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError, requireText } from "../errors";
import { assertNoSecretValues } from "../secrets";
import { boundedMs, clampLimit, jsonOrNull, opt } from "../sql";

export const RUNNER_JOB_STATUSES = ["queued", "claimed", "running", "succeeded", "failed", "rejected", "timed_out", "expired", "cancelled"] as const;
export type RunnerJobStatus = (typeof RUNNER_JOB_STATUSES)[number];
/** What a runner may report. */
export type RunnerJobResultStatus = "succeeded" | "failed" | "rejected" | "timed_out";

export interface RunnerJob {
  /** the envelope's `jti` */
  id: string;
  runnerId: string;
  workspaceId: string;
  operationId: string;
  kind: string;
  capability: string;
  /** compact JWS — opaque; deliver to the runner, never log or show */
  envelope: string;
  status: RunnerJobStatus;
  leaseUntil?: string;
  result?: unknown;
  error?: string;
  createdAt: string;
  claimedAt?: string;
  startedAt?: string;
  expiresAt: string;
  settledAt?: string;
}

interface JobRow {
  id: string;
  runner_id: string;
  workspace_id: string;
  operation_id: string;
  kind: string;
  capability: string;
  envelope: string;
  status: RunnerJobStatus;
  lease_until: string | null;
  result: unknown;
  error: string | null;
  created_at: string;
  claimed_at: string | null;
  started_at: string | null;
  expires_at: string;
  settled_at: string | null;
}

const COLUMNS = "id, runner_id, workspace_id, operation_id, kind, capability, envelope, status, lease_until, result, error, created_at, claimed_at, started_at, expires_at, settled_at";
const MAX_ENVELOPE_BYTES = 256 * 1024;

const toJob = (row: JobRow): RunnerJob => ({
  id: row.id,
  runnerId: row.runner_id,
  workspaceId: row.workspace_id,
  operationId: row.operation_id,
  kind: row.kind,
  capability: row.capability,
  envelope: row.envelope,
  status: row.status,
  leaseUntil: opt(row.lease_until),
  result: opt(row.result),
  error: opt(row.error),
  createdAt: row.created_at,
  claimedAt: opt(row.claimed_at),
  startedAt: opt(row.started_at),
  expiresAt: row.expires_at,
  settledAt: opt(row.settled_at),
});

export interface EnqueueJobInput {
  /** the envelope's `jti` (job id) */
  id: string;
  workspaceId: string;
  runnerId: string;
  operationId: string;
  kind: string;
  capability: string;
  envelope: string;
  /** how long the job may wait unclaimed (the envelope's own `exp` bounds this in practice); default 5 min, max 1 h */
  ttlMs?: number;
}

/**
 * Queue a job. The runner must exist in this workspace, be active, and the
 * operation must belong to it (composite foreign keys + an `active` check).
 */
export async function enqueue(sql: Sql, input: EnqueueJobInput): Promise<RunnerJob> {
  if (input.envelope.length === 0 || input.envelope.length > MAX_ENVELOPE_BYTES)
    throw new ControlStoreError("invalid_input", "envelope must be a non-empty compact JWS of at most 256 KiB.", { field: "envelope" });
  const ttl = boundedMs("ttlMs", input.ttlMs ?? 5 * 60 * 1000, 1000, 60 * 60 * 1000);
  const rows = await sql.query<JobRow>(
    `insert into platform.runner_jobs (id, runner_id, workspace_id, operation_id, kind, capability, envelope, expires_at)
     select $1, r.id, r.workspace_id, $4, $5, $6, $7, clock_timestamp() + ($8::bigint * interval '1 millisecond')
       from platform.runners r
      where r.workspace_id = $2 and r.id = $3 and r.status = 'active'
        and exists (select 1 from platform.operations o where o.workspace_id = $2 and o.id = $4)
     returning ${COLUMNS}`,
    [
      requireText("id", input.id, 128),
      requireText("workspaceId", input.workspaceId),
      requireText("runnerId", input.runnerId),
      requireText("operationId", input.operationId),
      requireText("kind", input.kind, 64),
      requireText("capability", input.capability, 128),
      input.envelope,
      ttl,
    ]
  );
  if (rows.length === 0) throw new ControlStoreError("not_found", "No active runner and operation with those ids in this workspace.", { runnerId: input.runnerId, operationId: input.operationId });
  return toJob(rows[0]);
}

/**
 * Claim up to `max` queued, unexpired jobs for a runner (default 1), oldest
 * first. `leaseMs` is how long the runner has to start/finish before the reaper
 * calls the job timed out (default 60 s; extend with `markRunning`).
 */
export async function claimNext(
  sql: Sql,
  input: { workspaceId: string; runnerId: string; max?: number; leaseMs?: number }
): Promise<RunnerJob[]> {
  const lease = boundedMs("leaseMs", input.leaseMs ?? 60_000, 1000, 24 * 60 * 60 * 1000);
  const rows = await sql.query<JobRow>(
    `update platform.runner_jobs j
        set status = 'claimed', claimed_at = clock_timestamp(),
            lease_until = clock_timestamp() + ($4::bigint * interval '1 millisecond')
      where j.id in (
        select q.id from platform.runner_jobs q
         where q.workspace_id = $1 and q.runner_id = $2 and q.status = 'queued' and q.expires_at > clock_timestamp()
           and exists (select 1 from platform.runners r
                        where r.workspace_id = q.workspace_id and r.id = q.runner_id and r.status = 'active')
         order by q.created_at, q.id
         limit $3::bigint
         for update of q skip locked)
      returning ${COLUMNS.split(", ").map((c) => `j.${c}`).join(", ")}`,
    [requireText("workspaceId", input.workspaceId), requireText("runnerId", input.runnerId), clampLimit(input.max, 1, 20), lease]
  );
  return rows.map(toJob).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
}

/** The runner has started the job: extend its lease to cover the job's timeout. False when it is not claimed by this runner. */
export async function markRunning(sql: Sql, input: { workspaceId: string; runnerId: string; jobId: string; leaseMs: number }): Promise<boolean> {
  const lease = boundedMs("leaseMs", input.leaseMs, 1000, 24 * 60 * 60 * 1000);
  const rows = await sql.query<{ id: string }>(
    `update platform.runner_jobs
        set status = 'running', started_at = coalesce(started_at, clock_timestamp()),
            lease_until = clock_timestamp() + ($4::bigint * interval '1 millisecond')
      where workspace_id = $1 and runner_id = $2 and id = $3 and status in ('claimed','running') and lease_until > clock_timestamp()
      returning id`,
    [requireText("workspaceId", input.workspaceId), requireText("runnerId", input.runnerId), requireText("jobId", input.jobId), lease]
  );
  return rows.length > 0;
}

export interface SettleJobInput {
  workspaceId: string;
  runnerId: string;
  jobId: string;
  status: RunnerJobResultStatus;
  result?: unknown;
  error?: string;
}

/**
 * Record a runner's result. Returns true for the FIRST result of a job that this
 * runner holds (claimed or running); false for any duplicate, for a job that
 * already timed out, was cancelled or belongs to another runner/workspace.
 */
export async function settle(sql: Sql, input: SettleJobInput): Promise<boolean> {
  if (!["succeeded", "failed", "rejected", "timed_out"].includes(input.status))
    throw new ControlStoreError("invalid_input", "status must be succeeded, failed, rejected or timed_out.", { field: "status" });
  assertNoSecretValues(input.result, "result");
  if (input.error !== undefined) {
    if (input.error.length > 4000) throw new ControlStoreError("invalid_input", "error is too long (max 4000 characters).");
    assertNoSecretValues(input.error, "error");
  }
  const rows = await sql.query<{ id: string }>(
    `update platform.runner_jobs
        set status = $4, result = $5::text::jsonb, error = $6, settled_at = clock_timestamp(), lease_until = null
      where workspace_id = $1 and runner_id = $2 and id = $3 and status in ('claimed','running')
      returning id`,
    [requireText("workspaceId", input.workspaceId), requireText("runnerId", input.runnerId), requireText("jobId", input.jobId), input.status, jsonOrNull(input.result), input.error ?? null]
  );
  return rows.length > 0;
}

/** Cancel a job that has not finished (control-plane initiated). Returns the job, or null when it is unknown or already settled. */
export async function cancel(sql: Sql, workspaceId: string, jobId: string, reason?: string): Promise<RunnerJob | null> {
  const rows = await sql.query<JobRow>(
    `update platform.runner_jobs set status = 'cancelled', settled_at = clock_timestamp(), lease_until = null, error = coalesce($3::text, error)
      where workspace_id = $1 and id = $2 and status in ('queued','claimed','running')
      returning ${COLUMNS}`,
    [requireText("workspaceId", workspaceId), requireText("jobId", jobId), reason ?? null]
  );
  return rows.length ? toJob(rows[0]) : null;
}

export async function get(sql: Sql, workspaceId: string, jobId: string): Promise<RunnerJob | null> {
  const rows = await sql.query<JobRow>(
    `select ${COLUMNS} from platform.runner_jobs where workspace_id = $1 and id = $2`,
    [requireText("workspaceId", workspaceId), requireText("jobId", jobId)]
  );
  return rows.length ? toJob(rows[0]) : null;
}

export async function listForOperation(sql: Sql, workspaceId: string, operationId: string): Promise<RunnerJob[]> {
  const rows = await sql.query<JobRow>(
    `select ${COLUMNS} from platform.runner_jobs where workspace_id = $1 and operation_id = $2 order by created_at, id`,
    [requireText("workspaceId", workspaceId), requireText("operationId", operationId)]
  );
  return rows.map(toJob);
}

/**
 * The reaper (cross-tenant, system): unclaimed jobs past their expiry become
 * `expired`; claimed/running jobs past their lease become `timed_out`. Returns
 * the affected jobs so the caller can reconcile each owning operation to
 * `uncertain`. Nothing is re-queued.
 */
export async function expireStale(sql: Sql, limit = 100): Promise<RunnerJob[]> {
  const rows = await sql.query<JobRow>(
    `update platform.runner_jobs
        set status = case when status = 'queued' then 'expired' else 'timed_out' end,
            settled_at = clock_timestamp(), lease_until = null,
            error = coalesce(error, case when status = 'queued' then 'not claimed before expiry' else 'runner stopped reporting before its lease ended' end)
      where id in (
        select id from platform.runner_jobs
         where (status = 'queued' and expires_at <= clock_timestamp())
            or (status in ('claimed','running') and lease_until <= clock_timestamp())
         order by created_at limit $1::bigint for update skip locked)
      returning ${COLUMNS}`,
    [clampLimit(limit, 100, 1000)]
  );
  return rows.map(toJob);
}

/* ---------------------------------- logs ------------------------------------ */

export interface JobLogLine {
  ts: string;
  stream: "stdout" | "stderr" | "info";
  line: string;
}

export interface JobLogEntry extends JobLogLine {
  id: number;
  jobId: string;
  batchSeq: number;
}

const MAX_LINES_PER_BATCH = 500;
const MAX_LINES_PER_JOB = 20_000;
const MAX_LINE_CHARS = 8192;
const WITHHELD = "[line withheld: it matched a secret pattern]";

/**
 * Append one batch of log lines from the runner that holds the job. A retried
 * POST of the same `batchSeq` does not duplicate lines. Lines are truncated to
 * 8192 characters; a line that looks like a secret is replaced, not rejected,
 * so a leaky job can never make its own log stream fail. Returns how many lines
 * were stored; `null` when the job is not this runner's in this workspace.
 */
export async function appendLogs(
  sql: Sql,
  input: { workspaceId: string; runnerId: string; jobId: string; batchSeq: number; lines: readonly JobLogLine[] }
): Promise<number | null> {
  if (!Number.isInteger(input.batchSeq) || input.batchSeq < 0) throw new ControlStoreError("invalid_input", "batchSeq must be a non-negative integer.");
  if (input.lines.length > MAX_LINES_PER_BATCH) throw new ControlStoreError("invalid_input", `A log batch holds at most ${MAX_LINES_PER_BATCH} lines.`);
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const jobId = requireText("jobId", input.jobId);
  return sql.tx(async (tx) => {
    const owned = await tx.query<{ id: string }>(
      "select id from platform.runner_jobs where workspace_id = $1 and runner_id = $2 and id = $3",
      [workspaceId, requireText("runnerId", input.runnerId), jobId]
    );
    if (owned.length === 0) return null;
    const have = await tx.query<{ n: number }>("select count(*)::int as n from platform.runner_job_logs where workspace_id = $1 and job_id = $2", [workspaceId, jobId]);
    let room = MAX_LINES_PER_JOB - (have[0]?.n ?? 0);
    let stored = 0;
    for (let i = 0; i < input.lines.length && room > 0; i++) {
      const l = input.lines[i];
      if (!["stdout", "stderr", "info"].includes(l.stream)) throw new ControlStoreError("invalid_input", "stream must be stdout, stderr or info.");
      let text = String(l.line).slice(0, MAX_LINE_CHARS);
      try {
        assertNoSecretValues(text);
      } catch {
        text = WITHHELD;
      }
      const inserted = await tx.query<{ id: number }>(
        `insert into platform.runner_job_logs (job_id, workspace_id, batch_seq, line_no, ts, stream, line)
         values ($1, $2, $3::int, $4::int, $5::timestamptz, $6, $7)
         on conflict (job_id, batch_seq, line_no) do nothing returning id`,
        [jobId, workspaceId, input.batchSeq, i, l.ts, l.stream, text]
      );
      if (inserted.length) {
        stored++;
        room--;
      }
    }
    return stored;
  });
}

/** Log lines of a job in insertion order, after `afterId` (exclusive). */
export async function listLogs(
  sql: Sql,
  input: { workspaceId: string; jobId: string; afterId?: number; limit?: number }
): Promise<JobLogEntry[]> {
  const rows = await sql.query<{ id: number; job_id: string; batch_seq: number; ts: string; stream: JobLogLine["stream"]; line: string }>(
    `select id, job_id, batch_seq, ts, stream, line from platform.runner_job_logs
      where workspace_id = $1 and job_id = $2 and id > $3::bigint order by id limit $4::bigint`,
    [requireText("workspaceId", input.workspaceId), requireText("jobId", input.jobId), input.afterId ?? 0, clampLimit(input.limit, 200, 1000)]
  );
  return rows.map((r) => ({ id: r.id, jobId: r.job_id, batchSeq: r.batch_seq, ts: r.ts, stream: r.stream, line: r.line }));
}
