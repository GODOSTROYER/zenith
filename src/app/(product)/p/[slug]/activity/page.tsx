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
import Link from "next/link";
import { Bot, Download, Search, ScrollText } from "lucide-react";
import { api, useJson } from "@/lib/client/api";
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
import { dedupe, groupByDay, inDateRange, objectLink, toCsv } from "./rows";

type ActorFilter = "all" | "user" | "navigator" | "system";
type ResultFilter = "all" | "ok" | "error" | "denied";

const PAGE_SIZE = 50;
const POLL_MS = 10_000;

const RESULT_TONE: Record<AuditEvent["result"], ChipTone> = {
  ok: "ok",
  error: "err",
  denied: "warn",
};

/** One vocabulary: the row chip reads like the filter that selects it. */
const RESULT_LABEL: Record<AuditEvent["result"], string> = {
  ok: "Succeeded",
  error: "Failed",
  denied: "Refused",
};

/** Action prefixes worth filtering by; the endpoint takes any `prefix.` form. */
const ACTION_OPTIONS = [
  { value: "all", label: "All actions" },
  { value: "deploy.", label: "Deploys" },
  { value: "system.", label: "System edits" },
  { value: "project.", label: "Project" },
  { value: "env.", label: "Environments" },
  { value: "connection.", label: "Connections" },
  { value: "security.", label: "Security" },
  { value: "ops.", label: "Operations" },
  { value: "workspace.", label: "Workspace" },
  { value: "navigator.", label: "Navigator runs" },
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
        download(`orrery-activity-${slug}-${stamp}.csv`, toCsv(shown), "text/csv");
        return;
      }
      download(
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
        {/* SEAM (T3): live once the audit route accepts `env=<environmentId>`. */}
        <span title="Filtering by environment needs the audit endpoint to accept it — it does not yet, and filtering only the loaded page would quietly lie about the rest of the trail.">
          <Select
            className="w-[150px]"
            aria-label="Filter by environment"
            value="all"
            disabled
            onChange={() => undefined}
            options={[
              { value: "all", label: "Any environment" },
              ...(data?.environments ?? []).map((e) => ({ value: e.id, label: e.name })),
            ]}
          />
        </span>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-mute">
        <span>Between</span>
        <Input
          type="date"
          className="w-[150px]"
          aria-label="Only actions on or after this date"
          value={from}
          max={to || undefined}
          onChange={(e) => setFrom(e.target.value)}
        />
        <span>and</span>
        <Input
          type="date"
          className="w-[150px]"
          aria-label="Only actions on or before this date"
          value={to}
          min={from || undefined}
          onChange={(e) => setTo(e.target.value)}
        />
        {(from || to) && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setFrom("");
                setTo("");
              }}
            >
              Clear dates
            </Button>
            <span className="text-ink-faint">
              Dates narrow the {events.length} actions loaded here, not the whole trail.
            </span>
          </>
        )}
      </div>

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
                <ul>
                  {day.events.map((e) => (
                    <EventRow key={e.id} event={e} slug={slug} />
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

function EventRow({ event: e, slug }: { event: AuditEvent; slug: string }) {
  const [open, setOpen] = useState(false);
  const isAgent = e.actor.type === "navigator";
  const link = objectLink(e);
  const hasInput = e.input !== undefined && e.input !== null && JSON.stringify(e.input) !== "{}";

  return (
    <li
      className={cx(
        "flex items-start gap-3 border-b border-line px-5 py-3 last:border-b-0",
        isAgent && "bg-nav-dim/30"
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
          <span
            className={cx("inline-flex items-center gap-1", isAgent && "text-nav-accent")}
          >
            {/* Shape, not just colour: the Navigator's rows carry its mark. */}
            {isAgent && <Bot className="h-3 w-3" aria-hidden="true" />}
            {isAgent ? `${e.actor.name} (agent)` : e.actor.name}
          </span>
          <span>·</span>
          <TimeAgo iso={e.ts} />
          {link && (
            <>
              <span>·</span>
              <Link href={`/p/${slug}${link.path}`} className="text-signal hover:underline">
                {link.label}
              </Link>
            </>
          )}
          {e.result === "denied" && (
            <>
              <span>·</span>
              <Link
                href={`/p/${slug}/settings#members`}
                className="text-signal hover:underline"
                title="Roles are granted in the project's member list"
              >
                who can do this
              </Link>
            </>
          )}
          {hasInput && (
            <>
              <span>·</span>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className="text-signal hover:underline"
              >
                {open ? "hide input" : "recorded input"}
              </button>
            </>
          )}
        </p>
        {open && hasInput && (
          <pre className="animate-enter mt-2 max-h-[280px] overflow-auto rounded-card border border-line bg-bg1 p-3 font-mono text-[11.5px] leading-relaxed text-ink-mute">
            {JSON.stringify(e.input, null, 2)}
          </pre>
        )}
        {open && (
          <p className="mt-1 text-[11px] text-ink-faint">
            Exactly what was recorded when the action ran, with secret-shaped keys redacted.
          </p>
        )}
      </div>
      <Chip tone={RESULT_TONE[e.result]} className="mt-0.5 shrink-0">
        {RESULT_LABEL[e.result]}
      </Chip>
    </li>
  );
}

/* --------------------------------- export --------------------------------- */

/** Client-side file save; the audit trail never round-trips through a server. */
function download(filename: string, body: string, type: string): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
