/**
 * Server-sent events helper.
 *
 * Durability contract: consumers reconnect with `?after=<seq>` and the route's
 * `pull` replays from the store, so a refresh or a dropped connection never
 * loses deployment history. Heartbeat comments every 15s keep proxies from
 * closing an idle stream; aborting the request tears everything down.
 *
 * Authorisation contract: a route authorises once, at connect, and then holds
 * the connection open for hours. That is a hole — someone removed from a
 * workspace would keep receiving payloads until they chose to disconnect — so
 * `sseResponse` takes a `guard` alongside `pull` and re-asks it on every poll,
 * which is every push and every heartbeat. It is a required argument rather
 * than an option precisely so a stream added later cannot quietly skip it.
 */

export interface SseEvent {
  /** SSE event name; omit for the default "message" */
  event?: string;
  /** becomes `id:` — the cursor a client resumes from */
  id?: number;
  data: unknown;
}

/** Return the next batch, or `null` to end the stream (an `done` event is sent). */
export type SsePull = () => SseEvent[] | null | Promise<SseEvent[] | null>;

/**
 * Re-asked before every write: `undefined` while the caller may still read,
 * otherwise why they may not — in the same `{ message, fix }` shape as every
 * error body, because it is delivered as one before the stream closes.
 */
export type SseGuard = () => { message: string; fix: string } | undefined;

const POLL_MS = 300;
const HEARTBEAT_MS = 15_000;

const frame = (e: SseEvent): string =>
  `${e.id === undefined ? "" : `id: ${e.id}\n`}${e.event ? `event: ${e.event}\n` : ""}data: ${JSON.stringify(e.data)}\n\n`;

export function sseResponse(signal: AbortSignal, guard: SseGuard, pull: SsePull): Response {
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let lastWrite = Date.now();
      let busy = false;

      const write = (s: string) => {
        if (closed) return;
        controller.enqueue(enc.encode(s));
        lastWrite = Date.now();
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        signal.removeEventListener("abort", close);
        try {
          controller.close();
        } catch {
          /* already closed by the client */
        }
      };

      /**
       * True once the caller may no longer read — by which point they have been
       * told why and the stream is closed. Asked before `pull` and again after
       * it, because membership can end while an async `pull` is awaiting and a
       * payload computed under the old answer must not still go out.
       */
      const revoked = (): boolean => {
        if (closed) return true;
        const denial = guard();
        if (!denial) return false;
        write(frame({ event: "error", data: denial }));
        close();
        return true;
      };

      if (signal.aborted) return close();
      signal.addEventListener("abort", close);
      write(": open\n\n");

      const tick = async () => {
        if (closed || busy) return;
        busy = true;
        try {
          if (revoked()) return;
          const batch = await pull();
          if (revoked()) return;
          if (batch === null) {
            write("event: done\ndata: {}\n\n");
            close();
            return;
          }
          for (const e of batch) write(frame(e));
          if (Date.now() - lastWrite >= HEARTBEAT_MS) write(": ping\n\n");
        } catch (err) {
          write(
            frame({
              event: "error",
              data: {
                message: err instanceof Error ? err.message : String(err),
                fix: "Reload the page to reconnect; history replays from the event log.",
              },
            })
          );
          close();
        } finally {
          busy = false;
        }
      };

      timer = setInterval(() => void tick(), POLL_MS);
      void tick();
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      /** disable proxy buffering so events arrive as they happen */
      "x-accel-buffering": "no",
    },
  });
}
