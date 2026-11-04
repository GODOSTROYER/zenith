/**
 * GitHub-backed source access for coding-agent runs (PROD-MACH-06).
 *
 * Same authority path as static source inspection: the workspace's bound
 * repository through the installation-scoped immutable access (token minted per
 * call, contents:read, one repository), or a PUBLIC repository when the
 * workspace has no binding. A revoked binding is never an anonymous fallback.
 *
 *  - `resolve` (web, at run creation) pins the ref to an exact commit and
 *    validates access WITHOUT downloading the repository.
 *  - `read` (worker, every step) re-validates access (binding revocation takes
 *    effect on the next step) and hands the snapshot of that exact commit to the
 *    callback, so the installation token never leaves this scope. The commit
 *    tarball is read as text by the bounded intake; nothing from the repository
 *    is executed or written to disk. Snapshots of immutable commits are cached
 *    in memory (small, per worker) so a step does not re-download the tarball.
 */
import type { Sql } from "@/lib/controlplane/types";
import { snapshotFromGithub, type RepoSnapshot } from "@/lib/analysis";
import { createGithubImmutableSourceAccess } from "@/lib/sources/github/runtime";
import { normalizeInspectionRoot } from "@/lib/sources/github/inspect";
import { createGithubSourceStore } from "@/lib/sources/github/store";
import { GithubSourceError, repository } from "@/lib/sources/github/types";
import type { SourceReader, SourceRequest, SourceResolver } from "./service";
import type { AgentSourceRef } from "./types";

const CACHE_MAX = 6;

export function createGithubSource(deps: { db: () => Promise<Sql>; fetchImpl?: typeof fetch; env?: Readonly<Record<string, string | undefined>> }): { read: SourceReader; resolve: SourceResolver } {
  const access = createGithubImmutableSourceAccess(deps);
  const cache = new Map<string, RepoSnapshot>();

  async function authorize(request: SourceRequest): Promise<{ location: { owner: string; repo: string }; root: string }> {
    const parts = request.repository.split("/");
    if (parts.length !== 2) throw new GithubSourceError("invalid");
    const asked = repository(parts[0], parts[1]);
    const root = normalizeInspectionRoot(request.root);
    const state = await createGithubSourceStore(await deps.db()).getState(request.workspaceId);
    if (state?.revoked) throw new GithubSourceError("refused");
    if (state && (state.binding.owner !== asked.owner || state.binding.repo !== asked.repo)) throw new GithubSourceError("refused");
    return { location: asked, root };
  }

  const resolve: SourceResolver = async (request) => {
    const { location, root } = await authorize(request);
    return access({ ...location, workspaceId: request.workspaceId, ref: request.ref }, async (identity): Promise<AgentSourceRef> => ({ repository: `${identity.owner}/${identity.repo}`, commit: identity.commitSha, ...(root ? { root } : {}) }));
  };

  const read: SourceReader = async (request, use) => {
    const { location, root } = await authorize(request);
    return access({ ...location, workspaceId: request.workspaceId, ref: request.ref }, async (identity, token) => {
      const key = `${request.workspaceId}|${identity.owner}/${identity.repo}|${identity.commitSha}|${root}`;
      let snapshot = cache.get(key);
      if (!snapshot) {
        const full = await snapshotFromGithub({ owner: identity.owner, repo: identity.repo, ref: identity.commitSha, token, fetchImpl: deps.fetchImpl, timeoutMs: 45_000 });
        snapshot = root === "" ? full : { ...full, files: full.files.filter((f) => f.path === root || f.path.startsWith(`${root}/`)) };
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
        cache.set(key, snapshot);
      }
      return use(snapshot, { repository: `${identity.owner}/${identity.repo}`, commit: identity.commitSha, ...(root ? { root } : {}) });
    });
  };

  return { read, resolve };
}
