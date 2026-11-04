/**
 * The zenithd request queue over the platform store (`platform.machine_requests`,
 * migration in `machine-requests-migration.ts`). A line-for-line mirror of
 * `controlplane/db/repos/jobs.ts` with `machine_id`/`operation` in place of
 * `runner_id`/`kind`, so the two queues cannot drift in meaning:
 *
 *  - claim is `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT n)`;
 *  - settle is a conditional UPDATE from `claimed`/`running` (first writer wins);
 *  - nothing is re-queued; the reaper only moves lapsed work to `timed_out`/`expired`;
 *  - every statement filters on `workspace_id` in SQL; results and log lines are
 *    scanned for literal secret shapes before they are stored (defence in depth —
 *    the service seals and redacts first).
 *
 * All SQL text is constant: table and column names are written out, never built
 * from data; every value is a `$n` parameter.
 */
import { requireText } from "@/lib/controlplane/db/errors";
import { assertNoSecretValues } from "@/lib/controlplane/db/secrets";
import { jsonOrNull } from "@/lib/controlplane/db/sql";
import type { Sql } from "@/lib/controlplane/types";
import { get as getEffectReceipt, recordMachineOutcome } from "@/lib/controlplane/db/repos/agent-effect-receipts";
import {
  RunnerStoreError,
  type AgentJob,
  type AgentJobResultStatus,
  type AgentJobStatus,
  type EnqueueJobInput,
  type JobLogEntry,
  type JobLogLine,
  type JobQueue,
} from "@/lib/runners/ports";
import { MAX_ENVELOPE_BYTES, MAX_LOG_LINES_PER_JOB, MAX_LOG_LINE_CHARS, STORE_LOG_BATCH_LINES } from "@/lib/runners/types";

interface Row {
  id: string;
  machine_id: string;
  workspace_id: string;
  operation_id: string;
  operation: string;
  capability: string;
  envelope: string;
  status: AgentJobStatus;
  lease_until: string | null;
  result: unknown;
  error: string | null;
  created_at: string;
  claimed_at: string | null;
  started_at: string | null;
  expires_at: string;
  settled_at: string | null;
}

const COLUMNS = "id, machine_id, workspace_id, operation_id, operation, capability, envelope, status, lease_until, result, error, created_at, claimed_at, started_at, expires_at, settled_at";
const PREFIXED = COLUMNS.split(", ").map((c) => `j.${c}`).join(", ");
const WITHHELD = "[line withheld: it matched a secret pattern]";

const opt = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v);

const toJob = (r: Row): AgentJob => ({
  id: r.id,
  agentId: r.machine_id,
  workspaceId: r.workspace_id,
  operationId: r.operation_id,
  kind: r.operation,
  capability: r.capability,
  envelope: r.envelope,
  status: r.status,
  leaseUntil: opt(r.lease_until),
  result: opt(r.result),
  error: opt(r.error),
  createdAt: r.created_at,
  claimedAt: opt(r.claimed_at),
  startedAt: opt(r.started_at),
  expiresAt: r.expires_at,
  settledAt: opt(r.settled_at),
});

function ms(name: string, value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new RunnerStoreError("invalid_input", `${name} must be between ${min} and ${max} milliseconds.`);
  return Math.trunc(value);
}

const limit = (n: number | undefined, fallback: number, max: number): number => (n === undefined || !Number.isFinite(n) ? fallback : Math.max(1, Math.min(max, Math.trunc(n))));

