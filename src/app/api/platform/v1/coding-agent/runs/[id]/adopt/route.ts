/**
 * POST /api/platform/v1/coding-agent/runs/:id/adopt : copy a run's approved proposal into its target
 * project's working copy (admin, browser only).
 *
 * The model never reaches this. The call refuses unless the run's broker operation is `approved`
 * (by policy or by a person, through the normal approval path) and still names this run's exact
 * manifest digest. The write itself is the existing `project.updateManifest` action, run as the
 * signed-in person, so role checks, manifest validation, the stale-copy guard and the audit row
 * are the product's own. Adoption stages the change in the working copy; planning and deploying
 * remain the usual separate, approval-gated steps.
 */
import { z } from "zod";
import { BrokerError, notFound } from "@/lib/capabilities/errors";
import { platformBroker } from "@/lib/capabilities/platform";
import { codingAgentStore } from "@/lib/coding-agent/platform";
import { AdoptionRefused, assertAdoptable } from "@/lib/coding-agent/proposal-sink";
import { parseWith, platformRoute, readJson } from "../../../../_lib/http";
import { agentAdmin } from "../../../../_lib/coding-agent";
import { runLifecycle } from "../../../../_lib/connections";
import type { AgentSourceRef, Checkpoint } from "@/lib/coding-agent/types";
import { createGithubSource } from "@/lib/coding-agent/github-source";
import { platformDb } from "@/lib/controlplane/db/open";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({ expectedHash: z.string().min(8).max(200) }).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await agentAdmin(req);
  const body = parseWith(Body, await readJson(req));
  const run = await (await codingAgentStore()).get(caller.agent.workspaceId, id);
  if (!run) throw notFound();
  if (run.payloadPurgedAt || (run.payloadExpiresAt && Date.parse(run.payloadExpiresAt) <= Date.now())) throw new BrokerError("invalid_state", "Analysis content has expired or was deleted. Start a new analysis.");
  if (!run.projectId || !run.proposalOperationId) throw new BrokerError("invalid_state", "This run has no proposal for a project to adopt.");
  const base = (run.checkpoint as Checkpoint).targetBase;
  if (!base || body.expectedHash !== base.manifestHash) throw new BrokerError("conflict", "This proposal does not match the working copy reviewed when the run started. Start a new analysis or review a merge.");
  const source = run.source as AgentSourceRef;
  if (!source.sourceIdentity) throw new BrokerError("invalid_state", "This legacy proposal has no pinned repository authorization. Start a new analysis.");
  try {
    await createGithubSource({ db: platformDb }).resolve({
      workspaceId: caller.agent.workspaceId, repository: source.repository, ref: source.commit,
      expected: source.sourceIdentity, bindingId: source.bindingId, bindingVersion: source.bindingVersion,
      repositoryId: source.repositoryId, ...(source.sourceIdentity.binding === null ? { accessKind: "public" } : {}),
    });
  } catch {
    throw new BrokerError("invalid_state", "Repository access changed or could not be confirmed. Reconnect and start a new analysis.");
  }
  const detail = await (await platformBroker()).getOperationDetail({ workspaceId: caller.agent.workspaceId, operationId: run.proposalOperationId, principal: caller.principal });
  let artifact;
  try {
    artifact = assertAdoptable({ id: run.id, status: run.status, result: run.result as { artifact?: never } | null, proposalOperationId: run.proposalOperationId, source, baseManifestHash: base.manifestHash }, detail.operation);
  } catch (error) {
    if (error instanceof AdoptionRefused) throw new BrokerError(error.code === "not_approved" ? "approval_required" : "invalid_state", error.message);
    throw error;
  }
  const current = await agentAdmin(req);
  if (current.agent.workspaceId !== caller.agent.workspaceId || current.agent.userId !== caller.agent.userId) throw notFound();
  return runLifecycle({ ctx: current.ctx, via: "browser" }, "project.updateManifest", { projectId: run.projectId, manifest: artifact.manifest, expectedHash: body.expectedHash });
});
