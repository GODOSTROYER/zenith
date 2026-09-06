"use client";
/**
 * Client data layer — the ONLY way UI code talks to the API.
 * SPINE FILE — owned by the integrator. Screens and the Navigator UI import
 * from here; nobody hand-rolls fetch calls, so conventions can't drift.
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
 */
export function pollDelay(baseMs: number, idleTicks: number): number {
  const steps = Math.min(Math.max(idleTicks, 0), MAX_IDLE_STEPS);
  return baseMs * 2 ** steps;
}

const isHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

// Share pending reads only, never cached responses or mutations. In particular,
// React Strict Mode's effect replay should not send a second identical request.
const pendingReads = new Map<string, Promise<unknown>>();
function readJson<T>(url: string): Promise<T> {
  let pending = pendingReads.get(url);
  if (!pending) {
    pending = api<unknown>(url).finally(() => pendingReads.delete(url));
    pendingReads.set(url, pending);
  }
  return pending as Promise<T>;
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

/**
 * Polling JSON hook. `refreshMs=0` disables polling (manual refresh only).
 *
 * Polling is honest about cost: it stops entirely while the tab is hidden and
 * refetches immediately on return, and it backs off while responses keep
 * coming back identical. Anything actually happening — a deployment moving
 * through its phases — changes the payload and snaps the interval back to
 * `refreshMs`.
 */
export function useJson<T>(url: string | null, refreshMs = 0): Loadable<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(!!url);
  const refreshRef = useRef<() => void>(() => {});
  const scheduleRef = useRef<() => void>(() => {});
  const intervalMs = useRef(refreshMs);
  intervalMs.current = refreshMs;
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    let alive = true;
    let requesting = false;
    let queued = false;
    let idle = 0;
    let seen: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setData(undefined);
    setError(undefined);
    setLoading(!!url);

    function schedule() {
      clearTimeout(timer);
      if (alive && url && intervalMs.current && !requesting && !isHidden()) {
        timer = setTimeout(run, pollDelay(intervalMs.current, idle));
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
      try {
        const result = await readJson<T>(url);
        if (!alive) return;
        const serialized = JSON.stringify(result);
        if (serialized === seen) idle += 1;
        else {
          idle = 0;
          seen = serialized;
          setData(result);
        }
        setError(undefined);
      } catch (cause) {
        if (alive) setError(cause as ApiError);
      } finally {
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
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const doneCb = useRef(onDone);
  doneCb.current = onDone;

  useEffect(() => {
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
