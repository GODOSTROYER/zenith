/** One Navigator run with its steps, scoped to the caller's workspace. */
import { db, q } from "@/lib/db/store";
import { notFound, requireWorkspace, resolveActor, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (req, { id }) => {
  await resolveActor(req);
  const workspace = requireWorkspace();
  const run = db().navigatorRuns.find((r) => r.id === id);
  // A run in another workspace is "not found", not "forbidden" — the API does
  // not confirm the existence of ids the caller cannot see.
  if (!run || q.project(run.projectId)?.workspaceId !== workspace.id)
    throw notFound(
      `Navigator run "${id}"`,
      "Open the project's Navigator tab to see runs that exist."
    );
  return { run };
});
