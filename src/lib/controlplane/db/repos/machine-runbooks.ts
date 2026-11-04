/**
 * Postgres `RunbookStore` (PROD-MACH-03). Every statement is workspace scoped
 * except `listDueSchedules`, the system tick's cross-tenant read; the tick then
 * acts only through workspace-scoped writes. Values are `$n` parameters; the only
 * text interpolated into SQL is the fixed column lists below.
 */
import { AUDIT_GENESIS, auditEntryDigest, boundedAuditDetail } from "@/lib/machines/runbooks/audit";
import { RunbookError } from "@/lib/machines/runbooks/definition";
import type {
  RunbookApprovalRecord,
  RunbookAuditRecord,
  RunbookRunRecord,
  RunbookScheduleRecord,
  RunbookStepRecord,
  RunbookStore,
  RunbookVersionRecord,
  ScheduleStatus,
} from "@/lib/machines/runbooks/ports";
import type { Sql } from "@/lib/controlplane/types";
import { json } from "../sql";

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const isoOrUndef = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : iso(v));
const parse = <T>(v: unknown): T => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T));
const isUnique = (e: unknown): boolean => typeof e === "object" && e !== null && ((e as { code?: unknown }).code === "23505" || /duplicate key|unique constraint/i.test(String((e as { message?: unknown }).message)));

type Row = Record<string, unknown>;

const versionOf = (r: Row): RunbookVersionRecord => ({
  workspaceId: r.workspace_id as string,
  runbookId: r.runbook_id as string,
  version: Number(r.version),
  name: r.name as string,
  definition: parse(r.definition),
  definitionDigest: r.definition_digest as string,
  signature: r.signature as string,
  signingKid: r.signing_kid as string,
  publishedBy: r.published_by as string,
  createdAt: iso(r.created_at),
});
const scheduleOf = (r: Row): RunbookScheduleRecord => ({
  id: r.id as string,
  workspaceId: r.workspace_id as string,
  runbookId: r.runbook_id as string,
  version: Number(r.version),
  spec: parse(r.spec),
  targets: parse(r.targets),
  bindingDigest: r.binding_digest as string,
  status: r.status as ScheduleStatus,
  nextDueAt: isoOrUndef(r.next_due_at) ?? null,
  createdBy: r.created_by as string,
  creator: parse(r.creator),
  createdAt: iso(r.created_at),
});
const runOf = (r: Row): RunbookRunRecord => ({
  id: r.id as string,
  workspaceId: r.workspace_id as string,
  runbookId: r.runbook_id as string,
  version: Number(r.version),
  definitionDigest: r.definition_digest as string,
  bindingDigest: r.binding_digest as string,
  ...(r.schedule_id ? { scheduleId: r.schedule_id as string } : {}),
  ...(r.due_at ? { dueAt: iso(r.due_at) } : {}),
  targets: parse(r.targets),
  maxParallelTargets: Number(r.max_parallel_targets),
  status: r.status as RunbookRunRecord["status"],
  ...(r.cancel_requested_at ? { cancelRequestedAt: iso(r.cancel_requested_at) } : {}),
  ...(r.cancel_reason ? { cancelReason: r.cancel_reason as string } : {}),
  requestedBy: r.requested_by as string,
  requester: parse(r.requester),
  deadlineAt: iso(r.deadline_at),
  ...(r.lease_until ? { leaseUntil: iso(r.lease_until) } : {}),
  ...(r.failure_code ? { failureCode: r.failure_code as string } : {}),
  createdAt: iso(r.created_at),
  ...(r.started_at ? { startedAt: iso(r.started_at) } : {}),
  ...(r.finished_at ? { finishedAt: iso(r.finished_at) } : {}),
});
const stepOf = (r: Row): RunbookStepRecord => ({
  workspaceId: r.workspace_id as string,
  runId: r.run_id as string,
  targetIndex: Number(r.target_index),
  stepId: r.step_id as string,
  operationId: r.operation_id as string,
  status: r.status as RunbookStepRecord["status"],
  ...(r.error_code ? { errorCode: r.error_code as string } : {}),
  ...(r.evidence_id ? { evidenceId: r.evidence_id as string } : {}),
  startedAt: iso(r.started_at),
  ...(r.finished_at ? { finishedAt: iso(r.finished_at) } : {}),
});
const auditOf = (r: Row): RunbookAuditRecord => ({
  workspaceId: r.workspace_id as string,
  subject: r.subject as string,
  seq: Number(r.seq),
  event: r.event as string,
  actor: r.actor as string,
  detail: parse(r.detail),
  prevDigest: r.prev_digest as string,
  entryDigest: r.entry_digest as string,
  createdAt: iso(r.created_at),
});

