"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, OctagonPause, ShieldCheck } from "lucide-react";
import {
  Button,
  Callout,
  Chip,
  LogViewer,
  PhaseTimeline,
  Skeleton,
  StatusDot,
  type LogLine,
} from "@/components/ui";
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
  const { project, selectedEnv, revisions } = useProjectData();
  const { boot } = useShell();
  const approveRole = useRequiredRole("deploy.approve", "admin");
  const { data, refresh } = useJson<{ deployment: Deployment }>(
    `/api/deployments/${deploymentId}`,
    1500
  );
  const [patch, setPatch] = useState<Patch>(EMPTY_PATCH);

  useEffect(() => setPatch(EMPTY_PATCH), [deploymentId]);

  const onEvent = useCallback((type: string, payload: unknown) => {
    const e = payload as DeploymentEvent;
    setPatch((p) => {
      if (type === "status" && e.type === "status") return { ...p, status: e.status };
      if (type === "step" && e.type === "step")
        return { ...p, steps: { ...p.steps, [e.stepId]: { status: e.status, error: e.error } } };
      if (type === "log" && e.type === "log")
        return {
          ...p,
          logs: [...p.logs, { seq: e.seq, stream: e.stream, line: e.line, ts: e.ts }],
        };
      if (type === "output" && e.type === "output")
        return {
          ...p,
          outputs: [...p.outputs.filter((o) => o.key !== e.output.key), e.output],
        };
      return p;
    });
  }, []);

  const { connected } = useEventStream(
    `/api/deployments/${deploymentId}/events`,
    EVENTS,
    onEvent,
    refresh
  );

  const deployment = useMemo<Deployment | undefined>(() => {
    const base = data?.deployment;
    if (!base) return undefined;
    const status = TERMINAL.includes(base.status) ? base.status : (patch.status ?? base.status);
    const keys = new Set(base.outputs.map((o) => o.key));
    return {
      ...base,
      status,
      steps: base.steps.map((s) => (patch.steps[s.id] ? { ...s, ...patch.steps[s.id] } : s)),
      outputs: [...base.outputs, ...patch.outputs.filter((o) => !keys.has(o.key))],
    };
  }, [data, patch]);

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

  if (!deployment)
    return (
      <div className="space-y-3">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );

  if (deployment.status === "succeeded")
    return <SuccessPanel deployment={deployment} onAddRoute={onAddRoute} />;

  const failedStep = deployment.steps.find((s) => s.status === "failed");
  const running = !TERMINAL.includes(deployment.status);
  const isProd = selectedEnv?.class === "production";

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
            <div className="flex items-center gap-2">
              <h2 className="text-[16px] font-medium text-ink">Waiting for approval</h2>
              {isProd && <Chip tone="prod">production</Chip>}
            </div>
            <p className="mt-1 text-[13px] text-ink-mute">
              {selectedEnv?.name ?? "This environment"} requires a human to approve before anything
              changes. Nothing has been applied yet — {deployment.changeSummary}.
            </p>
          </div>
        </div>

        <PhaseTimeline steps={deployment.steps} compact />

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
              ? "No step had finished, so this environment is untouched."
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
          <Link href={`/p/${project.slug}/observe`}>
            <Button size="sm" variant="quiet">
              View logs
            </Button>
          </Link>
        </div>

        <PhaseTimeline steps={deployment.steps} />
        <LogViewer lines={patch.logs} height={200} />
      </div>
    );
  }

  return (
    <div className="animate-enter space-y-4">
      <div className="flex items-center gap-2.5">
        <StatusDot status={running ? "running" : "idle"} />
        <h2 className="text-[15px] font-medium text-ink">
          {deployment.status === "rolling_back" ? "Rolling back" : "Deploying"} to{" "}
          {selectedEnv?.name ?? "the environment"}
        </h2>
        {isProd && <Chip tone="prod">production</Chip>}
        <span className="ml-auto text-[12px] text-ink-faint">
          {connected ? "live" : "reconnecting…"}
        </span>
      </div>
      <p className="text-[13px] text-ink-mute">{STATUS_COPY[deployment.status]}</p>

      <PhaseTimeline steps={deployment.steps} />
      <LogViewer lines={patch.logs} height={200} />

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
