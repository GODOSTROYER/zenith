import Link from "next/link";
import type { Environment, SecurityFinding } from "@/lib/domain/types";
import { ConnectedDetail } from "@/components/screens/connected-detail";
import { Callout } from "@/components/ui/callout";
import { CostDelta } from "@/components/ui/cost-delta";
import { RiskBadge } from "@/components/ui/risk-badge";
import { TimeAgo } from "@/components/ui/time-ago";
import { STATUS_LABEL, type FixRow } from "./rows";

export function FindingDetail({ finding, row, environment, slug, onClose }: {
  finding: SecurityFinding | undefined;
  row: FixRow | undefined;
  environment: Environment | undefined;
  slug: string;
  onClose: () => void;
}) {
  return (
    <ConnectedDetail
      open={!!finding}
      onClose={onClose}
      title={finding?.title ?? "Finding details"}
      resourceId={finding?.targetId}
      environment={environment?.name}
      context="Security finding · working configuration"
      footer={finding?.targetId ? (
        <Link className="text-[13px] font-medium text-signal hover:underline" href={`/p/${slug}?select=${encodeURIComponent(finding.targetId)}${finding.environmentId ? `&env=${encodeURIComponent(finding.environmentId)}` : ""}`}>
          Inspect resource on System Map →
        </Link>
      ) : undefined}
    >
      {finding && <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <RiskBadge level={finding.severity} />
          <span className="text-[13px] capitalize text-ink-mute">{STATUS_LABEL[finding.status]}</span>
          {environment?.class === "production" && <span className="text-[12px] font-semibold text-prod">Production environment</span>}
        </div>
        <section className="space-y-2">
          <h3 className="app-section-title">What needs attention</h3>
          <p className="text-[14px] leading-relaxed text-ink-mute [overflow-wrap:anywhere]">{finding.detail}</p>
        </section>
        <section className="space-y-3 border-t border-line pt-5">
          <h3 className="app-section-title">Remediation</h3>
          <p className="text-[13px] leading-relaxed text-ink-mute">{finding.fix?.label ?? "This finding needs a manual configuration change. Review the affected resource, then record your decision with a reason."}</p>
          {row?.plan && <dl className="grid grid-cols-2 gap-4 bg-bg1 p-4 text-[12px]">
            <div><dt className="text-ink-mute">Monthly estimate change</dt><dd className="mt-2"><CostDelta usd={row.plan.costDeltaUsd} suffix="/mo est." /></dd></div>
            <div><dt className="text-ink-mute">Change risk</dt><dd className="mt-2 capitalize text-ink">{row.plan.risk}</dd></div>
          </dl>}
          {row?.plan?.blocked && <Callout tone="warn" compact>{row.plan.blocked}</Callout>}
          {row?.error && <Callout tone="err" compact>{row.error} Close this detail and choose Review fix to retry the preview.</Callout>}
          <p className="text-[12px] leading-relaxed text-ink-faint">Review fix opens the action’s approval preview. Applying a configuration fix does not verify the running environment.</p>
        </section>
        <dl className="space-y-4 border-t border-line pt-5 text-[12px]">
          <div><dt className="text-ink-mute">Finding identifier</dt><dd className="mt-1 break-all font-mono text-ink">{finding.id}</dd></div>
          <div><dt className="text-ink-mute">First recorded</dt><dd className="mt-1 text-ink"><TimeAgo iso={finding.createdAt} /></dd></div>
          <div><dt className="text-ink-mute">Assessment scope</dt><dd className="mt-1 text-ink">{environment?.name ?? (finding.environmentId ? finding.environmentId : "Project working configuration")}</dd></div>
        </dl>
      </div>}
    </ConnectedDetail>
  );
}
