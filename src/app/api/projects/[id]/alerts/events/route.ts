/**
 * The alert history for one project, newest first.
 *
 *   ?limit=50            1..200 (default 50)
 *   ?cursor=<opaque>     `nextCursor` from the previous page (older entries)
 *   ?env=<id>            only alerts from that environment
 *
 * Events outlive the rules that produced them, so a deleted rule's history is
 * still here. Unlike the summary route this one does not evaluate: history is
 * read, not recomputed.
 */
import { eventPage } from "@/lib/alerts";
import { q } from "@/lib/db/store";
import { ApiError, intParam, route, scopedProject } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (req, { id }) => {
  const project = scopedProject(id);

  const environmentId = req.nextUrl.searchParams.get("env")?.trim() || undefined;
  if (environmentId && q.environment(environmentId)?.projectId !== project.id)
    throw new ApiError(`Unknown environment "${environmentId}" for this project.`, 400, {
      fix: "Use an environment id from this project, or drop ?env= to see every environment.",
    });

  const page = eventPage({
    projectId: project.id,
    environmentId,
    limit: intParam(req, "limit", 50, { min: 1, max: 200 }),
    cursor: req.nextUrl.searchParams.get("cursor") ?? undefined,
  });

  return { events: page.events, nextCursor: page.nextCursor, simulated: true };
});
