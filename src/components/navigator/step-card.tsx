"use client";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ChevronRight, HelpCircle, SearchCode } from "lucide-react";
import Link from "next/link";
import { Chip, CostDelta, RiskBadge, StatusDot } from "@/components/ui";
import { useProjectData } from "@/components/shell/project-context";
import { ApiError, planAction } from "@/lib/client/api";
import type { ActionPlan } from "@/lib/actions/core";
import { cx } from "@/lib/format";
import type { AutonomyLevel, NavigatorStep } from "@/lib/domain/types";
import { autonomyBlock, BLOCKED, CLARIFY, INVESTIGATE, isExecutable } from "@/lib/navigator/shared";

export interface StepCardProps {
  step: NavigatorStep;
  projectId: string;
  slug: string;
  autonomy: AutonomyLevel;
  approved: boolean;
  onToggleApprove: (stepId: string, approved: boolean) => void;
  /** true while the plan is still editable (nothing has run yet) */
  editable: boolean;
  /** reports the previewed cost delta upward so the footer can total it */
  onPreview: (stepId: string, costDeltaUsd: number) => void;
  /** ids of production-class environments — they carry the prod ring everywhere */
  prodEnvIds: Set<string>;
  /** an earlier step in this plan has not run yet, so previews may be incomplete */
  earlierPending: boolean;
}

const RAIL: Record<NavigatorStep["status"], string> = {
  proposed: "bg-nav-accent/45",
  running: "bg-nav-accent status-pulse",
  done: "bg-ok",
  failed: "bg-err",
  skipped: "bg-line-strong",
};

const STATUS_LABEL: Partial<Record<NavigatorStep["status"], string>> = {
  running: "running",
  done: "done",
  failed: "failed",
  skipped: "not run",
};

