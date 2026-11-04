/**
 * State backend recovery records (PROD-DUR-06). Database-only; every statement is scoped by workspace_id.
 * A restore proposal binds the exact immutable effect (backend digest, state object, source version, source
 * digest, current version). Status moves only through compare-and-set transitions guarded again by a database
 * trigger. No function here deletes a row, and none touches a cloud backend.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "@/lib/controlplane/types";
import { digest } from "@/lib/controlplane/digest";
import type { BackendProbeVerdict } from "@/lib/tofu/backend-capabilities";

export class StateRecoveryRecordError extends Error {
  readonly code = "state_recovery_refused";
  constructor(readonly reason: string) { super("The state restore request is unavailable or its state changed; nothing was written."); }
}

export type RestoreStatus = "proposed" | "approved" | "rejected" | "executing" | "restored" | "failed_uncertain" | "expired";
export interface StateRestoreRecord {
  id: string; workspaceId: string; projectId: string; environmentId: string; backendDigest: string;
  stateKey: string; sourceVersionId: string; sourceSha256: string; currentVersionId: string; connectionId: string;
  proposalDigest: string; status: RestoreStatus; requestedBy: { kind: string; id: string };
  approvedBy?: string; approvedAt?: string; expiresAt: string; restoredVersionId?: string; readbackSha256?: string; failureCode?: string; createdAt: string;
}
export interface ProposeRestoreInput {
  workspaceId: string; projectId: string; environmentId: string; backendDigest: string; backend: Record<string, unknown>; stateKey: string;
  sourceVersionId: string; sourceSha256: string; currentVersionId: string; connectionId: string; requestedBy: { kind: string; id: string }; ttlMs?: number;
}
interface Row {
  id: string; workspace_id: string; project_id: string; environment_id: string; backend_digest: string; state_key: string; source_version_id: string;
  source_sha256: string; current_version_id: string; connection_id: string; proposal_digest: string; status: RestoreStatus; requested_by: { kind: string; id: string };
  approved_by: string | null; approved_at: string | null; expires_at: string; restored_version_id: string | null; readback_sha256: string | null; failure_code: string | null; created_at: string;
}
const COLUMNS = `id, workspace_id, project_id, environment_id, backend_digest, state_key, source_version_id, source_sha256, current_version_id, connection_id,
  proposal_digest, status, requested_by, approved_by, approved_at, expires_at, restored_version_id, readback_sha256, failure_code, created_at`;
const record = (r: Row): StateRestoreRecord => ({
  id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, environmentId: r.environment_id, backendDigest: r.backend_digest, stateKey: r.state_key,
  sourceVersionId: r.source_version_id, sourceSha256: r.source_sha256, currentVersionId: r.current_version_id, connectionId: r.connection_id,
  proposalDigest: r.proposal_digest, status: r.status, requestedBy: r.requested_by,
  ...(r.approved_by ? { approvedBy: r.approved_by } : {}), ...(r.approved_at ? { approvedAt: String(r.approved_at) } : {}), expiresAt: String(r.expires_at),
  ...(r.restored_version_id ? { restoredVersionId: r.restored_version_id } : {}), ...(r.readback_sha256 ? { readbackSha256: r.readback_sha256 } : {}),
  ...(r.failure_code ? { failureCode: r.failure_code } : {}), createdAt: String(r.created_at),
});

/** The digest every approval binds. No credential or credential reference is part of a proposal: sessions are brokered at execution. */
export function restoreProposalDigest(input: Omit<ProposeRestoreInput, "requestedBy" | "ttlMs">): string {
  return digest({ format: "zenith.state-restore.v1", workspaceId: input.workspaceId, projectId: input.projectId, environmentId: input.environmentId,
    backendDigest: input.backendDigest, backend: input.backend, stateKey: input.stateKey, sourceVersionId: input.sourceVersionId,
    sourceSha256: input.sourceSha256, currentVersionId: input.currentVersionId, connectionId: input.connectionId });
}

/**
 * Ownership proof. A backend is this tenant's only if a plan artifact produced for the SAME workspace and environment
 * recorded exactly this backend digest. Returns the project that owns it, or null (never a foreign tenant's data).
 */
