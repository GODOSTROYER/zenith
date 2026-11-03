/**
 * Production wiring for the web side of coding-agent runs (PROD-MACH-06): the
 * platform control store, GitHub source resolution (pins a commit, downloads
 * nothing) and the Temporal launcher. The web process holds no model key and
 * does no agent work; the execution worker runs the steps.
 */
import { platformDb } from "@/lib/controlplane/db/open";
import { modelWorkerAvailable } from "./lifecycle";
import { AgentServiceError } from "./service";
import type { AgentSourceRef } from "./types";
import type { CodingAgentRunRow } from "./store";
import { createGithubSource } from "./github-source";
import { temporalRunLauncher } from "./launcher";
import type { AgentControlDeps } from "./service";
import { platformRunStore } from "./store";

export async function codingAgentControl(): Promise<AgentControlDeps> {
  return { store: platformRunStore(await platformDb()), resolveSource: createGithubSource({ db: platformDb }).resolve, launcher: temporalRunLauncher(), modelConfigured: async () => modelWorkerAvailable(await platformDb()) };
}

export async function codingAgentStore() {
  return platformRunStore(await platformDb());
}

function assertRetained(row: CodingAgentRunRow): void {
  const expires = row.payloadExpiresAt ? Date.parse(row.payloadExpiresAt) : undefined;
  if (row.payloadPurgedAt || expires !== undefined && (!Number.isFinite(expires) || expires <= Date.now())) {
    throw new AgentServiceError("invalid_state", "Analysis content has expired or was deleted.");
  }
}

/** One page/request only: coalesce provider I/O, never per-run retention or local grants. */
export function createRunSourceAccessChecker(): (row: CodingAgentRunRow) => Promise<void> {
  const github = createGithubSource({ db: platformDb });
  const verified = new Map<string, Promise<unknown>>();
  return async row => {
    assertRetained(row);
    const source = row.source as AgentSourceRef;
    const identity = source?.sourceIdentity;
    if (!identity) throw new AgentServiceError("invalid_state", "This legacy analysis needs a new source authorization.");
    const request = {
      workspaceId: row.workspaceId, repository: source.repository, ref: source.commit,
      expected: identity, bindingId: source.bindingId, bindingVersion: source.bindingVersion, repositoryId: source.repositoryId,
      ...(identity.binding === null ? { accessKind: "public" as const } : {}),
    };
    await github.assertLocalAccess(request);
    // Explicit scalars make JSONB key ordering irrelevant and keep every authority
    // dimension in the key, including the workspace and stable binding identity.
    const grant = identity.binding;
    const key = JSON.stringify([row.workspaceId, source.repository, source.commit,
      source.bindingId, source.bindingVersion, source.repositoryId,
      identity.owner, identity.repo, identity.repositoryId, identity.commitSha,
      grant ? [grant.appId, grant.installationId, grant.repositoryId, grant.version] : null]);
    let check = verified.get(key);
    if (!check) { check = github.resolve(request); verified.set(key, check); }
    await check;
    // A different row cannot inherit a retained row's expiry, nor can a grant
    // revoked while the provider request was in flight release cached content.
    await github.assertLocalAccess(request);
    assertRetained(row);
  };
}

/** Guard saved results and handoffs as well as new reads; an old cache is not authority. */
export async function assertRunSourceAccess(row: CodingAgentRunRow): Promise<void> {
  await createRunSourceAccessChecker()(row);
}
