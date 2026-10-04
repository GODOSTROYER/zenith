"use client";
/**
 * One proposal awaiting a human decision, with everything an approver needs on
 * one card: what it does, where, how risky, what it costs, what policy said and
 * who has to approve, bound to the exact proposal digest.
 *
 * Honesty and safety rules this card enforces:
 *  - the cost delta is labelled as an estimate, and "not estimated" is said
 *    outright rather than shown as $0;
 *  - a plan that destroys data has a callout naming the resources;
 *  - Approve and Reject are never dead: when the viewer cannot decide, both are
 *    disabled and the reason is printed beside them and linked with
 *    `aria-describedby` (see `approvalEligibility`);
 *  - the decision is sent with the digest the viewer reviewed, so the control
 *    plane can refuse it if the proposal moved;
 *  - a plan whose digest differs from the proposal's blocks the decision.
 * The card never calls the network: the host passes `onApprove` / `onReject`.
 */
import { useId, useRef, useState } from "react";
import { Info } from "lucide-react";
import type { ApprovalRecord, OperationRecord, PolicyDecisionRecord, Principal } from "@/lib/controlplane/types";
import type { PlanView } from "@/lib/tofu/plan";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { CostDelta } from "@/components/ui/cost-delta";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { SurfaceGate, type AsyncSurfaceProps } from "./async-gate";
import { DigestValue, Fact, RiskLabel, ScopeBreadcrumb, type ScopeNames } from "./badges";
import { useNow } from "./clock";
import { approvalEligibility, approvalProgress, type ApprovalEligibility, type ApprovalViewer } from "./approval-eligibility";
import { OperationStatusBadge } from "./operation-status";
import { PlanSummaryChips } from "./plan-changes-table";
import { PolicyReasonList } from "./policy-decision-panel";
import { OUTCOME_PRESENTATION, describeApprovalRequirement } from "./policy-language";
import { describeSpan, humanizeToken, parseTime, plural } from "./text";

export interface ApprovalDecisionInput {
  operationId: string;
  /** the digest the viewer reviewed; the control plane refuses the decision if it moved */
  proposalDigest: string;
  planDigest?: string;
  reason?: string;
}

export interface ApprovalCardProps extends AsyncSurfaceProps {
  /** Optional host gate when the reviewed artifact is unavailable; rejection remains possible. */
  approveDisabledReason?: string;
  /** Cost of the gated plan; null means the estimate is unknown. */
  planCostDeltaUsd?: number | null;
  operation: OperationRecord;
  /** the policy decision for this operation; without it nobody can be offered a decision */
  decision?: PolicyDecisionRecord;
  /** every approval recorded for this operation */
  approvals: readonly ApprovalRecord[];
  viewer: ApprovalViewer;
  /** the capability's human title (from the catalog); falls back to a readable form of its name */
  capabilityTitle?: string;
  /** display names for the scope breadcrumb; ids are shown when a name is missing */
  scopeNames?: ScopeNames;
  /** the reviewed plan, for infrastructure changes */
  plan?: PlanView;
  onApprove: (input: ApprovalDecisionInput) => void | Promise<void>;
  onReject: (input: ApprovalDecisionInput) => void | Promise<void>;
  /** a failure the host wants shown under the buttons (for example a refusal from the server) */
  actionError?: string;
  /** freeze the clock (tests, stories); otherwise the countdown ticks every 30 seconds */
  now?: Date | string;
}

const PRINCIPAL_KIND: Record<Principal["kind"], string> = {
  user: "a person",
  integration: "an integration",
  navigator: "Navigator",
  system: "Zenith",
  runner: "a runner",
  machine: "a machine",
};

function requestedBy(p: Principal): string {
  const who = p.name?.trim() || p.id;
  if (p.kind === "user") return who;
  return `${who} (${PRINCIPAL_KIND[p.kind]}${p.onBehalfOf ? `, for ${p.onBehalfOf}` : ""})`;
}

