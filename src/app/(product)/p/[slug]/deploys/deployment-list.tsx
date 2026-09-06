"use client";
/**
 * The left rail: every apply this environment has seen, newest first, with the
 * status filter that the endpoint understands and a search over what is
 * loaded. It says which of the two it is doing in the heading, because
 * "3 of 41" and "3 loaded match" are different claims.
 */
import { Search } from "lucide-react";
import type { Deployment } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";

import { TimeAgo } from "@/components/ui/time-ago";
import { ActorDot } from "@/components/screens/shared";
import { FILTER_LABEL, isLive, PAGE_SIZE, STATUS_DOT, STATUS_LABEL, type StatusFilter } from "./status";

export interface DeploymentListProps {
  envName: string;
  /** undefined while the first page is loading */
  list: Deployment[] | undefined;
  /** `list` narrowed by the search box, or undefined when nothing is typed */
  shown: Deployment[] | undefined;
  total: number;
  status: StatusFilter;
  query: string;
  cursor: string | undefined;
  loadingOlder: boolean;
  selectedId: string | undefined;
  revisionNumbers: Map<string, number>;
  onStatus: (status: StatusFilter) => void;
  onQuery: (query: string) => void;
  onSelect: (id: string) => void;
  onLoadOlder: () => void;
}

export function DeploymentList({
  envName,
  list,
  shown,
  total,
  status,
  query,
  cursor,
  loadingOlder,
  selectedId,
  revisionNumbers,
  onStatus,
  onQuery,
  onSelect,
  onLoadOlder,
}: DeploymentListProps) {
  const needle = query.trim();

  return (
    <aside className="min-w-0 lg:sticky lg:top-0 lg:flex lg:max-h-[calc(100dvh-190px)] lg:flex-col">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[13px] font-medium text-ink-mute">
          {envName} ·{" "}
          {!list
            ? "loading…"
            : needle
              ? `${shown?.length ?? 0} of ${list.length} loaded ${FILTER_LABEL[status]}${(shown?.length ?? 0) === 1 ? "" : "s"} match`
              : `${list.length === total ? list.length : `${list.length} of ${total}`} ${FILTER_LABEL[status]}${total === 1 ? "" : "s"}`}
        </h2>
        <SegmentedControl<StatusFilter>
          size="sm"
          label="Filter deployments by status"
          value={status}
          onChange={onStatus}
          options={[
            { value: "all", label: "All" },
            { value: "live", label: "In flight", title: "Planning, applying, verifying or awaiting approval" },
            { value: "terminal", label: "Finished", title: "Succeeded, failed, rolled back or cancelled" },
          ]}
        />
      </div>
      <div className="mb-2">
        <Input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search loaded deployments"
          aria-label="Search deployments by summary, who ran them, status or revision"
          prefix={<Search className="h-3.5 w-3.5" aria-hidden="true" />}
        />
      </div>
      <div className="min-h-0 max-h-[420px] overflow-y-auto rounded-card border border-line bg-bg2 lg:max-h-none">
        {!list ? (
          <div className="space-y-2 p-4">
            <Skeleton height={44} />
            <Skeleton height={44} />
            <Skeleton height={44} />
          </div>
        ) : list.length === 0 ? (
          <div className="space-y-3 px-4 py-5 text-[13px] text-ink-mute">
            <p>
              No {FILTER_LABEL[status]}s in {envName} right now
              {total === 0 && " — nothing matches this filter."}
            </p>
            <Button size="sm" variant="quiet" onClick={() => onStatus("all")}>
              Show all deployments
            </Button>
          </div>
        ) : shown && shown.length === 0 ? (
          <div className="space-y-3 px-4 py-5 text-[13px] text-ink-mute">
            <p>
              Nothing loaded matches “{needle}”. Older deployments are fetched a page at
              a time — load more, or clear the search.
            </p>
            <Button size="sm" variant="quiet" onClick={() => onQuery("")}>
              Clear search
            </Button>
          </div>
        ) : (
          <ul aria-label={`Deployments to ${envName}, newest first`} className="divide-y divide-line">
            {(shown ?? list).map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => onSelect(d.id)}
                  aria-pressed={selectedId === d.id}
                  aria-label={`Inspect r${revisionNumbers.get(d.revisionId) ?? "?"}: ${d.changeSummary}, ${STATUS_LABEL[d.status]}`}
                  className={`relative block w-full border-l-2 px-4 py-4 text-left transition-colors duration-[var(--dur-fast)] ${selectedId === d.id ? "border-l-signal bg-signal-dim" : "border-l-transparent hover:bg-bg1"}`}
                >
                  <span className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="tnum font-mono text-[13px] font-medium text-ink">r{revisionNumbers.get(d.revisionId) ?? "?"}</span>
                    <span className="flex items-center gap-1.5 text-[12px] text-ink-mute"><StatusDot status={STATUS_DOT[d.status]} pulse={isLive(d.status)} />{STATUS_LABEL[d.status]}</span>
                  </span>
                  <span className="block break-words text-[13px] font-medium leading-relaxed text-ink">{d.changeSummary}</span>
                  <span className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-mute"><ActorDot actor={d.actor} /><span className="break-words">{d.actor.name}</span><span aria-hidden="true">·</span><TimeAgo iso={d.createdAt} /></span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {list && cursor ? (
          <div className="border-t border-line p-2">
            <Button
              size="sm"
              variant="quiet"
              block
              busy={loadingOlder}
              onClick={onLoadOlder}
              title={`Fetch the next ${PAGE_SIZE} older deployments`}
            >
              Load older ({total - list.length} more)
            </Button>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
