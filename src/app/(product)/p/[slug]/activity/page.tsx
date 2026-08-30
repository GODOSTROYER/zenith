"use client";
/**
 * Activity — the durable trail. Every action, whoever ran it, whatever it did.
 * Agent work is always marked as agent work.
 */
import { useMemo, useState } from "react";
import { ScrollText } from "lucide-react";
import { useJson } from "@/lib/client/api";
import type { AuditEvent } from "@/lib/domain/types";
import { cx } from "@/lib/format";
import {
  Card,
  Chip,
  EmptyState,
  SegmentedControl,
  Skeleton,
  TimeAgo,
  type ChipTone,
} from "@/components/ui";
import { useSelectedEnv } from "@/components/screens/project-data";
import { ActorDot, ErrorNote } from "@/components/screens/shared";

type Filter = "all" | "you" | "navigator" | "deploys";

const RESULT_TONE: Record<AuditEvent["result"], ChipTone> = {
  ok: "ok",
  error: "err",
  denied: "warn",
};

export default function ActivityPage() {
  const { projectId } = useSelectedEnv();
  const [filter, setFilter] = useState<Filter>("all");

  const { data, error, loading } = useJson<{ events: AuditEvent[] }>(
    projectId ? `/api/projects/${projectId}/audit?limit=100` : null,
    10_000
  );

  const events = useMemo(() => data?.events ?? [], [data]);
  const shown = useMemo(
    () =>
      events.filter((e) =>
        filter === "you"
          ? e.actor.type === "user"
          : filter === "navigator"
            ? e.actor.type === "navigator"
            : filter === "deploys"
              ? e.actionId.startsWith("deploy.")
              : true
      ),
    [events, filter]
  );

  return (
    <div className="mx-auto h-full w-full overflow-y-auto max-w-[980px] px-6 py-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">
          Last {events.length} action{events.length === 1 ? "" : "s"}
        </h2>
        <SegmentedControl<Filter>
          label="Filter activity"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "you", label: "You", title: "Actions you ran yourself" },
            { value: "navigator", label: "Navigator", title: "Actions the agent ran" },
            { value: "deploys", label: "Deploys", title: "deploy.* actions only" },
          ]}
        />
      </div>

      {error ? <ErrorNote error={error} /> : null}

      {loading && events.length === 0 ? (
        <div className="space-y-2">
          <Skeleton height={52} />
          <Skeleton height={52} />
          <Skeleton height={52} />
        </div>
      ) : shown.length === 0 ? (
        <EmptyState
          icon={<ScrollText className="h-5 w-5" />}
          title={events.length === 0 ? "Nothing has happened yet" : "Nothing matches this filter"}
          body={
            events.length === 0
              ? "Every action anyone runs on this project — you, the Navigator, or the system — is recorded here permanently."
              : "Switch back to All to see the whole trail."
          }
        />
      ) : (
        <Card padded={false}>
          <ul>
            {shown.map((e) => (
              <li
                key={e.id}
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
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