const RUN_COLS = "id, workspace_id, runbook_id, version, definition_digest, binding_digest, schedule_id, due_at, targets, max_parallel_targets, status, cancel_requested_at, cancel_reason, requested_by, requester, deadline_at, lease_until, failure_code, created_at, started_at, finished_at";
const SCHED_COLS = "id, workspace_id, runbook_id, version, spec, targets, binding_digest, status, next_due_at, created_by, creator, created_at";

export function createPlatformRunbookStore(db: Sql): RunbookStore {
  return {
    async insertVersion(rec) {
      try {
        await db.query(
          "insert into platform.machine_runbook_versions(workspace_id, runbook_id, version, name, definition, definition_digest, signature, signing_kid, published_by, created_at) values ($1,$2,$3,$4,$5::text::jsonb,$6,$7,$8,$9,$10)",
          [rec.workspaceId, rec.runbookId, rec.version, rec.name, json(rec.definition), rec.definitionDigest, rec.signature, rec.signingKid, rec.publishedBy, rec.createdAt]
        );
      } catch (e) {
        if (isUnique(e)) throw new RunbookError("conflict", "That runbook version already exists; versions are immutable.");
        throw e;
      }
    },
    async getVersion(ws, runbookId, version) {
      const rows = await db.query<Row>("select * from platform.machine_runbook_versions where workspace_id=$1 and runbook_id=$2 and version=$3", [ws, runbookId, version]);
      return rows[0] ? versionOf(rows[0]) : null;
    },
    async latestVersion(ws, runbookId) {
      const rows = await db.query<Row>("select * from platform.machine_runbook_versions where workspace_id=$1 and runbook_id=$2 order by version desc limit 1", [ws, runbookId]);
      return rows[0] ? versionOf(rows[0]) : null;
    },

    async listRunbooks(ws, limit) {
      const rows = await db.query<Row>(
        "select distinct on (runbook_id) * from platform.machine_runbook_versions where workspace_id=$1 order by runbook_id, version desc",
        [ws]
      );
      return rows.map(versionOf).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, Math.max(1, Math.min(200, Math.trunc(limit))));
    },
    async listRuns(ws, limit, status) {
      const rows = await db.query<Row>(`select ${RUN_COLS} from platform.machine_runbook_runs where workspace_id=$1 and ($2::text is null or status=$2) order by created_at desc limit $3`, [ws, status ?? null, Math.max(1, Math.min(200, Math.trunc(limit)))]);
      return rows.map(runOf);
    },
    async listSchedules(ws, limit) {
      const rows = await db.query<Row>(`select ${SCHED_COLS} from platform.machine_runbook_schedules where workspace_id=$1 order by created_at desc limit $2`, [ws, Math.max(1, Math.min(200, Math.trunc(limit)))]);
      return rows.map(scheduleOf);
    },
    async listClaimableRuns(now, limit) {
      const rows = await db.query<Row>(
        `select ${RUN_COLS} from platform.machine_runbook_runs where status='approved' or (status='running' and lease_until <= $1::timestamptz) order by created_at asc limit $2`,
        [now.toISOString(), Math.max(1, Math.min(100, Math.trunc(limit)))]
      );
      return rows.map(runOf);
    },

    async insertApproval(rec: RunbookApprovalRecord) {
      await db.query(
        "insert into platform.machine_runbook_approvals(id, workspace_id, binding_digest, requested_by, approver_id, expires_at, created_at) values ($1,$2,$3,$4,$5,$6,$7)",
        [rec.id, rec.workspaceId, rec.bindingDigest, rec.requestedBy, rec.approverId, rec.expiresAt, rec.createdAt]
      );
    },
    async findValidApproval(ws, bindingDigest, now) {
      const rows = await db.query<Row>(
        "select * from platform.machine_runbook_approvals where workspace_id=$1 and binding_digest=$2 and expires_at > $3 order by created_at desc limit 1",
        [ws, bindingDigest, now.toISOString()]
      );
      const r = rows[0];
      return r ? { id: r.id as string, workspaceId: r.workspace_id as string, bindingDigest: r.binding_digest as string, requestedBy: r.requested_by as string, approverId: r.approver_id as string, expiresAt: iso(r.expires_at), createdAt: iso(r.created_at) } : null;
    },

    async insertSchedule(rec) {
      await db.query(
        "insert into platform.machine_runbook_schedules(id, workspace_id, runbook_id, version, spec, targets, binding_digest, status, next_due_at, created_by, creator, created_at) values ($1,$2,$3,$4,$5::text::jsonb,$6::text::jsonb,$7,$8,$9,$10,$11::text::jsonb,$12)",
        [rec.id, rec.workspaceId, rec.runbookId, rec.version, json(rec.spec), json(rec.targets), rec.bindingDigest, rec.status, rec.nextDueAt, rec.createdBy, json(rec.creator), rec.createdAt]
      );
    },
    async getSchedule(ws, id) {
      const rows = await db.query<Row>(`select ${SCHED_COLS} from platform.machine_runbook_schedules where workspace_id=$1 and id=$2`, [ws, id]);
      return rows[0] ? scheduleOf(rows[0]) : null;
    },
    async setScheduleStatus(ws, id, from, to) {
      const rows = await db.query("update platform.machine_runbook_schedules set status=$4 where workspace_id=$1 and id=$2 and status = any($3::text[]) returning id", [ws, id, `{${from.join(",")}}`, to]);
      return rows.length === 1;
    },
    async activateSchedule(ws, id, from, nextDueAt) {
      const rows = await db.query(
        "update platform.machine_runbook_schedules set status = case when $4::timestamptz is null then 'completed' else 'active' end, next_due_at=$4::timestamptz where workspace_id=$1 and id=$2 and status = any($3::text[]) returning id",
        [ws, id, `{${from.join(",")}}`, nextDueAt]
      );
      return rows.length === 1;
    },
    async listDueSchedules(now, limit) {
      const rows = await db.query<Row>(`select ${SCHED_COLS} from platform.machine_runbook_schedules where status='active' and next_due_at <= $1 order by next_due_at asc limit $2`, [now.toISOString(), Math.max(1, Math.min(100, Math.trunc(limit)))]);
      return rows.map(scheduleOf);
    },
    async advanceSchedule(ws, id, expectedDueAt, nextDueAt) {
      const rows = await db.query(
        "update platform.machine_runbook_schedules set next_due_at=$4::timestamptz, status = case when $4::timestamptz is null then 'completed' else status end where workspace_id=$1 and id=$2 and status='active' and next_due_at=$3::timestamptz returning id",
        [ws, id, expectedDueAt, nextDueAt]
      );
      return rows.length === 1;
    },

    async insertRun(rec) {
      const rows = await db.query<Row>(
        `insert into platform.machine_runbook_runs(id, workspace_id, runbook_id, version, definition_digest, binding_digest, schedule_id, due_at, targets, max_parallel_targets, status, requested_by, requester, deadline_at, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::text::jsonb,$10,$11,$12,$13::text::jsonb,$14,$15)
         on conflict (schedule_id, due_at) where schedule_id is not null do nothing returning id`,
        [rec.id, rec.workspaceId, rec.runbookId, rec.version, rec.definitionDigest, rec.bindingDigest, rec.scheduleId ?? null, rec.dueAt ?? null, json(rec.targets), rec.maxParallelTargets, rec.status, rec.requestedBy, json(rec.requester), rec.deadlineAt, rec.createdAt]
      );
      if (rows.length === 1) return { run: rec, created: true };
      const existing = await db.query<Row>(`select ${RUN_COLS} from platform.machine_runbook_runs where workspace_id=$1 and schedule_id=$2 and due_at=$3::timestamptz`, [rec.workspaceId, rec.scheduleId, rec.dueAt]);
      if (!existing[0]) throw new RunbookError("conflict", "The run could not be recorded.");
      return { run: runOf(existing[0]), created: false };
    },
    async getRun(ws, id) {
      const rows = await db.query<Row>(`select ${RUN_COLS} from platform.machine_runbook_runs where workspace_id=$1 and id=$2`, [ws, id]);
      return rows[0] ? runOf(rows[0]) : null;
    },
    async approveRun(ws, id) {
      const rows = await db.query("update platform.machine_runbook_runs set status='approved' where workspace_id=$1 and id=$2 and status='pending_approval' returning id", [ws, id]);
      return rows.length === 1;
    },
    async requestCancel(ws, id, reason, now) {
      const rows = await db.query<Row>(
        `update platform.machine_runbook_runs set
           cancel_requested_at = coalesce(cancel_requested_at, $4::timestamptz),
           cancel_reason = coalesce(cancel_reason, $3),
           status = case when status in ('pending_approval','approved') then 'cancelled' else status end,
           finished_at = case when status in ('pending_approval','approved') then $4::timestamptz else finished_at end
         where workspace_id=$1 and id=$2 and status in ('pending_approval','approved','running') returning ${RUN_COLS}`,
        [ws, id, reason, now.toISOString()]
      );
      return rows[0] ? runOf(rows[0]) : null;
    },
    async claimRun(ws, id, now, leaseMs) {
      const rows = await db.query<Row>(
        `update platform.machine_runbook_runs set status='running', started_at = coalesce(started_at, $3::timestamptz), lease_until = $3::timestamptz + ($4::bigint * interval '1 millisecond')
         where workspace_id=$1 and id=$2 and (status='approved' or (status='running' and lease_until <= $3::timestamptz)) returning ${RUN_COLS}`,
        [ws, id, now.toISOString(), Math.trunc(leaseMs)]
      );
      return rows[0] ? runOf(rows[0]) : undefined;
    },
    async touchLease(ws, id, now, leaseMs) {
      const rows = await db.query("update platform.machine_runbook_runs set lease_until = $3::timestamptz + ($4::bigint * interval '1 millisecond') where workspace_id=$1 and id=$2 and status='running' returning id", [ws, id, now.toISOString(), Math.trunc(leaseMs)]);
      return rows.length === 1;
    },
    async finishRun(ws, id, status, failureCode, now) {
      const rows = await db.query(
        "update platform.machine_runbook_runs set status=$3, failure_code=$4, finished_at=$5::timestamptz, lease_until=null where workspace_id=$1 and id=$2 and status='running' returning id",
        [ws, id, status, failureCode ?? null, now.toISOString()]
      );
      return rows.length === 1;
    },

    async beginStep(rec) {
      const rows = await db.query(
        `insert into platform.machine_runbook_run_steps(workspace_id, run_id, target_index, step_id, operation_id, status, error_code, started_at, finished_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (workspace_id, run_id, target_index, step_id) do nothing returning step_id`,
        [rec.workspaceId, rec.runId, rec.targetIndex, rec.stepId, rec.operationId, rec.status, rec.errorCode ?? null, rec.startedAt, rec.finishedAt ?? null]
      );
      if (rows.length === 1) return { step: rec, inserted: true };
      const existing = await db.query<Row>("select * from platform.machine_runbook_run_steps where workspace_id=$1 and run_id=$2 and target_index=$3 and step_id=$4", [rec.workspaceId, rec.runId, rec.targetIndex, rec.stepId]);
      if (!existing[0]) throw new RunbookError("conflict", "The step could not be recorded.");
      return { step: stepOf(existing[0]), inserted: false };
    },
    async finishStep(ws, runId, targetIndex, stepId, patch) {
      await db.query(
        "update platform.machine_runbook_run_steps set status=$5, error_code=$6, evidence_id=$7, finished_at=$8 where workspace_id=$1 and run_id=$2 and target_index=$3 and step_id=$4 and status='started'",
        [ws, runId, targetIndex, stepId, patch.status, patch.errorCode ?? null, patch.evidenceId ?? null, patch.finishedAt]
      );
    },
    async listSteps(ws, runId) {
      const rows = await db.query<Row>("select * from platform.machine_runbook_run_steps where workspace_id=$1 and run_id=$2 order by target_index, started_at, step_id", [ws, runId]);
      return rows.map(stepOf);
    },

    async appendAudit(ws, subject, event, actor, detail, now) {
      const safe = boundedAuditDetail(detail);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          return await db.tx(async (tx) => {
            // Serialize this immutable chain before choosing its next sequence.
            // Transaction scope survives pooler hops; a JSON tuple avoids delimiter collisions.
            await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`zenith:machine-runbook-audit:${JSON.stringify([ws, subject])}`]);
            const last = await tx.query<Row>("select seq, entry_digest from platform.machine_runbook_audit where workspace_id=$1 and subject=$2 order by seq desc limit 1", [ws, subject]);
            const seq = last[0] ? Number(last[0].seq) + 1 : 1;
            const prevDigest = last[0] ? (last[0].entry_digest as string) : AUDIT_GENESIS;
            const base = { workspaceId: ws, subject, seq, event, actor, detail: safe, createdAt: now.toISOString() };
            const entryDigest = auditEntryDigest(prevDigest, base);
            await tx.query(
              "insert into platform.machine_runbook_audit(workspace_id, subject, seq, event, actor, detail, prev_digest, entry_digest, created_at) values ($1,$2,$3,$4,$5,$6::text::jsonb,$7,$8,$9)",
              [ws, subject, seq, event, actor, json(safe), prevDigest, entryDigest, base.createdAt]
            );
            return { ...base, prevDigest, entryDigest };
          });
        } catch (e) {
          if (!isUnique(e) || attempt === 4) throw e; // another writer took this seq; re-read and chain after it
        }
      }
      throw new RunbookError("conflict", "The audit entry could not be appended.");
    },
    async listAudit(ws, subject) {
      const rows = await db.query<Row>("select * from platform.machine_runbook_audit where workspace_id=$1 and subject=$2 order by seq", [ws, subject]);
      return rows.map(auditOf);
    },
  };
}
