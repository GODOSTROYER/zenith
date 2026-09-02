"use client";
/**
 * Activity — the durable trail. Every action, whoever ran it, whatever it did.
 * Agent work is always marked as agent work.
 *
 * Filters are query parameters, not a pass over whatever happened to be
 * loaded: "Navigator only" reaches back through the whole log, so an empty
 * result means there is genuinely nothing, not that it fell outside a window.
 * Search is the one exception, and says so.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Search, ScrollText } from "lucide-react";
import { api } from "@/lib/client/api";
import type { AuditEvent } from "@/lib/domain/types";
import { cx } from "@/lib/format";
import {
  Button,
  Card,
  Chip,
  EmptyState,
  Input,
  SegmentedControl,
  Select,
  Skeleton,
  TimeAgo,
  type ChipTone,
} from "@/components/ui";
import { useSelectedEnv } from "@/components/screens/project-data";
import { ActorDot, ErrorNote } from "@/components/screens/shared";

type ActorFilter = "all" | "user" | "navigator" | "system";
type ResultFilter = "all" | "ok" | "error" | "denied";

const PAGE_SIZE = 50;
const POLL_MS = 10_000;

const RESULT_TONE: Record<AuditEvent["result"], ChipTone> = {
  ok: "ok",
  error: "err",
  denied: "warn",
};

/** Action prefixes worth filtering by; the endpoint takes any `prefix.` form. */
const ACTION_OPTIONS = [
  { value: "all", label: "All actions" },
  { value: "deploy.", label: "Deploys" },
  { value: "system.", label: "System edits" },
  { value: "project.", label: "Project" },
  { value: "env.", label: "Environments" },
  { value: "connection.", label: "Connections" },
];

const ACTOR_LABEL: Record<ActorFilter, string> = {
  all: "everyone",
  user: "people",
  navigator: "the Navigator",
  system: "the system",
};

interface AuditPage {
  events: AuditEvent[];
  nextCursor?: string;
}

