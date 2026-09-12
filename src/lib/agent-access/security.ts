/** Agent-reader credentials are operator-issued, scoped and never browser cookies. */
import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
export class AgentError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 403) {
    super(message); this.name = "AgentError"; this.code = code; this.status = status;
  }
}
export interface Credential {
  id: string; tokenHash: string; subject: string; workspaceId: string;
  projectIds: string[]; environmentIds?: string[];
  scopes: ("read" | "plan" | "export")[]; issuedAt: string; expiresAt: string;
}
export interface SelectedScope { workspaceId: string; projectId?: string; environmentId?: string }
export const object = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const identifier = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(x);
const identifiers = (x: unknown): x is string[] => Array.isArray(x) && x.length <= 100 && x.every(identifier) && new Set(x).size === x.length;
export function parseCredentials(value: unknown): Credential[] {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.credentials) || value.credentials.length > 100 || Object.keys(value).some(k => !["version", "credentials"].includes(k)))
    throw new AgentError("policy_unavailable", "The operator must repair the version-1 credential file.", 503);
  const ids = new Set(); const hashes = new Set();
  for (const row of value.credentials) {
    const valid = object(row) && Object.keys(row).every(k => ["id", "tokenHash", "subject", "workspaceId", "projectIds", "environmentIds", "scopes", "issuedAt", "expiresAt"].includes(k))
      && identifier(row.id) && identifier(row.subject) && !["local", "navigator", "system"].includes(row.subject)
      && identifier(row.workspaceId) && identifiers(row.projectIds) && row.projectIds.length > 0
      && (row.environmentIds === undefined || identifiers(row.environmentIds))
      && typeof row.tokenHash === "string" && /^[0-9a-f]{64}$/.test(row.tokenHash)
      && Array.isArray(row.scopes) && row.scopes.length <= 3 && row.scopes.includes("read")
      && row.scopes.every(s => ["read", "plan", "export"].includes(String(s)))
      && typeof row.issuedAt === "string" && typeof row.expiresAt === "string"
      && Number.isFinite(Date.parse(row.issuedAt)) && Number.isFinite(Date.parse(row.expiresAt))
      && Date.parse(row.expiresAt) > Date.parse(row.issuedAt)
      && Date.parse(row.expiresAt) - Date.parse(row.issuedAt) <= 30 * 86400000;
    if (!valid || ids.has(row.id) || hashes.has(row.tokenHash))
      throw new AgentError("policy_unavailable", "The operator must repair invalid or duplicate credential records.", 503);
    ids.add(row.id); hashes.add(row.tokenHash);
  }
  return value.credentials as Credential[];
}
export async function loadCredentials(path: string): Promise<Credential[]> {
  if (!isAbsolute(path)) throw new AgentError("policy_unavailable", "Configure an absolute private credential-file path.", 503);
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const s = await file.stat();
    if (!s.isFile() || s.size > 65536 || process.platform === "win32" || (s.mode & 0o077) !== 0 || s.uid !== process.getuid!())
      throw new Error("unsafe credential file");
    // A file can grow after stat; cap the actual read too.
    const bytes = Buffer.alloc(65537);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 65536) throw new Error("credential file too large");
    return parseCredentials(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError("policy_unavailable", "Credential authority unavailable. Check the private file, ownership, POSIX permissions and JSON; access is denied.", 503);
  } finally { await file?.close(); }
}
export function authenticate(header: string | null, records: Credential[], now = Date.now()): Credential {
  if (!header || !/^Bearer za_[A-Za-z0-9_-]{43}$/.test(header))
    throw new AgentError("unauthorized", "Supply an unexpired scoped Zenith agent credential.", 401);
  const digest = createHash("sha256").update(header.slice(7)).digest();
  let found: Credential | undefined;
  for (const record of records) if (timingSafeEqual(digest, Buffer.from(record.tokenHash, "hex"))) found = record;
  if (!found || Date.parse(found.expiresAt) <= now || Date.parse(found.issuedAt) > now)
    throw new AgentError("unauthorized", "Credential invalid, expired, or revoked. Ask the operator for a scoped replacement.", 401);
  return found;
}
export function selectScope(headers: Headers, grant: Credential): SelectedScope {
  const workspaceId = headers.get("x-zenith-workspace");
  const projectId = headers.get("x-zenith-project") ?? undefined;
  const environmentId = headers.get("x-zenith-environment") ?? undefined;
  if (workspaceId !== grant.workspaceId || !identifier(workspaceId) || projectId !== undefined && (!identifier(projectId) || !grant.projectIds.includes(projectId))
    || environmentId !== undefined && (!identifier(environmentId) || !projectId || grant.environmentIds !== undefined && !grant.environmentIds.includes(environmentId)))
    throw new AgentError("scope_denied", "Select identifiers permitted by this credential; browser workspace selection is not used.");
  return { workspaceId, ...(projectId ? { projectId } : {}), ...(environmentId ? { environmentId } : {}) };
}
/** Conservative projection. Free-form logs are not exposed by this profile. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 30) return "[depth limit]";
  if (typeof value === "string") return value
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/za_[A-Za-z0-9_-]{43}/g, "[redacted]")
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[redacted]@")
    .replace(/sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g, "[redacted]");
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key,
    key === "secretRef" && typeof v === "string" && v.startsWith("vault:") ? v
      : /^(value|input|authorization|cookie|set-cookie)$/i.test(key) || /password|secret|token|credential|api.?key/i.test(key)
        ? "[redacted]" : redact(v, depth + 1)]));
}
