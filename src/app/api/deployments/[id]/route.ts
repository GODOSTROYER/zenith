/** Deployment snapshot (steps, outputs, status). */
import { route, scopedDeployment } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (_req, { id }) => {
  // Scoped by the owning project's workspace: an id alone is not a read grant.
  return { deployment: scopedDeployment(id) };
});
