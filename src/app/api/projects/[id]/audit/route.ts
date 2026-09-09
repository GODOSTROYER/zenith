/**
 * Audit feed for one project, newest first.
 *
 * Filtering happens here, not in the browser: the log is tailed from the end
 * and only matching entries are returned, so "navigator only" reaches back
 * through the whole log instead of through the last 100 rows.
 *
 *   ?limit=50            1..500 (default 50)
 *   ?cursor=<opaque>     `nextCursor` from the previous page (older entries)
 *   ?env=<id>            only rows recorded against that environment
 *   ?from=<ISO>          inclusive lower bound on the timestamp
 *   ?to=<ISO>            inclusive upper bound on the timestamp
 *   ?actor=user|navigator|system
 *   ?action=deploy.      exact action id, or a prefix ending in "."
 *   ?result=ok|error|denied
 *
 * Returns `{ events, nextCursor?, total, totalIsExact }`. `total` counts every
 * row matching the current filters, over the newest 4 MB of the log;
 * `totalIsExact` is false when the log is longer than that, so a screen can say
 * "1000+" rather than presenting a floor as a fact.
 */
import { countAudit, q, readAuditPage } from "@/lib/db/store";
import type { AuditEvent } from "@/lib/domain/types";
import { ApiError, intParam, route, scopedProject } from "@/lib/server/context";

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

/** A date bound is compared as an ISO string, so it must really be one. */
function isoBound(raw: string | null, param: string, endOfDay: boolean): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  // A bare date means the whole day: ?to=2026-09-02 includes that day's rows.
  const full = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
    : value;
  const at = new Date(full);
  if (Number.isNaN(at.getTime()))
    throw new ApiError(`"${value}" is not a date Zenith can read for ?${param}.`, 400, {
      fix: 'Use an ISO timestamp like 2026-09-02T14:00:00Z, or a plain date like 2026-09-02.',
    });
  return at.toISOString();
}

export const GET = route<{ id: string }>(async (req, { id }) => {
  const project = scopedProject(id);
  const sp = req.nextUrl.searchParams;

  const envId = sp.get("env")?.trim() || undefined;
  // Bound to *this* project, not merely to some project: resolving globally
  // would answer "does this id exist?" for another tenant — a foreign id would
  // return an empty 200 where a made-up one returns 400. Same refusal for both.
  if (envId && q.environment(envId)?.projectId !== project.id)
    throw new ApiError(`Unknown environment "${envId}" for this project.`, 400, {
      fix: "Use an environment id from this project, or drop ?env= to see every environment.",
    });

  const from = isoBound(sp.get("from"), "from", false);
  const to = isoBound(sp.get("to"), "to", true);
  if (from && to && from > to)
    throw new ApiError("The ?from date is after the ?to date, so nothing can match.", 400, {
      fix: "Swap them, or drop one to leave that end of the range open.",
    });

  const filter = {
    projectId: project.id,
    environmentId: envId,
    from,
    to,
    actorType: oneOf<AuditEvent["actor"]["type"]>(sp.get("actor"), ACTOR_TYPES, "actor"),
    result: oneOf<AuditEvent["result"]>(sp.get("result"), RESULTS, "result"),
    actionId: sp.get("action")?.trim() || undefined,
  };

  const page = readAuditPage({
    ...filter,
    limit: Math.min(Math.max(intParam(req, "limit", 50), 1), 500),
    cursor: sp.get("cursor") ?? undefined,
  });
  const count = countAudit(filter);

  return {
    events: page.events,
    nextCursor: page.nextCursor,
    total: count.total,
    /** false when the log is longer than the count budget — `total` is a floor */
    totalIsExact: count.exact,
  };
});
