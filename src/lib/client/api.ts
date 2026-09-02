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
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // consecutive identical payloads, and the payload they were identical to
  const idle = useRef(0);
  const seen = useRef<string>("");

  useEffect(() => {
    idle.current = 0;
    seen.current = "";
  }, [url]);

  useEffect(() => {
    if (!url) return;
    let alive = true;
    setLoading((prev) => (data === undefined ? true : prev));
    api<T>(url)
      .then((d) => {
        if (!alive) return;
        const next = JSON.stringify(d);
        if (next === seen.current) idle.current += 1;
        else {
          idle.current = 0;
          seen.current = next;
        }
        setData(d);
        setError(undefined);
      })
      .catch((e: ApiError) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, tick]);

  useEffect(() => {
    if (!url || !refreshMs) return;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(run, ms);
    };
    // A hidden tab schedules nothing; `onVisibility` restarts the loop.
    function run() {
      if (isHidden()) return;
      refresh();
      schedule(pollDelay(refreshMs, idle.current));
    }

    const onVisibility = () => {
      clearTimeout(timer);
      if (isHidden()) return;
      idle.current = 0; // the tab was away; treat what it comes back to as new
      refresh();
      schedule(refreshMs);
    };

    if (!isHidden()) schedule(refreshMs);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [url, refreshMs, refresh]);

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
    if (!url) return;
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
