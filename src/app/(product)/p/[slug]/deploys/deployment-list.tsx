"use client";
/**
 * The left rail: every apply this environment has seen, newest first, with the
 * status filter that the endpoint understands and a search over what is
 * loaded. It says which of the two it is doing in the heading, because
 * "3 of 41" and "3 loaded match" are different claims.
 */
import { Search } from "lucide-react";
import type { Deployment } from "@/lib/domain/types";
import {
  Button,
  Input,
  SegmentedControl,
  Skeleton,
  StatusDot,
  Table,
  TimeAgo,
} from "@/components/ui";
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
    <aside className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">
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
      <div className="overflow-hidden rounded-card border border-line bg-bg2">
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
          <Table<Deployment>
            caption={`Deployments to ${envName}, newest first — pick one to see its steps, logs and outputs`}
            wrapperClassName="overflow-y-auto lg:max-h-[70vh]"
            rows={shown ?? list}
            rowKey={(d) => d.id}
            selectedKey={selectedId}
            onSelectRow={(d) => onSelect(d.id)}
            columns={[
              {
                key: "status",
                header: "",
                headerLabel: "Status",
                width: 26,
                render: (d) => (
                  <StatusDot
                    status={STATUS_DOT[d.status]}
                    pulse={isLive(d.status)}
                    label={STATUS_LABEL[d.status]}
                  />
                ),
              },
              {
                key: "deployment",
                header: "Deployment",
                render: (d) => (
                  <>
                    <span className="flex items-baseline gap-2">
                      <span className="tnum font-mono text-[12px] text-ink">
                        r{revisionNumbers.get(d.revisionId) ?? "?"}
                      </span>
                      <span className="truncate text-[13px] text-ink">
                        {d.changeSummary}
                      </span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-ink-faint">
                      <ActorDot actor={d.actor} />
                      {d.actor.name} · <TimeAgo iso={d.createdAt} />
                    </span>
                  </>
                ),
              },
            ]}
          />
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
