/**
 * Plugin registrations, review decisions, audience-bound grants and the audit
 * trail (PROD-UX-03). Storage only: who may call these (a signed-in workspace
 * admin in a browser session, or the live grant check on an MCP request) is
 * decided by `src/lib/plugins/service.ts`.
 *
 * Tenancy: id-based functions filter on
 * `workspace_id` in SQL, so a foreign id is the same as a missing one.
 * The resolve/classify/diagnose hash lookups are token-keyed authentication (the
 * 256-bit token hash is the key; the workspace is derived from the row and then
 * bound by the caller); it is never reachable with a caller-supplied id.
 *
 * Revocation is one transaction: the registration becomes `revoked` and every
 * grant of it gets `revoked_at`. The authentication lookup joins both, so a
 * grant is valid only while the registration is `approved` AND the grant is
 * unrevoked and unexpired, checked on every request.
 */
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError, requireText } from "../errors";
import { json, newId } from "../sql";

export type PluginStatus = "pending_review" | "approved" | "rejected" | "revoked";

export interface PluginRegistration {
  id: string;
  workspaceId: string;
  pluginId: string;
  pluginVersion: string;
  manifestDigest: string;
  artifactDigest: string;
  publisherId: string;
  manifest: Record<string, unknown>;
  provenance: Record<string, unknown>;
  status: PluginStatus;
  approvedTools: string[];
  approvedScopes: string[];
  requestedBy: string;
  reviewedBy?: string;
  reviewedAt?: string;
  revokedBy?: string;
  revokedAt?: string;
  revokeReason?: string;
  createdAt: string;
}

export interface PluginGrantRecord {
  id: string;
  workspaceId: string;
  registrationId: string;
  audience: string;
  credentialId: string;
  subject: string;
  scopes: string[];
  projectIds: string[];
  environmentIds?: string[];
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

export interface PluginEvent {
  id: string;
  registrationId: string;
  kind: string;
  actor: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

const iso = (v: unknown): string => new Date(v as string).toISOString();
const isoOpt = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : iso(v));
const parseJson = <T>(v: unknown): T => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T));

const REG_COLUMNS =
  "id, workspace_id, plugin_id, plugin_version, manifest_digest, artifact_digest, publisher_id, manifest, provenance, status, approved_tools, approved_scopes, requested_by, reviewed_by, reviewed_at, revoked_by, revoked_at, revoke_reason, created_at";
interface RegRow {
  id: string;
  workspace_id: string;
  plugin_id: string;
  plugin_version: string;
  manifest_digest: string;
  artifact_digest: string;
  publisher_id: string;
  manifest: unknown;
  provenance: unknown;
  status: PluginStatus;
  approved_tools: unknown;
  approved_scopes: unknown;
  requested_by: string;
  reviewed_by: string | null;
  reviewed_at: unknown;
  revoked_by: string | null;
  revoked_at: unknown;
  revoke_reason: string | null;
  created_at: unknown;
}
const toReg = (r: RegRow): PluginRegistration => ({
  id: r.id,
  workspaceId: r.workspace_id,
  pluginId: r.plugin_id,
  pluginVersion: r.plugin_version,
  manifestDigest: r.manifest_digest,
  artifactDigest: r.artifact_digest,
  publisherId: r.publisher_id,
  manifest: parseJson<Record<string, unknown>>(r.manifest),
  provenance: parseJson<Record<string, unknown>>(r.provenance),
  status: r.status,
  approvedTools: parseJson<string[]>(r.approved_tools),
  approvedScopes: parseJson<string[]>(r.approved_scopes),
  requestedBy: r.requested_by,
  ...(r.reviewed_by ? { reviewedBy: r.reviewed_by } : {}),
  ...(r.reviewed_at ? { reviewedAt: iso(r.reviewed_at) } : {}),
  ...(r.revoked_by ? { revokedBy: r.revoked_by } : {}),
  ...(r.revoked_at ? { revokedAt: iso(r.revoked_at) } : {}),
  ...(r.revoke_reason ? { revokeReason: r.revoke_reason } : {}),
  createdAt: iso(r.created_at),
});

