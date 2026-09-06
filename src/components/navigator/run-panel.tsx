"use client";
import { ProviderChecks } from "./provider-checks";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { CostDelta } from "@/components/ui/cost-delta";
import { StatusDot } from "@/components/ui/status-dot";
import { cx } from "@/lib/format";
import type { AutonomyLevel, NavigatorRun } from "@/lib/domain/types";
import {
  autonomyBlock,
  canExecuteAtAll,
  isExecutable,
  roleBlock,
  type WorkspaceRole,
} from "@/lib/navigator/shared";
import { StepCard } from "./step-card";
import { RunReceipt, StepReceipt } from "./recorded-receipt";
import { ConnectedDetail } from "@/components/screens/connected-detail";
import { useProjectData } from "@/components/shell/project-context";

export interface RunPanelProps {
  run: NavigatorRun;
  projectId: string;
  slug: string;
  autonomy: AutonomyLevel;
  approvals: Set<string>;
  onToggleApprove: (stepId: string, approved: boolean) => void;
  onRun: () => void;
  running: boolean;
  /** stop the run before its next step */
  onCancel: () => void;
  cancelling: boolean;
  /** the caller's own workspace role — the floor under every step in this plan */
  role: WorkspaceRole | null;
  /** prefill the command bar with a follow-up goal */
  onSuggest: (goal: string) => void;
  error?: string;
  prodEnvIds: Set<string>;
}

const OUTCOME_LINK = "ui-button inline-flex min-h-9 items-center justify-center rounded-ctl border border-line bg-bg2 px-3.5 text-[13px] font-medium text-ink transition-colors duration-[var(--dur-fast)] hover:border-line-strong hover:bg-bg3";

