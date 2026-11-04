"use client";
/**
 * What policy decided about a proposal and why, in plain language.
 *
 * The outcome, the rule messages, the approval requirement and the limits are all
 * sentences; the machine codes behind them sit in a disclosure. The policy version
 * is shown as a short hash with the full value on hover: it is the digest of the
 * compiled bundle, so two decisions with the same hash were made by the same rules.
 */
import { Scale } from "lucide-react";
import type { PolicyDecisionRecord, PolicyReason } from "@/lib/controlplane/types";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { TimeAgo } from "@/components/ui/time-ago";
import { SurfaceGate, type AsyncSurfaceProps } from "./async-gate";
import { Disclosure } from "./badges";
import { OUTCOME_PRESENTATION, describeApprovalRequirement, describeConstraints } from "./policy-language";
import { shortDigest } from "./text";

/** The reasons as sentences, with the rule codes tucked into a disclosure. */
export function PolicyReasonList({ reasons }: { reasons: readonly PolicyReason[] }) {
  if (reasons.length === 0) {
    return <p className="text-[13px] text-ink-mute">Policy did not record a reason for this decision.</p>;
  }
  return (
    <div className="space-y-2">
      <ul className="list-disc space-y-1 pl-5 text-[13px] text-ink">
        {reasons.map((r, i) => (
          <li key={`${r.code}-${i}`}>{r.message}</li>
        ))}
      </ul>
      <Disclosure summary="Rule codes">
        <ul className="space-y-1 font-mono text-[12px] text-ink-mute">
          {reasons.map((r, i) => (
            <li key={`${r.code}-${i}`} className="break-all">
              {r.code}
              {r.rule ? <span className="text-ink-faint"> · {r.rule}</span> : null}
            </li>
          ))}
        </ul>
      </Disclosure>
    </div>
  );
}

export interface PolicyDecisionPanelProps extends AsyncSurfaceProps {
  decision?: PolicyDecisionRecord;
  /** heading; defaults to "Policy decision" */
  title?: string;
}

export function PolicyDecisionPanel({ decision, title = "Policy decision", loading, error, onRetry }: PolicyDecisionPanelProps) {
  const outcome = decision ? OUTCOME_PRESENTATION[decision.outcome] : undefined;
  const constraints = decision ? describeConstraints(decision.constraints) : [];

  return (
    <Card
      title={title}
      subtitle="Decided by the policy rules in force, not by a person or a model."
      actions={outcome ? <Chip tone={outcome.tone}>{outcome.label}</Chip> : undefined}
    >
      <SurfaceGate loading={loading} error={error} onRetry={onRetry} what="the policy decision">
        {!decision || !outcome ? (
          <EmptyState
            icon={<Scale className="h-5 w-5" aria-hidden="true" />}
            title="No policy decision yet"
            body="Policy evaluates a proposal as soon as it is made. The decision appears here once it exists."
          />
        ) : (
          <div className="space-y-5">
            <p className="text-[14px] text-ink">{outcome.sentence}</p>

            <section aria-label="Reasons" className="space-y-2">
              <h4 className="text-[13px] font-medium text-ink-mute">Why</h4>
              <PolicyReasonList reasons={decision.reasons} />
            </section>

            {decision.outcome === "require_approval" && (
              <section aria-label="Approval needed" className="space-y-2">
                <h4 className="text-[13px] font-medium text-ink-mute">Who must approve</h4>
                {decision.approval ? (
                  <p className="text-[13px] text-ink">{describeApprovalRequirement(decision.approval)}</p>
                ) : (
                  <Callout tone="warn" compact>
                    Policy asked for approval but did not say how many people or which role. Zenith will not guess; nobody can approve until it does.
                  </Callout>
                )}
              </section>
            )}

            {constraints.length > 0 && (
              <section aria-label="Limits" className="space-y-2">
                <h4 className="text-[13px] font-medium text-ink-mute">Limits that apply</h4>
                <ul className="list-disc space-y-1 pl-5 text-[13px] text-ink">
                  {constraints.map((c) => (
                    <li key={c.key}>{c.sentence}</li>
                  ))}
                </ul>
                <Disclosure summary="Exact values">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[12px] text-ink-mute">
                    {constraints.map((c) => (
                      <div key={c.key} className="contents">
                        <dt>{c.key}</dt>
                        <dd className="break-all">{c.value}</dd>
                      </div>
                    ))}
                  </dl>
                </Disclosure>
              </section>
            )}

            <p className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-[12px] text-ink-faint">
              <span>
                Policy version{" "}
                <code className="tnum font-mono text-ink-mute" title={decision.policyVersion}>
                  {shortDigest(decision.policyVersion)}
                </code>
              </span>
              <span>
                Evaluated <TimeAgo iso={decision.evaluatedAt} />
              </span>
            </p>
          </div>
        )}
      </SurfaceGate>
    </Card>
  );
}
