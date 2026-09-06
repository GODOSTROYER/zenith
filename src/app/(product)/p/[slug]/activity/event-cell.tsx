"use client";
import Link from "next/link";
import { ArrowUpRight, Bot } from "lucide-react";
import type { AuditEvent, Environment } from "@/lib/domain/types";
import { cx } from "@/lib/format";
import { TimeAgo } from "@/components/ui/time-ago";
import { objectLink } from "./rows";

export interface EventCellProps {
  event: AuditEvent;
  slug: string;
  environments: Environment[];
  onInspect: (event: AuditEvent) => void;
}

export function EventCell({ event: e, slug, environments, onInspect }: EventCellProps) {
  const isAgent = e.actor.type === "navigator";
  const link = objectLink(e);
  const environment = environments.find((item) => item.id === e.environmentId);

  return (
    <div className="min-w-0 max-w-[80ch]">
      <button
        type="button"
        onClick={() => onInspect(e)}
        aria-label={`Inspect action: ${e.summary}`}
        className="group inline-flex max-w-full items-start gap-2 rounded-ctl text-left text-[13px] font-medium leading-relaxed text-ink transition-colors duration-[var(--dur-fast)] hover:text-signal"
      >
        <span className="break-words [overflow-wrap:anywhere]">{e.summary}</span>
        <ArrowUpRight aria-hidden="true" className="mt-1 h-3.5 w-3.5 shrink-0 text-ink-faint group-hover:text-signal" />
      </button>
      {e.error && <p className="mt-1 break-words text-[12px] text-err [overflow-wrap:anywhere]">{e.error}</p>}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-mute">
        <span className="break-all font-mono text-[11px]">{e.actionId}</span>
        <span className={cx("inline-flex items-center gap-1", isAgent && "text-nav-accent")}>
          {isAgent && <Bot className="h-3 w-3" aria-hidden="true" />}
          {isAgent ? `${e.actor.name} (agent)` : e.actor.name}
        </span>
        <TimeAgo iso={e.ts} />
        <span className={cx("break-all", environment?.class === "production" && "font-medium text-prod")}>
          {environment ? `${environment.name}${environment.class === "production" ? " · Production" : ""}` : e.environmentId || "Project scope"}
        </span>
        {link && <Link href={`/p/${slug}${link.path}`} className="text-signal underline-offset-4 hover:underline">{link.label}</Link>}
        {e.result === "denied" && <Link href={`/p/${slug}/settings#members`} className="text-signal underline-offset-4 hover:underline">Review member roles</Link>}
      </div>
    </div>
  );
}
