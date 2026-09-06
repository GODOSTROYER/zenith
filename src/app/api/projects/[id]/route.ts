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

import { json, route, scopedProject } from "@/lib/server/context";
import { projectPayload } from "./payload";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (req, { id }) => {
  const project = scopedProject(id);

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
