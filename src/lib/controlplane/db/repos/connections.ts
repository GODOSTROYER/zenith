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
import { isOpenedPlatformDbHandle } from "../open";
import * as events from "./events";
import { markConnectionRevoking as markGuestBindingsRevoking } from "./k8s-guest-bindings";
import { assertDefaultMcpProductTopology, assertFinalMcpProductTopology } from "./workflow-start-deploy-authority";

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

interface VerificationRow extends ConnectionRow {
  provider: string;
  mode: string;
  verified_at_raw: string | null;
  created_at_raw: string;
  revoked_at_raw: string | null;
}
/** Nonsecret observed view; only this repository can bind its owning raw tuple. */
export interface ConnectionVerificationCapture {
  readonly connection: Readonly<ProviderConnection>;
}
const verificationCaptures = new WeakMap<object, { owner: Sql; row: VerificationRow; actorId: string }>();
function freezeVerificationValue<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freezeVerificationValue(item);
    Object.freeze(value);
  }
  return value;
}
/** Capture before the provider read. DTO timestamp normalization supplies no comparison authority. */
export async function captureVerification(sql: Sql, workspaceId: string, id: string, actorId: string): Promise<ConnectionVerificationCapture | null> {
  if (!isOpenedPlatformDbHandle(sql, "postgres")) return null;
  try { await assertDefaultMcpProductTopology(sql); } catch { return null; }
  const actor = requireText("actorId", actorId);
  const members = await sql.query<{ id: string; workspace_id: string; role: string }>(
    "select id,workspace_id,role from public.members where workspace_id=$1 and id=$2", [requireText("workspaceId", workspaceId), actor]);
  if (members.length !== 1 || members[0].id !== actor || members[0].workspace_id !== workspaceId || !["editor", "admin"].includes(members[0].role)) return null;
  const rows = await sql.query<VerificationRow>(`select ${COLUMNS},provider,mode,verified_at::text as verified_at_raw,
    created_at::text as created_at_raw,revoked_at::text as revoked_at_raw
    from platform.provider_connections where workspace_id=$1 and id=$2`, [requireText("workspaceId", workspaceId), requireText("id", id)]);
  if (rows.length !== 1 || rows[0].status === "revoked" || rows[0].revoked_at_raw !== null
    || rows[0].provider !== rows[0].config.provider || rows[0].mode !== rows[0].config.mode) return null;
  const row = freezeVerificationValue(structuredClone(rows[0]));
  const captured = Object.freeze({ connection: freezeVerificationValue(toConnection(row)) });
  try { await assertDefaultMcpProductTopology(sql); } catch { return null; }
  verificationCaptures.set(captured, { owner: sql, row, actorId: actor });
  return captured;
}
/** Exact capture identity and original scoped tuple, repeated after any native update lock wait. */
export async function recordCapturedVerification(sql: Sql, captured: ConnectionVerificationCapture, result: { ok: boolean; detail?: string }): Promise<ProviderConnection | null> {
  const entry = verificationCaptures.get(captured);
  if (!entry || entry.owner !== sql || !isOpenedPlatformDbHandle(sql)) return null;
  if (result.detail !== undefined && result.detail.length > 1000) throw new ControlStoreError("invalid_input", "verification detail is too long (max 1000 characters).");
  // A lost commit response cannot make the same in-process observation reusable.
  verificationCaptures.delete(captured);
  const row = entry.row;
  try {
    await assertDefaultMcpProductTopology(sql);
    return await sql.tx(async tx => {
      await assertFinalMcpProductTopology(sql, tx);
      // Wait before taking a fresh membership snapshot. No remote probe is inside this transaction.
      const locked = await tx.query<{ id: string }>("select id from platform.provider_connections where workspace_id=$1 and id=$2 for update", [row.workspace_id, row.id]);
      if (locked.length !== 1) return null;
      const members = await tx.query<{ id: string; workspace_id: string; role: string }>(
        "select id,workspace_id,role from public.members where workspace_id=$1 and id=$2 for share", [row.workspace_id, entry.actorId]);
      if (members.length !== 1 || members[0].id !== entry.actorId || members[0].workspace_id !== row.workspace_id || !["editor", "admin"].includes(members[0].role)) return null;
      await assertFinalMcpProductTopology(sql, tx);
      const rows = await tx.query<ConnectionRow>(`update platform.provider_connections
        set status=case when $3::boolean then 'verified' else 'failed' end,
          verified_at=case when $3::boolean then clock_timestamp() else verified_at end,verification_detail=$4
        where workspace_id=$1 and id=$2 and status=$5 and status<>'revoked' and revoked_at is null
          and verified_at is not distinct from $6::text::timestamptz and created_at=$7::text::timestamptz
          and revoked_at is not distinct from $8::text::timestamptz and legacy_connection_id is not distinct from $9::text
          and provider=$10 and mode=$11 and config=$12::text::jsonb
          and verification_detail is not distinct from $13::text and created_by=$14
          and exists(select 1 from public.members where workspace_id=$1 and id=$15 and role in ('editor','admin'))
        returning ${COLUMNS}`, [row.workspace_id, row.id, result.ok, result.detail ?? null, row.status,
        row.verified_at_raw, row.created_at_raw, row.revoked_at_raw, row.legacy_connection_id, row.provider, row.mode,
        json(row.config), row.verification_detail, row.created_by, entry.actorId]);
      await assertFinalMcpProductTopology(sql, tx);
      return rows.length === 1 ? toConnection(rows[0]) : null;
    });
  } catch { return null; }
}

