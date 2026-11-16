/**
 * Staged credential rotation for provider connections (PROD-LIFE-01).
 *
 * A rotation row stores a NON-SECRET candidate config next to the live
 * connection. The live row is untouched until `promote`, which swaps the config
 * in one transaction guarded by (a) the live config still matching the digest
 * the candidate was staged against, (b) the candidate having been verified
 * recently, and (c) the connection not being revoked. Until then the old access
 * keeps serving, so rotation has no downtime window. Every function filters on
 * workspace_id; a foreign or missing id is `null`.
 */
import type { ConnectionConfig, ProviderConnection } from "@/lib/credentials/types";
import type { Sql } from "@/lib/controlplane/types";
import { digest } from "@/lib/controlplane/digest";
import { ControlStoreError, requireText } from "../errors";
import { assertNoSecretKeys } from "../secrets";
import { json, newId, opt } from "../sql";
import * as events from "./events";

export type RotationStatus = "staged" | "verified" | "failed" | "promoted" | "aborted" | "superseded";
/** A candidate verification older than this cannot be promoted; verify again. */
export const ROTATION_VERIFICATION_MAX_AGE_MIN = 60;

export interface ConnectionRotation {
  id: string;
  workspaceId: string;
  connectionId: string;
  status: RotationStatus;
  baseConfigDigest: string;
  candidateConfig: ConnectionConfig;
  candidateDigest: string;
  verificationDetail?: string;
  verifiedAt?: string;
  createdBy: string;
  createdAt: string;
  resolvedBy?: string;
  resolvedAt?: string;
}

interface Row {
  id: string;
  workspace_id: string;
  connection_id: string;
  status: RotationStatus;
  base_config_digest: string;
  candidate_config: ConnectionConfig;
  candidate_digest: string;
  verification_detail: string | null;
  verified_at: string | null;
  created_by: string;
  created_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
}
const COLUMNS = "id, workspace_id, connection_id, status, base_config_digest, candidate_config, candidate_digest, verification_detail, verified_at, created_by, created_at, resolved_by, resolved_at";
const toRotation = (r: Row): ConnectionRotation => ({
  id: r.id, workspaceId: r.workspace_id, connectionId: r.connection_id, status: r.status, baseConfigDigest: r.base_config_digest,
  candidateConfig: r.candidate_config, candidateDigest: r.candidate_digest, verificationDetail: opt(r.verification_detail),
  verifiedAt: opt(r.verified_at), createdBy: r.created_by, createdAt: r.created_at, resolvedBy: opt(r.resolved_by), resolvedAt: opt(r.resolved_at),
});

interface ConnRow { id: string; workspace_id: string; config: ConnectionConfig; status: ProviderConnection["status"]; revoked_at: string | null }

/** The live connection, row-locked for the rest of the transaction. */
async function lockConnection(tx: Sql, workspaceId: string, id: string): Promise<ConnRow | null> {
  const rows = await tx.query<ConnRow>(
    "select id, workspace_id, config, status, revoked_at from platform.provider_connections where workspace_id = $1 and id = $2 for update",
    [workspaceId, id]);
  return rows[0] ?? null;
}

export interface StageRotationInput {
  workspaceId: string;
  connectionId: string;
  candidateConfig: ConnectionConfig;
  createdBy: string;
}

/**
 * Stage a candidate. Any earlier open candidate for this connection is marked
 * `superseded`. Refuses a revoked connection and a candidate equal to the live
 * config (nothing to rotate). The caller has already validated the candidate
 * against the provider's identity-pinning rules.
 */
