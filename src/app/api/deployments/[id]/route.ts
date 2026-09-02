/** Deployment snapshot (steps, outputs, status). */
import { inWorkspace, q } from "@/lib/db/store";
import { notFound, requireWorkspace, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (_req, { id }) => {
  const deployment = q.deployment(id);
  // Scoped by the owning project's workspace: an id alone is not a read grant.
  if (!deployment || !inWorkspace(requireWorkspace().id, deployment.projectId))
    throw notFound(`Deployment "${id}"`, "Open the project's Deploys tab to see deployments that exist.");
  return { deployment };
});
