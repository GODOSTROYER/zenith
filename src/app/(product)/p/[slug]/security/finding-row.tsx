"use client";
/** One open finding: what it is, what its fix would cost, and the two buttons. */
import type { ReactNode } from "react";
import Link from "next/link";
import type { Role } from "@/lib/actions/core";
import type { SecurityFinding } from "@/lib/domain/types";
import { cx } from "@/lib/format";
import { Button, Callout, CostDelta, RiskBadge, TimeAgo } from "@/components/ui";
import { isEnvironmentPolicy, viewerReason, type FixRow } from "./rows";

export interface FindingRowProps {
  finding: SecurityFinding;
  /** the preview for this finding's automatic fix, once it has come back */
  row: FixRow | undefined;
  /** the finding is about the environment selected in the header */
  here: boolean;
  canEdit: boolean;
  role: Role | null;
  slug: string;
  envChip: ReactNode;
  onFix: () => void;
  onDismiss: () => void;
}

export function FindingRow({
  finding: f,
  row,
  here,
  canEdit,
  role,
  slug,
  envChip,
  onFix,
  onDismiss,
}: FindingRowProps) {
  const blocked = row?.plan?.blocked;
  return (
    <li
      className={cx(
        "flex items-start gap-4 border-b border-line px-5 py-4 last:border-b-0",
        here && "bg-signal/[0.045]"
      )}
    >
      <RiskBadge level={f.severity} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <h3 className="text-[14px] text-ink">{f.title}</h3>
        <p className="mt-1 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-mute">
          {f.detail}
        </p>

        {f.fix && (
          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-faint">
            <span className="text-ink-mute">{f.fix.label}</span>
            {row?.plan ? (
              <>
                <CostDelta usd={row.plan.costDeltaUsd} suffix="/mo est." />
                <span title={`Running this fix is ${row.plan.risk} risk.`}>
                  {row.plan.risk} risk
                </span>
              </>
            ) : row?.error ? (
              <span className="text-warn">could not be previewed</span>
            ) : (
              <span>working out what it would cost…</span>
            )}
          </p>
        )}

        {blocked && (
          <Callout tone="warn" compact className="mt-1.5 max-w-[70ch]">
            {blocked}
          </Callout>
        )}

        <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-faint">
          <TimeAgo iso={f.createdAt} prefix="found" />
          {envChip}
          {f.targetId && slug && (
            <Link
              href={`/p/${slug}?select=${f.targetId}`}
              className="font-mono text-signal hover:underline"
            >
              show on map
            </Link>
          )}
          {isEnvironmentPolicy(f) && slug && (
            <Link
              href={`/p/${slug}/settings#environments`}
              className="text-signal hover:underline"
            >
              Settings → Environments
            </Link>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          size="sm"
          disabled={!f.fix || !canEdit || !!blocked}
          disabledReason={
            !f.fix
              ? "This finding has no automatic fix — change the system, then dismiss it with a reason."
              : !canEdit
                ? viewerReason("Fixing a finding", role)
                : blocked
          }
          onClick={onFix}
          title={f.fix?.label}
        >
          {f.fix ? "Fix" : "No auto-fix"}
        </Button>
        <Button
          size="sm"
          variant="quiet"
          disabled={!canEdit}
          disabledReason={viewerReason("Dismissing a finding", role)}
          onClick={onDismiss}
        >
          Dismiss
        </Button>
      </div>
    </li>
  );
}