const RUN_TONE = {
  planning: "neutral",
  awaiting_approval: "nav",
  executing: "nav",
  done: "neutral",
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
  onCancel,
  cancelling,
  role,
  onSuggest,
  error,
  prodEnvIds,
}: RunPanelProps) {
  const { project, environments, deployments } = useProjectData();
  const [selectedStepId, setSelectedStepId] = useState<string>();
  const selectedStep = run.steps.find((step) => step.id === selectedStepId);
  const selectedInput = selectedStep?.input as { serviceId?: string; resourceId?: string; environmentId?: string; from?: string; to?: string } | undefined;
  const resourceReference = selectedInput?.resourceId ?? selectedInput?.serviceId;
  const selectedResource = [...project.workingManifest.services, ...project.workingManifest.resources]
    .find((resource) => resource.id === resourceReference || resource.name === resourceReference);
  const recordedEnvId = selectedInput?.environmentId ?? deployments.find((deployment) => deployment.id === selectedStep?.deploymentId)?.environmentId;
  const selectedEnvironment = environments.find((env) => env.id === recordedEnvId);
  const completed = run.steps.filter((step) => step.status === "done").length;
  const activeStep = run.steps.find((step) => step.status === "running");
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

  const previewed = run.steps.flatMap((step) => costs[step.id] === undefined ? [] : [costs[step.id]]);
  const previewTotal = previewed.reduce((a, b) => a + b, 0);

  // Your role is the floor under the whole plan: the Navigator executes with
  // your permissions, not its own, so a step you could not run yourself stops
  // the run server-side. Say it at the button instead of after the click.
  const roleReason = roleBlock(runnable, role);

  const disabledReason =
    run.status === "cancelled"
      ? "You cancelled this run, so it cannot be resumed — the steps that had not started were never applied. Plan the remaining work as a new run."
      : !canExecuteAtAll(autonomy)
        ? autonomy === "plan"
          ? "Autonomy is set to plan — Navigator prepares but never executes. Raise the dial to approve to run this plan."
          : "Autonomy is set to observe — Navigator explains and suggests, and never executes. Raise the dial to approve to run this plan."
        : runnable.length === 0
          ? run.steps.some((s) => isExecutable(s.actionId) && s.status === "proposed")
            ? "Approve at least one step first — nothing here runs without your say-so."
            : "Every step in this plan has already run."
          : roleReason;

  const cancellable = run.status === "executing" || run.status === "awaiting_approval";

  return (
    <section className="space-y-4" aria-label="Active Navigator plan">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[16px] font-semibold leading-relaxed text-ink">
          Plan <span className="text-ink-mute">— {run.goal}</span>
        </h2>
        <div className="flex items-center gap-2">
          {run.status === "executing" && <StatusDot status="running" label="Executing" />}
          <Chip tone={RUN_TONE[run.status]}>{run.status === "done" ? "Completed" : run.status.replace("_", " ")}</Chip>
          {role && (
            <Chip title="Every step runs with your workspace permissions, not the Navigator's own.">
              you: {role}
            </Chip>
          )}
          <span className="tnum text-[12px] text-ink-faint">
            {run.steps.length} step{run.steps.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      {(running || executed) && (
        <div className="border-y border-line py-3" role="status" aria-live="polite">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[12px]">
            <span className="text-ink">{activeStep ? `Executing: ${activeStep.title}` : run.status === "executing" ? "Waiting for the next recorded step" : `Run ${run.status === "done" ? "completed" : run.status.replace("_", " ")}`}</span>
            <span className="tnum font-mono text-ink-mute">{completed} / {run.steps.length} completed</span>
          </div>
          <div className="h-1 overflow-hidden bg-bg1" role="progressbar" aria-label="Completed plan steps" aria-valuemin={0} aria-valuemax={run.steps.length || 1} aria-valuenow={completed}>
            <div className="h-full bg-nav-accent transition-[width] duration-[var(--dur-base)] motion-reduce:transition-none" style={{ width: `${run.steps.length ? completed / run.steps.length * 100 : 0}%` }} />
          </div>
        </div>
      )}
      <ol className="space-y-0">
        {run.steps.map((step, i) => (
          <StepCard
            key={step.id}
            step={step}
            verification={run.verification}
            onInspect={() => setSelectedStepId(step.id)}
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
          "flex flex-wrap items-center justify-between gap-3 border-y border-line bg-bg1 px-4 py-4",
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
        <div className="flex max-w-full flex-wrap items-center gap-3">
          {runnable.length > 0 && (
            <span className="tnum text-[12.5px] text-ink-faint">
              {runnable.length} step{runnable.length === 1 ? "" : "s"} ready
            </span>
          )}
          {cancellable && (
            <Button
              variant="quiet"
              onClick={onCancel}
              busy={cancelling}
              icon={<Square className="h-3.5 w-3.5" />}
              title={
                run.status === "executing"
                  ? "Stops the run before its next step. A step already in flight finishes and is recorded — the Navigator does not abandon a half-applied action."
                  : "Abandons this plan. Nothing is running, so the steps that never started are marked not run."
              }
            >
              Cancel
            </Button>
          )}
          <Button
            variant="primary"
            className="max-w-full whitespace-normal"
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
        <Callout tone="err" compact>
          {error}
        </Callout>
      )}

      {/* final summary */}
      {run.summary && run.status !== "executing" && run.status !== "awaiting_approval" && (
        <Card
          className={cx(run.status === "failed" && "ring-1 ring-err/35")}
          title={
            run.status === "done"
              ? "What changed"
              : run.status === "cancelled"
                ? "You cancelled this run"
                : "The run stopped"
          }
          subtitle={run.status === "done" ? "Each executed step is recorded in the audit log." : undefined}
        >
          <div className="max-w-[80ch] text-[13px] leading-relaxed text-ink"><RunReceipt run={run} deployments={deployments} /></div>
          <ProviderChecks run={run} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Link href={`/p/${slug}`} className={OUTCOME_LINK}>Open the System Map</Link>
            <Link href={`/p/${slug}/deploys`} className={OUTCOME_LINK}>Deploys</Link>
            <Link href={`/p/${slug}/activity`} className="ui-button inline-flex min-h-9 items-center justify-center rounded-ctl px-3.5 text-[13px] font-medium text-ink-mute transition-colors duration-[var(--dur-fast)] hover:bg-bg2 hover:text-ink">Audit trail</Link>
            {run.status === "failed" && (
              <Button variant="ghost" onClick={() => onSuggest("Investigate the failed deployment")}>
                Plan an investigation
              </Button>
            )}
          </div>
        </Card>
      )}
      <ConnectedDetail open={Boolean(selectedStep)} onClose={() => setSelectedStepId(undefined)}
        title={selectedStep?.title ?? "Plan step"} resourceId={selectedResource?.id}
        environment={selectedEnvironment ? `${selectedEnvironment.name}${selectedEnvironment.class === "production" ? " · production" : ""}` : recordedEnvId ?? "Project scope"}
        context={selectedStep ? `Step ${selectedStep.seq} · ${selectedStep.actionId}` : undefined}>
        {selectedStep && <div className="space-y-5">
          <p className="text-[14px] leading-relaxed text-ink">{selectedStep.rationale}</p>
          {resourceReference && <p className="text-[12px] text-ink-mute">Target: <span className="break-all font-mono text-ink">{resourceReference}</span>{selectedResource ? " · identity resolved from the current working copy" : " · no current resource match"}</p>}
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-3 text-[13px]">
            <dt className="text-ink-mute">Status</dt><dd>{selectedStep.status === "done" ? "Completed" : selectedStep.status}</dd>
            <dt className="text-ink-mute">Risk</dt><dd>{selectedStep.risk}</dd>
            <dt className="text-ink-mute">Approval</dt><dd>{selectedStep.needsApproval ? "Required before execution" : "Within workspace policy"}</dd>
            {selectedInput?.from && <><dt className="text-ink-mute">Binding</dt><dd className="break-all font-mono">{selectedInput.from} → {selectedInput.to}</dd></>}
            {selectedStep.deploymentId && <><dt className="text-ink-mute">Deployment</dt><dd className="break-all font-mono">{selectedStep.deploymentId}</dd></>}
          </dl>
          {selectedStep.error && <Callout tone="err">{selectedStep.error}</Callout>}
          {selectedStep.resultSummary && <div className="border-t border-line pt-4 text-[13px] leading-relaxed"><StepReceipt step={selectedStep} verification={run.verification} deployment={deployments.find(deployment => deployment.id === selectedStep.deploymentId)} /></div>}
          {selectedResource && <Link href={`/p/${slug}?select=${encodeURIComponent(selectedResource.id)}`} className="block text-[13px] text-signal underline">Open current resource in System</Link>}
          {selectedStep.deploymentId && <Link href={`/p/${slug}/deploys?deployment=${encodeURIComponent(selectedStep.deploymentId)}`} className="inline-block text-[13px] text-signal underline">Inspect deployment</Link>}
        </div>}
      </ConnectedDetail>
    </section>
  );
}
