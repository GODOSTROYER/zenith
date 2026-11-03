/** Durable tenant-scoped bindings and single-use, expiring install intents. */
import { createHash, randomBytes } from "node:crypto";
import type { PlatformDb, Sql } from "@/lib/controlplane/types";
import { GithubSourceError, identifier, numericId, repository, type GithubRepository, type GithubSourceBinding } from "./types";
import { assertGithubWebhookFence, captureGithubWebhookFence } from "./webhook-store";

export const INSTALL_LIFETIME_MS = 10 * 60 * 1000;
export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
interface IntentRow {
  owner: string; repo: string; expected_version: number; installation_id: number | null;
  app_id: string | null; installation_generation: string | null; purpose: "bind" | "discover"; return_to: string | null; expected_repository_id: number | null;
  expected_name_repository_id: number | null; expected_name_version: number | null;
}
interface BindingRow {
  workspace_id: string; owner: string; repo: string; app_id: string;
  installation_id: number; repository_id: number; version: number;
  revoked_at: Date | string | null; binding_id: string;
  revoked_reason?: string | null;
  name_current: boolean;
}
export type GithubRevocationReason = "user_unbind" | "installation_deleted" | "installation_suspended" | "repositories_removed";
export interface GithubBindingState { bindingId: string; binding: GithubSourceBinding; revoked: boolean; revokedReason?: GithubRevocationReason; nameCurrent?: boolean }
export type GithubNameSnapshot = { repositoryId: number; version: number } | null;
export interface GithubBindingPage { bindings: GithubBindingState[]; nextCursor: string | null }
const REASONS: readonly string[] = ["user_unbind", "installation_deleted", "installation_suspended", "repositories_removed"];
export type GithubBindingSelector = { bindingId: string } | { repositoryId: number } | GithubRepository;
export interface GithubDiscoveredRepository extends GithubRepository { repositoryId: number; private: boolean; defaultBranch: string }
export interface GithubDiscoverySession { installationId: number; appId: string; installationGeneration: string; repositories: GithubDiscoveredRepository[]; truncated: boolean; expiresAt: string }
export function githubReturnTo(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value !== "/platform/source" && value !== "/platform/coding-agent") throw new GithubSourceError("invalid");
  return value;
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
function bindingState(row: BindingRow): GithubBindingState {
  return { bindingId: identifier(row.binding_id), binding: binding(row), revoked: row.revoked_at != null, nameCurrent: row.name_current !== false,
    ...(row.revoked_reason && REASONS.includes(row.revoked_reason) ? { revokedReason: row.revoked_reason as GithubRevocationReason } : {}) };
}
const BINDING_COLUMNS = "workspace_id, binding_id, app_id, installation_id, repository_id, owner, repo, version, revoked_at, revoked_reason, name_current";
async function recordBindingEvent(db: Sql, value: GithubSourceBinding, action: "bound" | "revoked", actorId: string, reason: GithubRevocationReason | null = null): Promise<void> {
  await db.query(`insert into platform.github_binding_events
    (workspace_id, version, action, actor_id, app_id, installation_id, repository_id, owner, repo, reason, binding_id)
    select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, binding_id from platform.github_source_bindings where workspace_id=$1 and repository_id=$7`,
  [value.workspaceId, value.version, action, actorId, value.appId, value.installationId, value.repositoryId, value.owner, value.repo, reason]);
}
export function createGithubSourceStore(db: Sql, backendKind = (db as Partial<PlatformDb>).kind) {
  function mutationBackend(): "postgres" | "pglite" {
    if (backendKind !== "postgres" && backendKind !== "pglite") throw new GithubSourceError("unavailable");
    return backendKind;
  }
  const store = {
    async listStatesPage(workspaceId: string, options: { cursor?: string; limit?: number } = {}): Promise<GithubBindingPage> {
      identifier(workspaceId);
      const limit = options.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new GithubSourceError("invalid");
      const params: (string | number)[] = [workspaceId];
      let clause = "";
      if (options.cursor !== undefined) {
        try {
          if (!/^[A-Za-z0-9_-]{1,600}$/.test(options.cursor)) throw new Error();
          const parts: unknown = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
          if (!Array.isArray(parts) || parts.length !== 4 || parts[0] !== workspaceId || typeof parts[1] !== "string" || typeof parts[2] !== "string") throw new Error();
          const location = repository(parts[1], parts[2]);
          params.push(location.owner, location.repo, numericId(parts[3]));
          clause = " and (owner,repo,repository_id)>($2,$3,$4)";
        } catch { throw new GithubSourceError("invalid"); }
      }
      params.push(limit + 1);
      const rows = await db.query<BindingRow>(`select ${BINDING_COLUMNS} from platform.github_source_bindings where workspace_id=$1${clause} order by owner,repo,repository_id limit $${params.length}`, params);
      const page = rows.slice(0, limit), last = page.at(-1);
      const nextCursor = rows.length > limit && last
        ? Buffer.from(JSON.stringify([workspaceId, last.owner, last.repo, Number(last.repository_id)])).toString("base64url") : null;
      return { bindings: page.map(bindingState), nextCursor };
    },
    async listStates(workspaceId: string): Promise<GithubBindingState[]> {
      // Compatibility helper for internal callers; browser lists use a bounded page.
      const bindings: GithubBindingState[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.listStatesPage(workspaceId, { cursor, limit: 200 });
        bindings.push(...page.bindings); cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return bindings;
    },
    async getState(workspaceId: string, selector?: GithubBindingSelector): Promise<GithubBindingState | undefined> {
      let clause = "";
      const params: (string | number)[] = [identifier(workspaceId)];
      if (selector) {
        if ("bindingId" in selector) { clause = " and binding_id=$2"; params.push(identifier(selector.bindingId)); }
        else if ("repositoryId" in selector) { clause = " and repository_id=$2"; params.push(numericId(selector.repositoryId)); }
        else { const location = repository(selector.owner, selector.repo); clause = " and owner=$2 and repo=$3 and name_current"; params.push(location.owner, location.repo); }
      }
      const rows = await db.query<BindingRow>(`select ${BINDING_COLUMNS} from platform.github_source_bindings where workspace_id = $1${clause} limit 2`, params);
      // Old callers cannot accidentally choose another project's source.
      if (rows.length > 1) throw new GithubSourceError("conflict", "Select a repository connection.");
      if (!rows[0]) return undefined;
      return bindingState(rows[0]);
    },
    async getBinding(workspaceId: string, selector?: GithubBindingSelector): Promise<GithubSourceBinding | undefined> {
      const current = await store.getState(workspaceId, selector);
      if (current?.revoked) throw new GithubSourceError("refused");
      return current?.binding;
    },
    async assertCurrent(expected: GithubSourceBinding): Promise<void> {
      const current = await store.getBinding(expected.workspaceId, { repositoryId: expected.repositoryId });
      if (!current || current.version !== expected.version || current.appId !== expected.appId ||
        current.installationId !== expected.installationId || current.repositoryId !== expected.repositoryId ||
        current.owner !== expected.owner || current.repo !== expected.repo) throw new GithubSourceError("refused");
    },
    async revoke(input: { workspaceId: string; actorId: string; expectedVersion: number; bindingId?: string }): Promise<void> {
      mutationBackend(); identifier(input.workspaceId); identifier(input.actorId);
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion <= 0) throw new GithubSourceError("invalid");
      await db.tx(async tx => {
        const current = await createGithubSourceStore(tx, backendKind).getState(input.workspaceId, input.bindingId ? { bindingId: input.bindingId } : undefined);
        if (!current) throw new GithubSourceError("conflict");
        const rows = await tx.query<BindingRow>(`update platform.github_source_bindings
          set revoked_at = clock_timestamp(), revoked_by = $2, revoked_reason = 'user_unbind', version = version + 1, updated_at = clock_timestamp()
          where workspace_id = $1 and version = $3 and binding_id=$4 and revoked_at is null
          returning workspace_id, binding_id, app_id, installation_id, repository_id, owner, repo, version`,
        [input.workspaceId, input.actorId, input.expectedVersion, current.bindingId]);
        if (rows.length !== 1) throw new GithubSourceError("conflict");
        await recordBindingEvent(tx, binding(rows[0]), "revoked", input.actorId, "user_unbind");
        await tx.query("delete from platform.github_install_intents where workspace_id=$1 and owner=$2 and repo=$3", [input.workspaceId, current.binding.owner, current.binding.repo]);
      });
    },
    async begin(workspaceId: string, actorId: string, repo: GithubRepository & { repositoryId?: number }, returnTo?: string): Promise<{ state: string; browserProof: string }> {
      return store.beginIntent(workspaceId, actorId, repo, "bind", returnTo);
    },
    async beginDiscovery(workspaceId: string, actorId: string): Promise<{ state: string; browserProof: string }> {
      return store.beginIntent(workspaceId, actorId, { owner: "discovery", repo: "repositories" }, "discover", "/platform/source");
    },
    async beginIntent(workspaceId: string, actorId: string, repo: GithubRepository & { repositoryId?: number }, purpose: "bind" | "discover", returnTo?: string): Promise<{ state: string; browserProof: string }> {
      mutationBackend(); identifier(workspaceId); identifier(actorId); const location = repository(repo.owner, repo.repo);
      const repositoryId = repo.repositoryId === undefined ? undefined : numericId(repo.repositoryId);
      githubReturnTo(returnTo);
      const state = randomBytes(32).toString("base64url"), browserProof = randomBytes(32).toString("base64url");
      await db.tx(async tx => {
        await tx.query("delete from platform.github_install_intents where workspace_id=$1 and expires_at<=clock_timestamp()", [workspaceId]);
        // Discovery supplies a provider-verified stable ID. Use it for renamed or
        // transferred repositories so reconnection preserves the grant and CAS.
        const currentStore = createGithubSourceStore(tx, backendKind);
        const named = purpose === "bind" ? await currentStore.getState(workspaceId, location) : undefined;
        const current = purpose === "bind" ? repositoryId === undefined ? named : await currentStore.getState(workspaceId, { repositoryId }) : undefined;
        await tx.query(`insert into platform.github_install_intents
          (workspace_id,state_digest,actor_id,browser_digest,owner,repo,expected_version,phase,expires_at,purpose,return_to,expected_repository_id,expected_name_repository_id,expected_name_version)
          values ($1,$2,$3,$4,$5,$6,$7,'install',clock_timestamp()+interval '10 minutes',$8,$9,$10,$11,$12)`,
        [workspaceId,digest(state),actorId,digest(browserProof),location.owner,location.repo,current?.binding.version ?? 0,purpose,returnTo ?? null,
          repositoryId ?? (current && !current.revoked ? current.binding.repositoryId : null), named?.binding.repositoryId ?? null, named?.binding.version ?? null]);
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
    async consume(input: InstallCaller): Promise<GithubRepository & { installationId: number; expectedVersion: number; appId: string; installationGeneration: string; expectedRepositoryId?: number; expectedName: GithubNameSnapshot; discovery?: true; returnTo?: string }> {
      mutationBackend();
      // Consume BEFORE external HTTP: duplicate callbacks cannot redeem or bind twice.
      const rows = await db.query<IntentRow>(`delete from platform.github_install_intents
        where workspace_id = $1 and state_digest = $2 and actor_id = $3 and browser_digest = $4
        and phase = 'oauth' and expires_at > clock_timestamp()
        returning owner, repo, installation_id, expected_version, app_id, installation_generation::text as installation_generation, purpose, return_to, expected_repository_id, expected_name_repository_id, expected_name_version`, keys(input));
      if (rows.length !== 1) throw new GithubSourceError("refused");
      const row = rows[0];
      // Historical pending callbacks have no captured fence; start again.
      if (!row.app_id || !/^[1-9]\d{0,15}$/.test(row.app_id) || row.installation_generation == null || !/^(0|[1-9]\d{0,18})$/.test(row.installation_generation)) throw new GithubSourceError("refused");
      return { ...repository(row.owner, row.repo), installationId: numericId(Number(row.installation_id)), expectedVersion: row.expected_version, appId: row.app_id, installationGeneration: row.installation_generation,
        expectedName: row.expected_name_repository_id == null ? null : { repositoryId: numericId(Number(row.expected_name_repository_id)), version: numericId(Number(row.expected_name_version)) },
        ...(row.expected_repository_id == null ? {} : { expectedRepositoryId: numericId(Number(row.expected_repository_id)) }), ...(row.purpose === "discover" ? { discovery: true as const } : {}), ...(row.return_to ? { returnTo: githubReturnTo(row.return_to) } : {}) };
    },
    async saveDiscovery(input: { workspaceId: string; actorId: string; appId: string; installationId: number; installationGeneration: string; repositories: GithubDiscoveredRepository[]; truncated: boolean }): Promise<string> {
      mutationBackend(); identifier(input.workspaceId); identifier(input.actorId); numericId(input.installationId);
      if (input.repositories.length > 1000) throw new GithubSourceError("invalid");
      const session = randomBytes(32).toString("base64url");
      await db.tx(async tx => {
        await assertGithubWebhookFence(tx, { appId: input.appId, installationId: input.installationId, generation: input.installationGeneration });
        await tx.query("delete from platform.github_discovery_sessions where workspace_id=$1 and (expires_at<=clock_timestamp() or actor_id=$2)", [input.workspaceId,input.actorId]);
        await tx.query(`insert into platform.github_discovery_sessions(workspace_id,session_digest,actor_id,app_id,installation_id,installation_generation,repositories,truncated,expires_at)
          values($1,$2,$3,$4,$5,$6::bigint,$7::text::jsonb,$8,clock_timestamp()+interval '10 minutes')`,
        [input.workspaceId,digest(session),input.actorId,input.appId,input.installationId,input.installationGeneration,JSON.stringify(input.repositories),input.truncated]);
      });
      return session;
    },
    async getDiscovery(workspaceId: string, actorId: string, session: string): Promise<GithubDiscoverySession> {
      identifier(workspaceId); identifier(actorId);
      const rows=await db.query<{app_id:string;installation_id:number;installation_generation:string;repositories:GithubDiscoveredRepository[];truncated:boolean;expires_at:Date|string}>(`select app_id,installation_id,installation_generation::text as installation_generation,repositories,truncated,expires_at
        from platform.github_discovery_sessions where workspace_id=$1 and actor_id=$2 and session_digest=$3 and expires_at>clock_timestamp()`,[workspaceId,actorId,proof(session)]);
      if(rows.length!==1)throw new GithubSourceError("refused");
      const row=rows[0];
      await db.tx(tx=>assertGithubWebhookFence(tx,{appId:row.app_id,installationId:Number(row.installation_id),generation:row.installation_generation}));
      return {appId:row.app_id,installationId:Number(row.installation_id),installationGeneration:row.installation_generation,repositories:row.repositories,truncated:row.truncated,expiresAt:new Date(row.expires_at).toISOString()};
    },
    async bind(input: Omit<GithubSourceBinding, "version"> & { actorId: string; expectedVersion: number; installationGeneration: string; expectedRepositoryId?: number; expectedName?: GithubNameSnapshot }): Promise<GithubSourceBinding> {
      const kind = mutationBackend();
      const repo = repository(input.owner, input.repo);
      identifier(input.workspaceId); identifier(input.actorId); numericId(input.installationId); numericId(input.repositoryId);
      if (!/^[1-9]\d{0,15}$/.test(input.appId) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new GithubSourceError("invalid");
      if (input.expectedRepositoryId !== undefined && numericId(input.expectedRepositoryId) !== input.repositoryId) throw new GithubSourceError("conflict");
      if (input.expectedName) { numericId(input.expectedName.repositoryId); numericId(input.expectedName.version); }
      // A manually entered name can now refer to a newly created repository. Its
      // fresh user proof creates a new ID; the old grant/version is not reused.
      const expectedVersion = input.expectedRepositoryId === undefined && input.expectedName && input.expectedName.repositoryId !== input.repositoryId ? 0 : input.expectedVersion;
      const params = [input.workspaceId, input.appId, input.installationId, input.repositoryId, repo.owner, repo.repo, input.actorId, expectedVersion];
      return db.tx(async (tx) => {
        await assertGithubWebhookFence(tx, { appId: input.appId, installationId: input.installationId, generation: input.installationGeneration });
        if (kind === "postgres") await tx.query("select pg_advisory_xact_lock(hashtextextended('zenith:github-binding:' || $1::text, 0))", [input.workspaceId]);
        const named = await createGithubSourceStore(tx, backendKind).getState(input.workspaceId, repo);
        if (input.expectedName !== undefined && (input.expectedName === null ? named !== undefined : !named || named.binding.repositoryId !== input.expectedName.repositoryId || named.binding.version !== input.expectedName.version)) throw new GithubSourceError("conflict");
        if (named && named.binding.repositoryId !== input.repositoryId) {
          if (!named.revoked) throw new GithubSourceError("conflict", "Revoke the previous repository connection before replacing its name.");
          const moved = await tx.query(`update platform.github_source_bindings set name_current=false,updated_at=clock_timestamp()
            where workspace_id=$1 and binding_id=$2 and version=$3 and revoked_at is not null and name_current returning binding_id`, [input.workspaceId, named.bindingId, named.binding.version]);
          if (moved.length !== 1) throw new GithubSourceError("conflict");
        }
        const rows = await tx.query<BindingRow>(expectedVersion === 0
          ? `insert into platform.github_source_bindings (workspace_id, app_id, installation_id, repository_id, owner, repo, bound_by, version)
             values ($1, $2, $3, $4, $5, $6, $7, 1) on conflict do nothing
             returning workspace_id, binding_id, app_id, installation_id, repository_id, owner, repo, version`
          : `update platform.github_source_bindings set app_id = $2, installation_id = $3, repository_id = $4, owner = $5, repo = $6,
             bound_by = $7, version = version + 1, revoked_at = null, revoked_by = null, revoked_reason = null, name_current=true, updated_at = clock_timestamp() where workspace_id = $1 and repository_id=$4 and version = $8
             returning workspace_id, binding_id, app_id, installation_id, repository_id, owner, repo, version`,
        expectedVersion === 0 ? params.slice(0, 7) : params);
        if (rows.length !== 1) throw new GithubSourceError("conflict");
        const value = binding(rows[0]);
        await recordBindingEvent(tx, value, "bound", input.actorId);
        return value;
      });
    },
  };
  return store;
}
