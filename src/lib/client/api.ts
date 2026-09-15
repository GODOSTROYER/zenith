"use client";
/**
 * Client data layer — the ONLY way UI code talks to the API.
 * Screens and the Navigator UI import from here; nobody hand-rolls fetch
 * calls, so conventions can't drift.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionPlan, ActionResult } from "@/lib/actions/core";

export class ApiError extends Error {
  fix?: string;
  status: number;
  constructor(message: string, status: number, fix?: string) {
    super(message);
    this.status = status;
    this.fix = fix;
  }
}

/** JSON fetch with the API's error envelope decoded. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as T & {
    error?: { message: string; fix?: string };
  };
  if (!res.ok || body?.error) {
    const e = body?.error;
    throw new ApiError(e?.message ?? `Request failed (${res.status}).`, res.status, e?.fix);
  }
  return body as T;
}

export interface ActionCall {
  input?: unknown;
  scope?: { projectId?: string; environmentId?: string };
  idempotencyKey?: string;
}

export async function planAction(actionId: string, call: ActionCall): Promise<ActionPlan> {
  const { plan } = await api<{ plan: ActionPlan }>(`/api/actions/${actionId}`, {
    method: "POST",
    body: JSON.stringify({ input: call.input ?? {}, mode: "plan", scope: call.scope }),
  });
  return plan;
}

export async function executeAction(actionId: string, call: ActionCall): Promise<ActionResult> {
  const { result } = await api<{ result: ActionResult }>(`/api/actions/${actionId}`, {
    method: "POST",
    body: JSON.stringify({
      input: call.input ?? {},
      mode: "execute",
      scope: call.scope,
      idempotencyKey: call.idempotencyKey,
    }),
  });
  return result;
}

/* --------------------------------- hooks ---------------------------------- */

export interface Loadable<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  /** refetch immediately (e.g. after executing an action) */
  refresh: () => void;
}

/** How far polling backs off after consecutive unchanged responses. */
export const MAX_IDLE_STEPS = 2;

/**
 * Poll interval for a hook that has seen `idleTicks` identical responses in a
 * row: `base` while anything is moving, doubling to 4× base once it is not.
 * A single changed payload (a deployment starting, say) resets it to `base`.
 *
 * `maxSteps` lowers that ceiling for a URL where lateness costs more than the
 * request does — `0` means no backoff at all, and the interval stays `base`.
 */
export function pollDelay(baseMs: number, idleTicks: number, maxSteps = MAX_IDLE_STEPS): number {
  const ceiling = Math.min(Math.max(maxSteps, 0), MAX_IDLE_STEPS);
  const steps = Math.min(Math.max(idleTicks, 0), ceiling);
  return baseMs * 2 ** steps;
}

/**
 * Spread a polling delay over a bounded window above itself.
 *
 * Tabs that opened together stay together: every one of them asks at the same
 * instant, for as long as they are open, and a run watched from three screens
 * arrives as three simultaneous requests every interval. Jitter breaks that
 * convoy without changing what the interval promises — the delay is never
 * shorter than `delayMs`, and never longer than `delayMs * (1 + ratio)`.
 *
 * `ratio` of 0 (the default everywhere that has not asked for it) returns the
 * delay untouched, so existing callers keep exactly the timing they had.
 */
export function withJitter(delayMs: number, ratio: number, random: () => number = Math.random): number {
  const spread = Math.min(Math.max(ratio, 0), 1);
  if (spread === 0 || delayMs <= 0) return delayMs;
  return Math.round(delayMs * (1 + spread * random()));
}

const isHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/**
 * The last body a conditional GET returned, and the tag it came with.
 *
 * Polling is mostly a question — "has this moved?" — and a route that answers
 * with an ETag can say no in a header instead of a payload. The entry is keyed
 * by URL and shared by every hook reading it, which is also what makes a
 * second reader of the same URL safe: a 304 hands back the body held here, not
 * nothing.
 *
 * TODO(ceiling): bounded, LRU by insertion order. A route with no ETag never gets
 * an entry and behaves exactly as before.
 */
const ETAG_CACHE_MAX = 64;
const etagCache = new Map<string, { etag: string; body: unknown }>();

async function conditionalRead<T>(
  url: string,
  conditional = true,
  signal?: AbortSignal
): Promise<{ data: T; unchanged: boolean }> {
  const cached = conditional ? etagCache.get(url) : undefined;
  const res = await fetch(url, {
    headers: {
      "content-type": "application/json",
      ...(cached ? { "if-none-match": cached.etag } : {}),
    },
    cache: "no-store",
    signal,
  });

  if (res.status === 304) {
    // Only ever sent a tag we held, so this is the body that tag named. A 304
    // without one (a proxy answering from its own cache) is re-asked plainly
    // rather than turned into an empty payload.
    if (cached) return { data: cached.body as T, unchanged: true };
    return conditionalRead<T>(url, false, signal);
  }

  const body = (await res.json().catch(() => ({}))) as T & {
    error?: { message: string; fix?: string };
  };
  if (!res.ok || body?.error) {
    const e = body?.error;
    throw new ApiError(e?.message ?? `Request failed (${res.status}).`, res.status, e?.fix);
  }

  // Optional chaining, not laziness: `fetch` is stubbed in tests and by some
  // service workers with the two fields a caller actually reads, and a missing
  // header must mean "this route has no tag", not a thrown read.
  const etag = res.headers?.get("etag");
  etagCache.delete(url);
  if (etag) {
    etagCache.set(url, { etag, body });
    if (etagCache.size > ETAG_CACHE_MAX)
      etagCache.delete(etagCache.keys().next().value as string);
  }
  return { data: body as T, unchanged: false };
}

