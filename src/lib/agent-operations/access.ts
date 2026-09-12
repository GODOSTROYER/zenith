/** Two explicit identities: scoped agents and an independent local operator.
 * Remote bearer validation delegates to a maintained OAuth provider's RFC 7662
 * introspection endpoint. Zenith never implements an authorization-code server.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { OperationError, canonical, digest, type Owner } from "./journal";
import type { Credential, SelectedScope } from "../agent-access/security";

export const SCOPES = ["read", "plan", "export", "execute", "publish", "logs"] as const;
export type ScopeName = typeof SCOPES[number];
export interface AgentGrant {
  id: string; kind: "opaque" | "oauth"; subject: string; workspaceId: string;
  projectIds: string[]; environmentIds?: string[]; appIds?: string[]; scopes: ScopeName[];
  issuedAt: string; expiresAt: string; tokenHash?: string;
  oauthSubject?: string; oauthClientId?: string; issuer?: string;
  authorityHash?: string;
}
export const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(v);
const ids = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 100 && v.every(identifier) && new Set(v).size === v.length;
const unavailable = () => new OperationError("policy_unavailable", "Agent authority is unavailable. Check the private credential file or authorization-provider configuration; access is denied.", 503);
export async function privateBytes(path: string, maxBytes = 65536): Promise<Buffer> {
  if (!isAbsolute(path) || process.platform === "win32") throw unavailable();
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077) || stat.size > maxBytes) throw unavailable();
    const bytes = Buffer.alloc(maxBytes + 1); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxBytes) throw unavailable();
    return bytes.subarray(0, bytesRead);
  } catch { throw unavailable(); } finally { await file?.close(); }
}
export function parseGrants(value: unknown): AgentGrant[] {
  if (!object(value) || value.version !== 2 || Object.keys(value).some(k => !["version", "grants"].includes(k)) || !Array.isArray(value.grants) || value.grants.length > 100) throw unavailable();
  const names = new Set<string>(), tokens = new Set<string>();
  for (const item of value.grants) {
    if (!object(item) || Object.keys(item).some(k => !["id", "kind", "subject", "workspaceId", "projectIds", "environmentIds", "appIds", "scopes", "issuedAt", "expiresAt", "tokenHash", "oauthSubject", "oauthClientId", "issuer"].includes(k))
      || !identifier(item.id) || !identifier(item.subject) || ["local", "navigator", "system"].includes(item.subject)
      || !identifier(item.workspaceId) || !ids(item.projectIds) || item.environmentIds !== undefined && !ids(item.environmentIds) || item.appIds !== undefined && !ids(item.appIds)
      || !Array.isArray(item.scopes) || !item.scopes.includes("read") || item.scopes.length > SCOPES.length || new Set(item.scopes).size !== item.scopes.length || item.scopes.some(s => !(SCOPES as readonly unknown[]).includes(s))
      || typeof item.issuedAt !== "string" || typeof item.expiresAt !== "string" || !Number.isFinite(Date.parse(item.issuedAt)) || !Number.isFinite(Date.parse(item.expiresAt))
      || Date.parse(item.expiresAt) <= Date.parse(item.issuedAt) || Date.parse(item.expiresAt) - Date.parse(item.issuedAt) > 30 * 86400000)
      throw unavailable();
    if (names.has(item.id)) throw unavailable(); names.add(item.id);
    if (item.kind === "opaque") {
      if (typeof item.tokenHash !== "string" || !/^[0-9a-f]{64}$/.test(item.tokenHash) || tokens.has(item.tokenHash) || item.oauthSubject !== undefined || item.oauthClientId !== undefined || item.issuer !== undefined) throw unavailable();
      tokens.add(item.tokenHash);
    } else if (item.kind === "oauth") {
      if (item.tokenHash !== undefined || !identifier(item.oauthSubject) || !identifier(item.oauthClientId) || typeof item.issuer !== "string" || !item.issuer.startsWith("https://")) throw unavailable();
    } else throw unavailable();
  }
  return value.grants as AgentGrant[];
}
export async function loadGrants(path: string): Promise<AgentGrant[]> {
  try { return parseGrants(JSON.parse((await privateBytes(path)).toString("utf8"))); } catch { throw unavailable(); }
}
export function checkGrantTime(grant: AgentGrant, now = Date.now()): void {
  if (Date.parse(grant.issuedAt) > now || Date.parse(grant.expiresAt) <= now) throw new OperationError("unauthorized", "The agent grant is expired or not active. Ask the operator for a scoped replacement.", 401);
}
export function authenticateOpaque(header: string | null, grants: AgentGrant[], now = Date.now()): AgentGrant {
  if (!header || !/^Bearer za_[A-Za-z0-9_-]{43}$/.test(header)) throw new OperationError("unauthorized", "Supply a scoped Zenith agent credential; cookies and operator credentials are not accepted.", 401);
  const hash = createHash("sha256").update(header.slice(7)).digest(); let found: AgentGrant | undefined;
  for (const grant of grants) if (grant.kind === "opaque" && timingSafeEqual(hash, Buffer.from(grant.tokenHash!, "hex"))) found = grant;
  if (!found) throw new OperationError("unauthorized", "The credential is invalid or revoked. Ask the operator to review its grant.", 401);
  checkGrantTime(found, now); return { ...found, authorityHash: digest(found) };
}
export interface OAuthConfig { issuer: string; introspectionUrl: string; clientId: string; clientSecret: string; resource: string }
export function oauthConfig(value: OAuthConfig): OAuthConfig {
  try {
    const issuer = new URL(value.issuer), target = new URL(value.introspectionUrl), resource = new URL(value.resource);
    if ([issuer, target, resource].some(u => u.protocol !== "https:" || u.username || u.password || u.hash || u.search)
      || target.origin !== issuer.origin || !target.pathname.startsWith(issuer.pathname.replace(/\/$/, "") + "/") || !value.clientId || !value.clientSecret) throw unavailable();
    return value;
  } catch { throw unavailable(); }
}
export async function boundedBytes(request: Request | Response, limit: number, timeoutMs = 10000): Promise<Buffer> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader(), chunks: Buffer[] = []; let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { void reader.cancel().catch(() => undefined); reject(new OperationError("body_timeout", "The body did not arrive before its deadline. Retry only a read, or inspect an existing operation before retrying a write.", 408)); }, timeoutMs); });
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), timeout]); if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > limit) { await reader.cancel(); throw new OperationError("body_too_large", `The body exceeds ${limit} bytes. Narrow the request or use the source-upload endpoint.`, 413); }
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks, total);
  } finally { clearTimeout(timer); reader.releaseLock(); }
}
export async function authenticateOAuth(header: string | null, grants: AgentGrant[], rawConfig: OAuthConfig, fetcher: typeof fetch = fetch, now = Date.now()): Promise<AgentGrant> {
  const config = oauthConfig(rawConfig);
  if (!header || !/^Bearer [\x21-\x7e]{20,8192}$/.test(header) || header.startsWith("Bearer za_")) throw new OperationError("unauthorized", "Use an access token issued for this MCP resource through the configured OAuth provider.", 401);
  let claims: Record<string, unknown>;
  try {
    const response = await fetcher(config.introspectionUrl, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000), headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ token: header.slice(7), token_type_hint: "access_token", client_id: config.clientId, client_secret: config.clientSecret }) });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) { await response.body?.cancel(); throw unavailable(); }
    const parsed: unknown = JSON.parse((await boundedBytes(response, 32768, 5000)).toString("utf8"));
    if (!object(parsed)) throw unavailable(); claims = parsed;
  } catch { throw unavailable(); }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.active !== true || claims.iss !== config.issuer || !audience.includes(config.resource)
    || typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= now
    || claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf * 1000 > now)
    || typeof claims.sub !== "string" || typeof claims.client_id !== "string" || typeof claims.scope !== "string")
    throw new OperationError("unauthorized", "The token is inactive, expired, or not issued for this resource. Sign in through the configured authorization provider.", 401);
  const row = grants.find(g => g.kind === "oauth" && g.issuer === config.issuer && g.oauthSubject === claims.sub && g.oauthClientId === claims.client_id);
  if (!row) throw new OperationError("scope_denied", "No Zenith enrollment authorizes this OAuth subject and client. Ask an administrator to create a scoped enrollment.", 403);
  checkGrantTime(row, now);
  const tokenScopes = new Set(claims.scope.split(" "));
  const scopes = row.scopes.filter(s => tokenScopes.has(`zenith:${s}`));
  if (!scopes.includes("read")) throw new OperationError("scope_denied", "The enrollment and token must both authorize zenith:read.", 403);
  return { ...row, scopes, authorityHash: digest({ ...row, scopes }), expiresAt: new Date(Math.min(Date.parse(row.expiresAt), claims.exp * 1000)).toISOString() };
}
export function select(headers: Headers, grant: AgentGrant): SelectedScope {
  const workspaceId = headers.get("x-zenith-workspace") ?? grant.workspaceId;
  const projectId = headers.get("x-zenith-project") ?? undefined, environmentId = headers.get("x-zenith-environment") ?? undefined;
  if (workspaceId !== grant.workspaceId || projectId && (!identifier(projectId) || !grant.projectIds.includes(projectId))
    || environmentId && (!identifier(environmentId) || !projectId || grant.environmentIds && !grant.environmentIds.includes(environmentId)))
    throw new OperationError("scope_denied", "Select only workspace, project and environment identifiers permitted by this grant.", 403);
  return { workspaceId, ...(projectId ? { projectId } : {}), ...(environmentId ? { environmentId } : {}) };
}
export const ownerOf = (grant: AgentGrant, selected: SelectedScope): Owner => ({ subject: grant.subject, credentialId: grant.id, ...selected, authorizationHash: grant.authorityHash ?? digest(grant) });
export const readGrant = (grant: AgentGrant): Credential => ({ ...grant, tokenHash: grant.tokenHash ?? "", scopes: grant.scopes.filter((s): s is "read" | "plan" | "export" => ["read", "plan", "export"].includes(s)) });
export function requireScope(grant: AgentGrant, scope: ScopeName): void {
  checkGrantTime(grant);
  if (!grant.scopes.includes(scope)) throw new OperationError("scope_denied", `This credential does not permit ${scope}. Ask its owner for a narrower approved workflow or an explicitly extended grant.`, 403);
}
export interface ReviewRequest { receiptId: string; subject: string; decision: "inspect" | "approve" | "reject"; digest: string; nonce: string; expiresAt: number }
export async function operatorKey(path: string): Promise<Buffer> {
  const text = (await privateBytes(path, 100)).toString("utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(text)) throw unavailable(); return Buffer.from(text, "hex");
}
export const signReview = (key: Buffer, origin: string, request: ReviewRequest): string => createHmac("sha256", key).update(canonical({ version: 1, origin, path: "/api/agent/v2/review", request })).digest("hex");
export function verifyReview(key: Buffer, origin: string, request: ReviewRequest, signature: string | null, now = Date.now()): void {
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin) || !signature || !/^[0-9a-f]{64}$/.test(signature)
    || !object(request) || Object.keys(request).sort().join(",") !== "decision,digest,expiresAt,nonce,receiptId,subject"
    || !identifier(request.subject) || ["local", "navigator", "system"].includes(request.subject)
    || !["inspect", "approve", "reject"].includes(request.decision) || typeof request.digest !== "string"
    || !Number.isSafeInteger(request.expiresAt) || request.expiresAt <= now || request.expiresAt > now + 60000
    || !timingSafeEqual(Buffer.from(signReview(key, origin, request), "hex"), Buffer.from(signature, "hex")))
    throw new OperationError("operator_auth_required", "An independent control-host operator must review this receipt. Agent bearer credentials, cookies and approval flags cannot authorize this endpoint.", 403);
}
