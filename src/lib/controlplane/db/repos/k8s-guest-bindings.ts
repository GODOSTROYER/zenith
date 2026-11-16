/**
 * Tenant-scoped Kubernetes guest bindings (PROD-MACH-02).
 *
 * A row records the Zenith-minted ServiceAccount/Role/RoleBinding behind a
 * `scoped_guest` connection's machine sessions. Rows never hold credentials. The
 * status is the dispatch gate and every transition re-checks the owning
 * connection inside SQL, so a revoked connection can neither create a new
 * binding nor record a new token issuance. Every function filters on
 * workspace_id; a foreign or missing id is `null`/`[]`.
 */
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError, requireText } from "../errors";
import { newId, opt } from "../sql";

export type GuestBindingStatus = "provisioning" | "active" | "revoking" | "revoked";
export type GuestProfile = "read" | "exec";

export interface GuestBinding {
  id: string;
  workspaceId: string;
  connectionId: string;
  namespace: string;
  profile: GuestProfile;
  objectName: string;
  status: GuestBindingStatus;
  saUid?: string;
  issuedCount: number;
  lastIssuedAt?: string;
  lastTokenExpiresAt?: string;
  lastError?: string;
  createdAt: string;
  revokedAt?: string;
}

interface Row {
  id: string; workspace_id: string; connection_id: string; namespace: string; profile: GuestProfile; object_name: string;
  status: GuestBindingStatus; sa_uid: string | null; issued_count: number; last_issued_at: unknown; last_token_expires_at: unknown;
  last_error: string | null; created_at: unknown; revoked_at: unknown;
}
const COLUMNS = "id, workspace_id, connection_id, namespace, profile, object_name, status, sa_uid, issued_count, last_issued_at, last_token_expires_at, last_error, created_at, revoked_at";
const iso = (v: unknown): string | undefined => v === null || v === undefined ? undefined : v instanceof Date ? v.toISOString() : String(v);
const toBinding = (r: Row): GuestBinding => ({
  id: r.id, workspaceId: r.workspace_id, connectionId: r.connection_id, namespace: r.namespace, profile: r.profile, objectName: r.object_name,
  status: r.status, saUid: opt(r.sa_uid), issuedCount: Number(r.issued_count), lastIssuedAt: iso(r.last_issued_at),
  lastTokenExpiresAt: iso(r.last_token_expires_at), lastError: opt(r.last_error), createdAt: iso(r.created_at) ?? "", revokedAt: iso(r.revoked_at),
});

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
function profileOf(value: unknown): GuestProfile {
  if (value !== "read" && value !== "exec") throw new ControlStoreError("invalid_input", "profile must be read or exec.", { field: "profile" });
  return value;
}

export interface EnsureGuestBindingInput { workspaceId: string; connectionId: string; namespace: string; profile: GuestProfile; objectName: string }

/**
 * Create (or return) the binding for one scope. Returns `null` when the connection
 * does not exist in this workspace or is revoked: a revoked connection can never
 * acquire a binding. An existing `revoking`/`revoked` row is returned as-is so the
 * caller can refuse; it is never resurrected.
 */
export async function ensure(sql: Sql, input: EnsureGuestBindingInput): Promise<GuestBinding | null> {
  const ws = requireText("workspaceId", input.workspaceId);
  const connectionId = requireText("connectionId", input.connectionId);
  const profile = profileOf(input.profile);
  if (!DNS_LABEL.test(input.namespace) || !DNS_LABEL.test(input.objectName)) throw new ControlStoreError("invalid_input", "namespace and objectName must be DNS labels.");
  return sql.tx(async (tx) => {
    const live = await tx.query<{ status: string }>("select status from platform.provider_connections where workspace_id = $1 and id = $2 for share", [ws, connectionId]);
    if (!live.length || live[0].status === "revoked") return null;
    await tx.query(
      `insert into platform.k8s_guest_bindings (id, workspace_id, connection_id, namespace, profile, object_name, status)
       values ($1, $2, $3, $4, $5, $6, 'provisioning') on conflict (workspace_id, connection_id, namespace, profile) do nothing`,
      [newId("kgb"), ws, connectionId, input.namespace, profile, input.objectName]);
    const rows = await tx.query<Row>(
      `select ${COLUMNS} from platform.k8s_guest_bindings where workspace_id = $1 and connection_id = $2 and namespace = $3 and profile = $4`,
      [ws, connectionId, input.namespace, profile]);
    return rows[0] ? toBinding(rows[0]) : null;
  });
}

export async function get(sql: Sql, workspaceId: string, id: string): Promise<GuestBinding | null> {
  const rows = await sql.query<Row>(`select ${COLUMNS} from platform.k8s_guest_bindings where workspace_id = $1 and id = $2`,
    [requireText("workspaceId", workspaceId), requireText("id", id)]);
  return rows[0] ? toBinding(rows[0]) : null;
}

