"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import {
  Button,
  Chip,
  LogViewer,
  PhaseTimeline,
  Skeleton,
  StatusDot,
  type LogLine,
} from "@/components/ui";
import { useProjectData } from "@/components/shell/project-context";
import { PlanFirst } from "@/components/inspector/plan-first";
import { useEventStream, useJson } from "@/lib/client/api";
import { cx } from "@/lib/format";
import type {
  Deployment,
  DeploymentEvent,
  DeploymentStatus,
  Output,
  StepStatus,
} from "@/lib/domain/types";
import { SuccessPanel } from "./success-panel";

const TERMINAL: DeploymentStatus[] = ["succeeded", "failed", "rolled_back", "cancelled"];
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
}: DeploymentViewProps) {
  const { project, selectedEnv } = useProjectData();
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

  useEffect(() => {
    onLiveTargets(liveTargets);
    return () => onLiveTargets([]);
  }, [liveTargets, onLiveTargets]);

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

  if (deployment.status === "failed" || deployment.status === "rolled_back")
    return (
      <div className="animate-enter space-y-4">
        <div className="flex items-start gap-3 rounded-card border border-err/30 bg-err-dim p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-medium text-ink">
              {deployment.status === "failed"
                ? `Stopped at "${failedStep?.title ?? "a step"}"`
                : "Rolled back"}
            </h2>
            <p className="mt-1 text-[13px] text-ink">
              {failedStep?.error ?? deployment.error ?? STATUS_COPY[deployment.status]}
            </p>
            <p className="mt-1 text-[12.5px] text-ink-mute">
              Steps that finished before this stayed applied. Rolling back returns the environment
              to the last revision it ran successfully.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <PlanFirst
            actionId="deploy.rollback"
            input={{ environmentId: deployment.environmentId }}
            scope={{ environmentId: deployment.environmentId }}
            label="Roll back to the last good revision"
            variant="primary"
            onDone={(r) => {
              const next = (r.data as { deploymentId?: string } | undefined)?.deploymentId;
              if (next) onSwitch(next);
            }}
          />
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
