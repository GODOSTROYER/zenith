/**
 * Navigator runs in the caller's workspace, newest first.
 * `?projectId=` narrows to one project, `?limit=` (1–200, default 50) bounds
 * the page — a run carries every step it planned, so this list is not small.
 */
import { db, q } from "@/lib/db/store";
import { intParam, requireWorkspace, resolveActor, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 200;

export const GET = route(async (req) => {
  // Membership, not just a session: a signed-in stranger is refused by name.
  await resolveActor(req);
  const workspace = requireWorkspace();
  const projectId = req.nextUrl.searchParams.get("projectId");
  const limit = Math.min(Math.max(1, Math.trunc(intParam(req, "limit", 50))), MAX_LIMIT);

  const runs = db()
    .navigatorRuns.filter(
      (r) =>
        (!projectId || r.projectId === projectId) &&
        q.project(r.projectId)?.workspaceId === workspace.id
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit);

  return { runs, limit };
});
