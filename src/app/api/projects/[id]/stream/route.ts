/**
 * GET /api/projects/:idOrSlug/stream — the project payload, pushed.
 *
 * Same body, same workspace scoping and the same hash as
 * `GET /api/projects/:idOrSlug`; the difference is that it arrives when
 * something actually changed instead of every 5 seconds per open tab. The
 * store's change events wake this route; nothing is recomputed on a quiet
 * connection.
 *
 * Contract:
 *   event: project      data: { etag, ...the GET payload }   id: <seq>
 *   ?env=<id>           narrows changesets, exactly as on the GET
 *   ?after=<seq> / Last-Event-ID
 *                       resumes the id sequence. A snapshot stream has no
 *                       history to replay — the newest payload supersedes
 *                       every older one — so a reconnect always gets the
 *                       current state first, whatever the cursor said.
 *   `: ping`            heartbeat every 15s (from sseResponse)
 *
 * A payload whose hash matches the last one sent is not sent again, so a save
 * that did not touch this project costs one hash, not a message.
 */
import { changed, onChange, q } from "@/lib/db/store";
import { intParam, membershipCheck, route, scopedProject } from "@/lib/server/context";
import { sseResponse, type SseEvent, type SseGuard } from "@/lib/server/sse";
import { projectPayload } from "../payload";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (req, { id }) => {
  // Knowing an id is not permission to read it — same 404 as the GET, so the
  // id space is not enumerable through the stream either.
  const project = scopedProject(id);
  // Connecting is not a standing grant: this is re-asked on every push and
  // heartbeat, so a member removed mid-stream stops receiving payloads then,
  // not whenever their tab happens to disconnect.
  const stillAMember = membershipCheck();

  const only = req.nextUrl.searchParams.get("env");
  // `Number(null)` is 0 and so is `Number("")` — an absent header must not
  // read as "resume from 0", which would put the first id one step too high.
  const header = req.headers.get("last-event-id")?.trim();
  const resume = header ? Math.trunc(Number(header)) : NaN;
  let seq = Number.isFinite(resume) ? resume : intParam(req, "after", -1, { min: -1 });
  let lastEtag = "";
  /** Send the current state on connect, then only when the store says so. */
  let dirty = true;

  const unsubscribe = onChange((c) => {
    if (changed(c, project.id)) dirty = true;
  });
  // sseResponse tears down on abort and so do we; a dropped connection must
  // not leave a listener holding this closure.
  req.signal.addEventListener("abort", unsubscribe);

  // A revoked stream is closed by sseResponse, which knows nothing about this
  // subscription — so drop it on the way out rather than leaving a listener
  // alive for a reader that is gone.
  const guard: SseGuard = () => {
    const denial = stillAMember();
    if (denial) unsubscribe();
    return denial;
  };

  // sseResponse polls this every 300ms — under the 250ms-per-message cap once
  // the change flag gates it, and O(1) while nothing is happening.
  return sseResponse(req.signal, guard, async () => {
    if (!dirty) return [];
    dirty = false;
    const fresh = q.project(project.id);
    // Deleted underneath us: end the stream rather than replay a ghost.
    if (!fresh) {
      unsubscribe();
      return null;
    }
    const { etag, body } = await projectPayload(fresh, only);
    if (etag === lastEtag) return [];
    lastEtag = etag;
    return [{ event: "project", id: ++seq, data: { etag, ...body } } satisfies SseEvent];
  });
});
