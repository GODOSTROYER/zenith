/** Durable tenant-scoped bindings and single-use, expiring install intents. */
import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "@/lib/controlplane/types";
import { GithubSourceError, identifier, numericId, repository, type GithubRepository, type GithubSourceBinding } from "./types";

export const INSTALL_LIFETIME_MS = 10 * 60 * 1000;
export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
interface IntentRow {
  owner: string; repo: string; expected_version: number; installation_id: number | null;
}
interface BindingRow {
  workspace_id: string; owner: string; repo: string; app_id: string;
  installation_id: number; repository_id: number; version: number;
}
export interface InstallCaller { workspaceId: string; actorId: string; browserProof: string; state: string }
function proof(value: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new GithubSourceError("refused");
  return digest(value);
}
function keys(input: InstallCaller): readonly string[] {
  return [identifier(input.workspaceId), proof(input.state), identifier(input.actorId), proof(input.browserProof)];
}
function binding(row: BindingRow): GithubSourceBinding {
  if (!/^[1-9]\d{0,15}$/.test(row.app_id) || !Number.isSafeInteger(row.version) || row.version <= 0) throw new GithubSourceError("unavailable");
  return { workspaceId: identifier(row.workspace_id), ...repository(row.owner, row.repo), appId: row.app_id, installationId: numericId(Number(row.installation_id)), repositoryId: numericId(Number(row.repository_id)), version: row.version };
}
export function createGithubSourceStore(db: Sql) {
  const store = {
    async getBinding(workspaceId: string): Promise<GithubSourceBinding | undefined> {
      const rows = await db.query<BindingRow>("select workspace_id, app_id, installation_id, repository_id, owner, repo, version from platform.github_source_bindings where workspace_id = $1", [identifier(workspaceId)]);
      return rows[0] ? binding(rows[0]) : undefined;
    },
    async begin(workspaceId: string, actorId: string, repo: GithubRepository): Promise<{ state: string; browserProof: string }> {
      identifier(workspaceId); identifier(actorId); const location = repository(repo.owner, repo.repo);
      const state = randomBytes(32).toString("base64url"); const browserProof = randomBytes(32).toString("base64url");
      await db.tx(async (tx) => {
        // Expired rows are removed only in the current workspace.
        await tx.query("delete from platform.github_install_intents where workspace_id = $1 and expires_at <= clock_timestamp()", [workspaceId]);
        const current = await createGithubSourceStore(tx).getBinding(workspaceId);
        await tx.query(`insert into platform.github_install_intents
          (workspace_id, state_digest, actor_id, browser_digest, owner, repo, expected_version, phase, expires_at)
          values ($1, $2, $3, $4, $5, $6, $7, 'install', clock_timestamp() + interval '10 minutes')`,
        [workspaceId, digest(state), actorId, digest(browserProof), location.owner, location.repo, current?.version ?? 0]);
      });
      return { state, browserProof };
    },
    async authorize(input: InstallCaller, installationId: number): Promise<void> {
      numericId(installationId);
      const rows = await db.query(`update platform.github_install_intents set phase = 'oauth', installation_id = $5
        where workspace_id = $1 and state_digest = $2 and actor_id = $3 and browser_digest = $4
        and phase = 'install' and expires_at > clock_timestamp() returning state_digest`, [...keys(input), installationId]);
      if (rows.length !== 1) throw new GithubSourceError("refused");
    },
    async consume(input: InstallCaller): Promise<GithubRepository & { installationId: number; expectedVersion: number }> {
      // Consume BEFORE external HTTP: duplicate callbacks cannot redeem or bind twice.
      const rows = await db.query<IntentRow>(`delete from platform.github_install_intents
        where workspace_id = $1 and state_digest = $2 and actor_id = $3 and browser_digest = $4
        and phase = 'oauth' and expires_at > clock_timestamp()
        returning owner, repo, installation_id, expected_version`, keys(input));
      if (rows.length !== 1) throw new GithubSourceError("refused");
      return { ...repository(rows[0].owner, rows[0].repo), installationId: numericId(Number(rows[0].installation_id)), expectedVersion: rows[0].expected_version };
    },
    async bind(input: Omit<GithubSourceBinding, "version"> & { actorId: string; expectedVersion: number }): Promise<GithubSourceBinding> {
      const repo = repository(input.owner, input.repo);
      identifier(input.workspaceId); identifier(input.actorId); numericId(input.installationId); numericId(input.repositoryId);
      if (!/^[1-9]\d{0,15}$/.test(input.appId) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new GithubSourceError("invalid");
      const params = [input.workspaceId, input.appId, input.installationId, input.repositoryId, repo.owner, repo.repo, input.actorId, input.expectedVersion];
      const rows = await db.query<BindingRow>(input.expectedVersion === 0
        ? `insert into platform.github_source_bindings (workspace_id, app_id, installation_id, repository_id, owner, repo, bound_by, version)
           values ($1, $2, $3, $4, $5, $6, $7, 1) on conflict (workspace_id) do nothing
           returning workspace_id, app_id, installation_id, repository_id, owner, repo, version`
        : `update platform.github_source_bindings set app_id = $2, installation_id = $3, repository_id = $4, owner = $5, repo = $6,
           bound_by = $7, version = version + 1, updated_at = clock_timestamp() where workspace_id = $1 and version = $8
           returning workspace_id, app_id, installation_id, repository_id, owner, repo, version`,
      input.expectedVersion === 0 ? params.slice(0, 7) : params);
      if (rows.length !== 1) throw new GithubSourceError("conflict");
      return binding(rows[0]);
    },
  };
  return store;
}