export function createMachineRequestQueue(sql: Sql): JobQueue {
  return {
    settleOutcome: input => recordMachineOutcome(sql, input),
    getEffectReceipt: (workspaceId, jobId) => getEffectReceipt(sql, { workspaceId, jobId, agentKind: "machine" }),
    async enqueue(input: EnqueueJobInput) {
      if (input.envelope.length === 0 || input.envelope.length > MAX_ENVELOPE_BYTES) throw new RunnerStoreError("invalid_input", "envelope must be a non-empty compact JWS of at most 256 KiB.");
      const ttl = ms("ttlMs", input.ttlMs ?? 5 * 60 * 1000, 1000, 60 * 60 * 1000);
      const rows = await sql.query<Row>(
        `insert into platform.machine_requests (id, machine_id, workspace_id, operation_id, operation, capability, envelope, expires_at)
         select $1, m.id, m.workspace_id, $4, $5, $6, $7, clock_timestamp() + ($8::bigint * interval '1 millisecond')
           from platform.machines m
          where m.workspace_id = $2 and m.id = $3 and m.transport = 'zenithd' and m.status = 'active'
            and exists (select 1 from platform.operations o where o.workspace_id = $2 and o.id = $4)
         returning ${COLUMNS}`,
        [requireText("id", input.id, 128), requireText("workspaceId", input.workspaceId), requireText("agentId", input.agentId), requireText("operationId", input.operationId), requireText("kind", input.kind, 64), requireText("capability", input.capability, 128), input.envelope, ttl]
      );
      if (rows.length === 0) throw new RunnerStoreError("not_found", "No active zenithd machine and operation with those ids in this workspace.");
      return toJob(rows[0]);
    },

    async claimNext(input) {
      const lease = ms("leaseMs", input.leaseMs ?? 60_000, 1000, 24 * 60 * 60 * 1000);
      const rows = await sql.query<Row>(
        `update platform.machine_requests j
            set status = 'claimed', claimed_at = clock_timestamp(),
                lease_until = clock_timestamp() + ($4::bigint * interval '1 millisecond')
          where j.id in (
            select q.id from platform.machine_requests q
             where q.workspace_id = $1 and q.machine_id = $2 and q.status = 'queued' and q.expires_at > clock_timestamp()
               and exists (select 1 from platform.machines m
                            where m.workspace_id = q.workspace_id and m.id = q.machine_id and m.status = 'active')
             order by q.created_at, q.id
             limit $3::bigint
             for update of q skip locked)
          returning ${PREFIXED}`,
        [requireText("workspaceId", input.workspaceId), requireText("agentId", input.agentId), limit(input.max, 1, 20), lease]
      );
      return rows.map(toJob).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
    },

    async markRunning(input) {
      const lease = ms("leaseMs", input.leaseMs, 1000, 24 * 60 * 60 * 1000);
      const rows = await sql.query<{ id: string }>(
        `update platform.machine_requests
            set status = 'running', started_at = coalesce(started_at, clock_timestamp()),
                lease_until = clock_timestamp() + ($4::bigint * interval '1 millisecond')
          where workspace_id = $1 and machine_id = $2 and id = $3 and status in ('claimed','running') and lease_until > clock_timestamp()
          returning id`,
        [requireText("workspaceId", input.workspaceId), requireText("agentId", input.agentId), requireText("jobId", input.jobId), lease]
      );
      return rows.length > 0;
    },

    async settle(input: { workspaceId: string; agentId: string; jobId: string; status: AgentJobResultStatus; result?: unknown; error?: string }) {
      if (!["succeeded", "failed", "rejected", "timed_out"].includes(input.status)) throw new RunnerStoreError("invalid_input", "status must be succeeded, failed, rejected or timed_out.");
      if (input.error !== undefined && input.error.length > 4000) throw new RunnerStoreError("invalid_input", "error is too long (max 4000 characters).");
      try {
        assertNoSecretValues(input.result, "result");
        if (input.error !== undefined) assertNoSecretValues(input.error, "error");
      } catch {
        // a report that looks like a secret must still settle the request; the error text is the only free-form part
        input = { ...input, error: input.error === undefined ? undefined : "[error withheld: it matched a secret pattern]" };
      }
      const rows = await sql.query<{ id: string }>(
        `update platform.machine_requests
            set status = $4, result = $5::text::jsonb, error = $6, settled_at = clock_timestamp(), lease_until = null
          where workspace_id = $1 and machine_id = $2 and id = $3 and status in ('claimed','running')
          returning id`,
        [requireText("workspaceId", input.workspaceId), requireText("agentId", input.agentId), requireText("jobId", input.jobId), input.status, jsonOrNull(input.result), input.error ?? null]
      );
      return rows.length > 0;
    },

    async cancel(workspaceId, jobId, reason) {
      const rows = await sql.query<Row>(
        `update platform.machine_requests set status = 'cancelled', settled_at = clock_timestamp(), lease_until = null, error = coalesce($3::text, error)
          where workspace_id = $1 and id = $2 and status in ('queued','claimed','running')
          returning ${COLUMNS}`,
        [requireText("workspaceId", workspaceId), requireText("jobId", jobId), reason ?? null]
      );
      return rows.length ? toJob(rows[0]) : null;
    },

    async get(workspaceId, jobId) {
      const rows = await sql.query<Row>(`select ${COLUMNS} from platform.machine_requests where workspace_id = $1 and id = $2`, [requireText("workspaceId", workspaceId), requireText("jobId", jobId)]);
      return rows.length ? toJob(rows[0]) : null;
    },

    async listForOperation(workspaceId, operationId) {
      const rows = await sql.query<Row>(`select ${COLUMNS} from platform.machine_requests where workspace_id = $1 and operation_id = $2 order by created_at, id`, [requireText("workspaceId", workspaceId), requireText("operationId", operationId)]);
      return rows.map(toJob);
    },

    async expireStale(max = 100) {
      const rows = await sql.query<Row>(
        `update platform.machine_requests
            set status = case when status = 'queued' then 'expired' else 'timed_out' end,
                settled_at = clock_timestamp(), lease_until = null,
                error = coalesce(error, case when status = 'queued' then 'not claimed before expiry' else 'machine stopped reporting before its lease ended' end)
          where id in (
            select id from platform.machine_requests
             where (status = 'queued' and expires_at <= clock_timestamp())
                or (status in ('claimed','running') and lease_until <= clock_timestamp())
             order by created_at limit $1::bigint for update skip locked)
          returning ${COLUMNS}`,
        [limit(max, 100, 1000)]
      );
      return rows.map(toJob);
    },

    async appendLogs(input: { workspaceId: string; agentId: string; jobId: string; batchSeq: number; lines: readonly JobLogLine[] }) {
      if (!Number.isInteger(input.batchSeq) || input.batchSeq < 0) throw new RunnerStoreError("invalid_input", "batchSeq must be a non-negative integer.");
      if (input.lines.length > STORE_LOG_BATCH_LINES) throw new RunnerStoreError("invalid_input", `A log batch holds at most ${STORE_LOG_BATCH_LINES} lines.`);
      const workspaceId = requireText("workspaceId", input.workspaceId);
      const jobId = requireText("jobId", input.jobId);
      return sql.tx(async (tx) => {
        const owned = await tx.query<{ id: string }>("select id from platform.machine_requests where workspace_id = $1 and machine_id = $2 and id = $3", [workspaceId, requireText("agentId", input.agentId), jobId]);
        if (owned.length === 0) return null;
        const have = await tx.query<{ n: number }>("select count(*)::int as n from platform.machine_request_logs where workspace_id = $1 and request_id = $2", [workspaceId, jobId]);
        let room = MAX_LOG_LINES_PER_JOB - (have[0]?.n ?? 0);
        let stored = 0;
        for (let i = 0; i < input.lines.length && room > 0; i++) {
          const l = input.lines[i];
          if (!["stdout", "stderr", "info"].includes(l.stream)) throw new RunnerStoreError("invalid_input", "stream must be stdout, stderr or info.");
          let text = String(l.line).slice(0, MAX_LOG_LINE_CHARS);
          try {
            assertNoSecretValues(text);
          } catch {
            text = WITHHELD;
          }
          const inserted = await tx.query<{ id: number }>(
            `insert into platform.machine_request_logs (request_id, workspace_id, batch_seq, line_no, ts, stream, line)
             values ($1, $2, $3::int, $4::int, $5::timestamptz, $6, $7)
             on conflict (request_id, batch_seq, line_no) do nothing returning id`,
            [jobId, workspaceId, input.batchSeq, i, l.ts, l.stream, text]
          );
          if (inserted.length) {
            stored++;
            room--;
          }
        }
        return stored;
      });
    },

    async logUsage(workspaceId, jobId) {
      const rows = await sql.query<{ lines: number; bytes: number }>(
        "select count(*)::int as lines, coalesce(sum(octet_length(line)), 0)::bigint as bytes from platform.machine_request_logs where workspace_id = $1 and request_id = $2",
        [requireText("workspaceId", workspaceId), requireText("jobId", jobId)]
      );
      return { lines: rows[0]?.lines ?? 0, bytes: Number(rows[0]?.bytes ?? 0) };
    },

    async listLogs(input) {
      const rows = await sql.query<{ id: number; request_id: string; batch_seq: number; ts: string; stream: JobLogLine["stream"]; line: string }>(
        `select id, request_id, batch_seq, ts, stream, line from platform.machine_request_logs
          where workspace_id = $1 and request_id = $2 and id > $3::bigint order by id limit $4::bigint`,
        [requireText("workspaceId", input.workspaceId), requireText("jobId", input.jobId), input.afterId ?? 0, limit(input.limit, 200, 1000)]
      );
      return rows.map((r): JobLogEntry => ({ id: r.id, jobId: r.request_id, batchSeq: r.batch_seq, ts: r.ts, stream: r.stream, line: r.line }));
    },
  };
}
