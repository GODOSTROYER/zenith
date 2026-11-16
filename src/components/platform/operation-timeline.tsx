"use client";
/**
 * The story of an operation as a list of events, one plain sentence each.
 *
 * Events are grouped by correlation id (one deploy, one incident = one flow) and
 * shown in the order the control plane recorded them. The raw event type and ids
 * live in a per-event disclosure next to the sentence, never instead of it.
 *
 * `uncertain` gets a notice of its own wherever it appears, because it is the one
 * status that means "the control plane does not know": the notice says so and says
 * what happens next. Nothing on this surface says "verified" unless an event of
 * that type exists, and a simulated event is labelled as simulated.
 */
import { Fragment } from "react";
import { History } from "lucide-react";
import type { OperationRecord, PlatformEvent } from "@/lib/controlplane/types";
import { cx } from "@/lib/format";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { TimeAgo } from "@/components/ui/time-ago";
import { SimulatedChip } from "@/components/screens/badges";
import { SurfaceGate, type AsyncSurfaceProps } from "./async-gate";
import { Disclosure } from "./badges";
import { describeEvent, groupByCorrelation, safeDataEntries } from "./event-sentences";
import { UNCERTAIN_EXPLANATION } from "./labels";
import { OperationStatusBadge } from "./operation-status";
import { plural, shortDigest, truncate } from "./text";

export interface OperationTimelineProps extends AsyncSurfaceProps {
  events: readonly PlatformEvent[];
  /** the operation the events belong to; adds its status and explains failure/uncertainty */
  operation?: Pick<OperationRecord, "id" | "status" | "error">;
  /** heading; defaults to "Timeline" */
  title?: string;
}

const DOT: Record<string, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  err: "bg-err",
  info: "bg-info",
  idle: "bg-ink-faint",
  running: "bg-signal",
};

function EventRow({ event, focusOperationId }: { event: PlatformEvent; focusOperationId?: string }) {
  const d = describeEvent(event);
  const entries = safeDataEntries(event.data);
  const otherOperation = focusOperationId && event.operationId && event.operationId !== focusOperationId;
  return (
    <li className="flex gap-3 border-b border-line py-3 last:border-b-0">
      {/* decorative: the sentence beside it carries the meaning */}
      <span aria-hidden="true" className={cx("mt-1.5 h-2 w-2 shrink-0 rounded-full", DOT[d.tone])} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="min-w-0 text-[13px] text-ink">
            {d.sentence}{" "}
            {d.simulated && <SimulatedChip title="This event came from a simulation; no real infrastructure was involved." />}
            {otherOperation && <Chip title={`Belongs to operation ${event.operationId}`}>another operation</Chip>}
          </p>
          <TimeAgo iso={event.ts} className="shrink-0 text-[12px] text-ink-faint" />
        </div>
        {d.detail && (
          <p className="mt-0.5 text-[12.5px] text-ink-mute">
            <span className="text-ink-faint">Reported: </span>
            {d.detail}
          </p>
        )}
        <Disclosure summary="Details" className="mt-1">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
            <dt className="text-ink-faint">Event</dt>
            <dd className="font-mono text-ink-mute">{event.type}</dd>
            <dt className="text-ink-faint">Sequence</dt>
            <dd className="tnum font-mono text-ink-mute">{event.seq}</dd>
            {event.actor && (
              <>
                <dt className="text-ink-faint">Actor</dt>
                <dd className="text-ink-mute">
                  {event.actor.name} ({event.actor.kind})
                </dd>
              </>
            )}
            {event.causationId && (
              <>
                <dt className="text-ink-faint">Caused by</dt>
                <dd className="break-all font-mono text-ink-mute">{event.causationId}</dd>
              </>
            )}
            {entries.map((e) => (
              <Fragment key={e.key}>
                <dt className="text-ink-faint">{e.key}</dt>
                <dd className="break-words text-ink-mute">{e.value}</dd>
              </Fragment>
            ))}
          </dl>
        </Disclosure>
      </div>
    </li>
  );
}

export function OperationTimeline({ events, operation, title = "Timeline", loading, error, onRetry }: OperationTimelineProps) {
  const groups = groupByCorrelation(events);
  const uncertain = operation?.status === "uncertain" || events.some((e) => e.type === "operation.uncertain");
  const showGroupHeadings = groups.length > 1;

  return (
    <Card
      title={title}
      subtitle="What happened, in the order Zenith recorded it."
      actions={operation ? <OperationStatusBadge status={operation.status} /> : undefined}
    >
      <SurfaceGate loading={loading} error={error} onRetry={onRetry} what="the timeline">
        <div className="space-y-4">
          {uncertain && (
            <Callout tone="warn" title="Outcome uncertain">
              <p>{UNCERTAIN_EXPLANATION}</p>
              <p className="mt-1 text-ink-mute">
                Nothing will retry this automatically. Once the real state has been observed, a person or a new operation decides what to do.
              </p>
            </Callout>
          )}
          {operation?.status === "failed" && operation.error && (
            <Callout tone="err" title="Why it failed">
              <p className="break-words">{truncate(operation.error, 500)}</p>
              <p className="mt-1 text-ink-mute">Some changes may have been made before it stopped. Check the timeline and the resource state.</p>
            </Callout>
          )}

          {groups.length === 0 ? (
            <EmptyState
              icon={<History className="h-5 w-5" aria-hidden="true" />}
              title="No events recorded yet"
              body="Events appear here as the change is proposed, approved and run."
            />
          ) : (
            groups.map((g) => (
              <section key={g.correlationId} aria-label={showGroupHeadings ? undefined : "Events"}>
                {showGroupHeadings && (
                  <h4 className="mb-1 text-[13px] font-medium text-ink-mute">
                    Flow <span className="font-mono text-[12px]" title={g.correlationId}>{shortDigest(g.correlationId, 8)}</span>{" "}
                    <span className="font-normal text-ink-faint">· {plural(g.events.length, "event")}</span>
                  </h4>
                )}
                <ol>
                  {g.events.map((e) => (
                    <EventRow key={e.id} event={e} focusOperationId={operation?.id} />
                  ))}
                </ol>
              </section>
            ))
          )}
        </div>
      </SurfaceGate>
    </Card>
  );
}
