/** Default C3 access: workspace authority is checked even without App configuration. */
import { platformDb } from "@/lib/controlplane/db/open";
import type { Sql } from "@/lib/controlplane/types";
import { createGithubApp, githubAppConfig } from "./app";
import { createGithubSourceStore } from "./store";
import { GithubSourceError, repository, type GithubAccessScope } from "./types";

export function createGithubAccess(deps: { db: () => Promise<Sql>; fetchImpl?: typeof fetch; env?: Readonly<Record<string, string | undefined>> }) {
  return async function withGithubAccess<T>(input: GithubAccessScope, fn: (token?: string) => Promise<T>): Promise<T> {
    if (!input.workspaceId) return fn();
    const requested = repository(input.owner, input.repo);
    try {
      const store = createGithubSourceStore(await deps.db());
      const binding = await store.getBinding(input.workspaceId);
      if (!binding) return await fn();
      const config = githubAppConfig(deps.env);
      if (!config || binding.appId !== config.appId || binding.owner !== requested.owner || binding.repo !== requested.repo) throw new GithubSourceError("refused");
      return await createGithubApp(config, { fetchImpl: deps.fetchImpl }).withRepositoryAccess(binding, async (token) => {
        // Token acquisition can race a browser revocation or a replacement binding.
        await store.assertCurrent(binding);
        return fn(token);
      }, input.signal);
    } catch { throw new GithubSourceError("unavailable"); }
  };
}
export const defaultGithubAccess = createGithubAccess({ db: platformDb });
