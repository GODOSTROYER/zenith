/** Audit feed for one project, newest first. */
import { q, readAudit } from "@/lib/db/store";
import { intParam, notFound, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (req, { id }) => {
  const project = q.project(id);
  if (!project) throw notFound(`Project "${id}"`, "Check the URL, or pick a project from the overview.");
  const limit = Math.min(Math.max(intParam(req, "limit", 50), 1), 500);
  return { events: readAudit({ projectId: project.id, limit }) };
});