const GRANT_COLUMNS = "id, workspace_id, registration_id, audience, credential_id, subject, scopes, project_ids, environment_ids, created_by, created_at, expires_at, revoked_at, last_used_at";
interface GrantRow {
  id: string;
  workspace_id: string;
  registration_id: string;
  audience: string;
  credential_id: string;
  subject: string;
  scopes: unknown;
  project_ids: unknown;
  environment_ids: unknown;
  created_by: string;
  created_at: unknown;
  expires_at: unknown;
  revoked_at: unknown;
  last_used_at: unknown;
}
const toGrant = (r: GrantRow): PluginGrantRecord => ({
  id: r.id,
  workspaceId: r.workspace_id,
  registrationId: r.registration_id,
  audience: r.audience,
  credentialId: r.credential_id,
  subject: r.subject,
  scopes: parseJson<string[]>(r.scopes),
  projectIds: parseJson<string[]>(r.project_ids),
  ...(r.environment_ids === null || r.environment_ids === undefined ? {} : { environmentIds: parseJson<string[]>(r.environment_ids) }),
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
  expiresAt: iso(r.expires_at),
  ...(isoOpt(r.revoked_at) ? { revokedAt: isoOpt(r.revoked_at) } : {}),
  ...(isoOpt(r.last_used_at) ? { lastUsedAt: isoOpt(r.last_used_at) } : {}),
});

async function audit(sql: Sql, workspaceId: string, registrationId: string, kind: string, actor: string, detail: Record<string, unknown>): Promise<void> {
  await sql.query("insert into platform.plugin_events (id, workspace_id, registration_id, kind, actor, detail) values ($1,$2,$3,$4,$5,$6::text::jsonb)", [
    newId("pev"),
    workspaceId,
    registrationId,
    kind,
    actor,
    json(detail),
  ]);
}

export interface RegisterPluginInput {
  workspaceId: string;
  pluginId: string;
  pluginVersion: string;
  manifestDigest: string;
  artifactDigest: string;
  publisherId: string;
  manifest: Record<string, unknown>;
  provenance: Record<string, unknown>;
  requestedBy: string;
}

/** Register a verified manifest as `pending_review`. The same digest again returns the existing row; a different digest for the same version is a conflict. */
export async function register(sql: Sql, input: RegisterPluginInput): Promise<{ registration: PluginRegistration; created: boolean }> {
  const ws = requireText("workspaceId", input.workspaceId);
  return sql.tx(async (tx) => {
    const id = newId("plg");
    const inserted = await tx.query<RegRow>(
      `insert into platform.plugin_registrations (id, workspace_id, plugin_id, plugin_version, manifest_digest, artifact_digest, publisher_id, manifest, provenance, status, requested_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8::text::jsonb,$9::text::jsonb,'pending_review',$10)
       on conflict (workspace_id, plugin_id, plugin_version) do nothing
       returning ${REG_COLUMNS}`,
      [id, ws, input.pluginId, input.pluginVersion, input.manifestDigest, input.artifactDigest, input.publisherId, json(input.manifest), json(input.provenance), requireText("requestedBy", input.requestedBy)]
    );
    if (inserted.length) {
      await audit(tx, ws, id, "registered", input.requestedBy, { manifestDigest: input.manifestDigest, version: input.pluginVersion });
      return { registration: toReg(inserted[0]), created: true };
    }
    const existing = await tx.query<RegRow>(`select ${REG_COLUMNS} from platform.plugin_registrations where workspace_id=$1 and plugin_id=$2 and plugin_version=$3`, [ws, input.pluginId, input.pluginVersion]);
    if (!existing.length) throw new ControlStoreError("conflict", "Plugin registration changed concurrently; retry.");
    if (existing[0].manifest_digest !== input.manifestDigest) {
      throw new ControlStoreError("conflict", "A different manifest is already registered for this plugin version. Publish a new version.", { pluginId: input.pluginId, version: input.pluginVersion });
    }
    return { registration: toReg(existing[0]), created: false };
  });
}

export async function get(sql: Sql, workspaceId: string, id: string): Promise<PluginRegistration | null> {
  const rows = await sql.query<RegRow>(`select ${REG_COLUMNS} from platform.plugin_registrations where workspace_id=$1 and id=$2`, [requireText("workspaceId", workspaceId), requireText("id", id)]);
  return rows.length ? toReg(rows[0]) : null;
}