export async function stage(sql: Sql, input: StageRotationInput): Promise<ConnectionRotation | null> {
  const ws = requireText("workspaceId", input.workspaceId);
  const connectionId = requireText("connectionId", input.connectionId);
  const createdBy = requireText("createdBy", input.createdBy);
  assertNoSecretKeys(input.candidateConfig, "candidateConfig");
  return sql.tx(async (tx) => {
    const live = await lockConnection(tx, ws, connectionId);
    if (!live) return null;
    if (live.status === "revoked" || live.revoked_at !== null) throw new ControlStoreError("invalid_state", "A revoked connection cannot be rotated; create a new connection.");
    // The one sanctioned mode change: legacy kubeconfig_ref -> scoped_guest (PROD-MACH-02). It still verifies and promotes like any rotation.
    const conversion = live.config.provider === "kubernetes" && input.candidateConfig.provider === "kubernetes"
      && live.config.mode === "kubeconfig_ref" && input.candidateConfig.mode === "scoped_guest";
    if (live.config.provider !== input.candidateConfig.provider || (live.config.mode !== input.candidateConfig.mode && !conversion))
      throw new ControlStoreError("invalid_input", "A rotation cannot change the provider or the federation mode.", { field: "candidateConfig" });
    const candidateDigest = digest(input.candidateConfig);
    const baseDigest = digest(live.config);
    if (candidateDigest === baseDigest) throw new ControlStoreError("invalid_input", "The candidate equals the current access; there is nothing to rotate.", { field: "candidateConfig" });
    await tx.query(
      `update platform.connection_rotations set status = 'superseded', resolved_by = $3, resolved_at = clock_timestamp()
        where workspace_id = $1 and connection_id = $2 and status in ('staged','verified','failed')`,
      [ws, connectionId, createdBy]);
    const rows = await tx.query<Row>(
      `insert into platform.connection_rotations (id, workspace_id, connection_id, status, base_config_digest, candidate_config, candidate_digest, created_by)
       values ($1, $2, $3, 'staged', $4, $5::text::jsonb, $6, $7) returning ${COLUMNS}`,
      [newId("rot"), ws, connectionId, baseDigest, json(input.candidateConfig), candidateDigest, createdBy]);
    const rotation = toRotation(rows[0]);
    await events.append(tx, { type: "connection.rotation_staged", workspaceId: ws, correlationId: rotation.id,
      actor: { kind: "user", id: createdBy, name: createdBy }, data: { connectionId, rotationId: rotation.id, provider: live.config.provider } });
    return rotation;
  });
}

export async function get(sql: Sql, workspaceId: string, id: string): Promise<ConnectionRotation | null> {
  const rows = await sql.query<Row>(`select ${COLUMNS} from platform.connection_rotations where workspace_id = $1 and id = $2`, [requireText("workspaceId", workspaceId), requireText("id", id)]);
  return rows.length ? toRotation(rows[0]) : null;
}

/** The single open (staged, verified or failed) rotation of a connection, if any. */
export async function getOpen(sql: Sql, workspaceId: string, connectionId: string): Promise<ConnectionRotation | null> {
  const rows = await sql.query<Row>(
    `select ${COLUMNS} from platform.connection_rotations where workspace_id = $1 and connection_id = $2 and status in ('staged','verified','failed')`,
    [requireText("workspaceId", workspaceId), requireText("connectionId", connectionId)]);
  return rows.length ? toRotation(rows[0]) : null;
}

export async function list(sql: Sql, workspaceId: string, connectionId: string, limit = 20): Promise<ConnectionRotation[]> {
  const rows = await sql.query<Row>(
    `select ${COLUMNS} from platform.connection_rotations where workspace_id = $1 and connection_id = $2 order by created_at desc, id limit $3`,
    [requireText("workspaceId", workspaceId), requireText("connectionId", connectionId), Math.max(1, Math.min(100, Math.trunc(limit)))]);
  return rows.map(toRotation);
}

/** Record the candidate's own verification outcome. The live connection's status is NOT touched. */
export async function recordCandidateVerification(
  sql: Sql,
  input: { workspaceId: string; id: string; ok: boolean; detail?: string },
): Promise<ConnectionRotation | null> {
  if (input.detail !== undefined && input.detail.length > 1000) throw new ControlStoreError("invalid_input", "verification detail is too long (max 1000 characters).");
  const rows = await sql.query<Row>(
    `update platform.connection_rotations
        set status = case when $3::boolean then 'verified' else 'failed' end,
            verified_at = case when $3::boolean then clock_timestamp() else null end,
            verification_detail = $4
      where workspace_id = $1 and id = $2 and status in ('staged','verified','failed')
      returning ${COLUMNS}`,
    [requireText("workspaceId", input.workspaceId), requireText("id", input.id), input.ok, input.detail ?? null]);
  return rows.length ? toRotation(rows[0]) : null;
}

