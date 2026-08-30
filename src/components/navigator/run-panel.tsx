"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Play } from "lucide-react";
import { Button, Card, Chip, CostDelta, StatusDot } from "@/components/ui";
import { cx } from "@/lib/format";
import type { AutonomyLevel, NavigatorRun } from "@/lib/domain/types";
import { autonomyBlock, canExecuteAtAll, isExecutable } from "@/lib/navigator/shared";
import { StepCard } from "./step-card";

export interface RunPanelProps {
  run: NavigatorRun;
  projectId: string;
  slug: string;
  autonomy: AutonomyLevel;
  approvals: Set<string>;
  onToggleApprove: (stepId: string, approved: boolean) => void;
  onRun: () => void;
  running: boolean;
  /** prefill the command bar with a follow-up goal */
  onSuggest: (goal: string) => void;
  error?: string;
  prodEnvIds: Set<string>;
}

const RUN_TONE = {
  planning: "neutral",
  awaiting_approval: "nav",
  executing: "nav",
  done: "ok",
  failed: "err",
  cancelled: "neutral",
} as const;

export function RunPanel({
  run,
  projectId,
  slug,
  autonomy,
  approvals,
  onToggleApprove,
  onRun,
  running,
  onSuggest,
  error,
  prodEnvIds,
}: RunPanelProps) {
  const [costs, setCosts] = useState<Record<string, number>>({});
  const onPreview = useMemo(
    () => (stepId: string, usd: number) => setCosts((c) => (c[stepId] === usd ? c : { ...c, [stepId]: usd })),
    []
  );

  const editable = run.status === "awaiting_approval" || run.status === "planning";
  const executed = run.steps.some((s) => s.status !== "proposed" && s.status !== "skipped");

  const runnable = run.steps.filter(
    (s) =>
      isExecutable(s.actionId) &&
      s.status === "proposed" &&
      !autonomyBlock(autonomy, s.risk) &&
      (!s.needsApproval || approvals.has(s.id))
  );

  const previewed = Object.values(costs);
  const previewTotal = previewed.reduce((a, b) => a + b, 0);

  const disabledReason = !canExecuteAtAll(autonomy)
    ? autonomy === "plan"
      ? "Autonomy is set to plan — Navigator prepares but never executes. Raise the dial to approve to run this plan."
      : "Autonomy is set to observe — Navigator explains and suggests, and never executes. Raise the dial to approve to run this plan."
    : runnable.length === 0
      ? run.steps.some((s) => isExecutable(s.actionId) && s.status === "proposed")
        ? "Approve at least one step first — nothing here runs without your say-so."
        : "Every step in this plan has already run."
      : undefined;

  return (
    <section className="animate-enter space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[15px] font-medium text-ink">
          Plan <span className="text-ink-mute">— {run.goal}</span>
        </h2>
        <div className="flex items-center gap-2">
          {run.status === "executing" && <StatusDot status="running" label="Executing" />}
          <Chip tone={RUN_TONE[run.status]}>{run.status.replace("_", " ")}</Chip>
          <span className="tnum text-[12px] text-ink-faint">
            {run.steps.length} step{run.steps.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      <ol className="space-y-2">
        {run.steps.map((step, i) => (
          <StepCard
            key={step.id}
            step={step}
            projectId={projectId}
            slug={slug}
            autonomy={autonomy}
            approved={approvals.has(step.id)}
            onToggleApprove={onToggleApprove}
            editable={editable && step.status === "proposed"}
            onPreview={onPreview}
            prodEnvIds={prodEnvIds}
            earlierPending={run.steps
              .slice(0, i)
              .some((s) => isExecutable(s.actionId) && s.status !== "done")}
          />
        ))}
      </ol>

      {/* footer — gone once there is genuinely nothing left to run */}
      <div
        className={cx(
          "flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-bg1 px-4 py-3",
          run.status === "done" &&
            !run.steps.some((s) => isExecutable(s.actionId) && s.status === "proposed") &&
            "hidden"
        )}
      >
        <div className="min-w-0 text-[12.5px] text-ink-mute">
          {previewed.length > 0 ? (
            <span className="inline-flex flex-wrap items-baseline gap-1.5">
              Est. monthly change across {previewed.length} previewed step
              {previewed.length === 1 ? "" : "s"}:
              <CostDelta usd={previewTotal} />
              <span className="text-ink-faint">estimate</span>
            </span>
          ) : (
            "Expand a step to preview exactly what it does and what it costs."
          )}
        </div>
        <div className="flex items-center gap-3">
          {runnable.length > 0 && (
            <span className="tnum text-[12.5px] text-ink-faint">
              {runnable.length} step{runnable.length === 1 ? "" : "s"} ready
            </span>
          )}
          <Button
            variant="primary"
            onClick={onRun}
            busy={running}
            disabled={Boolean(disabledReason)}
            disabledReason={disabledReason}
            icon={<Play className="h-3.5 w-3.5" />}
          >
            {executed ? "Run remaining approved steps" : "Run approved steps"}
          </Button>
        </div>
      </div>

      {error && (
        <p className="rounded-ctl border border-err/30 bg-err-dim px-3 py-2 text-[12.5px] text-err">
          {error}
        </p>
      )}

      {/* final summary */}
      {run.summary && (run.status === "done" || run.status === "failed") && (
        <Card
          className={cx(run.status === "failed" && "ring-1 ring-err/35")}
          title={run.status === "done" ? "What changed" : "The run stopped"}
          subtitle={run.status === "done" ? "Every step below is in the audit log." : undefined}
        >
          <p className="max-w-[80ch] text-[13px] leading-relaxed text-ink">{run.summary}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Link href={`/p/${slug}`}>
              <Button variant="quiet">Open the System Map</Button>
            </Link>
            <Link href={`/p/${slug}/deploys`}>
              <Button variant="quiet">Deploys</Button>
            </Link>
            <Link href={`/p/${slug}/activity`}>
              <Button variant="ghost">Audit trail</Button>
            </Link>
            {run.status === "failed" && (
              <Button variant="ghost" onClick={() => onSuggest("Investigate the failed deployment")}>
                Plan an investigation
              </Button>
            )}
          </div>
        </Card>
      )}
    </section>
  );
}
