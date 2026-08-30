/** Full revision incl. manifest — the diff view reads this. */
import { q } from "@/lib/db/store";
import { notFound, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (_req, { id }) => {
  const revision = q.revision(id);
  if (!revision)
    throw notFound(`Revision "${id}"`, "Open the project's Revisions tab and pick an existing revision.");
  return { revision };
});
