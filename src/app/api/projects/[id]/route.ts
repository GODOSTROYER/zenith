/**
 * Everything a project screen needs, by id or slug.
 *
 * The payload itself is built in ./payload.ts, shared with the streaming
 * transport at ./stream. This route adds only the HTTP conventions:
 *  - `?env=<id>` computes only that environment's changeset;
 *  - an unchanged payload answers `304 Not Modified` to `If-None-Match`.
 *
 * Screens prefer `GET /api/projects/:id/stream` and fall back to polling this.
 */
import { inWorkspace, q } from "@/lib/db/store";
import { json, notFound, requireWorkspace, route } from "@/lib/server/context";
import { projectPayload } from "./payload";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (req, { id }) => {
  const project = q.project(id);
  if (!project)
    throw notFound(
      `Project "${id}"`,
      "Check the URL, or pick a project from the workspace overview."
    );
  // Knowing an id is not permission to read it.
  if (!inWorkspace(requireWorkspace().id, project.id))
    throw notFound(
      `Project "${id}"`,
      "Check the URL, or pick a project from the workspace overview."
    );

  const { etag, body } = await projectPayload(project, req.nextUrl.searchParams.get("env"));

  // 304 on an unchanged payload: this is polled every 5s per open tab that
  // could not use the stream.
  if (req.headers.get("if-none-match") === etag)
    return new Response(null, {
      status: 304,
      headers: { etag, "cache-control": "no-store" },
    });

  const res = json(body);
  res.headers.set("etag", etag);
  return res;
});