export async function list(sql: Sql, workspaceId: string, limit = 100): Promise<PluginRegistration[]> {
  const n = Math.min(Math.max(Math.trunc(limit), 1), 200);
  const rows = await sql.query<RegRow>(`select ${REG_COLUMNS} from platform.plugin_registrations where workspace_id=$1 order by created_at desc, id limit $2`, [requireText("workspaceId", workspaceId), n]);
  return rows.map(toReg);
}

export interface ReviewPluginInput {
  workspaceId: string;
  id: string;
  /** the manifest digest the reviewer actually read; a mismatch refuses */
  manifestDigest: string;
  decision: "approve" | "reject";
  tools: readonly string[];
  scopes: readonly string[];
  reviewedBy: string;
}

/** Decide a `pending_review` registration. Approval records the (sub)set of tools/scopes the reviewer allowed. */
export async function review(sql: Sql, input: ReviewPluginInput): Promise<PluginRegistration> {
  const ws = requireText("workspaceId", input.workspaceId);
  const id = requireText("id", input.id);
  return sql.tx(async (tx) => {
    const rows = await tx.query<RegRow>(`select ${REG_COLUMNS} from platform.plugin_registrations where workspace_id=$1 and id=$2 for update`, [ws, id]);
    if (!rows.length) throw new ControlStoreError("not_found", "Plugin not found.");
    const current = toReg(rows[0]);
    if (current.manifestDigest !== input.manifestDigest) throw new ControlStoreError("digest_mismatch", "The manifest changed since you reviewed it.", { pluginId: current.pluginId });
    if (current.status !== "pending_review") throw new ControlStoreError("invalid_state", `This plugin is ${current.status}; only a pending plugin can be reviewed.`, { status: current.status });
    const status: PluginStatus = input.decision === "approve" ? "approved" : "rejected";
    const manifest = current.manifest as { capabilities?: { tools?: string[]; scopes?: string[] } };
    const declaredTools = manifest.capabilities?.tools ?? [];
    const declaredScopes = manifest.capabilities?.scopes ?? [];
    const tools = input.decision === "approve" ? [...new Set(input.tools)] : [];
    const scopes = input.decision === "approve" ? [...new Set(input.scopes)] : [];
    if (input.decision === "approve") {
      if (!tools.length || !tools.every((t) => declaredTools.includes(t))) throw new ControlStoreError("invalid_input", "Approved tools must be a non-empty subset of the declared tools.", { field: "tools" });
      if (!scopes.includes("read") || !scopes.every((s) => declaredScopes.includes(s))) throw new ControlStoreError("invalid_input", "Approved scopes must include read and be a subset of the requested scopes.", { field: "scopes" });
    }
    const updated = await tx.query<RegRow>(
      `update platform.plugin_registrations set status=$3, approved_tools=$4::text::jsonb, approved_scopes=$5::text::jsonb, reviewed_by=$6, reviewed_at=clock_timestamp()
       where workspace_id=$1 and id=$2 and status='pending_review' returning ${REG_COLUMNS}`,
      [ws, id, status, json(tools), json(scopes), requireText("reviewedBy", input.reviewedBy)]
    );
    if (!updated.length) throw new ControlStoreError("conflict", "Plugin state changed concurrently; reload and retry.");
    await audit(tx, ws, id, input.decision === "approve" ? "approved" : "rejected", input.reviewedBy, { manifestDigest: input.manifestDigest, tools, scopes });
    return toReg(updated[0]);
  });
}

