/**
 * SSE: replay from `?after=<seq>` then tail.
 *
 * The stream ends 2s after the deployment reaches a terminal status, giving
 * late events (final outputs) time to land. Reconnecting with the last seq
 * replays everything missed — a refresh mid-deploy loses nothing.
 *
 * Each 300ms tick is one keyed read of the log:
 *
 *  - file store — `readEvents` keeps a byte cursor into the JSONL, so a poll
 *    parses only what was appended since the last one;
 *  - Postgres — `readEventsAsync` is a range read on the primary key
 *    `(deployment_id, seq)`, index-only, never a scan. It is the async reader
 *    on purpose: the synchronous one blocks the event loop for its round trip,
 *    and a tailing client must not do that 200 times a minute.
 *
 * The terminal check follows the same split. `q.deployment()` is live on the
 * file store, but on Postgres it reads the snapshot this request loaded at
 * connect, which never changes while the stream is open — so the status the
 * log itself reports wins when the stream has seen one. Every transition emits
 * a `status` event, so that is the same answer, one poll earlier.
 */
import { isPostgres, q, readEvents } from "@/lib/db/store";
import { readEventsAsync } from "@/lib/db/pg/history";
import type { DeploymentEvent, DeploymentStatus } from "@/lib/domain/types";
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
  /** the newest status the log has reported on this connection */
  let streamed: DeploymentStatus | undefined;

  // Membership is re-checked on every poll, not just here at connect — a
  // deployment log is a live read and losing access has to stop it.
  return sseResponse(req.signal, membershipCheck(), async () => {
    const events: DeploymentEvent[] = isPostgres()
      ? await readEventsAsync(deployment.id, cursor)
      : readEvents(deployment.id, cursor);
    for (const e of events) {
      cursor = Math.max(cursor, e.seq);
      if (e.type === "status") streamed = e.status;
    }

    const status = streamed ?? q.deployment(deployment.id)?.status;
    if (status && TERMINAL.includes(status)) {
      terminalSince ??= Date.now();
      if (Date.now() - terminalSince > LINGER_MS && events.length === 0) return null;
    } else {
      terminalSince = null;
    }

    return events.map((e): SseEvent => ({ event: e.type, id: e.seq, data: e }));
  });
});
