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

/** Guard saved results and handoffs as well as new reads; an old cache is not authority. */
export async function assertRunSourceAccess(row: CodingAgentRunRow): Promise<void> {
  const source = row.source as AgentSourceRef;
  if (!source.sourceIdentity) throw new AgentServiceError("invalid_state", "This legacy analysis needs a new source authorization.");
  if (row.payloadPurgedAt || (row.payloadExpiresAt && Date.parse(row.payloadExpiresAt) <= Date.now())) throw new AgentServiceError("invalid_state", "Analysis content has expired or was deleted.");
  await createGithubSource({ db: platformDb }).resolve({
    workspaceId: row.workspaceId, repository: source.repository, ref: source.commit,
    expected: source.sourceIdentity, bindingId: source.bindingId, bindingVersion: source.bindingVersion, repositoryId: source.repositoryId,
    ...(source.sourceIdentity.binding === null ? { accessKind: "public" } : {}),
  });
}