export default function ActivityPage() {
  const { projectId, slug } = useSelectedEnv();
  const [actor, setActor] = useState<ActorFilter>("all");
  const [action, setAction] = useState("all");
  const [result, setResult] = useState<ResultFilter>("all");
  const [query, setQuery] = useState("");

  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<unknown>();

  /** Older pages are hand-loaded; polling would throw them away. */
  const pagedRef = useRef(false);

  const base = projectId
    ? `/api/projects/${projectId}/audit?limit=${PAGE_SIZE}` +
      (actor === "all" ? "" : `&actor=${actor}`) +
      (action === "all" ? "" : `&action=${encodeURIComponent(action)}`) +
      (result === "all" ? "" : `&result=${result}`)
    : null;

  useEffect(() => {
    if (!base) return;
    let alive = true;
    pagedRef.current = false;
    setLoading(true);
    setEvents([]);
    setCursor(undefined);

    const fetchFirst = () =>
      api<AuditPage>(base)
        .then((page) => {
          if (!alive) return;
          setEvents(page.events);
          setCursor(page.nextCursor);
          setError(undefined);
        })
        .catch((e: unknown) => alive && setError(e))
        .finally(() => alive && setLoading(false));

    void fetchFirst();
    const timer = setInterval(() => {
      if (!pagedRef.current) void fetchFirst();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [base]);

  const loadOlder = async () => {
    if (!base || !cursor) return;
    pagedRef.current = true;
    setLoadingOlder(true);
    try {
      const page = await api<AuditPage>(`${base}&cursor=${encodeURIComponent(cursor)}`);
      setEvents((prev) => [...prev, ...page.events]);
      setCursor(page.nextCursor);
      setError(undefined);
    } catch (e) {
      setError(e);
    } finally {
      setLoadingOlder(false);
    }
  };

  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      needle
        ? events.filter((e) =>
            `${e.summary} ${e.actionId} ${e.actor.name} ${e.error ?? ""}`
              .toLowerCase()
              .includes(needle)
          )
        : events,
    [events, needle]
  );

  const days = useMemo(() => groupByDay(shown), [shown]);

  const exportTrail = useCallback(() => {
    download(
      `orrery-activity-${slug}-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          project: slug,
          filters: { actor, action, result, search: query.trim() || undefined },
          note: "The events matching these filters that were loaded in the browser at export time; load older pages first for a longer trail.",
          events: shown,
        },
        null,
        2
      )
    );
  }, [shown, slug, actor, action, result, query]);

  const filterSentence = [
    actor === "all" ? null : `by ${ACTOR_LABEL[actor]}`,
    action === "all" ? null : `matching ${action}*`,
    result === "all" ? null : `that ended ${result}`,
  ]
    .filter(Boolean)
    .join(", ");

  const heading = needle
    ? `${shown.length} of ${events.length} loaded action${events.length === 1 ? "" : "s"} match “${query.trim()}”`
    : `${events.length} action${events.length === 1 ? "" : "s"} loaded${filterSentence ? ` ${filterSentence}` : ""}${
        cursor ? " · older still available" : " · that is the whole trail"
      }`;

  return (
    <div className="mx-auto h-full w-full overflow-y-auto max-w-[980px] px-6 py-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">{heading}</h2>
        <Button
          size="sm"
          variant="quiet"
          icon={<Download className="h-3.5 w-3.5" />}
          disabled={shown.length === 0}
          disabledReason="Nothing to export yet — load or match at least one action first."
          onClick={exportTrail}
          title="Download the actions currently listed as a JSON file"
        >
          Export {shown.length}
        </Button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          className="min-w-[220px] flex-1"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search loaded actions…"
          aria-label="Search loaded actions"
          prefix={<Search className="h-3.5 w-3.5" />}
        />
        <SegmentedControl<ActorFilter>
          size="sm"
          label="Filter by who acted"
          value={actor}
          onChange={setActor}
          options={[
            { value: "all", label: "Everyone" },
            { value: "user", label: "People", title: "Actions a person ran" },
            { value: "navigator", label: "Navigator", title: "Actions the agent ran" },
            { value: "system", label: "System", title: "Actions the platform ran itself" },
          ]}
        />
        <Select
          className="w-[150px]"
          aria-label="Filter by action"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          options={ACTION_OPTIONS}
        />
        <Select
          className="w-[130px]"
          aria-label="Filter by result"
          value={result}
          onChange={(e) => setResult(e.target.value as ResultFilter)}
          options={[
            { value: "all", label: "Any result" },
            { value: "ok", label: "Succeeded" },
            { value: "error", label: "Failed" },
            { value: "denied", label: "Refused" },
          ]}
        />
      </div>

      {needle && cursor ? (
        <p className="mb-3 text-[12.5px] text-ink-faint">
          Search only reads the {events.length} actions loaded so far — the filters above run
          against the whole trail. Load older to search further back.
        </p>
      ) : null}

      {error ? <ErrorNote error={error} className="mb-4" /> : null}

      {loading && events.length === 0 ? (
        <div className="space-y-2">
          <Skeleton height={52} />
          <Skeleton height={52} />
          <Skeleton height={52} />
        </div>
      ) : shown.length === 0 ? (
        <EmptyState
          icon={<ScrollText className="h-5 w-5" />}
          title={
            needle
              ? `Nothing loaded matches “${query.trim()}”`
              : filterSentence
                ? "Nothing in the whole trail matches this filter"
                : "Nothing has happened yet"
          }
          body={
            needle
              ? "Search looks at the actions loaded in this page. Clear it, or load older actions and search again."
              : filterSentence
                ? "The filters query the full audit log, not just this page — so this really is empty. Widen a filter to see more."
                : "Every action anyone runs on this project — you, the Navigator, or the system — is recorded here permanently."
          }
        />
      ) : (
        <div className="space-y-5">
          {days.map((day) => (
            <section key={day.key}>
              <h3 className="mb-2 flex items-baseline gap-2 text-[12px] tracking-[0.02em] text-ink-mute uppercase">
                {day.label}
                <span className="tnum text-ink-faint normal-case">
                  {day.events.length} action{day.events.length === 1 ? "" : "s"}
                </span>
              </h3>
              <Card padded={false}>
                <ul>
                  {day.events.map((e) => (
                    <EventRow key={e.id} event={e} />
                  ))}
                </ul>
              </Card>
            </section>
          ))}

          {cursor ? (
            <Button variant="quiet" block busy={loadingOlder} onClick={loadOlder}>
              Load {PAGE_SIZE} older actions
            </Button>
          ) : (
            <p className="text-center text-[12.5px] text-ink-faint">
              The beginning of the trail{filterSentence ? ` ${filterSentence}` : ""}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function EventRow({ event: e }: { event: AuditEvent }) {
  return (
    <li
      className={cx(
        "flex items-start gap-3 border-b border-line px-5 py-3 last:border-b-0",
        e.actor.type === "navigator" && "bg-nav-dim/30"
      )}
    >
      <span className="mt-1.5">
        <ActorDot actor={e.actor} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-ink">{e.summary}</p>
        {e.error && <p className="mt-0.5 text-[12.5px] text-err">{e.error}</p>}
        <p className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-faint">
          <span className="font-mono">{e.actionId}</span>
          <span>·</span>
          <span className={e.actor.type === "navigator" ? "text-nav-accent" : undefined}>
            {e.actor.type === "navigator" ? `${e.actor.name} (agent)` : e.actor.name}
          </span>
          <span>·</span>
          <TimeAgo iso={e.ts} />
        </p>
      </div>
      <Chip tone={RESULT_TONE[e.result]} className="mt-0.5 shrink-0">
        {e.result}
      </Chip>
    </li>
  );
}

/* -------------------------------- grouping -------------------------------- */

interface Day {
  key: string;
  label: string;
  events: AuditEvent[];
}

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

/** Local calendar days, newest first — the order the feed already arrives in. */
function groupByDay(events: AuditEvent[]): Day[] {
  const out: Day[] = [];
  for (const e of events) {
    const date = new Date(e.ts);
    const key = Number.isNaN(date.getTime()) ? "unknown" : date.toDateString();
    const last = out[out.length - 1];
    if (last?.key === key) last.events.push(e);
    else out.push({ key, label: dayLabel(date, key), events: [e] });
  }
  return out;
}

function dayLabel(date: Date, key: string): string {
  if (key === "unknown") return "Undated";
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (key === today.toDateString()) return "Today";
  if (key === yesterday.toDateString()) return "Yesterday";
  return DAY_FORMAT.format(date);
}

/* --------------------------------- export --------------------------------- */

/** Client-side file save; the audit trail never round-trips through a server. */
function download(filename: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
