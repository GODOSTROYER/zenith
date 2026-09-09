/**
 * Pure row logic behind the Activity feed: grouping, filtering, the CSV
 * export, and working out what object an action touched. Kept out of the
 * component so it can be tested directly — see tests/screens/activity-rows.test.ts.
 */
import type { AuditEvent } from "@/lib/domain/types";
import { csv } from "@/components/screens/download-file";

export interface Day {
  key: string;
  label: string;
  /** newest first, like the feed */
  events: AuditEvent[];
}

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

function dayLabel(date: Date, key: string): string {
  if (key === "unknown") return "Undated";
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (key === today.toDateString()) return "Today";
  if (key === yesterday.toDateString()) return "Yesterday";
  return DAY_FORMAT.format(date);
}

/**
 * Local calendar days, newest first. Independent of the order events arrive
 * in: two pages loaded out of order still produce one section per day.
 */
export function groupByDay(events: AuditEvent[]): Day[] {
  const days = new Map<string, { at: number; date: Date; events: AuditEvent[] }>();
  for (const e of events) {
    const date = new Date(e.ts);
    const valid = !Number.isNaN(date.getTime());
    const key = valid ? date.toDateString() : "unknown";
    const day = days.get(key);
    if (day) day.events.push(e);
    else
      days.set(key, {
        at: valid ? new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() : -Infinity,
        date,
        events: [e],
      });
  }
  return [...days.values()]
    .sort((a, b) => b.at - a.at)
    .map((day) => {
      const key = day.at === -Infinity ? "unknown" : day.date.toDateString();
      return {
        key,
        label: dayLabel(day.date, key),
        events: day.events.sort((a, b) => (a.ts === b.ts ? 0 : a.ts < b.ts ? 1 : -1)),
      };
    });
}

/** Newest first, one row per id — pages can overlap when new actions land. */
export function dedupe(events: AuditEvent[]): AuditEvent[] {
  const byId = new Map<string, AuditEvent>();
  for (const e of events) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => (a.ts === b.ts ? 0 : a.ts < b.ts ? 1 : -1));
}

/**
 * Keep events inside an inclusive local date range. `from`/`to` are
 * `<input type="date">` values ("2026-09-02"); either may be empty.
 */
export function inDateRange(e: AuditEvent, from: string, to: string): boolean {
  if (!from && !to) return true;
  const at = Date.parse(e.ts);
  if (Number.isNaN(at)) return false;
  if (from && at < new Date(`${from}T00:00:00`).getTime()) return false;
  if (to && at > new Date(`${to}T23:59:59.999`).getTime()) return false;
  return true;
}

/* --------------------------------- export --------------------------------- */

const CSV_COLUMNS = [
  "ts",
  "actor_type",
  "actor_name",
  "action",
  "result",
  "environment_id",
  "summary",
  "error",
] as const;

export function toCsv(events: AuditEvent[]): string {
  return csv(
    [...CSV_COLUMNS],
    events.map((e) => [
      e.ts,
      e.actor.type,
      e.actor.name,
      e.actionId,
      e.result,
      e.environmentId,
      e.summary,
      e.error,
    ])
  );
}

/* ------------------------------ object links ------------------------------ */

export interface ObjectLink {
  /** appended to /p/<slug> */
  path: string;
  label: string;
}

const ID_KEYS = ["serviceId", "nodeId", "targetId", "resourceId", "routeId"] as const;

function str(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" && v ? v : undefined;
}

/** Identity explicitly recorded by the action; never infer one from its prose. */
export function recordedResourceId(event: AuditEvent): string | undefined {
  for (const key of ID_KEYS) {
    const id = str(event.input, key);
    if (id) return id;
  }
  return undefined;
}

/**
 * Where the thing this action changed can be looked at, when the recorded
 * input names one. Only destinations that actually exist are returned — a
 * link that lands on a page which cannot show the object is worse than none.
 */
export function objectLink(event: AuditEvent): ObjectLink | undefined {
  const { input, actionId } = event;
  const resourceId = recordedResourceId(event);
  if (resourceId) return { path: `?select=${encodeURIComponent(resourceId)}`, label: "show on map" };
  if (str(input, "deploymentId") || actionId.startsWith("deploy."))
    return { path: "/deploys", label: "open deploys" };
  if (str(input, "revisionId") || str(input, "toRevisionId"))
    return { path: "/revisions", label: "open revisions" };
  if (actionId.startsWith("security.")) return { path: "/security", label: "open findings" };
  if (actionId.startsWith("connection.") || actionId.startsWith("env."))
    return { path: "/settings", label: "open settings" };
  return undefined;
}
