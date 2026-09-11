/**
 * `GET /api/hosted/apps/:appId/events?limit=` — this app's own activity.
 *
 * Owner only. Content-free by construction: an event row holds a release id,
 * an outcome, a pseudonymous subject hash and small counts — never a record's
 * contents and never a person's id or email. That is what makes it safe to
 * show an owner what their colleagues have been doing *at the level of "a
 * request was updated"* without showing them the request.
 *
 * Workstream W8 (hosted R3).
 */
import type { AppEventsWire } from "@/lib/hosted/contracts";
import { appLogs } from "@/lib/hosted/health";
import { listEvents } from "@/lib/hosted/events";
import { intParam } from "@/lib/server/context";
import { hostedRoute } from "@/lib/server/hosted";

export const dynamic = "force-dynamic";

export const GET = hostedRoute<{ appId: string }>(
  { appRole: "owner", refusal: "not_found" },
  async (req, { appId }): Promise<AppEventsWire> => {
    const url = new URL(req.url);
    const limit = intParam(url, "limit", 100, { min: 1, max: 1000 });
    const since = url.searchParams.get("since") ?? undefined;
    const logs = appLogs(appId, { limit, since });
    return {
      events: listEvents({ appId, since, limit }),
      logs: logs.lines,
      disclosure: logs.disclosure,
    };
  }
);