export async function provenOwner(sql: Sql, workspaceId: string, environmentId: string, backendDigest: string): Promise<{ projectId: string } | null> {
  const rows = await sql.query<{ project_id: string }>(
    `select manifest->>'projectId' as project_id from platform.plan_artifacts
     where workspace_id=$1 and manifest->>'environmentId'=$2 and manifest->>'backendDigest'=$3 and manifest->>'workspaceId'=$1
     order by created_at desc limit 1`, [workspaceId, environmentId, backendDigest]);
  return rows[0]?.project_id ? { projectId: rows[0].project_id } : null;
}

export async function recordProbe(sql: Sql, input: { workspaceId: string; projectId: string; environmentId: string; backendDigest: string; verdict: BackendProbeVerdict }): Promise<string> {
  const id = `sbp_${randomUUID()}`;
  await sql.query(`insert into platform.state_backend_probes (id, workspace_id, project_id, environment_id, backend_digest, backend_kind, verdict)
    values ($1,$2,$3,$4,$5,$6,$7::text::jsonb)`, [id, input.workspaceId, input.projectId, input.environmentId, input.backendDigest, input.verdict.backendKind, JSON.stringify(input.verdict)]);
  return id;
}
export async function latestProbe(sql: Sql, workspaceId: string, environmentId: string, backendDigest: string): Promise<{ id: string; verdict: BackendProbeVerdict; createdAt: string } | null> {
  const rows = await sql.query<{ id: string; verdict: BackendProbeVerdict; created_at: string }>(
    `select id, verdict, created_at from platform.state_backend_probes where workspace_id=$1 and environment_id=$2 and backend_digest=$3 order by created_at desc, id desc limit 1`,
    [workspaceId, environmentId, backendDigest]);
  return rows[0] ? { id: rows[0].id, verdict: rows[0].verdict, createdAt: String(rows[0].created_at) } : null;
}

/** Idempotent for an identical live proposal: the same exact effect returns the existing record. */
export async function propose(sql: Sql, input: ProposeRestoreInput): Promise<StateRestoreRecord> {
  const proposalDigest = restoreProposalDigest(input);
  const ttl = Math.min(Math.max(input.ttlMs ?? 3600_000, 60_000), 24 * 3600_000);
  return sql.tx(async (tx) => {
    const existing = await tx.query<Row>(`select ${COLUMNS} from platform.state_backend_restores
      where workspace_id=$1 and environment_id=$2 and proposal_digest=$3 and status in ('proposed','approved','executing') and expires_at > clock_timestamp() for update`,
      [input.workspaceId, input.environmentId, proposalDigest]);
    if (existing[0]) return record(existing[0]);
    const rows = await tx.query<Row>(`insert into platform.state_backend_restores
      (id, workspace_id, project_id, environment_id, backend_digest, backend, state_key, source_version_id, source_sha256, current_version_id, connection_id, proposal_digest, requested_by, expires_at)
      values ($1,$2,$3,$4,$5,$6::text::jsonb,$7,$8,$9,$10,$11,$12,$13::text::jsonb, clock_timestamp() + ($14 || ' milliseconds')::interval) returning ${COLUMNS}`,
      [`sbr_${randomUUID()}`, input.workspaceId, input.projectId, input.environmentId, input.backendDigest, JSON.stringify(input.backend), input.stateKey,
        input.sourceVersionId, input.sourceSha256, input.currentVersionId, input.connectionId, proposalDigest, JSON.stringify(input.requestedBy), String(ttl)]);
    return record(rows[0]);
  });
}
export async function get(sql: Sql, workspaceId: string, id: string): Promise<StateRestoreRecord | null> {
  const rows = await sql.query<Row>(`select ${COLUMNS} from platform.state_backend_restores where workspace_id=$1 and id=$2`, [workspaceId, id]);
  return rows[0] ? record(rows[0]) : null;
}
/** The stored non-secret backend block, for the executor. Immutable after proposal. */
export async function backendOf(sql: Sql, workspaceId: string, id: string): Promise<Record<string, unknown> | null> {
  const rows = await sql.query<{ backend: Record<string, unknown> }>(`select backend from platform.state_backend_restores where workspace_id=$1 and id=$2`, [workspaceId, id]);
  return rows[0]?.backend ?? null;
}
export async function list(sql: Sql, workspaceId: string, environmentId: string, limit = 50): Promise<StateRestoreRecord[]> {
  const rows = await sql.query<Row>(`select ${COLUMNS} from platform.state_backend_restores where workspace_id=$1 and environment_id=$2 order by created_at desc, id desc limit $3`,
    [workspaceId, environmentId, Math.min(Math.max(1, limit), 200)]);
  return rows.map(record);
}

