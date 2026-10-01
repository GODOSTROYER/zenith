/**
 * Permanent release launch claims in the existing platform idempotency table.
 * Unlike API request retries, a migration must NEVER become launchable after
 * a TTL. These namespaced rows use PostgreSQL timestamptz infinity and are not
 * reclaimed/pruned by the API idempotency repository. No new table or schema.
 * Every query scopes workspace AND a digest of environment/key; only cloud
 * identifiers are recorded, never sessions, source bytes, commands or SAS.
 */
import type { Sql } from "@/lib/controlplane/types";
import { digest } from "@/lib/controlplane/digest";
import type { LaunchJournal, LaunchScope } from "./support";

function identity(scope: LaunchScope): { key: string; hash: string } {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(scope.workspaceId) || !/^[A-Za-z0-9_-]{1,128}$/.test(scope.environmentId) || !/^[a-f0-9]{64}$/.test(scope.key)) throw new Error("Invalid Azure launch journal scope.");
  const hash = digest([scope.environmentId, scope.key]);
  return { key: `release:azure:${hash}`, hash };
}
function validateReference(raw: string): void {
  if (typeof raw !== "string" || raw.length > 4000 || /[?#\r\n\\]/.test(raw)) throw new Error("Invalid Azure launch journal reference.");
  if (raw.startsWith("/subscriptions/")) {
    if (!/^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[A-Za-z0-9_.()-]+\/providers\/Microsoft\.App\/jobs\/[a-z0-9-]+\/executions\/[a-z0-9-]+$/i.test(raw)) throw new Error("Invalid Azure execution reference.");
    return;
  }
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(raw); } catch { throw new Error("Invalid Azure build reference."); }
  const keys = ["version", "scope", "runId", "registryId", "registryAddress", "loginServer", "repository", "tag"];
  if (Object.keys(obj).length !== keys.length || Object.keys(obj).some((k) => !keys.includes(k)) || obj.version !== 1 || typeof obj.scope !== "string" || !/^[a-f0-9]{64}$/.test(obj.scope) || typeof obj.runId !== "string" || !/^[A-Za-z0-9]{1,32}$/.test(obj.runId) || typeof obj.registryId !== "string" || !/^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[A-Za-z0-9_.()-]+\/providers\/Microsoft\.ContainerRegistry\/registries\/[a-z0-9]{5,50}$/i.test(obj.registryId) || typeof obj.registryAddress !== "string" || !/^[a-z_]+\/[A-Za-z0-9_.-]+$/.test(obj.registryAddress) || typeof obj.loginServer !== "string" || !/^[a-z0-9]{5,50}\.azurecr\.io$/.test(obj.loginServer) || typeof obj.repository !== "string" || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(obj.repository) || typeof obj.tag !== "string" || !/^zn-[a-f0-9]{64}$/.test(obj.tag)) throw new Error("Invalid Azure build reference.");
}

export function createLaunchJournal(sql: Sql): LaunchJournal {
  return {
    async claim(scope) {
      const { key, hash } = identity(scope);
      const claimed = await sql.query<{ key: string }>(
        `insert into platform.idempotency_keys (workspace_id, key, request_hash, expires_at)
         values ($1, $2, $3, 'infinity'::timestamptz)
         on conflict (workspace_id, key) do nothing returning key`, [scope.workspaceId, key, hash]);
      return claimed.length === 1;
    },
    async record(scope, reference) {
      const { key, hash } = identity(scope); validateReference(reference);
      const response = JSON.stringify({ reference });
      const saved = await sql.query<{ key: string }>(
        `update platform.idempotency_keys set response = $4::text::jsonb
         where workspace_id = $1 and key = $2 and request_hash = $3
           and expires_at = 'infinity'::timestamptz
           and (response is null or response = $4::text::jsonb) returning key`, [scope.workspaceId, key, hash, response]);
      if (saved.length !== 1) throw new Error("Azure launch receipt was not persisted consistently.");
    },
    async read(scope) {
      const { key, hash } = identity(scope);
      const rows = await sql.query<{ response: { reference?: unknown } | null }>(
        `select response from platform.idempotency_keys
         where workspace_id = $1 and key = $2 and request_hash = $3 and expires_at = 'infinity'::timestamptz`, [scope.workspaceId, key, hash]);
      if (rows.length !== 1 || rows[0].response === null) return undefined;
      const reference = rows[0].response?.reference;
      if (typeof reference !== "string") throw new Error("Azure launch receipt is malformed.");
      validateReference(reference); return reference;
    },
  };
}
