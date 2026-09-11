"use client";
/**
 * Activity — the durable trail. Every action, whoever ran it, whatever it did.
 * Agent work is always marked as agent work.
 *
 * Filters are query parameters, not a pass over whatever happened to be
 * loaded: "Navigator only" reaches back through the whole log, so an empty
 * result means there is genuinely nothing, not that it fell outside a window.
 * Search and the date range are the exceptions, and say so.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, ScrollText } from "lucide-react";
import { api, useJson } from "@/lib/client/api";
import type { AuditEvent } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Table } from "@/components/ui/table";
import { useSelectedEnv } from "@/components/screens/project-data";
import { downloadFile } from "@/components/screens/download-file";
import { ErrorNote } from "@/components/screens/shared";
import { ActivityDetail } from "./activity-detail";
import { ACTIVITY_COLUMNS } from "./columns";
import {
  ActivityFilters,
  ACTOR_LABEL,
  type ActorFilter,
  type ResultFilter,
} from "./activity-filters-bar";
import { dedupe, groupByDay, inDateRange, toCsv } from "./rows";

const PAGE_SIZE = 50;
const POLL_MS = 10_000;

interface AuditPage {
  events: AuditEvent[];
  nextCursor?: string;
  /** SEAM (T10): the route does not count matches yet; "50+" until it does. */
  total?: number;
}