function transitionResult(rows: Row[], from: RestoreStatus): StateRestoreRecord {
  if (!rows[0]) throw new StateRecoveryRecordError(`not_${from}`);
  return record(rows[0]);
}
/** A person approves the exact proposal digest they reviewed. A different digest never matches. */
export async function approve(sql: Sql, input: { workspaceId: string; id: string; proposalDigest: string; approverId: string }): Promise<StateRestoreRecord> {
  // The digest is part of the compare-and-set: a stale or different proposal can never become approved.
  const rows = await sql.query<Row>(
    `update platform.state_backend_restores set status='approved', approved_by=$3, approved_at=clock_timestamp()
     where workspace_id=$1 and id=$2 and status='proposed' and proposal_digest=$4 and expires_at > clock_timestamp() returning ${COLUMNS}`,
    [input.workspaceId, input.id, input.approverId, input.proposalDigest]);
  if (!rows[0]) throw new StateRecoveryRecordError("not_approvable");
  return record(rows[0]);
}
export async function reject(sql: Sql, input: { workspaceId: string; id: string; approverId: string }): Promise<StateRestoreRecord> {
  return transitionResult(await sql.query<Row>(
    `update platform.state_backend_restores set status='rejected', approved_by=$3, approved_at=clock_timestamp()
     where workspace_id=$1 and id=$2 and status='proposed' returning ${COLUMNS}`,
    [input.workspaceId, input.id, input.approverId]), "proposed");
}
/** Exactly one executor wins this transition; a lost response never re-enters it. */
export async function beginExecution(sql: Sql, workspaceId: string, id: string): Promise<StateRestoreRecord> {
  return transitionResult(await sql.query<Row>(
    `update platform.state_backend_restores set status='executing'
     where workspace_id=$1 and id=$2 and status='approved' and expires_at > clock_timestamp() returning ${COLUMNS}`,
    [workspaceId, id]), "approved");
}
export async function complete(sql: Sql, workspaceId: string, id: string, input: { restoredVersionId: string; readbackSha256: string }): Promise<StateRestoreRecord> {
  return transitionResult(await sql.query<Row>(
    `update platform.state_backend_restores set status='restored', restored_version_id=$3, readback_sha256=$4
     where workspace_id=$1 and id=$2 and status='executing' returning ${COLUMNS}`,
    [workspaceId, id, input.restoredVersionId, input.readbackSha256]), "executing");
}
export async function failUncertain(sql: Sql, workspaceId: string, id: string, failureCode: string): Promise<StateRestoreRecord> {
  return transitionResult(await sql.query<Row>(
    `update platform.state_backend_restores set status='failed_uncertain', failure_code=$3
     where workspace_id=$1 and id=$2 and status='executing' returning ${COLUMNS}`,
    [workspaceId, id, /^[a-z_]{1,48}$/.test(failureCode) ? failureCode : "unknown"]), "executing");
}
/** Mark unreviewed or unexecuted proposals past their deadline. Returns how many changed. Rows are never deleted. */
export async function expireStale(sql: Sql, workspaceId: string): Promise<number> {
  const rows = await sql.query<{ id: string }>(
    `update platform.state_backend_restores set status='expired' where workspace_id=$1 and status in ('proposed','approved') and expires_at <= clock_timestamp() returning id`, [workspaceId]);
  return rows.length;
}