/** Revoke (terminal, idempotent). Returns the connection, or null when it is not in this workspace. */
export async function revoke(sql: Sql, workspaceId: string, id: string): Promise<ProviderConnection | null> {
  const ws = requireText("workspaceId", workspaceId);
  const connectionId = requireText("id", id);
  return sql.tx(async (tx) => {
    const rows = await tx.query<ConnectionRow>(
      `update platform.provider_connections
          set status = 'revoked', revoked_at = coalesce(revoked_at, clock_timestamp())
        where workspace_id = $1 and id = $2
        returning ${COLUMNS}`,
      [ws, connectionId]
    );
    if (rows.length && rows[0].config.provider === "kubernetes") await markGuestBindingsRevoking(tx, ws, connectionId);
    return rows.length ? toConnection(rows[0]) : null;
  });
}

export type RevokeAuditedResult = { connection: ProviderConnection; alreadyRevoked: boolean };

/**
 * Revoke for an administrator action (PROD-LIFE-01): terminal and idempotent like
 * `revoke`, but it also discards any open rotation candidate and appends a
 * `connection.revoked` event in the same transaction, so a revocation cannot be
 * recorded without its audit fact. From the commit on, the broker and every
 * dispatch gate read `revoked` and refuse. Null when not in this workspace.
 */
export async function revokeAudited(sql: Sql, input: { workspaceId: string; id: string; actorId: string; reason?: string }): Promise<RevokeAuditedResult | null> {
  const ws = requireText("workspaceId", input.workspaceId);
  const id = requireText("id", input.id);
  const actor = requireText("actorId", input.actorId);
  return sql.tx(async (tx) => {
    const before = await tx.query<{ status: string }>("select status from platform.provider_connections where workspace_id = $1 and id = $2 for update", [ws, id]);
    if (!before.length) return null;
    const alreadyRevoked = before[0].status === "revoked";
    const rows = await tx.query<ConnectionRow>(
      `update platform.provider_connections set status = 'revoked', revoked_at = coalesce(revoked_at, clock_timestamp())
        where workspace_id = $1 and id = $2 returning ${COLUMNS}`, [ws, id]);
    await tx.query(
      `update platform.connection_rotations set status = 'aborted', resolved_by = $3, resolved_at = clock_timestamp()
        where workspace_id = $1 and connection_id = $2 and status in ('staged','verified','failed')`, [ws, id, actor]);
    // PROD-MACH-02: in the same commit, scoped Kubernetes guest bindings stop being mintable.
    if (rows[0].config.provider === "kubernetes") await markGuestBindingsRevoking(tx, ws, id);
    if (!alreadyRevoked) {
      await events.append(tx, { type: "connection.revoked", workspaceId: ws, correlationId: id, actor: { kind: "user", id: actor, name: actor },
        data: { connectionId: id, provider: rows[0].config.provider, ...(input.reason ? { reason: input.reason.slice(0, 300) } : {}) } });
    }
    return { connection: toConnection(rows[0]), alreadyRevoked };
  });
}

/** Append a lifecycle event (`connection.created` / `connection.verified`) for an existing connection of this workspace. */
export async function appendLifecycleEvent(sql: Sql, input: { workspaceId: string; id: string; type: "connection.created" | "connection.verified"; actorId: string; data?: Record<string, unknown> }): Promise<boolean> {
  const row = await get(sql, input.workspaceId, input.id);
  if (!row) return false;
  const actorId = requireText("actorId", input.actorId);
  await events.append(sql, { type: input.type, workspaceId: input.workspaceId, correlationId: input.id,
    actor: { kind: "user", id: actorId, name: actorId },
    data: { connectionId: input.id, provider: row.config.provider, ...(input.data ?? {}) } });
  return true;
}
