"use client";
/**
 * Client access to the alerts feed.
 *
 * Deliberately small: it is `useJson` against the alerts route and nothing
 * else, so it inherits the spine's polling behaviour — backs off while the
 * answer stops changing, stops entirely while the tab is hidden, refetches on
 * return. Two consumers today: the Observe screen (rules, events, history) and,
 * once it is wired, the shell's activity bell, which only needs `open`.
 *
 *   import { useProjectAlerts } from "@/lib/client/alerts";
 *   const { open } = useProjectAlerts(projectId);   // AlertEvent[], newest first
 *
 * Delivery is in-product only — see `feed.delivery` on the wire and
 * docs/LIMITATIONS.md. This hook is the delivery channel.
 */
import { useJson, type Loadable } from "@/lib/client/api";
// Type-only: erased at compile time, so no server module reaches the bundle.
import type { AlertKindSpec } from "@/lib/alerts";
import type { AlertEvent, AlertKind, AlertRule } from "@/lib/domain/types";

/** Matches GET /api/projects/:id/alerts. */
export interface AlertsFeed {
  rules: AlertRule[];
  /** the evaluator's own vocabulary, so UI copy cannot drift from it */
  kinds: Record<AlertKind, AlertKindSpec>;
  /** open alerts first, then the tail of history */
  events: AlertEvent[];
  open: AlertEvent[];
  recent: AlertEvent[];
  /** true: every condition Orrery evaluates today reads generated or estimated data */
  simulated: boolean;
  generatedBy: string;
  evaluatedAt: string;
  evaluationIntervalMs: number;
  /** the honest sentence about where an alert does and does not go */
  delivery: string;
}

/**
 * Poll rate. Slower than the health cards (5s) on purpose: an alert that
 * appears within half a minute is a notification; one that costs a request a
 * second is a bill. `useJson` doubles this while nothing changes.
 */
export const ALERTS_POLL_MS = 20_000;

export interface ProjectAlerts extends Loadable<AlertsFeed> {
  /** open alerts, newest first — empty while loading or on error */
  open: AlertEvent[];
  /** open alerts nobody has acknowledged yet; what a bell should count */
  unacknowledged: AlertEvent[];
  rules: AlertRule[];
}

/**
 * Alerts for one project, optionally narrowed to one environment.
 * Pass `null`/`undefined` for `projectId` to hold off fetching.
 */
export function useProjectAlerts(
  projectId: string | undefined | null,
  environmentId?: string,
  refreshMs: number = ALERTS_POLL_MS
): ProjectAlerts {
  const feed = useJson<AlertsFeed>(
    projectId ? `/api/projects/${projectId}/alerts${environmentId ? `?env=${environmentId}` : ""}` : null,
    refreshMs
  );
  const open = feed.data?.open ?? [];
  return {
    ...feed,
    open,
    unacknowledged: open.filter((e) => !e.acknowledgedAt),
    rules: feed.data?.rules ?? [],
  };
}

/** Matches GET /api/projects/:id/alerts/events. */
export interface AlertHistory {
  events: AlertEvent[];
  nextCursor?: string;
  simulated: boolean;
}

/** A page of past alerts. No polling: history does not move under the reader. */
export function useAlertHistory(
  projectId: string | undefined | null,
  environmentId?: string,
  limit = 50
): Loadable<AlertHistory> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (environmentId) params.set("env", environmentId);
  return useJson<AlertHistory>(
    projectId ? `/api/projects/${projectId}/alerts/events?${params}` : null
  );
}
