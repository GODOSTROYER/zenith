"use client";
/** Resolved and dismissed findings, collapsed. A dismissal can be undone here. */
import type { ReactNode } from "react";
import Link from "next/link";
import type { Role } from "@/lib/actions/core";
import type { SecurityFinding } from "@/lib/domain/types";
import type { RevisionMeta } from "@/components/screens/project-data";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { TimeAgo } from "@/components/ui/time-ago";
import { STATUS_LABEL, viewerReason } from "./rows";

export interface HistorySectionProps {
  history: SecurityFinding[];
  revisions: RevisionMeta[];
  slug: string;
  canEdit: boolean;
  role: Role | null;
  envChip: (finding: SecurityFinding) => ReactNode;
  onReopen: (finding: SecurityFinding) => void;
}

export function HistorySection({
  history,
  revisions,
  slug,
  canEdit,
  role,
  envChip,
  onReopen,
}: HistorySectionProps) {
  return (
    <details className="group border-y border-line bg-bg2">
      <summary className="cursor-pointer px-4 py-4 text-[14px] font-medium text-ink select-none hover:bg-bg1 sm:px-5">
        Decision history <span className="ml-2 font-mono text-[12px] text-ink-mute">{history.length} resolved or dismissed</span>
      </summary>
      <ul className="border-t border-line">
        {history.map((f) => {
          const landed = revisions.find((r) => r.id === f.fixedInRevisionId);
          return (
            <li
              key={f.id}
              className="flex flex-wrap items-start gap-3 border-b border-line px-4 py-4 text-[13px] last:border-b-0 sm:px-5"
            >
              <Chip tone={f.status === "resolved" ? "ok" : "neutral"} className="mt-0.5">
                {STATUS_LABEL[f.status]}
              </Chip>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-ink [overflow-wrap:anywhere]">{f.title}</p>
                <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-ink-faint">
                  <TimeAgo
                    iso={f.resolvedAt ?? f.createdAt}
                    prefix={f.status === "resolved" ? "resolved" : "dismissed"}
                  />
                  <span>by {f.resolvedBy?.name ?? "someone before this was recorded"}</span>
                  {envChip(f)}
                  {landed && slug && (
                    <Link
                      href={`/p/${slug}/revisions`}
                      className="text-signal hover:underline"
                      title="The deployed revision that made the fix true"
                    >
                      landed in revision {landed.number}
                    </Link>
                  )}
                </p>
                {f.resolvedReason && (
                  <p className="mt-0.5 text-[12px] text-ink-mute">{f.resolvedReason}</p>
                )}
              </div>
              {f.status === "dismissed" && (
                <Button
                  size="sm"
                  variant="quiet"
                  className="shrink-0"
                  disabled={!canEdit}
                  disabledReason={viewerReason("Reopening a finding", role)}
                  title="Undo this dismissal — the finding counts as open again"
                  onClick={() => onReopen(f)}
                >
                  Reopen
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