export default function ActivityPage() {
  const { data, projectId, slug } = useSelectedEnv();
  const [actor, setActor] = useState<ActorFilter>("all");
  const [action, setAction] = useState("all");
  const [result, setResult] = useState<ResultFilter>("all");
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selection, setSelection] = useState<{ projectId: string; event: AuditEvent }>();
  const selectedEvent = selection?.projectId === projectId ? selection.event : undefined;

  /** Older pages are hand-loaded; polling the newest page would sit on top of them. */
  const [older, setOlder] = useState<{ events: AuditEvent[]; cursor?: string }>({ events: [] });
  const [paused, setPaused] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>();

  const base = projectId
    ? `/api/projects/${projectId}/audit?limit=${PAGE_SIZE}` +
      (actor === "all" ? "" : `&actor=${actor}`) +
      (action === "all" ? "" : `&action=${encodeURIComponent(action)}`) +
      (result === "all" ? "" : `&result=${result}`)
    : // SEAM (T3): `&env=<environmentId>` goes here once the audit route filters on it.
      null;

  const page = useJson<AuditPage>(base, paused ? 0 : POLL_MS);

  useEffect(() => {
    setOlder({ events: [] });
    setPaused(false);
    setOlderError(undefined);
  }, [base]);

  const events = useMemo(
    () => dedupe([...(page.data?.events ?? []), ...older.events]),
    [page.data, older.events]
  );
  const cursor = older.events.length ? older.cursor : page.data?.nextCursor;

  const loadOlder = async () => {
    if (!base || !cursor) return;
    setPaused(true);
    setLoadingOlder(true);
    setOlderError(undefined);
    try {
      const next = await api<AuditPage>(`${base}&cursor=${encodeURIComponent(cursor)}`);
      setOlder((prev) => ({
        events: [...prev.events, ...next.events],
        cursor: next.nextCursor,
      }));
    } catch (e) {
      setOlderError(e);
    } finally {
      setLoadingOlder(false);
    }
  };

  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      events.filter(
        (e) =>
          inDateRange(e, from, to) &&
          (!needle ||
            `${e.summary} ${e.actionId} ${e.actor.name} ${e.error ?? ""}`
              .toLowerCase()
              .includes(needle))
      ),
    [events, needle, from, to]
  );

  const days = useMemo(() => groupByDay(shown), [shown]);

  const save = useCallback(
    (kind: "json" | "csv") => {
      const stamp = new Date().toISOString().slice(0, 10);
      const note =
        "The events matching these filters that were loaded in the browser at export time; load older pages first for a longer trail.";
      if (kind === "csv") {
        downloadFile(`zenith-activity-${slug}-${stamp}.csv`, toCsv(shown), "text/csv");
        return;
      }
      downloadFile(
        `zenith-activity-${slug}-${stamp}.json`,
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            project: slug,
            filters: { actor, action, result, search: query.trim() || undefined, from, to },
            note,
            events: shown,
          },
          null,
          2
        ),
        "application/json"
      );
    },
    [shown, slug, actor, action, result, query, from, to]
  );

  const filterSentence = [
    actor === "all" ? null : `by ${ACTOR_LABEL[actor]}`,
    action === "all" ? null : `matching ${action}*`,
    result === "all" ? null : `that ended ${result}`,
  ]
    .filter(Boolean)
    .join(", ");

  const clientFiltered = Boolean(needle || from || to);
  const loadedCount = `${events.length}${cursor ? "+" : ""}`;
  const matching = [
    needle ? `“${query.trim()}”` : null,
    from || to ? `${from || "the start"} to ${to || "now"}` : null,
  ]
    .filter(Boolean)
    .join(" and ");
  const heading = clientFiltered
    ? `${shown.length} of ${loadedCount} loaded action${events.length === 1 ? "" : "s"} match ${matching}`
    : `${loadedCount} action${events.length === 1 ? "" : "s"} loaded${filterSentence ? ` ${filterSentence}` : ""}${
        cursor ? " · older still available" : " · that is the whole trail"
      }`;

  return (
    <div className="product-page h-full w-full overflow-y-auto">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-line pb-5">
        <div className="min-w-0">
          <h1 className="app-page-title">Activity</h1>
          <p className="mt-2 max-w-[65ch] text-[13px] text-ink-mute">The project’s audit trail, across every environment. Inspect an action to see its recorded context.</p>
        </div>
        <span className="flex items-center gap-2">
          <Button
            size="sm"
            variant="quiet"
            icon={<Download className="h-3.5 w-3.5" />}
            disabled={shown.length === 0}
            disabledReason="Nothing to export yet — load or match at least one action first."
            onClick={() => save("csv")}
            title={`Download the ${shown.length} actions listed here as CSV, built in your browser`}
          >
            CSV
          </Button>
          <Button
            size="sm"
            variant="quiet"
            icon={<Download className="h-3.5 w-3.5" />}
            disabled={shown.length === 0}
            disabledReason="Nothing to export yet — load or match at least one action first."
            onClick={() => save("json")}
            title={`Download the ${shown.length} actions listed here as JSON, built in your browser`}
          >
            JSON
          </Button>
        </span>
      </div>

      <ActivityFilters
        query={query}
        actor={actor}
        action={action}
        result={result}
        from={from}
        to={to}
        loadedCount={events.length}
        onQuery={setQuery}
        onActor={setActor}
        onAction={setAction}
        onResult={setResult}
        onFrom={setFrom}
        onTo={setTo}
        onClearDates={() => {
          setFrom("");
          setTo("");
        }}
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3 text-[12px] text-ink-mute">
        <p aria-live="polite">{page.loading && !events.length ? "Loading the audit trail…" : page.error && !events.length ? "Audit trail unavailable" : heading}</p>
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${paused || page.error ? "bg-warn" : "bg-info"}`} />
          {paused ? "Updates paused" : page.error ? "Refresh unavailable" : "Updates automatically"}
        </span>
      </div>

      {paused && (
        <div
          role="status"
          className="mb-3 flex flex-wrap items-center gap-3 border-y border-line bg-bg1 px-4 py-3 text-[13px] text-ink-mute"
        >
          <span className="min-w-0 flex-1">
            Live updates are paused while you read older actions — new ones will not appear until
            you resume.
          </span>
          <Button
            size="sm"
            variant="quiet"
            onClick={() => {
              setOlder({ events: [] });
              setPaused(false);
              page.refresh();
            }}
          >
            Resume, back to newest
          </Button>
        </div>
      )}

      {needle && cursor ? (
        <p className="mb-3 text-[12.5px] text-ink-faint">
          Search only reads the {events.length} actions loaded so far — the actor, action and
          result filters run against the whole trail. Load older to search further back.
        </p>
      ) : null}

      {page.error ? <ErrorNote error={page.error} className="mb-4" /> : null}
      {olderError ? <ErrorNote error={olderError} className="mb-4" /> : null}

      {page.loading && events.length === 0 ? (
        <div className="space-y-2">
          <Skeleton height={52} />
          <Skeleton height={52} />
          <Skeleton height={52} />
        </div>
      ) : page.error && events.length === 0 ? (
        <EmptyState icon={<ScrollText className="h-5 w-5" />} title="The audit trail could not be loaded" body="Retry to retrieve the project’s recorded actions. Existing history has not been changed." action={<Button variant="quiet" onClick={page.refresh}>Retry audit trail</Button>} />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={<ScrollText className="h-5 w-5" />}
          title={
            clientFiltered
              ? "Nothing loaded matches this search or date range"
              : filterSentence
                ? "Nothing in the whole trail matches this filter"
                : "Nothing has happened yet"
          }
          body={
            clientFiltered
              ? "Search and dates look at the actions loaded in this page. Clear them, or load older actions and try again."
              : filterSentence
                ? "The filters query the full audit log, not just this page — so this really is empty. Widen a filter to see more."
                : "Every action anyone runs on this project — you, the Navigator, or the system — is recorded here permanently."
          }
          action={clientFiltered ? <Button variant="quiet" onClick={() => { setQuery(""); setFrom(""); setTo(""); }}>Clear search and dates</Button> : undefined}
        />
      ) : (
        <div className="space-y-5">
          {days.map((day) => (
            <section key={day.key}>
              <h2 className="mb-3 flex items-baseline gap-3 text-[14px] font-medium text-ink">
                {day.label}
                <span className="tnum text-ink-faint normal-case">
                  {day.events.length} action{day.events.length === 1 ? "" : "s"}
                </span>
              </h2>
              <div className="border-y border-line">
                {/* One table per day: a single table spanning the whole feed
                    would put a day heading inside a row, which is a heading
                    pretending to be data. The day is the caption. */}
                <Table<AuditEvent>
                  caption={`${day.label} — ${day.events.length} action${day.events.length === 1 ? "" : "s"}`}
                  rows={day.events}
                  rowKey={(e) => e.id}
                  selectedKey={selectedEvent?.id}
                  rowClassName={(e) => (e.actor.type === "navigator" ? "bg-nav-dim/30" : undefined)}
                  columns={ACTIVITY_COLUMNS(slug, data?.environments ?? [], (event) => {
                    if (projectId) setSelection({ projectId, event });
                  })}
                />
              </div>
            </section>
          ))}

          {!cursor && (
            <p className="text-center text-[12.5px] text-ink-faint">
              The beginning of the trail{filterSentence ? ` ${filterSentence}` : ""}.
            </p>
          )}
        </div>
      )}
      {cursor && <div className="mt-5"><Button variant="quiet" block busy={loadingOlder} onClick={loadOlder}>Load {PAGE_SIZE} older actions</Button></div>}
      <ActivityDetail event={selectedEvent} environments={data?.environments ?? []} slug={slug} onClose={() => setSelection(undefined)} />
    </div>
  );
}
