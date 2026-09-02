/** Full revision incl. manifest — the diff view reads this. */
import { inWorkspace, q } from "@/lib/db/store";
import { notFound, requireWorkspace, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (_req, { id }) => {
  const revision = q.revision(id);
  // Scoped by the owning project's workspace: an id alone is not a read grant.
  if (!revision || !inWorkspace(requireWorkspace().id, revision.projectId))
    throw notFound(`Revision "${id}"`, "Open the project's Revisions tab and pick an existing revision.");
  return { revision };
});