/** Discard an open candidate. The live connection is untouched. */
export async function abort(sql: Sql, input: { workspaceId: string; id: string; actorId: string }): Promise<ConnectionRotation | null> {
  const ws = requireText("workspaceId", input.workspaceId);
  const actor = requireText("actorId", input.actorId);
  return sql.tx(async (tx) => {
    const rows = await tx.query<Row>(
      `update platform.connection_rotations set status = 'aborted', resolved_by = $3, resolved_at = clock_timestamp()
        where workspace_id = $1 and id = $2 and status in ('staged','verified','failed') returning ${COLUMNS}`,
      [ws, requireText("id", input.id), actor]);
    if (!rows.length) return null;
    const rotation = toRotation(rows[0]);
    await events.append(tx, { type: "connection.rotation_aborted", workspaceId: ws, correlationId: rotation.id,
      actor: { kind: "user", id: actor, name: actor }, data: { connectionId: rotation.connectionId, rotationId: rotation.id } });
    return rotation;
  });
}

export type PromoteRefusal = "not_found" | "not_verified" | "stale_verification" | "base_changed" | "revoked";
export type PromoteResult =
  | { ok: true; connection: ProviderConnection; rotation: ConnectionRotation; previousConfig: ConnectionConfig }
  | { ok: false; reason: PromoteRefusal };

interface PromotedRow {
  id: string; workspace_id: string; legacy_connection_id: string | null; config: ConnectionConfig; status: ProviderConnection["status"];
  verified_at: string | null; verification_detail: string | null; created_by: string; created_at: string; revoked_at: string | null;
}

/**
 * Atomically replace the live config with the verified candidate. Refuses when
 * the connection was revoked, changed since staging, or the candidate was not
 * verified within the freshness window. A successful promotion leaves the
 * connection `verified` (the candidate just proved itself) and resolves the row.
 */
export async function promote(sql: Sql, input: { workspaceId: string; id: string; actorId: string }): Promise<PromoteResult> {
  const ws = requireText("workspaceId", input.workspaceId);
  const actor = requireText("actorId", input.actorId);
  return sql.tx(async (tx): Promise<PromoteResult> => {
    const found = await tx.query<Row & { fresh: boolean }>(
      `select ${COLUMNS}, (verified_at is not null and verified_at > clock_timestamp() - ($3::int * interval '1 minute')) as fresh
         from platform.connection_rotations where workspace_id = $1 and id = $2 for update`,
      [ws, requireText("id", input.id), ROTATION_VERIFICATION_MAX_AGE_MIN]);
    if (!found.length) return { ok: false, reason: "not_found" };
    const rotation = toRotation(found[0]);
    const live = await lockConnection(tx, ws, rotation.connectionId);
    if (!live) return { ok: false, reason: "not_found" };
    if (live.status === "revoked" || live.revoked_at !== null) return { ok: false, reason: "revoked" };
    if (rotation.status !== "verified") return { ok: false, reason: "not_verified" };
    if (!found[0].fresh) return { ok: false, reason: "stale_verification" };
    if (digest(live.config) !== rotation.baseConfigDigest || digest(rotation.candidateConfig) !== rotation.candidateDigest) return { ok: false, reason: "base_changed" };
    const updated = await tx.query<PromotedRow>(
      `update platform.provider_connections
          set config = $3::text::jsonb, status = 'verified', verified_at = clock_timestamp(), verification_detail = $4
        where workspace_id = $1 and id = $2 and status <> 'revoked' and revoked_at is null
        returning id, workspace_id, legacy_connection_id, config, status, verified_at, verification_detail, created_by, created_at, revoked_at`,
      [ws, rotation.connectionId, json(rotation.candidateConfig), rotation.verificationDetail ?? "Rotated access verified before promotion."]);
    if (!updated.length) return { ok: false, reason: "revoked" };
    const done = await tx.query<Row>(
      `update platform.connection_rotations set status = 'promoted', resolved_by = $3, resolved_at = clock_timestamp()
        where workspace_id = $1 and id = $2 returning ${COLUMNS}`, [ws, rotation.id, actor]);
    const u = updated[0];
    await events.append(tx, { type: "connection.rotated", workspaceId: ws, correlationId: rotation.id,
      actor: { kind: "user", id: actor, name: actor }, data: { connectionId: rotation.connectionId, rotationId: rotation.id, provider: u.config.provider } });
    return {
      ok: true,
      previousConfig: live.config,
      rotation: toRotation(done[0]),
      connection: {
        id: u.id, workspaceId: u.workspace_id, legacyConnectionId: opt(u.legacy_connection_id), config: u.config, status: u.status,
        verifiedAt: opt(u.verified_at), verificationDetail: opt(u.verification_detail), createdBy: u.created_by, createdAt: u.created_at, revokedAt: opt(u.revoked_at),
      },
    };
  });
}
