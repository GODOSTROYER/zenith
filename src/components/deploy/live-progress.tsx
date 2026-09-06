"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, OctagonPause, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/chip";
import { LogViewer, type LogLine } from "@/components/ui/log-viewer";
import { PhaseTimeline } from "@/components/ui/phase-timeline";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { useProjectData } from "@/components/shell/project-context";
import { useShell } from "@/components/shell/shell-context";
import { PlanFirst } from "@/components/inspector/plan-first";
import { useEventStream, useJson } from "@/lib/client/api";
import { cx } from "@/lib/format";
import { roleAllows, roleReason, useRequiredRole } from "./caller-role";
import type {
  Deployment,
  DeploymentEvent,
  DeploymentStatus,
  Output,
  StepStatus,
} from "@/lib/domain/types";
import { SuccessPanel } from "./success-panel";
import { ConnectedDetail } from "@/components/screens/connected-detail";
import { fmtUsd } from "@/lib/format";
import type { DeploymentStep } from "@/lib/domain/types";
import { reconcileDeployment } from "./deployment-state";
import { downloadFile } from "@/components/screens/download-file";

const TERMINAL: DeploymentStatus[] = ["succeeded", "failed", "rolled_back", "cancelled"];
/**
 * Terminal and not the activation moment. `cancelled` used to fall through to
 * the running view, which put a "Deploying" heading and a live Cancel button
 * on a deployment that had already stopped.
 */
const STOPPED: DeploymentStatus[] = ["failed", "rolled_back", "cancelled"];
const EVENTS = ["status", "step", "log", "output"];

const STATUS_COPY: Record<DeploymentStatus, string> = {
  planning: "Working out what has to change.",
  awaiting_approval: "Waiting for a human to approve this.",
  applying: "Applying the plan.",
  verifying: "Checking that what was applied actually works.",
  succeeded: "Done.",
  failed: "Stopped at a failed step.",
  rolling_back: "Rolling back to the last good revision.",
  rolled_back: "Rolled back. The environment runs the previous revision.",
  cancelled: "Cancelled. Steps that had already finished stayed applied.",
};

interface Patch {
  status?: DeploymentStatus;
  steps: Record<string, { status: StepStatus; error?: string }>;
  outputs: Output[];
  logs: LogLine[];
}

const EMPTY_PATCH: Patch = { steps: {}, outputs: [], logs: [] };

export interface DeploymentViewProps {
  deploymentId: string;
  /** node ids a step is touching right now — the map pulses them */
  onLiveTargets: (ids: string[]) => void;
  /** a rollback started a new deployment; follow it */
  onSwitch: (deploymentId: string) => void;
  onAddRoute: () => void;
  /** it landed — the dock gives the activation moment the whole panel */
  onSucceeded?: (deploymentId: string) => void;
  /** after a failure or a cancel: back to the review for the same changeset */
  onRetry?: () => void;
}

/**
 * A deployment, watched. Steps and status come from the event stream (which
 * replays from the last seq on reconnect, so a refresh mid-deploy loses
 * nothing) and are reconciled against the deployment record.
 */
