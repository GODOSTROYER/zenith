"use client";
/** Resolved and dismissed findings, collapsed. A dismissal can be undone here. */
import type { ReactNode } from "react";
import Link from "next/link";
import type { Role } from "@/lib/actions/core";
import type { SecurityFinding } from "@/lib/domain/types";
import type { RevisionMeta } from "@/components/screens/project-data";
import { Button, Chip, TimeAgo } from "@/components/ui";
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
    <details className="rounded-card border border-line bg-bg2">
      <summary className="cursor-pointer px-5 py-3 text-[13px] text-ink-mute select-none hover:text-ink">
        History — {history.length} resolved or dismissed
      </summary>
      <ul className="border-t border-line">
        {history.map((f) => {
          const landed = revisions.find((r) => r.id === f.fixedInRevisionId);
          return (
            <li
              key={f.id}
              className="flex items-start gap-3 border-b border-line px-5 py-3 text-[12.5px] last:border-b-0"
            >
              <Chip tone={f.status === "resolved" ? "ok" : "neutral"} className="mt-0.5">
                {STATUS_LABEL[f.status]}
              </Chip>
              <div className="min-w-0 flex-1">
                <p className="truncate text-ink">{f.title}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-faint">
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