/** True for the rejection a cancelled `fetch` produces, in either shape. */
export const isAbort = (cause: unknown): boolean =>
  (cause as { name?: string } | null)?.name === "AbortError";

interface SharedRead {
  promise: Promise<{ data: unknown; unchanged: boolean }>;
  controller: AbortController;
  /** how many mounted hooks are still waiting on this one request */
  readers: number;
}

// Share pending reads only, never cached responses or mutations. In particular,
// React Strict Mode's effect replay should not send a second identical request.
//
// Each shared read carries the AbortController for its own `fetch`, and the
// readers are counted: a screen that unmounts or changes route lets go of its
// read, and the request is cancelled only once nobody is left waiting for it.
// Aborting on the first release would cancel a request a *second*, still-mounted
// reader of the same URL is depending on.
const pendingReads = new Map<string, SharedRead>();

interface Read<T> {
  promise: Promise<{ data: T; unchanged: boolean }>;
  /** stop waiting; cancels the request when this was the last reader */
  release: () => void;
}

function readJson<T>(url: string): Read<T> {
  let shared = pendingReads.get(url);
  if (!shared) {
    const controller = new AbortController();
    const entry: SharedRead = {
      controller,
      readers: 0,
      promise: undefined as unknown as SharedRead["promise"],
    };
    entry.promise = conditionalRead<T>(url, true, controller.signal).finally(() => {
      if (pendingReads.get(url) === entry) pendingReads.delete(url);
    });
    pendingReads.set(url, entry);
    shared = entry;
  }
  const entry = shared;
  entry.readers += 1;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    entry.readers -= 1;
    // Strict Mode detaches and re-attaches inside one commit. Deferring the
    // decision by a microtask lets that remount re-claim the request it just
    // let go of, instead of cancelling it and paying for a second one.
    queueMicrotask(() => {
      if (entry.readers > 0) return;
      if (pendingReads.get(url) === entry) pendingReads.delete(url);
      entry.controller.abort();
    });
  };

  return { promise: entry.promise as Read<T>["promise"], release };
}

/**
 * Poll interval for a screen that also has an SSE stream for the same data.
 *
 * `streaming` must mean *payloads are arriving*, not merely that the socket
 * opened: a stream that connects and then says nothing — a buffering proxy, a
 * route that throws after the first frame — would otherwise leave the screen
 * frozen with no poll behind it. Anything short of a live stream (no
 * EventSource in this browser, a connection that failed, one that has not
 * delivered yet) falls back to `baseMs`, which is exactly the behaviour that
 * existed before the stream.
 */
export const streamedPollMs = (streaming: boolean, baseMs: number): number =>
  streaming ? 0 : baseMs;

export interface UseJsonOptions {
  /**
   * How far this URL may back off while its responses are identical, in
   * doublings. Defaults to `MAX_IDLE_STEPS` (4× the base interval); `0` keeps
   * the base interval no matter how long nothing changes, for a URL whose
   * whole job is to notice something that happened somewhere else.
   */
  maxIdleSteps?: number;
  /**
   * Fraction of the delay to spread each poll over, so several tabs watching
   * the same thing stop asking in lockstep. `0.2` means "somewhere in the next
   * interval to interval-and-a-fifth". Defaults to `0` — no jitter, and the
   * exact timing every existing caller already has.
   */
  jitterRatio?: number;
}

/**
 * Polling JSON hook. `refreshMs=0` disables polling (manual refresh only).
 *
 * Polling is honest about cost: it stops entirely while the tab is hidden and
 * refetches immediately on return, and it backs off while responses keep
 * coming back identical. Anything actually happening — a deployment moving
 * through its phases — changes the payload and snaps the interval back to
 * `refreshMs`.
 */