export function DeploymentView({
  deploymentId,
  onLiveTargets,
  onSwitch,
  onAddRoute,
  onSucceeded,
  onRetry,
}: DeploymentViewProps) {
  const { project, environments, revisions } = useProjectData();
  const { boot } = useShell();
  const approveRole = useRequiredRole("deploy.approve", "admin");
  const { data, error: loadError, refresh } = useJson<{ deployment: Deployment }>(
    `/api/deployments/${deploymentId}`,
    1500
  );
  const [patch, setPatch] = useState<Patch>(EMPTY_PATCH);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const queuedLogs = useRef<LogLine[]>([]);
  const seenLogs = useRef(new Set<number>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setPatch(EMPTY_PATCH);
    setSelectedStepId(null);
    queuedLogs.current = [];
    seenLogs.current = new Set();
    return () => { clearTimeout(flushTimer.current); flushTimer.current = undefined; };
  }, [deploymentId]);

  const onEvent = useCallback((type: string, payload: unknown) => {
    const e = payload as DeploymentEvent;
    if (e.deploymentId !== deploymentId) return;
    // Preserve the complete history while committing bursts once per frame
    // window. Replayed SSE sequences must not duplicate the visible log.
    if (type === "log" && e.type === "log") {
      if (seenLogs.current.has(e.seq)) return;
      seenLogs.current.add(e.seq);
      queuedLogs.current.push({ seq: e.seq, stream: e.stream, line: e.line, ts: e.ts });
      if (!flushTimer.current) flushTimer.current = setTimeout(() => {
        const incoming = queuedLogs.current;
        queuedLogs.current = [];
        flushTimer.current = undefined;
        setPatch((p) => ({ ...p, logs: [...p.logs, ...incoming] }));
      }, 120);
      return;
    }
    setPatch((p) => {
      if (type === "status" && e.type === "status") return { ...p, status: e.status };
      if (type === "step" && e.type === "step")
        return { ...p, steps: { ...p.steps, [e.stepId]: { status: e.status, error: e.error } } };
      if (type === "output" && e.type === "output")
        return {
          ...p,
          outputs: [...p.outputs.filter((o) => o.key !== e.output.key), e.output],
        };
      return p;
    });
  }, [deploymentId]);

  const { connected } = useEventStream(
    `/api/deployments/${deploymentId}/events`,
    EVENTS,
    onEvent,
    refresh
  );

  const deployment = useMemo<Deployment | undefined>(() => {
    const base = data?.deployment;
    if (!base || base.id !== deploymentId) return undefined;
    return reconcileDeployment(base, patch);
  }, [data, patch, deploymentId]);

  const liveTargets = useMemo(
    () =>
      (deployment?.steps ?? [])
        .filter((s) => s.status === "running" && s.targetId)
        .map((s) => s.targetId),
    [deployment]
  );

  // Two effects on purpose. One effect with a clearing cleanup runs
  // clear-then-set on every step transition, and the map flickers off between
  // steps; the pulse should move, not blink. Only unmounting clears.
  useEffect(() => {
    onLiveTargets(liveTargets);
  }, [liveTargets, onLiveTargets]);

  useEffect(() => () => onLiveTargets([]), [onLiveTargets]);

  const succeeded = deployment?.status === "succeeded";
  useEffect(() => {
    if (succeeded) onSucceeded?.(deploymentId);
  }, [succeeded, deploymentId, onSucceeded]);

  if (!deployment && loadError) return <Callout tone="err" title="Deployment unavailable"><p>{loadError.message}</p>{loadError.fix && <p className="mt-1">{loadError.fix}</p>}<Button className="mt-3" variant="quiet" onClick={refresh}>Retry loading deployment</Button></Callout>;

  if (!deployment)
    return (
      <div className="space-y-3">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );

  const failedStep = deployment.steps.find((s) => s.status === "failed");
  const selectedEnv = environments.find((env) => env.id === deployment.environmentId);
  const connection = boot?.connections.find((entry) => entry.id === selectedEnv?.connectionId);
  // Provider identity comes from this deployment's environment connection,
  // never from the environment's display name. Recorded output flags are
  // explicit simulation evidence even before bootstrap finishes loading.
  const simulated = connection?.provider === "sandbox" || deployment.outputs.some((output) => output.simulated === true);
  const simulationBadge = simulated ? <Chip title="The Sandbox provider simulates these steps. No real infrastructure is changed or verified.">Simulation</Chip> : null;
  const running = !TERMINAL.includes(deployment.status);
  const isProd = selectedEnv?.class === "production";
  const selectedStep = deployment.steps.find((s) => s.id === selectedStepId);
  const timeline = <><PhaseTimeline steps={deployment.steps} selectedStepId={selectedStepId ?? undefined} onSelectStep={(step: DeploymentStep) => setSelectedStepId(step.id)} /><ConnectedDetail open={Boolean(selectedStep)} onClose={() => setSelectedStepId(null)} title={selectedStep?.title ?? "Deployment step"} resourceId={selectedStep?.targetId || undefined} environment={selectedEnv?.name} context={`${simulated ? "Simulation · " : ""}Deployment ${deployment.id}`}>
    {selectedStep && <div className="space-y-4"><dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-3 text-[13px]"><dt className="text-ink-mute">Phase</dt><dd className="capitalize">{selectedStep.phase}</dd><dt className="text-ink-mute">State</dt><dd className="capitalize">{selectedStep.status}</dd><dt className="text-ink-mute">Scope</dt><dd>{selectedStep.targetId ? "Selected resource" : "Whole system"}</dd></dl>{selectedStep.detail && <pre className="whitespace-pre-wrap break-words border border-line bg-bg1 p-3 font-mono text-[12px]">{selectedStep.detail}</pre>}{selectedStep.error && <Callout tone="err">{selectedStep.error}</Callout>}<p className="text-[12px] text-ink-mute">Read-only evidence from this deployment. Resource configuration is edited in System.</p></div>}
  </ConnectedDetail></>;
  const context = <div className="space-y-2 border-b border-line pb-4"><p className="text-[14px] font-medium text-ink">{deployment.changeSummary}</p><div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[12px] text-ink-mute"><span>{deployment.id}</span><span>{revisions.find((r) => r.id === deployment.revisionId)?.number ? `r${revisions.find((r) => r.id === deployment.revisionId)!.number}` : deployment.revisionId}</span><span>{fmtUsd(deployment.estCostDeltaUsd, { sign: true })}/mo estimated change</span></div></div>;
  const logs = <section className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-[13px] font-medium text-ink">Deployment logs</h3>{patch.logs.length > 0 && <Button size="sm" variant="ghost" onClick={() => downloadFile(`orrery-deployment-${deployment.id}.log`, patch.logs.map((line) => `${line.ts ?? ""} ${line.stream} ${line.line}`).join("\n") + "\n", "text/plain")}>Download all {patch.logs.length} lines</Button>}</div><LogViewer lines={patch.logs} height={200} label="Deployment logs" /></section>;

  if (deployment.status === "succeeded") return <div className="space-y-5">{simulationBadge}<SuccessPanel deployment={deployment} onAddRoute={onAddRoute} /><details className="border-t border-line pt-4" open={selectedStepId ? true : undefined}><summary className="cursor-pointer text-[13px] font-medium text-ink">Inspect completed steps and logs</summary><div className="mt-4 space-y-4">{context}{timeline}{logs}</div></details></div>;

  if (deployment.status === "awaiting_approval")
    return (
      <div
        className={cx(
          "animate-enter space-y-4 rounded-card border bg-bg1 p-4",
          isProd ? "border-prod/50 ring-1 ring-prod/45" : "border-line"
        )}
      >
        <div className="flex items-start gap-3">
          <ShieldCheck
            className={cx("mt-0.5 h-5 w-5 shrink-0", isProd ? "text-prod" : "text-info")}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[16px] font-medium text-ink">Waiting for approval</h2>
              {isProd && <Chip tone="prod">production</Chip>}
              {simulationBadge}
            </div>
            <p className="mt-1 text-[13px] text-ink-mute">
              {selectedEnv?.name ?? "This environment"} requires a human to approve before anything
              changes. Nothing has been applied yet — {deployment.changeSummary}.
            </p>
          </div>
        </div>

        {context}
        {timeline}

        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
          <PlanFirst
            actionId="deploy.approve"
            input={{ deploymentId }}
            scope={{ environmentId: deployment.environmentId }}
            label="Approve and apply"
            variant={isProd ? "danger" : "primary"}
            disabled={!roleAllows(boot, approveRole)}
            disabledReason={roleReason(boot, approveRole, "Approving a deployment")}
            onDone={refresh}
          />
          <PlanFirst
            actionId="deploy.cancel"
            input={{ deploymentId }}
            scope={{ environmentId: deployment.environmentId }}
            label="Cancel"
            variant="quiet"
            onDone={refresh}
          />
        </div>
      </div>
    );

  if (STOPPED.includes(deployment.status)) {
    const cancelled = deployment.status === "cancelled";
    const applied = deployment.steps.filter((s) => s.status === "done").length;
    // The revision this environment ran before this deployment — the only
    // honest rollback target, and absent on a first-ever deploy.
    const previousId = deployment.previousRevisionId;
    const previousNumber = revisions.find((r) => r.id === previousId)?.number;
    // Already rolled back: there is nothing left to undo, and offering it
    // again would roll back the rollback.
    const offerRollback = deployment.status !== "rolled_back";

    return (
      <div className="animate-enter space-y-4">
        {simulationBadge}
        <Callout
          tone={cancelled ? "warn" : "err"}
          icon={
            cancelled ? (
              <OctagonPause className="mt-0.5 h-5 w-5 shrink-0 text-warn" aria-hidden="true" />
            ) : (
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" aria-hidden="true" />
            )
          }
          title={
            <h2 className="text-[16px] font-medium text-ink">
              {deployment.status === "failed"
                ? `Stopped at "${failedStep?.title ?? "a step"}"`
                : cancelled
                  ? "Cancelled"
                  : "Rolled back"}
            </h2>
          }
        >
          <p className="text-[13px] text-ink">
            {failedStep?.error ??
              deployment.error ??
              (cancelled
                ? "Stopped on request — nothing further will be applied."
                : STATUS_COPY[deployment.status])}
          </p>
          <p className="mt-1 text-[12.5px] text-ink-mute">
            {applied === 0
              ? "No step reported completion. A failed or interrupted provider operation may still need inspection."
              : `${applied} step${applied === 1 ? "" : "s"} had already finished and stayed applied. ` +
                (!offerRollback
                  ? `${selectedEnv?.name ?? "The environment"} now runs the previous revision.`
                  : previousNumber
                    ? `Rolling back returns ${selectedEnv?.name ?? "the environment"} to r${previousNumber}.`
                    : "There is no earlier revision to return to — fix the working copy and deploy again.")}
          </p>
        </Callout>

        <div className="flex flex-wrap items-center gap-3">
          {offerRollback && (
            <PlanFirst
              actionId="deploy.rollback"
              input={{ environmentId: deployment.environmentId, toRevisionId: previousId }}
              scope={{ environmentId: deployment.environmentId }}
              label={previousNumber ? `Roll back to r${previousNumber}` : "Roll back"}
              variant="primary"
              disabled={!previousId}
              disabledReason={`This was the first deployment to ${selectedEnv?.name ?? "this environment"} — there is no earlier revision to return to. Fix the problem in the working copy and deploy again.`}
              onDone={(r) => {
                const next = (r.data as { deploymentId?: string } | undefined)?.deploymentId;
                if (next) onSwitch(next);
              }}
            />
          )}
          {onRetry && deployment.status !== "rolled_back" && (
            <Button
              size="sm"
              variant={offerRollback && previousId ? "quiet" : "primary"}
              onClick={onRetry}
            >
              Review changes and deploy again
            </Button>
          )}
          <Link href={`/p/${project.slug}/observe`} className="ui-button inline-flex h-8 items-center justify-center rounded-ctl border border-line bg-bg2 px-2.5 text-[12.5px] font-medium text-ink transition-colors duration-[var(--dur-fast)] hover:border-line-strong hover:bg-bg3">
            View logs
          </Link>
        </div>

        {context}
        {timeline}
        {logs}
      </div>
    );
  }

  return (
    <div className="animate-enter space-y-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <StatusDot status={running ? "running" : "idle"} />
        <h2 className="text-[15px] font-medium text-ink">
          {deployment.status === "rolling_back" ? "Rolling back" : "Deploying"} to{" "}
          {selectedEnv?.name ?? "the environment"}
        </h2>
        {isProd && <Chip tone="prod">production</Chip>}
        {simulationBadge}
        <span className="ml-auto text-[12px] text-ink-faint">
          {connected ? "Live updates" : "Reconnecting updates…"}
        </span>
      </div>
      <p role="status" className="text-[13px] text-ink-mute">{simulated && deployment.status === "verifying" ? "Running the Sandbox provider’s simulated checks." : STATUS_COPY[deployment.status]}</p>
      {!connected && <Callout tone="warn">Live events are reconnecting. The deployment record continues to refresh; execution may still be running.</Callout>}
      {loadError && <Callout tone="warn">The last deployment refresh failed. Showing the last available record. <Button variant="ghost" size="sm" onClick={refresh}>Refresh now</Button></Callout>}
      {context}

      {timeline}
      {logs}

      <div className="border-t border-line pt-3">
        <PlanFirst
          actionId="deploy.cancel"
          input={{ deploymentId }}
          scope={{ environmentId: deployment.environmentId }}
          label="Cancel deployment"
          variant="quiet"
          onDone={refresh}
        />
      </div>
    </div>
  );
}
