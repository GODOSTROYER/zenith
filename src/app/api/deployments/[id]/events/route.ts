/**
 * SSE: replay from `?after=<seq>` then tail.
 *
 * The stream ends 2s after the deployment reaches a terminal status, giving
 * late events (final outputs) time to land. Reconnecting with the last seq
 * replays everything missed — a refresh mid-deploy loses nothing.
 */
import { q, readEvents } from "@/lib/db/store";
import type { DeploymentStatus } from "@/lib/domain/types";
import { intParam, membershipCheck, route, scopedDeployment } from "@/lib/server/context";
import { sseResponse, type SseEvent } from "@/lib/server/sse";

export const dynamic = "force-dynamic";

const TERMINAL: DeploymentStatus[] = ["succeeded", "failed", "rolled_back", "cancelled"];
const LINGER_MS = 2_000;

export const GET = route<{ id: string }>(async (req, { id }) => {
  // Bound to the caller's workspace, same as the deployment's own GET: a
  // foreign id 404s exactly like a missing one, so the id space stays
  // unenumerable through the event log too.
  const deployment = scopedDeployment(id);

  let cursor = intParam(req, "after", -1);
  let terminalSince: number | null = null;

  // Membership is re-checked on every poll, not just here at connect — a
  // deployment log is a live read and losing access has to stop it.
  // readEvents keeps a byte cursor into the JSONL, so each poll parses only
  // what was appended since the last one.
  return sseResponse(req.signal, membershipCheck(), () => {
    const events = readEvents(deployment.id, cursor);
    for (const e of events) cursor = Math.max(cursor, e.seq);

    const status = q.deployment(deployment.id)?.status;
    if (status && TERMINAL.includes(status)) {
      terminalSince ??= Date.now();
      if (Date.now() - terminalSince > LINGER_MS && events.length === 0) return null;
    } else {
      terminalSince = null;
    }

    return events.map((e): SseEvent => ({ event: e.type, id: e.seq, data: e }));
  });
});
