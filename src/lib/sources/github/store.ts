/** Durable tenant-scoped bindings and single-use, expiring install intents. */
import { createHash, randomBytes } from "node:crypto";
import type { PlatformDb, Sql } from "@/lib/controlplane/types";
import { GithubSourceError, identifier, numericId, repository, type GithubRepository, type GithubSourceBinding } from "./types";
import { assertGithubWebhookFence, captureGithubWebhookFence } from "./webhook-store";

export const INSTALL_LIFETIME_MS = 10 * 60 * 1000;
export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
interface IntentRow {
  owner: string; repo: string; expected_version: number; installation_id: number | null;
  app_id: string | null; installation_generation: string | null;
}
interface BindingRow {
  workspace_id: string; owner: string; repo: string; app_id: string;
  installation_id: number; repository_id: number; version: number;
  revoked_at: Date | string | null;
}
export interface GithubBindingState { binding: GithubSourceBinding; revoked: boolean }
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
async function recordBindingEvent(db: Sql, value: GithubSourceBinding, action: "bound" | "revoked", actorId: string): Promise<void> {
  await db.query(`insert into platform.github_binding_events
    (workspace_id, version, action, actor_id, app_id, installation_id, repository_id, owner, repo)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
  [value.workspaceId, value.version, action, actorId, value.appId, value.installationId, value.repositoryId, value.owner, value.repo]);
}
export function createGithubSourceStore(db: Sql, backendKind = (db as Partial<PlatformDb>).kind) {
  function mutationBackend(): "postgres" | "pglite" {
    if (backendKind !== "postgres" && backendKind !== "pglite") throw new GithubSourceError("unavailable");
    return backendKind;
  }
  const store = {
    async getState(workspaceId: string): Promise<GithubBindingState | undefined> {
      const rows = await db.query<BindingRow>("select workspace_id, app_id, installation_id, repository_id, owner, repo, version, revoked_at from platform.github_source_bindings where workspace_id = $1", [identifier(workspaceId)]);
      return rows[0] ? { binding: binding(rows[0]), revoked: rows[0].revoked_at != null } : undefined;
    },
    async getBinding(workspaceId: string): Promise<GithubSourceBinding | undefined> {
      const current = await store.getState(workspaceId);
      // A revoked binding is not a missing public-source binding.
      if (current?.revoked) throw new GithubSourceError("refused");
      return current?.binding;
    },
    async assertCurrent(expected: GithubSourceBinding): Promise<void> {
      const current = await store.getBinding(expected.workspaceId);
      if (!current || current.version !== expected.version || current.appId !== expected.appId ||
        current.installationId !== expected.installationId || current.repositoryId !== expected.repositoryId ||
        current.owner !== expected.owner || current.repo !== expected.repo) throw new GithubSourceError("refused");
    },
    async revoke(input: { workspaceId: string; actorId: string; expectedVersion: number }): Promise<void> {
      mutationBackend();
      identifier(input.workspaceId); identifier(input.actorId);
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion <= 0) throw new GithubSourceError("invalid");
      await db.tx(async (tx) => {
        const rows = await tx.query<BindingRow>(`update platform.github_source_bindings
          set revoked_at = clock_timestamp(), revoked_by = $2, version = version + 1, updated_at = clock_timestamp()
          where workspace_id = $1 and version = $3 and revoked_at is null
          returning workspace_id, app_id, installation_id, repository_id, owner, repo, version`,
        [input.workspaceId, input.actorId, input.expectedVersion]);
        if (rows.length !== 1) throw new GithubSourceError("conflict");
        await recordBindingEvent(tx, binding(rows[0]), "revoked", input.actorId);
        // Includes pending callbacks; already-consumed callbacks lose the version CAS.
        await tx.query("delete from platform.github_install_intents where workspace_id = $1", [input.workspaceId]);
      });
    },
    async begin(workspaceId: string, actorId: string, repo: GithubRepository): Promise<{ state: string; browserProof: string }> {
      mutationBackend();
      identifier(workspaceId); identifier(actorId); const location = repository(repo.owner, repo.repo);
      const state = randomBytes(32).toString("base64url"); const browserProof = randomBytes(32).toString("base64url");
      await db.tx(async (tx) => {
        // Expired rows are removed only in the current workspace.
        await tx.query("delete from platform.github_install_intents where workspace_id = $1 and expires_at <= clock_timestamp()", [workspaceId]);
        const current = await createGithubSourceStore(tx, backendKind).getState(workspaceId);
        await tx.query(`insert into platform.github_install_intents
          (workspace_id, state_digest, actor_id, browser_digest, owner, repo, expected_version, phase, expires_at)
          values ($1, $2, $3, $4, $5, $6, $7, 'install', clock_timestamp() + interval '10 minutes')`,
        [workspaceId, digest(state), actorId, digest(browserProof), location.owner, location.repo, current?.binding.version ?? 0]);
      });
      return { state, browserProof };
    },
    async authorize(input: InstallCaller, installationId: number, appId: string): Promise<void> {
      const kind = mutationBackend();
      numericId(installationId);
      const caller = keys(input);
      await db.tx(async tx => {
        // All writers take installation before tenant; never reverse this order.
        const fence = await captureGithubWebhookFence(tx, appId, installationId);
        if (kind === "postgres") await tx.query("select pg_advisory_xact_lock(hashtextextended('zenith:github-binding:' || $1::text, 0))", [input.workspaceId]);
        const rows = await tx.query(`update platform.github_install_intents
          set phase = 'oauth', installation_id = $5, app_id = $6, installation_generation = $7::bigint
          where workspace_id = $1 and state_digest = $2 and actor_id = $3 and browser_digest = $4
          and phase = 'install' and expires_at > clock_timestamp() returning state_digest`,
        [...caller, installationId, appId, fence.generation]);
        if (rows.length !== 1) throw new GithubSourceError("refused");
      });
    },
    async consume(input: InstallCaller): Promise<GithubRepository & { installationId: number; expectedVersion: number; appId: string; installationGeneration: string }> {
      mutationBackend();
      // Consume BEFORE external HTTP: duplicate callbacks cannot redeem or bind twice.
      const rows = await db.query<IntentRow>(`delete from platform.github_install_intents
        where workspace_id = $1 and state_digest = $2 and actor_id = $3 and browser_digest = $4
        and phase = 'oauth' and expires_at > clock_timestamp()
        returning owner, repo, installation_id, expected_version, app_id, installation_generation::text as installation_generation`, keys(input));
      if (rows.length !== 1) throw new GithubSourceError("refused");
      const row = rows[0];
      // Historical pending callbacks have no captured fence; start again.
      if (!row.app_id || !/^[1-9]\d{0,15}$/.test(row.app_id) || row.installation_generation == null || !/^(0|[1-9]\d{0,18})$/.test(row.installation_generation)) throw new GithubSourceError("refused");
      return { ...repository(row.owner, row.repo), installationId: numericId(Number(row.installation_id)), expectedVersion: row.expected_version, appId: row.app_id, installationGeneration: row.installation_generation };
    },
    async bind(input: Omit<GithubSourceBinding, "version"> & { actorId: string; expectedVersion: number; installationGeneration: string }): Promise<GithubSourceBinding> {
      const kind = mutationBackend();
      const repo = repository(input.owner, input.repo);
      identifier(input.workspaceId); identifier(input.actorId); numericId(input.installationId); numericId(input.repositoryId);
      if (!/^[1-9]\d{0,15}$/.test(input.appId) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new GithubSourceError("invalid");
      const params = [input.workspaceId, input.appId, input.installationId, input.repositoryId, repo.owner, repo.repo, input.actorId, input.expectedVersion];
      return db.tx(async (tx) => {
        await assertGithubWebhookFence(tx, { appId: input.appId, installationId: input.installationId, generation: input.installationGeneration });
        if (kind === "postgres") await tx.query("select pg_advisory_xact_lock(hashtextextended('zenith:github-binding:' || $1::text, 0))", [input.workspaceId]);
        const rows = await tx.query<BindingRow>(input.expectedVersion === 0
          ? `insert into platform.github_source_bindings (workspace_id, app_id, installation_id, repository_id, owner, repo, bound_by, version)
             values ($1, $2, $3, $4, $5, $6, $7, 1) on conflict (workspace_id) do nothing
             returning workspace_id, app_id, installation_id, repository_id, owner, repo, version`
          : `update platform.github_source_bindings set app_id = $2, installation_id = $3, repository_id = $4, owner = $5, repo = $6,
             bound_by = $7, version = version + 1, revoked_at = null, revoked_by = null, updated_at = clock_timestamp() where workspace_id = $1 and version = $8
             returning workspace_id, app_id, installation_id, repository_id, owner, repo, version`,
        input.expectedVersion === 0 ? params.slice(0, 7) : params);
        if (rows.length !== 1) throw new GithubSourceError("conflict");
        const value = binding(rows[0]);
        await recordBindingEvent(tx, value, "bound", input.actorId);
        return value;
      });
    },
  };
  return store;
}
