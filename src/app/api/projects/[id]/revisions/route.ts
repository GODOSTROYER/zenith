/**
 * Revision history for one project, newest first.
 *
 * The project payload carries revision metadata inline, which grows without
 * bound as a project is deployed. This is the paged route the Revisions screen
 * moves to; manifests still come one at a time from /api/revisions/:id.
 *
 *   ?limit=50            1..200 (default 50)
 *   ?cursor=<offset>     `nextCursor` from the previous page
 */
import { q } from "@/lib/db/store";
import { intParam, route, scopedProject } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (req, { id }) => {
  const project = scopedProject(id);

  const all = q.revisionsOf(project.id);
  const limit = Math.min(Math.max(intParam(req, "limit", 50), 1), 200);
  const offset = Math.max(intParam(req, "cursor", 0), 0);
  const page = all.slice(offset, offset + limit);
  const next = offset + page.length;

  return {
    /** metadata only — fetch a manifest from /api/revisions/:id */
    revisions: page.map((r) => ({
      id: r.id,
      number: r.number,
      message: r.message,
      author: r.author,
      createdAt: r.createdAt,
      /** environments this revision was actually deployed to, as recorded */
      deployedTo: r.deployedTo ?? [],
    })),
    /** so the UI can say "50 of 214" honestly */
    total: all.length,
    nextCursor: next < all.length ? String(next) : undefined,
  };
});
