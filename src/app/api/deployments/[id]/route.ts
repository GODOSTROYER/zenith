/** Deployment snapshot (steps, outputs, status). */
import { q } from "@/lib/db/store";
import { notFound, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (_req, { id }) => {
  const deployment = q.deployment(id);
  if (!deployment)
    throw notFound(`Deployment "${id}"`, "Open the project's Deploys tab to see deployments that exist.");
  return { deployment };
});