export function ApprovalCard({
  operation,
  decision,
  approvals,
  viewer,
  capabilityTitle,
  scopeNames,
  plan,
  onApprove,
  onReject,
  actionError,
  now,
  loading,
  error,
  onRetry,
  approveDisabledReason,
  planCostDeltaUsd,
}: ApprovalCardProps) {
  const nowMs = useNow(now);
  const ids = useId();
  const reasonId = `${ids}-blocked`;
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const [localError, setLocalError] = useState<string>();
  const inflight = useRef(false);

  const { proposal } = operation;
  const title = capabilityTitle ?? humanizeToken(operation.capability);

  const boundPlanDigest = operation.planDigest ?? proposal.planDigest;
  const planMismatch = Boolean(plan && boundPlanDigest && plan.planDigest !== boundPlanDigest);

  const roundOf = (record: object) => (record as { approvalRound?: number }).approvalRound ?? 0;
  const currentApprovals = approvals.filter((a) => roundOf(a) === roundOf(operation));
  const base = approvalEligibility(viewer, operation, decision, currentApprovals, nowMs);
  const eligibility: ApprovalEligibility =
    base.eligible && planMismatch
      ? {
          eligible: false,
          reason: "digest_changed",
          message: "The plan shown here is not the plan this proposal is bound to. Reload before deciding.",
        }
      : base;
  // While the proposal is (re)loading or failed to load, nobody is offered a decision either.
  const blocked = eligibility.eligible
    ? loading || error
      ? "Waiting for the latest details of this proposal before a decision can be recorded."
      : undefined
    : eligibility.message;

  const progress = approvalProgress(operation, decision, currentApprovals, nowMs);
  const costDelta = planCostDeltaUsd === undefined ? proposal.costDeltaUsd : planCostDeltaUsd ?? undefined;
  const missingPlan = boundPlanDigest && !plan ? "The bound plan is unavailable for review. You can still reject this proposal." : undefined;
  const approveBlocked = approveDisabledReason ?? missingPlan;
  const expiresMs = parseTime(operation.expiresAt);
  const remaining = expiresMs === undefined ? undefined : expiresMs - nowMs;
  const dataLoss = plan ? plan.resources.filter((r) => r.destroysData) : [];

  const submit = async (kind: "approve" | "reject") => {
    if (blocked || inflight.current || (kind === "approve" && approveBlocked)) return;
    inflight.current = true;
    setPending(kind);
    setLocalError(undefined);
    const input: ApprovalDecisionInput = {
      operationId: operation.id,
      proposalDigest: operation.proposalDigest,
      ...(kind === "approve" && plan ? { planDigest: plan.planDigest } : {}),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    };
    try {
      await (kind === "approve" ? onApprove(input) : onReject(input));
    } catch (e) {
      setLocalError(
        e instanceof Error && e.message
          ? e.message
          : "Zenith could not record your decision. Nothing was changed; try again."
      );
    } finally {
      inflight.current = false;
      setPending(null);
    }
  };

  const shownError = actionError ?? localError;

  return (
    <Card
      title={title}
      subtitle={proposal.summary}
      actions={
        <>
          <RiskLabel level={proposal.risk} />
          <OperationStatusBadge status={operation.status} />
        </>
      }
      footer={
        <div className="space-y-3">
          {blocked ? (
            <p id={reasonId} className="flex items-start gap-2 text-[12.5px] text-ink-mute">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{blocked}</span>
            </p>
          ) : (
            <Field label="Reason (optional)" help="Recorded with your decision and visible to the people reviewing this change.">
              <Textarea
                rows={2}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={pending !== null}
              />
            </Field>
          )}
          {shownError && (
            <Callout tone="err" compact>
              {shownError}
            </Callout>
          )}
          {approveBlocked && <p id={`${ids}-approve-blocked`} className="text-[12.5px] text-ink-mute">{approveBlocked}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={Boolean(blocked || approveBlocked) || pending !== null}
              busy={pending === "approve"}
              disabledReason={blocked ?? approveBlocked}
              aria-describedby={blocked ? reasonId : approveBlocked ? `${ids}-approve-blocked` : undefined}
              aria-label={`Approve ${title}`}
              onClick={() => void submit("approve")}
            >
              Approve
            </Button>
            <Button
              variant="quiet"
              disabled={Boolean(blocked) || pending !== null}
              busy={pending === "reject"}
              disabledReason={blocked}
              aria-describedby={blocked ? reasonId : undefined}
              aria-label={`Reject ${title}`}
              onClick={() => void submit("reject")}
            >
              Reject
            </Button>
            <span className="text-[12px] text-ink-faint">Your decision applies to exactly this proposal, identified by the digest above.</span>
          </div>
        </div>
      }
    >
      <SurfaceGate loading={loading} error={error} onRetry={onRetry} what="this proposal" rows={4}>
        <div className="space-y-5">
          <ScopeBreadcrumb scope={proposal.scope} names={scopeNames} />

          {proposal.details.length > 0 && (
            <section aria-label="What it does">
              <h4 className="mb-1.5 text-[13px] font-medium text-ink-mute">What it does</h4>
              <ul className="list-disc space-y-1 pl-5 text-[13px] text-ink">
                {proposal.details.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </section>
          )}

          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <Fact label="Requested by">{requestedBy(operation.principal)}</Fact>
            <Fact label="Cost change (estimate)">
              {costDelta === undefined ? (
                <span className="text-ink-mute">Not estimated for this proposal</span>
              ) : (
                <span className="inline-flex flex-wrap items-baseline gap-x-2">
                  <CostDelta usd={costDelta} />
                  <span className="text-[12px] text-ink-faint">estimate from catalog prices, not an invoice</span>
                </span>
              )}
            </Fact>
            <Fact label="Expires">
              {remaining === undefined ? (
                <span className="text-ink-mute">Expiry time unreadable</span>
              ) : remaining > 0 ? (
                <time dateTime={operation.expiresAt} suppressHydrationWarning>
                  in {describeSpan(remaining)}
                </time>
              ) : (
                <span className="text-err">
                  <time dateTime={operation.expiresAt} suppressHydrationWarning>
                    Expired {describeSpan(remaining)} ago
                  </time>
                </span>
              )}
            </Fact>
            {proposal.origin && (proposal.origin.tool || proposal.origin.model) && (
              <Fact label="Proposed with">
                {[proposal.origin.tool, proposal.origin.model].filter(Boolean).join(" · ")}
              </Fact>
            )}
          </dl>

          {plan && (
            <section aria-label="Plan summary" className="space-y-2">
              <h4 className="text-[13px] font-medium text-ink-mute">Plan summary</h4>
              <DigestValue digest={plan.planDigest} what="reviewed plan digest" />
              {plan.executableSourceDigest && <div className="space-y-2">
                <p className="text-[13px] text-ink-mute">This plan binds the retained source commits, build recipes and archive bytes.</p>
                <DigestValue digest={plan.executableSourceDigest} what="approved source set digest" />
                {plan.approvedSourcesTruncated && <p className="text-[12px] text-ink-mute">Details for {plan.approvedSourcesOmitted} additional build services are omitted; the source set digest binds every service.</p>}
                {plan.approvedSources?.map(source => <dl key={source.service} className="space-y-1 text-[12px]">
                  <Fact label="Build service">{source.service}</Fact>
                  <Fact label="Retained commit">{source.commit}</Fact>
                  <Fact label="Dockerfile"><DigestValue digest={source.dockerfileDigest} what="Dockerfile digest" /></Fact>
                  <Fact label="Build recipe"><DigestValue digest={source.recipeDigest} what="build recipe digest" /></Fact>
                  <Fact label={`Source archive (${source.archiveFormat})`}><DigestValue digest={source.archiveDigest} what="source archive digest" /></Fact>
                </dl>)}
              </div>}
              {plan.empty ? (
                <p className="text-[13px] text-ink-mute">This plan contains no changes.</p>
              ) : (
                <PlanSummaryChips plan={plan} />
              )}
              {planMismatch && (
                <Callout tone="err" compact>
                  The plan shown here does not match the plan this proposal is bound to. Reload before deciding.
                </Callout>
              )}
              {dataLoss.length > 0 && (
                <Callout tone="err" title="This plan destroys data" compact>
                  Deleting or replacing {plural(dataLoss.length, "stateful resource")} destroys its data, and rollback cannot restore it:{" "}
                  <span className="font-mono">{dataLoss.map((r) => r.address).join(", ")}</span>
                </Callout>
              )}
            </section>
          )}

          <section aria-label="Policy" className="space-y-2">
            <h4 className="text-[13px] font-medium text-ink-mute">What policy said</h4>
            {decision ? (
              <>
                {decision.outcome !== "require_approval" && (
                  <p className="text-[13px] text-ink">{OUTCOME_PRESENTATION[decision.outcome].sentence}</p>
                )}
                <PolicyReasonList reasons={decision.reasons} />
                {decision.approval ? (
                  <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink">
                    <span>{describeApprovalRequirement(decision.approval)}</span>
                    <Chip tone={progress.granted >= decision.approval.count ? "ok" : "neutral"}>
                      <span className="tnum">
                        {progress.granted} of {decision.approval.count}
                      </span>{" "}
                      approved
                    </Chip>
                  </div>
                ) : decision.outcome === "require_approval" ? (
                  <Callout tone="warn" compact>
                    Policy asked for approval but did not say how many people or which role, so nobody can be offered a decision.
                  </Callout>
                ) : null}
              </>
            ) : (
              <Callout tone="warn" compact>
                The policy decision for this proposal is not available yet.
              </Callout>
            )}
          </section>

          <section aria-label="Proposal digest" className="space-y-1">
            <h4 className="text-[13px] font-medium text-ink-mute">Proposal digest</h4>
            <DigestValue digest={operation.proposalDigest} what="proposal digest" />
            <p className="text-[12px] text-ink-faint">
              An approval is bound to this digest. If the proposal changes, it has a new digest and needs a new decision.
            </p>
          </section>
        </div>
      </SurfaceGate>
    </Card>
  );
}
