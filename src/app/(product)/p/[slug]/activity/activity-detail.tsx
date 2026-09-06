import Link from "next/link";
import { ArrowUpRight, Bot } from "lucide-react";
import type { AuditEvent, Environment } from "@/lib/domain/types";
import { fmtDate } from "@/lib/format";
import { Chip } from "@/components/ui/chip";
import { ConnectedDetail } from "@/components/screens/connected-detail";
import { objectLink, recordedResourceId } from "./rows";

export function ActivityDetail({ event, environments, slug, onClose }: {
  event?: AuditEvent;
  environments: Environment[];
  slug: string;
  onClose: () => void;
}) {
  const environment = environments.find((item) => item.id === event?.environmentId);
  const link = event ? objectLink(event) : undefined;
  const environmentLabel = environment
    ? `${environment.name}${environment.class === "production" ? " · Production" : ""}`
    : event?.environmentId ?? "Project scope";
  return (
    <ConnectedDetail
      open={Boolean(event)}
      onClose={onClose}
      title="Recorded action"
      resourceId={event ? recordedResourceId(event) : undefined}
      environment={environmentLabel}
      context="Activity · historical record"
      footer={link && <Link href={`/p/${slug}${link.path}`} className="inline-flex min-h-9 items-center gap-2 text-[13px] font-medium text-signal hover:underline">{link.label}<ArrowUpRight aria-hidden="true" className="h-4 w-4" /></Link>}
    >
      {event && <div className="space-y-6">
        <div>
          <Chip tone={event.result === "ok" ? "ok" : event.result === "error" ? "err" : "warn"}>
            {event.result === "ok" ? "Succeeded" : event.result === "error" ? "Failed" : "Refused"}
          </Chip>
          <p className="mt-3 break-words text-[16px] font-medium leading-relaxed text-ink [overflow-wrap:anywhere]">{event.summary}</p>
          {event.error && <p className="mt-3 break-words border-y border-err/25 bg-err-dim px-3 py-3 text-[13px] text-err [overflow-wrap:anywhere]">{event.error}</p>}
        </div>
        <dl className="divide-y divide-line border-y border-line text-[13px]">
          <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-4 py-3"><dt className="text-ink-mute">Actor</dt><dd className="flex flex-wrap items-center gap-1.5 break-all text-ink">{event.actor.type === "navigator" && <Bot aria-hidden="true" className="h-3.5 w-3.5 text-nav-accent" />}{event.actor.name}<span className="text-ink-mute">({event.actor.type === "navigator" ? "agent" : event.actor.type})</span></dd></div>
          <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-4 py-3"><dt className="text-ink-mute">Action</dt><dd className="break-all font-mono text-[12px] text-ink">{event.actionId}</dd></div>
          <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-4 py-3"><dt className="text-ink-mute">Recorded</dt><dd><time dateTime={event.ts} title={event.ts} className="tnum text-ink">{fmtDate(event.ts)}</time></dd></div>
          <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-4 py-3"><dt className="text-ink-mute">Environment</dt><dd className={`break-all ${environment?.class === "production" ? "font-medium text-prod" : "text-ink"}`}>{environmentLabel}</dd></div>
          <div className="grid grid-cols-[90px_minmax(0,1fr)] gap-4 py-3"><dt className="text-ink-mute">Event ID</dt><dd className="break-all font-mono text-[12px] text-ink">{event.id}</dd></div>
        </dl>
        <section>
          <h3 className="text-[14px] font-medium text-ink">Recorded input</h3>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-mute">The input saved when this action ran. Secret-shaped keys are redacted. This historical record is read-only.</p>
          <pre tabIndex={0} aria-label="Recorded action input" className="mt-3 max-h-[400px] overflow-auto border border-line bg-bg1 p-4 font-mono text-[12px] leading-relaxed text-ink">{JSON.stringify(event.input ?? null, null, 2)}</pre>
        </section>
      </div>}
    </ConnectedDetail>
  );
}