/** Revoke a registration and every grant of it in one transaction. Idempotent: an already revoked plugin returns itself with 0 newly revoked grants. */
export async function revoke(sql: Sql, input: { workspaceId: string; id: string; revokedBy: string; reason: string }): Promise<{ registration: PluginRegistration; grantsRevoked: number }> {
  const ws = requireText("workspaceId", input.workspaceId);
  const id = requireText("id", input.id);
  return sql.tx(async (tx) => {
    const rows = await tx.query<RegRow>(`select ${REG_COLUMNS} from platform.plugin_registrations where workspace_id=$1 and id=$2 for update`, [ws, id]);
    if (!rows.length) throw new ControlStoreError("not_found", "Plugin not found.");
    if (rows[0].status === "revoked") return { registration: toReg(rows[0]), grantsRevoked: 0 };
    const updated = await tx.query<RegRow>(
      `update platform.plugin_registrations set status='revoked', revoked_by=$3, revoked_at=clock_timestamp(), revoke_reason=$4 where workspace_id=$1 and id=$2 returning ${REG_COLUMNS}`,
      [ws, id, requireText("revokedBy", input.revokedBy), requireText("reason", input.reason, 500)]
    );
    const revoked = await tx.query<{ id: string }>(`update platform.plugin_grants set revoked_at=clock_timestamp() where workspace_id=$1 and registration_id=$2 and revoked_at is null returning id`, [ws, id]);
    await audit(tx, ws, id, "revoked", input.revokedBy, { reason: input.reason.slice(0, 500), grantsRevoked: revoked.length });
    return { registration: toReg(updated[0]), grantsRevoked: revoked.length };
  });
}

export interface CreateGrantInput {
  workspaceId: string;
  registrationId: string;
  tokenHash: string;
  audience: string;
  credentialId: string;
  subject: string;
  scopes: readonly string[];
  projectIds: readonly string[];
  environmentIds?: readonly string[];
  expiresAt: string;
  createdBy: string;
}

export const MAX_ACTIVE_GRANTS_PER_PLUGIN = 20;

/** Create a grant only for an `approved` registration; the check and insert are one statement. */
export async function createGrant(sql: Sql, input: CreateGrantInput): Promise<PluginGrantRecord> {
  const ws = requireText("workspaceId", input.workspaceId);
  const registrationId = requireText("registrationId", input.registrationId);
  return sql.tx(async (tx) => {
    const active = await tx.query<{ n: number | string }>(
      "select count(*) as n from platform.plugin_grants where workspace_id=$1 and registration_id=$2 and revoked_at is null and expires_at > clock_timestamp()",
      [ws, registrationId]
    );
    if (Number(active[0]?.n ?? 0) >= MAX_ACTIVE_GRANTS_PER_PLUGIN) throw new ControlStoreError("conflict", "Revoke an existing plugin token before issuing another.", { limit: MAX_ACTIVE_GRANTS_PER_PLUGIN });
    const id = newId("pgr");
    const rows = await tx.query<GrantRow>(
      `insert into platform.plugin_grants (id, workspace_id, registration_id, token_hash, audience, credential_id, subject, scopes, project_ids, environment_ids, created_by, expires_at)
       select $1,$2,r.id,$4,$5,$6,$7,$8::text::jsonb,$9::text::jsonb,$10::text::jsonb,$11,$12::timestamptz
       from platform.plugin_registrations r where r.workspace_id=$2 and r.id=$3 and r.status='approved'
       returning ${GRANT_COLUMNS}`,
      [id, ws, registrationId, input.tokenHash, input.audience, input.credentialId, input.subject, json(input.scopes), json(input.projectIds), input.environmentIds ? json(input.environmentIds) : null, input.createdBy, input.expiresAt]
    );
    if (!rows.length) throw new ControlStoreError("invalid_state", "Only an approved plugin can be issued a token.");
    await audit(tx, ws, registrationId, "grant_issued", input.createdBy, { grantId: id, credentialId: input.credentialId, expiresAt: input.expiresAt });
    return toGrant(rows[0]);
  });
}

export async function listGrants(sql: Sql, workspaceId: string, registrationId?: string): Promise<PluginGrantRecord[]> {
  const ws = requireText("workspaceId", workspaceId);
  const rows = registrationId
    ? await sql.query<GrantRow>(`select ${GRANT_COLUMNS} from platform.plugin_grants where workspace_id=$1 and registration_id=$2 order by created_at desc limit 200`, [ws, registrationId])
    : await sql.query<GrantRow>(`select ${GRANT_COLUMNS} from platform.plugin_grants where workspace_id=$1 order by created_at desc limit 200`, [ws]);
  return rows.map(toGrant);
}