export function useJson<T>(
  url: string | null,
  refreshMs = 0,
  options: UseJsonOptions = {}
): Loadable<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(!!url);
  const refreshRef = useRef<() => void>(() => {});
  const scheduleRef = useRef<() => void>(() => {});
  const intervalMs = useRef(refreshMs);
  intervalMs.current = refreshMs;
  // Read through a ref, like the interval: an options object is a new literal
  // on every render and must not re-run the effect that owns the timer.
  const maxIdleSteps = useRef(options.maxIdleSteps);
  maxIdleSteps.current = options.maxIdleSteps;
  const jitterRatio = useRef(options.jitterRatio);
  jitterRatio.current = options.jitterRatio;
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    let alive = true;
    let requesting = false;
    let queued = false;
    let idle = 0;
    let seen: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** the read this hook is currently waiting on, so it can let go of it */
    let inflight: { release: () => void } | undefined;
    setData(undefined);
    setError(undefined);
    setLoading(!!url);

    function schedule() {
      clearTimeout(timer);
      if (alive && url && intervalMs.current && !requesting && !isHidden()) {
        timer = setTimeout(
          run,
          withJitter(
            pollDelay(intervalMs.current, idle, maxIdleSteps.current ?? MAX_IDLE_STEPS),
            jitterRatio.current ?? 0
          )
        );
      }
    }
    scheduleRef.current = schedule;

    // Wait for completion before scheduling another poll. A cold route compile
    // can take longer than the interval; overlapping it only adds a backlog.
    async function run() {
      if (!alive || !url || isHidden()) return;
      if (requesting) { queued = true; return; }
      clearTimeout(timer);
      requesting = true;
      queued = false;
      const read = readJson<T>(url);
      inflight = read;
      try {
        const { data: result, unchanged } = await read.promise;
        if (!alive) return;
        // A 304 is the server saying "identical", which is the same answer the
        // stringify below computes — without the payload or the compare. It is
        // only trusted once this hook has a payload of its own to keep: a hook
        // mounting onto a URL another one already cached still needs it.
        if (unchanged && seen !== undefined) idle += 1;
        else {
          const serialized = JSON.stringify(result);
          if (serialized === seen) idle += 1;
          else {
            idle = 0;
            seen = serialized;
            setData(result);
          }
        }
        setError(undefined);
      } catch (cause) {
        // A cancelled read is this hook going away, not the route failing.
        if (alive && !isAbort(cause)) setError(cause as ApiError);
      } finally {
        if (inflight === read) inflight = undefined;
        read.release();
        requesting = false;
        if (alive) {
          setLoading(false);
          // Explicit refresh during a request (e.g. after a mutation) gets one
          // fresh read afterwards, so the pending response cannot swallow it.
          if (queued && !isHidden()) void run();
          else schedule();
        }
      }
    }

    refreshRef.current = () => { idle = 0; void run(); };
    const onVisibility = () => {
      clearTimeout(timer);
      if (!isHidden()) { idle = 0; void run(); }
    };
    void run();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      clearTimeout(timer);
      // Unmount, or a new URL: stop waiting on the old read. The request is
      // cancelled outright when no other mounted hook is reading the same URL.
      inflight?.release();
      inflight = undefined;
      refreshRef.current = () => {};
      scheduleRef.current = () => {};
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [url]);

  useEffect(() => scheduleRef.current(), [refreshMs]);

  return { data, error, loading, refresh };
}

/**
 * SSE hook with replay cursors. Handler receives parsed event payloads;
 * `eventTypes` filters which named events are subscribed. Reconnects with
 * `?after=<lastSeq>` automatically (long operations survive refresh).
 */
export function useEventStream(
  url: string | null,
  eventTypes: string[],
  onEvent: (type: string, data: unknown, seq: number) => void,
  onDone?: () => void
): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const lastSeq = useRef(-1);
  const cursorUrl = useRef<string | null>(null);
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const doneCb = useRef(onDone);
  doneCb.current = onDone;

  useEffect(() => {
    // Sequence numbers belong to one stream. A new deployment must replay
    // from its beginning; reconnecting or changing listeners keeps its cursor.
    if (cursorUrl.current !== url) {
      cursorUrl.current = url;
      lastSeq.current = -1;
    }
    // No EventSource (an old browser, a test renderer) is not an error: the
    // caller keeps `connected: false` and whatever fallback it has.
    if (!url || typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    let closed = false;

    const open = () => {
      if (closed) return;
      const sep = url.includes("?") ? "&" : "?";
      es = new EventSource(`${url}${sep}after=${lastSeq.current}`);
      es.onopen = () => setConnected(true);
      for (const t of eventTypes) {
        es.addEventListener(t, (ev) => {
          const me = ev as MessageEvent;
          const seq = Number(me.lastEventId ?? -1);
          if (!Number.isNaN(seq)) lastSeq.current = Math.max(lastSeq.current, seq);
          try {
            cb.current(t, JSON.parse(me.data as string), seq);
          } catch {
            cb.current(t, me.data, seq);
          }
        });
      }
      es.addEventListener("done", () => {
        closed = true;
        setConnected(false);
        es?.close();
        doneCb.current?.();
      });
      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (!closed) setTimeout(open, 1200); // reconnect with replay cursor
      };
    };
    open();
    return () => {
      closed = true;
      es?.close();
      setConnected(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, eventTypes.join(",")]);

  return { connected };
}
