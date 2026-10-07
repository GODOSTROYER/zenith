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

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({ expectedHash: z.string().max(200).optional() }).strict();

export const POST = platformRoute<{ id: string }>(async (req, { id }) => {
  const caller = await agentAdmin(req);
  const body = parseWith(Body, await readJson(req));
  const run = await (await codingAgentStore()).get(caller.agent.workspaceId, id);
  if (!run) throw notFound();
  if (!run.projectId || !run.proposalOperationId) throw new BrokerError("invalid_state", "This run has no proposal for a project to adopt.");
  const detail = await (await platformBroker()).getOperationDetail({ workspaceId: caller.agent.workspaceId, operationId: run.proposalOperationId, principal: caller.agent.principal });
  let artifact;
  try {
    artifact = assertAdoptable({ id: run.id, status: run.status, result: run.result as { artifact?: never } | null, proposalOperationId: run.proposalOperationId }, detail.operation);
  } catch (error) {
    if (error instanceof AdoptionRefused) throw new BrokerError(error.code === "not_approved" ? "approval_required" : "invalid_state", error.message);
    throw error;
  }
  return runLifecycle({ ctx: caller.ctx, via: "browser" }, "project.updateManifest", { projectId: run.projectId, manifest: artifact.manifest, ...(body.expectedHash ? { expectedHash: body.expectedHash } : {}) });
});
