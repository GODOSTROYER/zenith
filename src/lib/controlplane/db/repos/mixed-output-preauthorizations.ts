/**
 * Precise output preauthorizations (PROD-MIX-03). Every function names the workspace and filters
 * on it. `reserveUse` is one guarded UPDATE (active, unexpired, below `max_uses`), so concurrent
 * consumers can never exceed the count.
 */
import type { Sql } from "@/lib/controlplane/types";
import { requireText } from "../errors";
import { clampLimit } from "../sql";

export interface PreauthorizationRow {
  id: string;
  workspaceId: string;
  environmentId: string;
  parentOperationId: string;
  createdBy: string;
  createdByName: string;
  desiredDigest: string;
  referenceId: string;
  contractDigest: string;
  consumerSubplanDigest: string;
  producerSubplanDigest: string;
  valueType: "string" | "number" | "boolean" | "resource_id" | "endpoint" | "secret_ref";
  secretRef?: string;
  valueDigest?: string;
  maxUses: number;
  uses: number;
  expiresAt: string;
  createdAt: string;
  status: "active" | "revoked";
  revokedAt?: string;
  revokedBy?: string;
  revokedReason?: string;
}

interface Row {
  id: string; workspace_id: string; environment_id: string; parent_operation_id: string; created_by: string; created_by_name: string; desired_digest: string;
  reference_id: string; contract_digest: string; consumer_subplan_digest: string; producer_subplan_digest: string; value_type: PreauthorizationRow["valueType"];
  secret_ref: string | null; value_digest: string | null; max_uses: number; uses: number; expires_at: string; created_at: string; status: "active" | "revoked";
  revoked_at: string | null; revoked_by: string | null; revoked_reason: string | null;
}
const COLUMNS = "id, workspace_id, environment_id, parent_operation_id, created_by, created_by_name, desired_digest, reference_id, contract_digest, consumer_subplan_digest, producer_subplan_digest, value_type, secret_ref, value_digest, max_uses, uses, expires_at, created_at, status, revoked_at, revoked_by, revoked_reason";
const iso = (value: string): string => new Date(value).toISOString();
const toRow = (r: Row): PreauthorizationRow => ({
  id: r.id, workspaceId: r.workspace_id, environmentId: r.environment_id, parentOperationId: r.parent_operation_id, createdBy: r.created_by, createdByName: r.created_by_name,
  desiredDigest: r.desired_digest, referenceId: r.reference_id, contractDigest: r.contract_digest, consumerSubplanDigest: r.consumer_subplan_digest,
  producerSubplanDigest: r.producer_subplan_digest, valueType: r.value_type, ...(r.secret_ref ? { secretRef: r.secret_ref } : {}), ...(r.value_digest ? { valueDigest: r.value_digest } : {}),
  maxUses: Number(r.max_uses), uses: Number(r.uses), expiresAt: iso(r.expires_at), createdAt: iso(r.created_at), status: r.status,
  ...(r.revoked_at ? { revokedAt: iso(r.revoked_at) } : {}), ...(r.revoked_by ? { revokedBy: r.revoked_by } : {}), ...(r.revoked_reason ? { revokedReason: r.revoked_reason } : {}),
});

export async function create(sql: Sql, input: Omit<PreauthorizationRow, "uses" | "status" | "revokedAt" | "revokedBy" | "revokedReason">): Promise<PreauthorizationRow> {
  const rows = await sql.query<Row>(
    `insert into platform.mixed_output_preauthorizations (id, workspace_id, environment_id, parent_operation_id, created_by, created_by_name, desired_digest, reference_id, contract_digest,
       consumer_subplan_digest, producer_subplan_digest, value_type, secret_ref, value_digest, max_uses, expires_at, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::timestamptz,$17::timestamptz) returning ${COLUMNS}`,
    [requireText("id", input.id), requireText("workspaceId", input.workspaceId), input.environmentId, requireText("parentOperationId", input.parentOperationId), input.createdBy, input.createdByName,
      input.desiredDigest, input.referenceId, input.contractDigest, input.consumerSubplanDigest, input.producerSubplanDigest, input.valueType, input.secretRef ?? null, input.valueDigest ?? null,
      input.maxUses, input.expiresAt, input.createdAt]);
  return toRow(rows[0]);
}

export async function get(sql: Sql, workspaceId: string, id: string): Promise<PreauthorizationRow | null> {
  const rows = await sql.query<Row>(`select ${COLUMNS} from platform.mixed_output_preauthorizations where workspace_id = $1 and id = $2`, [requireText("workspaceId", workspaceId), requireText("id", id)]);
  return rows.length ? toRow(rows[0]) : null;
}

export async function list(sql: Sql, workspaceId: string, filter: { parentOperationId?: string; activeOnly?: boolean; now?: Date; limit?: number } = {}): Promise<PreauthorizationRow[]> {
  const rows = await sql.query<Row>(
    `select ${COLUMNS} from platform.mixed_output_preauthorizations where workspace_id = $1 and ($2::text is null or parent_operation_id = $2)
       and (not $3::boolean or (status = 'active' and expires_at > $4::timestamptz and uses < max_uses)) order by created_at, id limit $5`,
    [requireText("workspaceId", workspaceId), filter.parentOperationId ?? null, filter.activeOnly === true, (filter.now ?? new Date()).toISOString(), clampLimit(filter.limit, 100, 200)]);
  return rows.map(toRow);
}

export async function revoke(sql: Sql, input: { workspaceId: string; id: string; revokedBy: string; reason?: string; at: Date }): Promise<PreauthorizationRow | null> {
  const ws = requireText("workspaceId", input.workspaceId);
  await sql.query(
    `update platform.mixed_output_preauthorizations set status = 'revoked', revoked_at = $3::timestamptz, revoked_by = $4, revoked_reason = $5
     where workspace_id = $1 and id = $2 and status = 'active'`, [ws, requireText("id", input.id), input.at.toISOString(), input.revokedBy, input.reason ?? null]);
  return get(sql, ws, input.id);
}

export async function reserveUse(sql: Sql, input: { workspaceId: string; id: string; now: Date }): Promise<PreauthorizationRow | null> {
  const rows = await sql.query<Row>(
    `update platform.mixed_output_preauthorizations set uses = uses + 1
     where workspace_id = $1 and id = $2 and status = 'active' and expires_at > $3::timestamptz and uses < max_uses returning ${COLUMNS}`,
    [requireText("workspaceId", input.workspaceId), requireText("id", input.id), input.now.toISOString()]);
  return rows.length ? toRow(rows[0]) : null;
}