export function StepCard({
  step,
  projectId,
  slug,
  autonomy,
  approved,
  onToggleApprove,
  editable,
  onPreview,
  prodEnvIds,
  earlierPending,
}: StepCardProps) {
  const { selectedEnvId } = useProjectData();
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<ActionPlan>();
  const [planError, setPlanError] = useState<string>();
  const [loading, setLoading] = useState(false);

  // The environment this step will actually run against: the one it names, or
  // the one the project view is on. Without it `requireEnvironment` refuses to
  // guess as soon as a project has two, and every preview fails for a reason
  // that has nothing to do with the step.
  const stepEnvId = (step.input as { environmentId?: string } | null)?.environmentId;
  const scopeEnvId = stepEnvId ?? selectedEnvId;

  const executable = isExecutable(step.actionId);
  const readOnly = step.actionId === INVESTIGATE;
  const previewable = executable;
  const blocked = step.actionId === BLOCKED || step.actionId === CLARIFY;
  const gate = autonomyBlock(autonomy, step.risk);

  const loadPlan = useCallback(async () => {
    if (!previewable || plan || loading) return;
    setLoading(true);
    try {
      const p = await planAction(step.actionId, {
        input: step.input,
        scope: { projectId, environmentId: scopeEnvId || undefined },
      });
      setPlan(p);
      onPreview(step.id, p.costDeltaUsd);
    } catch (err) {
      const e = err as ApiError;
      setPlanError(`${e.message}${e.fix ? ` ${e.fix}` : ""}`);
    } finally {
      setLoading(false);
    }
  }, [
    previewable,
    plan,
    loading,
    step.actionId,
    step.input,
    step.id,
    projectId,
    scopeEnvId,
    onPreview,
  ]);

  useEffect(() => {
    if (open) void loadPlan();
  }, [open, loadPlan]);

  const isDeploy = step.actionId.startsWith("deploy.");
  const statusText = STATUS_LABEL[step.status];
  const isProd = Boolean(stepEnvId && prodEnvIds.has(stepEnvId));

  return (
    <li className="animate-enter relative flex gap-3">
      {/* the Navigator rail */}
      <div className="relative flex w-6 shrink-0 flex-col items-center">
        <span className={cx("absolute top-0 bottom-0 w-px", RAIL[step.status])} aria-hidden="true" />
        <span
          className={cx(
            "tnum relative z-10 mt-3 grid h-6 w-6 place-items-center rounded-full border font-mono text-[11px]",
            step.status === "done"
              ? "border-ok/40 bg-ok-dim text-ok"
              : step.status === "failed"
                ? "border-err/40 bg-err-dim text-err"
                : step.status === "running"
                  ? "border-nav-accent/50 bg-nav-dim text-nav-accent"
                  : blocked
                    ? "border-warn/35 bg-warn-dim text-warn"
                    : "border-line bg-bg1 text-ink-faint"
          )}
        >
          {step.seq}
        </span>
      </div>

      <div
        className={cx(
          "min-w-0 flex-1 rounded-card border bg-bg2 px-4 py-3",
          blocked ? "border-warn/30 bg-warn-dim/40" : "border-line",
          isProd && "ring-1 ring-prod/45",
          step.status === "failed" && "border-err/35",
          step.status === "skipped" && "opacity-60"
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {step.status === "running" && <StatusDot status="running" label="Running" />}
              {blocked && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warn" />}
              {readOnly && <SearchCode className="h-3.5 w-3.5 shrink-0 text-nav-accent" />}
              <h3 className="truncate text-[14px] font-medium text-ink">{step.title}</h3>
              {statusText && (
                <span
                  className={cx(
                    "text-[11.5px]",
                    step.status === "done"
                      ? "text-ok"
                      : step.status === "failed"
                        ? "text-err"
                        : step.status === "running"
                          ? "text-nav-accent"
                          : "text-ink-faint"
                  )}
                >
                  {statusText}
                </span>
              )}
            </div>
            <p className="mt-1 max-w-[76ch] text-[12.5px] leading-relaxed text-ink-mute">
              {step.rationale}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {isProd && (
              <Chip tone="prod" title="This step acts on a production environment.">
                production
              </Chip>
            )}
            {executable && <RiskBadge level={step.risk} />}
            {executable ? (
              <Chip tone="nav" className="font-mono" title="The registered action this step calls">
                {step.actionId}
              </Chip>
            ) : (
              <Chip
                tone="warn"
                icon={<HelpCircle className="h-3 w-3" />}
                title="This step cannot be executed — it is here so the plan accounts for your whole sentence."
              >
                {step.actionId === CLARIFY ? "unparsed" : "blocked"}
              </Chip>
            )}
          </div>
        </div>

        {/* approval */}
        {editable && executable && step.needsApproval && (
          <div className="mt-2.5">
            <label
              className={cx(
                "inline-flex items-start gap-2 rounded-ctl border px-2.5 py-1.5 text-[12.5px]",
                gate
                  ? "cursor-not-allowed border-line bg-bg1 text-ink-faint"
                  : "cursor-pointer border-nav-accent/30 bg-nav-dim text-ink hover:border-nav-accent/60"
              )}
              title={gate}
            >
              <input
                type="checkbox"
                checked={approved && !gate}
                disabled={Boolean(gate)}
                onChange={(e) => onToggleApprove(step.id, e.target.checked)}
                className="mt-[3px] h-3.5 w-3.5 shrink-0 accent-[var(--nav-accent)]"
              />
              <span className="max-w-[70ch]">
                {gate ?? `Approve this step — ${step.risk} risk, and it changes your system.`}
              </span>
            </label>
          </div>
        )}
        {editable && executable && !step.needsApproval && (
          <p className="mt-2 text-[12px] text-ink-faint">
            Low risk and inside policy — runs without a separate approval.
          </p>
        )}

        {/* preview toggle */}
        {previewable && (
          <div className="mt-2.5">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className={cx(
                "inline-flex items-center gap-1 text-[12.5px] text-ink-mute",
                "transition-colors duration-[120ms] hover:text-ink"
              )}
            >
              <ChevronRight
                className={cx(
                  "h-3.5 w-3.5 transition-transform duration-[200ms] [transition-timing-function:var(--ease-swift)]",
                  open && "rotate-90"
                )}
              />
              {open ? "Hide preview" : "Preview what this does"}
            </button>

            {open && (
              <div className="animate-enter mt-2 rounded-ctl border border-line bg-bg1 px-3 py-2.5">
                {loading && <p className="text-[12.5px] text-ink-faint">Planning…</p>}
                {planError &&
                  (earlierPending ? (
                    <>
                      <p className="text-[12.5px] leading-relaxed text-ink-mute">
                        This step could not be previewed. An earlier step in this plan has not run
                        yet, so it may be waiting on something that step creates — but the exact
                        reason is the one below.
                      </p>
                      <p className="mt-1 text-[12px] text-ink-faint">{planError}</p>
                    </>
                  ) : (
                    <p className="text-[12.5px] leading-relaxed text-err">{planError}</p>
                  ))}
                {plan && (
                  <>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-[13px] text-ink">{plan.summary}</p>
                      <CostDelta usd={plan.costDeltaUsd} />
                    </div>
                    {plan.details.length > 0 && (
                      <ul className="mt-1.5 space-y-1">
                        {plan.details.map((d, i) => (
                          <li key={i} className="text-[12.5px] leading-relaxed text-ink-mute">
                            <span className="mr-1.5 text-ink-faint">—</span>
                            {d}
                          </li>
                        ))}
                      </ul>
                    )}
                    {plan.warnings.length > 0 && (
                      <ul className="mt-2 space-y-1 border-t border-line pt-2">
                        {plan.warnings.map((w, i) => (
                          <li
                            key={i}
                            className="flex gap-1.5 text-[12.5px] leading-relaxed text-warn"
                          >
                            <AlertTriangle className="mt-[3px] h-3 w-3 shrink-0" />
                            {w}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {readOnly && editable && (
          <p className="mt-2 text-[12px] text-ink-faint">
            Read-only — it inspects the last failure and writes a summary. Nothing changes.
          </p>
        )}

        {/* outcome */}
        {step.resultSummary && step.status !== "failed" && (
          <p className="mt-2.5 border-t border-line pt-2.5 text-[12.5px] leading-relaxed text-ink">
            {step.resultSummary}
          </p>
        )}
        {step.status === "failed" && (
          <div className="mt-2.5 rounded-ctl border border-err/30 bg-err-dim px-3 py-2">
            <p className="text-[12.5px] leading-relaxed text-err">
              {step.error ?? step.resultSummary ?? "This step failed without a recorded reason."}
            </p>
          </div>
        )}

        {isDeploy && (step.status === "done" || step.status === "failed") && (
          <Link
            href={`/p/${slug}/deploys`}
            className="mt-2 inline-block text-[12.5px] text-signal hover:underline"
          >
            Open Deploys for the full step log →
          </Link>
        )}
      </div>
    </li>
  );
}