/** Bindings of one connection that still have (or may have) cluster objects. */
export async function listOpen(sql: Sql, workspaceId: string, connectionId: string): Promise<GuestBinding[]> {
  const rows = await sql.query<Row>(
    `select ${COLUMNS} from platform.k8s_guest_bindings where workspace_id = $1 and connection_id = $2 and status <> 'revoked' order by namespace, profile`,
    [requireText("workspaceId", workspaceId), requireText("connectionId", connectionId)]);
  return rows.map(toBinding);
}

export async function listForConnection(sql: Sql, workspaceId: string, connectionId: string): Promise<GuestBinding[]> {
  const rows = await sql.query<Row>(
    `select ${COLUMNS} from platform.k8s_guest_bindings where workspace_id = $1 and connection_id = $2 order by namespace, profile`,
    [requireText("workspaceId", workspaceId), requireText("connectionId", connectionId)]);
  return rows.map(toBinding);
}

/** provisioning/active -> active once the cluster objects exist and carry this ServiceAccount UID. */
export async function markActive(sql: Sql, workspaceId: string, id: string, saUid: string): Promise<GuestBinding | null> {
  const rows = await sql.query<Row>(
    `update platform.k8s_guest_bindings b set status = 'active', sa_uid = $3, last_error = null, updated_at = clock_timestamp()
      where b.workspace_id = $1 and b.id = $2 and b.status in ('provisioning','active')
        and exists (select 1 from platform.provider_connections c where c.workspace_id = b.workspace_id and c.id = b.connection_id and c.status <> 'revoked')
      returning ${COLUMNS}`,
    [requireText("workspaceId", workspaceId), requireText("id", id), requireText("saUid", saUid, 128)]);
  return rows[0] ? toBinding(rows[0]) : null;
}

/**
 * The final gate before a token leaves the broker: records the issuance only while
 * the binding is `active` AND its connection is not revoked, in one statement.
 * `false` means the token must be discarded.
 */
export async function recordIssuance(sql: Sql, workspaceId: string, id: string, tokenExpiresAt: Date): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `update platform.k8s_guest_bindings b set issued_count = b.issued_count + 1, last_issued_at = clock_timestamp(),
            last_token_expires_at = $3::timestamptz, updated_at = clock_timestamp()
      where b.workspace_id = $1 and b.id = $2 and b.status = 'active'
        and exists (select 1 from platform.provider_connections c where c.workspace_id = b.workspace_id and c.id = b.connection_id and c.status <> 'revoked')
      returning b.id`,
    [requireText("workspaceId", workspaceId), requireText("id", id), tokenExpiresAt.toISOString()]);
  return rows.length === 1;
}

/** Stable error code only (never provider text). Does not change the status. */
export async function recordError(sql: Sql, workspaceId: string, id: string, code: string): Promise<void> {
  if (!/^[a-z_]{1,64}$/.test(code)) throw new ControlStoreError("invalid_input", "code must be a short snake_case identifier.", { field: "code" });
  await sql.query("update platform.k8s_guest_bindings set last_error = $3, updated_at = clock_timestamp() where workspace_id = $1 and id = $2",
    [requireText("workspaceId", workspaceId), requireText("id", id), code]);
}

/** Any non-terminal binding of this connection -> revoking. Idempotent; runs in revokeAudited's transaction. */
export async function markConnectionRevoking(sql: Sql, workspaceId: string, connectionId: string): Promise<number> {
  const rows = await sql.query<{ id: string }>(
    `update platform.k8s_guest_bindings set status = 'revoking', updated_at = clock_timestamp()
      where workspace_id = $1 and connection_id = $2 and status in ('provisioning','active') returning id`,
    [requireText("workspaceId", workspaceId), requireText("connectionId", connectionId)]);
  return rows.length;
}

/** revoking -> revoked, only after the cluster objects were deleted (or proven absent). */
export async function markRevoked(sql: Sql, workspaceId: string, id: string): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `update platform.k8s_guest_bindings set status = 'revoked', revoked_at = coalesce(revoked_at, clock_timestamp()), last_error = null, updated_at = clock_timestamp()
      where workspace_id = $1 and id = $2 and status in ('revoking','revoked') returning id`,
    [requireText("workspaceId", workspaceId), requireText("id", id)]);
  return rows.length === 1;
}

/** A binding the caller found unusable (failed provisioning): same terminal path as revocation. */
export async function markRevoking(sql: Sql, workspaceId: string, id: string): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `update platform.k8s_guest_bindings set status = 'revoking', updated_at = clock_timestamp()
      where workspace_id = $1 and id = $2 and status in ('provisioning','active') returning id`,
    [requireText("workspaceId", workspaceId), requireText("id", id)]);
  return rows.length === 1;
}
