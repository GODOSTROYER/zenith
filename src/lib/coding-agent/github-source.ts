/**
 * GitHub-backed `SourceReader` for coding-agent runs (PROD-MACH-06).
 *
 * Same authority path as static source inspection: the workspace's bound
 * repository through the installation-scoped immutable access (token minted per
 * call, contents:read, one repository), or a PUBLIC repository when the
 * workspace has no binding. A revoked binding is never an anonymous fallback.
 * The ref is resolved to an exact commit before any byte is read, the commit
 * tarball is read as text by the bounded intake, and nothing from the
 * repository is executed or written to disk. The agent runs INSIDE the access
 * callback, so the installation token never leaves this scope.
 */
import type { Sql } from "@/lib/controlplane/types";
import { snapshotFromGithub } from "@/lib/analysis";
import { createGithubImmutableSourceAccess } from "@/lib/sources/github/runtime";
import { normalizeInspectionRoot } from "@/lib/sources/github/inspect";
import { createGithubSourceStore } from "@/lib/sources/github/store";
import { GithubSourceError, repository } from "@/lib/sources/github/types";
import type { SourceReader } from "./service";

export function createGithubSourceReader(deps: { db: () => Promise<Sql>; fetchImpl?: typeof fetch; env?: Readonly<Record<string, string | undefined>> }): SourceReader {
  const access = createGithubImmutableSourceAccess(deps);
  return async (request, use) => {
    const parts = request.repository.split("/");
    if (parts.length !== 2) throw new GithubSourceError("invalid");
    const asked = repository(parts[0], parts[1]);
    const root = normalizeInspectionRoot(request.root);
    const state = await createGithubSourceStore(await deps.db()).getState(request.workspaceId);
    if (state?.revoked) throw new GithubSourceError("refused");
    if (state && (state.binding.owner !== asked.owner || state.binding.repo !== asked.repo)) throw new GithubSourceError("refused");
    return access({ ...asked, workspaceId: request.workspaceId, ref: request.ref }, async (identity, token) => {
      const snapshot = await snapshotFromGithub({ owner: identity.owner, repo: identity.repo, ref: identity.commitSha, token, fetchImpl: deps.fetchImpl, timeoutMs: 45_000 });
      const files = root === "" ? snapshot.files : snapshot.files.filter((f) => f.path === root || f.path.startsWith(`${root}/`));
      return use({ ...snapshot, files }, { repository: `${identity.owner}/${identity.repo}`, commit: identity.commitSha, ...(root ? { root } : {}) });
    });
  };
}
