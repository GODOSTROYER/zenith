"use client";
/**
 * One audit entry's middle column: what happened, who did it, and — on demand
 * — exactly what was recorded as the input. Agent work is always marked as
 * agent work, in shape as well as colour.
 */
import { useState } from "react";
import Link from "next/link";
import { Bot } from "lucide-react";
import type { AuditEvent } from "@/lib/domain/types";
import { cx } from "@/lib/format";
import { TimeAgo } from "@/components/ui";
import { objectLink } from "./rows";

export interface EventCellProps {
  event: AuditEvent;
  slug: string;
}

export function EventCell({ event: e, slug }: EventCellProps) {
  const [open, setOpen] = useState(false);
  const isAgent = e.actor.type === "navigator";
  const link = objectLink(e);
  const hasInput = e.input !== undefined && e.input !== null && JSON.stringify(e.input) !== "{}";

  return (
    <div className="min-w-0">
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
  );
}
