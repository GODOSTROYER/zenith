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
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Table } from "@/components/ui/table";
import { useSelectedEnv } from "@/components/screens/project-data";
import { downloadFile } from "@/components/screens/download-file";
import { ErrorNote } from "@/components/screens/shared";
import { ACTIVITY_COLUMNS } from "./columns";
import {
  ActivityFilters,
  ACTOR_LABEL,
  type ActorFilter,
  type ResultFilter,
} from "./filters-bar";
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
        downloadFile(`orrery-activity-${slug}-${stamp}.csv`, toCsv(shown), "text/csv");
        return;
      }
      downloadFile(
        `orrery-activity-${slug}-${stamp}.json`,
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
    <div className="mx-auto h-full w-full overflow-y-auto max-w-[980px] px-6 py-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">{heading}</h2>
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
            JSON {shown.length}
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
        environments={data?.environments ?? []}
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

      {paused && (
        <div
          role="status"
          className="mb-3 flex flex-wrap items-center gap-3 rounded-card border border-line bg-bg1 px-4 py-2.5 text-[12.5px] text-ink-mute"
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
                {/* One table per day: a single table spanning the whole feed
                    would put a day heading inside a row, which is a heading
                    pretending to be data. The day is the caption. */}
                <Table<AuditEvent>
                  caption={`${day.label} — ${day.events.length} action${day.events.length === 1 ? "" : "s"}`}
                  rows={day.events}
                  rowKey={(e) => e.id}
                  rowClassName={(e) => (e.actor.type === "navigator" ? "bg-nav-dim/30" : undefined)}
                  columns={ACTIVITY_COLUMNS(slug)}
                />
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
