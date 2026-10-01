/** Default C3 access: absent configuration/binding stays anonymous; a binding is exact. */
import { platformDb } from "@/lib/controlplane/db/open";
import type { Sql } from "@/lib/controlplane/types";
import { createGithubApp, githubAppConfig } from "./app";
import { createGithubSourceStore } from "./store";
import { GithubSourceError, repository, type GithubAccessScope } from "./types";

export function createGithubAccess(deps: { db: () => Promise<Sql>; fetchImpl?: typeof fetch; env?: Readonly<Record<string, string | undefined>> }) {
  return async function withGithubAccess<T>(input: GithubAccessScope, fn: (token?: string) => Promise<T>): Promise<T> {
    const config = githubAppConfig(deps.env);
    if (!config || !input.workspaceId) return fn();
    const requested = repository(input.owner, input.repo);
    try {
      const binding = await createGithubSourceStore(await deps.db()).getBinding(input.workspaceId);
      if (!binding) return await fn();
      if (binding.owner !== requested.owner || binding.repo !== requested.repo) throw new GithubSourceError("refused");
      return await createGithubApp(config, { fetchImpl: deps.fetchImpl }).withRepositoryAccess(binding, fn, input.signal);
    } catch { throw new GithubSourceError("unavailable"); }
  };
}
export const defaultGithubAccess = createGithubAccess({ db: platformDb });
