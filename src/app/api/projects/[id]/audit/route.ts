/**
 * Audit feed for one project, newest first.
 *
 * Filtering happens here, not in the browser: the log is tailed from the end
 * and only matching entries are returned, so "navigator only" reaches back
 * through the whole log instead of through the last 100 rows.
 *
 *   ?limit=50            1..500 (default 50)
 *   ?cursor=<opaque>     `nextCursor` from the previous page (older entries)
 *   ?actor=user|navigator|system
 *   ?action=deploy.      exact action id, or a prefix ending in "."
 *   ?result=ok|error|denied
 */
import { q, readAuditPage } from "@/lib/db/store";
import type { AuditEvent } from "@/lib/domain/types";
import { ApiError, intParam, notFound, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

const ACTOR_TYPES = ["user", "navigator", "system"] as const;
const RESULTS = ["ok", "error", "denied"] as const;

function oneOf<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  param: string
): T | undefined {
  if (raw === null || raw === "" || raw === "all") return undefined;
  if (!(allowed as readonly string[]).includes(raw))
    throw new ApiError(`Unknown ${param} filter "${raw}".`, 400, {
      fix: `Use one of: ${allowed.join(", ")} — or drop the parameter for everything.`,
    });
  return raw as T;
}

export const GET = route<{ id: string }>(async (req, { id }) => {
  const project = q.project(id);
  if (!project) throw notFound(`Project "${id}"`, "Check the URL, or pick a project from the overview.");
  const sp = req.nextUrl.searchParams;

  const page = readAuditPage({
    projectId: project.id,
    limit: Math.min(Math.max(intParam(req, "limit", 50), 1), 500),
    cursor: sp.get("cursor") ?? undefined,
    actorType: oneOf<AuditEvent["actor"]["type"]>(sp.get("actor"), ACTOR_TYPES, "actor"),
    result: oneOf<AuditEvent["result"]>(sp.get("result"), RESULTS, "result"),
    actionId: sp.get("action")?.trim() || undefined,
  });

  return { events: page.events, nextCursor: page.nextCursor };
});
