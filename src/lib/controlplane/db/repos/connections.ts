/**
 * Provider connections (`ProviderConnection`, `credentials/types.ts`).
 *
 * A connection holds only NON-SECRET identifiers: role ARNs, workload-identity
 * pools, tenant/client ids, account ids, references (`credentialRef:
 * "vault:…"`). The credential broker exchanges them for short-lived
 * credentials at execution time. As defence in depth, `config` is refused when
 * any member is named like a secret (`secretAccessKey`, `password`, `token`,
 * `privateKey`, `apiKey`, …) or any value looks like key material — see
 * `secrets.ts`. Reference-typed names (`…Ref`, `…Arn`, `…Name`, `…Path`) are
 * allowed.
 *
 * `revoked` is terminal: a revoked connection is never re-verified or
 * re-activated (create a new one).
 */
import type { ConnectionConfig, ProviderConnection } from "@/lib/credentials/types";
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError, requireText } from "../errors";
import { assertNoSecretKeys } from "../secrets";
import { json, newId, opt } from "../sql";

interface ConnectionRow {
  id: string;
  workspace_id: string;
  legacy_connection_id: string | null;
  config: ConnectionConfig;
  status: ProviderConnection["status"];
  verified_at: string | null;
  verification_detail: string | null;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
}

const COLUMNS = "id, workspace_id, legacy_connection_id, config, status, verified_at, verification_detail, created_by, created_at, revoked_at";

const toConnection = (row: ConnectionRow): ProviderConnection => ({
  id: row.id,
  workspaceId: row.workspace_id,
  legacyConnectionId: opt(row.legacy_connection_id),
  config: row.config,
  status: row.status,
  verifiedAt: opt(row.verified_at),
  verificationDetail: opt(row.verification_detail),
  createdBy: row.created_by,
  createdAt: row.created_at,
  revokedAt: opt(row.revoked_at),
});

export interface CreateConnectionInput {
  workspaceId: string;
  config: ConnectionConfig;
  createdBy: string;
  legacyConnectionId?: string;
  id?: string;
}

/** Create a connection in `pending_verification`. Refuses secret-shaped configuration. */
export async function create(sql: Sql, input: CreateConnectionInput): Promise<ProviderConnection> {
  assertNoSecretKeys(input.config, "config");
  const rows = await sql.query<ConnectionRow>(
    `insert into platform.provider_connections (id, workspace_id, legacy_connection_id, provider, mode, config, status, created_by)
     values ($1, $2, $3, $4, $5, $6::text::jsonb, 'pending_verification', $7)
     returning ${COLUMNS}`,
    [
      input.id ?? newId("conn"),
      requireText("workspaceId", input.workspaceId),
      input.legacyConnectionId ?? null,
      requireText("config.provider", input.config.provider, 32),
      requireText("config.mode", input.config.mode, 64),
      json(input.config),
      requireText("createdBy", input.createdBy),
    ]
  );
  return toConnection(rows[0]);
}

export async function get(sql: Sql, workspaceId: string, id: string): Promise<ProviderConnection | null> {
  const rows = await sql.query<ConnectionRow>(
    `select ${COLUMNS} from platform.provider_connections where workspace_id = $1 and id = $2`,
    [requireText("workspaceId", workspaceId), requireText("id", id)]
  );
  return rows.length ? toConnection(rows[0]) : null;
}

export async function list(sql: Sql, workspaceId: string, filter: { provider?: string; includeRevoked?: boolean } = {}): Promise<ProviderConnection[]> {
  const rows = await sql.query<ConnectionRow>(
    `select ${COLUMNS} from platform.provider_connections
      where workspace_id = $1 and ($2::text is null or provider = $2::text) and ($3::boolean or status <> 'revoked')
      order by created_at desc, id`,
    [requireText("workspaceId", workspaceId), filter.provider ?? null, filter.includeRevoked ?? false]
  );
  return rows.map(toConnection);
}

/**
 * Record a verification outcome. Only `pending_verification`, `verified` and
 * `failed` connections can be re-verified; a revoked one returns null.
 */
export async function recordVerification(
  sql: Sql,
  input: { workspaceId: string; id: string; ok: boolean; detail?: string }
): Promise<ProviderConnection | null> {
  if (input.detail !== undefined && input.detail.length > 1000) throw new ControlStoreError("invalid_input", "verification detail is too long (max 1000 characters).");
  const rows = await sql.query<ConnectionRow>(
    `update platform.provider_connections
        set status = case when $3::boolean then 'verified' else 'failed' end,
            verified_at = case when $3::boolean then clock_timestamp() else verified_at end,
            verification_detail = $4
      where workspace_id = $1 and id = $2 and status <> 'revoked'
      returning ${COLUMNS}`,
    [requireText("workspaceId", input.workspaceId), requireText("id", input.id), input.ok, input.detail ?? null]
  );
  return rows.length ? toConnection(rows[0]) : null;
}

/** Revoke (terminal, idempotent). Returns the connection, or null when it is not in this workspace. */
export async function revoke(sql: Sql, workspaceId: string, id: string): Promise<ProviderConnection | null> {
  const rows = await sql.query<ConnectionRow>(
    `update platform.provider_connections
        set status = 'revoked', revoked_at = coalesce(revoked_at, clock_timestamp())
      where workspace_id = $1 and id = $2
      returning ${COLUMNS}`,
    [requireText("workspaceId", workspaceId), requireText("id", id)]
  );
  return rows.length ? toConnection(rows[0]) : null;
}
