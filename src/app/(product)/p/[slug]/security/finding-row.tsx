"use client";
/** One open finding: what it is, what its fix would cost, and the two buttons. */
import type { ReactNode } from "react";
import Link from "next/link";
import type { Role } from "@/lib/actions/core";
import type { SecurityFinding } from "@/lib/domain/types";
import { cx } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { CostDelta } from "@/components/ui/cost-delta";
import { RiskBadge } from "@/components/ui/risk-badge";
import { TimeAgo } from "@/components/ui/time-ago";
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
  onInspect: () => void;
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
  onInspect,
}: FindingRowProps) {
  const blocked = row?.plan?.blocked;
  return (
    <li
      className={cx(
        "grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-3 border-b border-line px-4 py-5 last:border-b-0 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:gap-x-4 lg:px-5",
        here && "bg-bg1/60"
      )}
    >
      <RiskBadge level={f.severity} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <h3 className="text-[14px] font-semibold text-ink">
          <button type="button" onClick={onInspect} className="text-left [overflow-wrap:anywhere] underline-offset-4 hover:underline" aria-label={`Inspect finding: ${f.title}`}>{f.title}</button>
        </h3>
        <p className="mt-1.5 max-w-[78ch] text-[13px] leading-relaxed text-ink-mute [overflow-wrap:anywhere]">
          {f.detail}
        </p>

        {f.fix && (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-ink-faint">
            <span className="text-ink-mute">{f.fix.label}</span>
            {row?.plan ? (
              <>
                <CostDelta usd={row.plan.costDeltaUsd} suffix="/mo est." />
                <span title={`Running this fix is ${row.plan.risk} risk.`}>
                  {row.plan.risk} risk
                </span>
              </>
            ) : row?.error ? (
              <span className="text-warn">Preview unavailable — open Review fix to retry</span>
            ) : (
              <span>Estimating this fix…</span>
            )}
          </p>
        )}

        {blocked && (
          <Callout tone="warn" compact className="mt-1.5 max-w-[70ch]">
            {blocked}
          </Callout>
        )}

        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px] text-ink-faint">
          <TimeAgo iso={f.createdAt} prefix="found" />
          {envChip}
          {f.targetId && slug && (
            <Link
              href={`/p/${slug}?select=${encodeURIComponent(f.targetId)}${f.environmentId ? `&env=${encodeURIComponent(f.environmentId)}` : ""}`}
              className="font-mono text-signal hover:underline"
            >
              Show on map
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
      <div className="col-start-2 flex flex-wrap items-center gap-2 lg:col-start-3">
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
          {f.fix ? "Review fix" : "Manual fix"}
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