/** Revoke one grant. Returns false for an unknown, foreign or already revoked grant. */
export async function revokeGrant(sql: Sql, input: { workspaceId: string; grantId: string; revokedBy: string }): Promise<boolean> {
  const ws = requireText("workspaceId", input.workspaceId);
  const rows = await sql.query<{ registration_id: string }>(
    "update platform.plugin_grants set revoked_at=clock_timestamp() where workspace_id=$1 and id=$2 and revoked_at is null returning registration_id",
    [ws, requireText("grantId", input.grantId)]
  );
  if (!rows.length) return false;
  await audit(sql, ws, rows[0].registration_id, "grant_revoked", input.revokedBy, { grantId: input.grantId });
  return true;
}

export interface ResolvedPluginGrant {
  grant: PluginGrantRecord;
  registration: PluginRegistration;
}

/**
 * Authentication lookup: the grant matching `tokenHash`, only while the grant is
 * unrevoked and unexpired AND its registration is `approved`. Anything else
 * answers `null`, with the reason available through `diagnose` for the audit trail.
 */
export async function resolveGrantByTokenHash(sql: Sql, tokenHash: string): Promise<ResolvedPluginGrant | null> {
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) return null;
  const rows = await sql.query<GrantRow & { g_id: string }>(
    `select g.id, g.workspace_id, g.registration_id, g.audience, g.credential_id, g.subject, g.scopes, g.project_ids, g.environment_ids, g.created_by, g.created_at, g.expires_at, g.revoked_at, g.last_used_at, g.id as g_id
     from platform.plugin_grants g join platform.plugin_registrations r on r.id=g.registration_id and r.workspace_id=g.workspace_id
     where g.token_hash=$1 and g.revoked_at is null and g.expires_at > clock_timestamp() and r.status='approved'`,
    [tokenHash]
  );
  if (!rows.length) return null;
  const grant = toGrant(rows[0]);
  const reg = await get(sql, grant.workspaceId, grant.registrationId);
  return reg ? { grant, registration: reg } : null;
}

/** Why a token hash does not resolve (for a precise, still secret-free refusal). */
export async function diagnoseTokenHash(sql: Sql, tokenHash: string): Promise<"unknown" | "grant_revoked" | "grant_expired" | "plugin_revoked" | "plugin_not_approved"> {
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) return "unknown";
  const rows = await sql.query<{ revoked_at: unknown; expired: boolean; status: PluginStatus }>(
    `select g.revoked_at, g.expires_at <= clock_timestamp() as expired, r.status
     from platform.plugin_grants g join platform.plugin_registrations r on r.id=g.registration_id and r.workspace_id=g.workspace_id where g.token_hash=$1`,
    [tokenHash]
  );
  if (!rows.length) return "unknown";
  const r = rows[0];
  if (r.status === "revoked") return "plugin_revoked";
  if (r.status !== "approved") return "plugin_not_approved";
  if (r.revoked_at) return "grant_revoked";
  return r.expired ? "grant_expired" : "unknown";
}

/** Best-effort last-used stamp; never able to deny a request. */
export async function touchGrant(sql: Sql, workspaceId: string, grantId: string): Promise<void> {
  await sql.query("update platform.plugin_grants set last_used_at=clock_timestamp() where workspace_id=$1 and id=$2", [workspaceId, grantId]);
}

/** Token-keyed classification, including revoked grants. A known child must
 * never fall through to the general credential authority after revocation. */
export async function hasGrantTokenHash(sql: Sql, tokenHash: string): Promise<boolean> {
  const rows = await sql.query("select id from platform.plugin_grants where token_hash=$1 limit 1", [tokenHash]);
  return rows.length === 1;
}

export async function listEvents(sql: Sql, workspaceId: string, registrationId: string, limit = 100): Promise<PluginEvent[]> {
  const n = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const rows = await sql.query<{ id: string; registration_id: string; kind: string; actor: string; detail: unknown; created_at: unknown }>(
    "select id, registration_id, kind, actor, detail, created_at from platform.plugin_events where workspace_id=$1 and registration_id=$2 order by created_at, id limit $3",
    [requireText("workspaceId", workspaceId), requireText("registrationId", registrationId), n]
  );
  return rows.map((r) => ({ id: r.id, registrationId: r.registration_id, kind: r.kind, actor: r.actor, detail: parseJson<Record<string, unknown>>(r.detail), createdAt: iso(r.created_at) }));
}
