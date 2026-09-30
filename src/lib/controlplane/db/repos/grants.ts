/**
 * The capability-grant ledger (`CapabilityGrantClaims`).
 *
 * The signed grant (JWT) is verified by the execution surface; this table is
 * what makes it *single-use and revocable*: the broker records each issued
 * `jti`, and `consume(jti)` is one conditional UPDATE that succeeds exactly
 * once — the second presenter of the same grant gets `false`. Nothing here
 * stores the token itself, only its identity, scope and lifecycle timestamps.
 */
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError, requireText } from "../errors";

export interface GrantRecord {
  jti: string;
  workspaceId: string;
  operationId: string;
  capability: string;
  audience: string;
  issuedAt: string;
  expiresAt: string;
  consumedAt?: string;
  revokedAt?: string;
}

export type GrantStatus = "active" | "consumed" | "revoked" | "expired" | "unknown";

interface GrantRow {
  jti: string;
  workspace_id: string;
  operation_id: string;
  capability: string;
  audience: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
}

const COLUMNS = "jti, workspace_id, operation_id, capability, audience, issued_at, expires_at, consumed_at, revoked_at";

const toGrant = (row: GrantRow): GrantRecord => ({
  jti: row.jti,
  workspaceId: row.workspace_id,
  operationId: row.operation_id,
  capability: row.capability,
  audience: row.audience,
  issuedAt: row.issued_at,
  expiresAt: row.expires_at,
  consumedAt: row.consumed_at ?? undefined,
  revokedAt: row.revoked_at ?? undefined,
});

export interface InsertGrantInput {
  jti: string;
  workspaceId: string;
  operationId: string;
  capability: string;
  audience: string;
  issuedAt: string;
  expiresAt: string;
}

/**
 * Record an issued grant. `operationId` must be an operation of `workspaceId`
 * (composite foreign key). Grants live at most one hour.
 */
export async function insert(sql: Sql, input: InsertGrantInput): Promise<GrantRecord> {
  const issued = Date.parse(input.issuedAt);
  const expires = Date.parse(input.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued)
    throw new ControlStoreError("invalid_input", "A grant must expire after it is issued.");
  if (expires - issued > 60 * 60 * 1000) throw new ControlStoreError("invalid_input", "A capability grant may live at most one hour.");
  const rows = await sql.query<GrantRow>(
    `insert into platform.capability_grants (jti, workspace_id, operation_id, capability, audience, issued_at, expires_at)
     values ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz)
     returning ${COLUMNS}`,
    [
      requireText("jti", input.jti, 128),
      requireText("workspaceId", input.workspaceId),
      requireText("operationId", input.operationId),
      requireText("capability", input.capability, 128),
      requireText("audience", input.audience, 256),
      input.issuedAt,
      input.expiresAt,
    ]
  );
  return toGrant(rows[0]);
}

/**
 * Consume a grant: true exactly once, and only while it is unexpired, unrevoked
 * and issued in `workspaceId`. When `audience` is given it must equal the
 * grant's. A second consume, a revoked or expired grant, an unknown jti or a
 * grant of another workspace all return false.
 */
export async function consume(sql: Sql, input: { workspaceId: string; jti: string; audience?: string }): Promise<boolean> {
  const rows = await sql.query<{ jti: string }>(
    `update platform.capability_grants set consumed_at = clock_timestamp()
      where workspace_id = $1 and jti = $2 and consumed_at is null and revoked_at is null
        and expires_at > clock_timestamp() and ($3::text is null or audience = $3::text)
      returning jti`,
    [requireText("workspaceId", input.workspaceId), requireText("jti", input.jti, 128), input.audience ?? null]
  );
  return rows.length > 0;
}

/** Revoke a grant (idempotent; true when it was newly revoked). A consumed grant can still be marked revoked. */
export async function revoke(sql: Sql, workspaceId: string, jti: string): Promise<boolean> {
  const rows = await sql.query<{ jti: string }>(
    `update platform.capability_grants set revoked_at = clock_timestamp()
      where workspace_id = $1 and jti = $2 and revoked_at is null returning jti`,
    [requireText("workspaceId", workspaceId), requireText("jti", jti, 128)]
  );
  return rows.length > 0;
}

/** Revoke every still-live grant of an operation (cancel, lease loss). Returns how many. */
export async function revokeForOperation(sql: Sql, workspaceId: string, operationId: string): Promise<number> {
  const rows = await sql.query<{ jti: string }>(
    `update platform.capability_grants set revoked_at = clock_timestamp()
      where workspace_id = $1 and operation_id = $2 and revoked_at is null and consumed_at is null returning jti`,
    [requireText("workspaceId", workspaceId), requireText("operationId", operationId)]
  );
  return rows.length;
}

export async function get(sql: Sql, workspaceId: string, jti: string): Promise<GrantRecord | null> {
  const rows = await sql.query<GrantRow>(
    `select ${COLUMNS} from platform.capability_grants where workspace_id = $1 and jti = $2`,
    [requireText("workspaceId", workspaceId), requireText("jti", jti, 128)]
  );
  return rows.length ? toGrant(rows[0]) : null;
}

/** Lifecycle status, evaluated on the database clock. */
export async function status(sql: Sql, workspaceId: string, jti: string): Promise<GrantStatus> {
  const rows = await sql.query<{ status: GrantStatus }>(
    `select case
              when revoked_at is not null then 'revoked'
              when consumed_at is not null then 'consumed'
              when expires_at <= clock_timestamp() then 'expired'
              else 'active' end as status
       from platform.capability_grants where workspace_id = $1 and jti = $2`,
    [requireText("workspaceId", workspaceId), requireText("jti", jti, 128)]
  );
  return rows[0]?.status ?? "unknown";
}

/** True only for a grant that exists in `workspaceId` and has been revoked. Unknown jti is NOT "revoked" — use `status` to tell them apart. */
export async function isRevoked(sql: Sql, workspaceId: string, jti: string): Promise<boolean> {
  return (await status(sql, workspaceId, jti)) === "revoked";
}
