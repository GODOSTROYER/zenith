"use client";
/**
 * Everything that happened inside one deployment. A deployment in flight
 * streams; a finished one replays the same event log from seq 0, so history
 * and live look identical and a refresh loses nothing.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { GitCompare } from "lucide-react";
import { useEventStream } from "@/lib/client/api";
import type { Deployment, DeploymentEvent } from "@/lib/domain/types";
import { fmtDuration } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { CostDelta } from "@/components/ui/cost-delta";
import { LogViewer, type LogLine } from "@/components/ui/log-viewer";
import { PhaseTimeline } from "@/components/ui/phase-timeline";
import { StatusDot } from "@/components/ui/status-dot";
import { TimeAgo } from "@/components/ui/time-ago";
import { useShell } from "@/components/shell/shell-context";
import { roleAllows, roleReason, useRequiredRole } from "@/components/deploy/caller-role";
import { ActionConfirm, ErrorNote } from "@/components/screens/shared";
import { ConnectedDetail } from "@/components/screens/connected-detail";
import { OutputRow } from "./output-row";
import { isLive, STATUS_DOT, STATUS_LABEL, STREAM_EVENTS } from "./status";

/** A long deployment must not grow the tab's memory without bound. */
const MAX_BUFFERED_LINES = 2000;

export interface DeploymentDetailProps {
  snapshot: Deployment;
  envName: string;
  isProd: boolean;
  environmentId: string;
  connectionId: string;
  projectId: string | undefined;
  slug: string;
  revisionNumbers: Map<string, number>;
  onChanged: () => void;
}

export function DeploymentDetail({
  snapshot,
  envName,
  isProd,
  environmentId,
  connectionId,
  projectId,
  slug,
  revisionNumbers,
  onChanged,
}: DeploymentDetailProps) {
  const { boot } = useShell();
  const approveRole = useRequiredRole("deploy.approve", "admin");
  const [dep, setDep] = useState<Deployment>(snapshot);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [confirm, setConfirm] = useState<null | "approve" | "cancel" | "rollback">(null);
  const [selectedStepId, setSelectedStepId] = useState<string>();

  const revisionNumber = revisionNumbers.get(snapshot.revisionId);

  useEffect(() => {
    setDep(snapshot);
  }, [snapshot]);

  const onEvent = useCallback((type: string, raw: unknown) => {
    const e = raw as DeploymentEvent;
    if (type === "log" && e.type === "log") {
      setLines((prev) =>
        [...prev, { seq: e.seq, stream: e.stream, line: e.line, ts: e.ts }].slice(
          -MAX_BUFFERED_LINES
        )
      );
      return;
    }
    setDep((prev) => {
      if (type === "status" && e.type === "status") return { ...prev, status: e.status };
      if (type === "step" && e.type === "step")
        return {
          ...prev,
          steps: prev.steps.map((s) =>
            s.id === e.stepId ? { ...s, status: e.status, error: e.error ?? s.error } : s
          ),
        };
      if (type === "output" && e.type === "output")
        return prev.outputs.some((o) => o.key === e.output.key)
          ? prev
          : { ...prev, outputs: [...prev.outputs, e.output] };
      return prev;
    });
  }, []);

  const { connected } = useEventStream(
    `/api/deployments/${snapshot.id}/events`,
    STREAM_EVENTS,
    onEvent,
    onChanged
  );

  const scope = { projectId, environmentId };
  const live = isLive(dep.status);
  const selectedStep = dep.steps.find((step) => step.id === selectedStepId);
  const previousNumber = dep.previousRevisionId
    ? revisionNumbers.get(dep.previousRevisionId)
    : undefined;
  // "What changed" is the diff between the revision this replaced and the one
  // it deployed — the Revisions screen already renders exactly that.
  const changedHref = dep.previousRevisionId
    ? `/p/${slug}/revisions?compare=${dep.previousRevisionId},${dep.revisionId}`
    : `/p/${slug}/revisions?view=${dep.revisionId}`;
  // Only the sandbox hands out addresses nothing answers on. `undefined` until
  // the workspace payload lands — unknown is not "real".
  const connection = boot?.connections.find((c) => c.id === connectionId);
  const envSimulated = connection ? connection.provider === "sandbox" : undefined;
  const simulated = envSimulated === true || dep.outputs.some((output) => output.simulated === true);

  return (
    <div className="space-y-5">
      <Card
        prod={isProd}
        title={
          <span className="flex flex-wrap items-center gap-2.5">
            <StatusDot status={STATUS_DOT[dep.status]} pulse={live} />
            {STATUS_LABEL[dep.status]}
            <span className="tnum font-mono text-[13px] text-ink-mute">
              r{revisionNumber ?? "?"}
            </span>
            {simulated && <Chip title="This deployment includes simulated execution or outputs. Simulated outcomes do not verify real infrastructure.">Simulation</Chip>}
          </span>
        }
        subtitle={
          <>
            {dep.changeSummary} · {envName} · <TimeAgo iso={dep.createdAt} /> ·{" "}
            <span title="Estimated change to the monthly bill this deployment carried.">
              <CostDelta usd={dep.estCostDeltaUsd} /> estimated
            </span>
          </>
        }
        actions={
          <>
            {isProd && <Chip tone="prod">production</Chip>}
            {live && (
              <Chip tone={connected ? "signal" : "warn"}>
                {connected ? "streaming" : "reconnecting"}
              </Chip>
            )}
            <Link href={changedHref}
                className="ui-button inline-flex h-8 items-center justify-center gap-1.5 rounded-ctl border border-line bg-bg2 px-3 text-[13px] font-medium text-ink hover:border-line-strong hover:bg-bg3"
                title={
                  previousNumber
                    ? `Diff r${previousNumber} against r${revisionNumber ?? "?"}`
                    : `Show r${revisionNumber ?? "?"} — the first revision this environment ran`
                }
              >
                <GitCompare className="h-3.5 w-3.5" aria-hidden="true" />
                {dep.previousRevisionId ? "What changed" : "View revision"}
            </Link>
          </>
        }
      >
        <p className="mb-5 break-all font-mono text-[12px] text-ink-mute">{dep.id}</p>
        <PhaseTimeline steps={dep.steps} selectedStepId={selectedStepId} onSelectStep={(step) => setSelectedStepId(step.id)} />
      </Card>

      {dep.status === "awaiting_approval" && (
        <Card
          prod={isProd}
          title="This deployment is waiting for you"
          subtitle={`${envName} requires approval before anything is applied. Nothing has changed yet.`}
        >
          <div className="flex gap-2">
            <Button
              onClick={() => setConfirm("approve")}
              disabled={!roleAllows(boot, approveRole)}
              disabledReason={roleReason(boot, approveRole, "Approving a deployment")}
            >
              Approve and apply
            </Button>
            <Button variant="quiet" onClick={() => setConfirm("cancel")}>
              Cancel deployment
            </Button>
          </div>
        </Card>
      )}

      {(dep.status === "failed" || dep.status === "cancelled") && (
        <Card
          title={dep.status === "failed" ? "This deployment failed" : "This deployment was cancelled"}
          subtitle={
            dep.status === "failed"
              ? "Remaining steps were skipped. The environment is between two revisions until you roll back or deploy again."
              : "Steps that had already finished stayed applied. The environment is between two revisions until you roll back or deploy again."
          }
        >
          {dep.error && <ErrorNote error={new Error(dep.error)} className="mb-3" />}
          <Button
            variant="danger"
            disabled={!dep.previousRevisionId}
            disabledReason={`This was the first deployment to ${envName} — there is no earlier revision to return to. Fix the working copy and deploy again.`}
            onClick={() => setConfirm("rollback")}
          >
            Roll {envName} back{previousNumber ? ` to r${previousNumber}` : ""}
          </Button>
        </Card>
      )}

      {/* A good deployment can still be the one you want to undo. */}
      {dep.status === "succeeded" && dep.previousRevisionId && (
        <div className="flex justify-end">
          <Button
            variant="quiet"
            size="sm"
            onClick={() => setConfirm("rollback")}
            title={`Deploy r${previousNumber ?? "?"} — what ${envName} ran before this — as a new deployment`}
          >
            Roll {envName} back to r{previousNumber ?? "?"}
          </Button>
        </div>
      )}

      {live && dep.status !== "awaiting_approval" && (
        <div className="flex justify-end">
          <Button variant="quiet" size="sm" onClick={() => setConfirm("cancel")}>
            Cancel deployment
          </Button>
        </div>
      )}

      {dep.outputs.length > 0 && (
        <Card
          title="Outputs"
          subtitle="Values returned by this deployment. Historical addresses may have changed in a later deployment; simulated outputs remain labeled."
          padded={false}
        >
          <ul>
            {dep.outputs.map((o) => (
              <OutputRow key={o.key} output={o} envSimulated={envSimulated} />
            ))}
          </ul>
        </Card>
      )}

      <div>
        <h3 className="mb-3 text-[14px] font-medium text-ink">
          Deployment log
        </h3>
        <LogViewer
          lines={lines}
          height={340}
          label={`Deployment log for r${revisionNumber ?? "?"} on ${envName}`}
          downloadName={`${envName}-r${revisionNumber ?? "x"}-deploy.log`}
          emptyMessage={
            live
              ? "Waiting for the first line — steps narrate as they run."
              : "This deployment recorded no log lines."
          }
        />
      </div>

      <ConnectedDetail open={Boolean(selectedStep)} onClose={() => setSelectedStepId(undefined)} title={selectedStep?.title ?? "Deployment step"} resourceId={selectedStep?.targetId || undefined} environment={envName} context={`r${revisionNumber ?? "?"} · deployment step`}>
        {selectedStep && <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2"><Chip>{selectedStep.phase}</Chip><Chip tone={selectedStep.status === "failed" ? "err" : selectedStep.status === "done" ? "ok" : "neutral"}>{selectedStep.status}</Chip></div>
          <dl className="divide-y divide-line text-[13px]">
            <div className="py-3"><dt className="text-ink-mute">Step identity</dt><dd className="mt-1 break-all font-mono text-ink">{selectedStep.id}</dd></div>
            {selectedStep.startedAt && <div className="py-3"><dt className="text-ink-mute">Started</dt><dd className="mt-1 text-ink"><TimeAgo iso={selectedStep.startedAt} /></dd></div>}
            {selectedStep.startedAt && selectedStep.endedAt && <div className="py-3"><dt className="text-ink-mute">Elapsed</dt><dd className="mt-1 font-mono text-ink">{fmtDuration(new Date(selectedStep.endedAt).getTime() - new Date(selectedStep.startedAt).getTime())}</dd></div>}
          </dl>
          {selectedStep.error && <ErrorNote error={new Error(selectedStep.error)} />}
          <p className="text-[13px] text-ink-mute">This record belongs to the selected deployment. Step completion describes execution; environment verification remains a separate phase.</p>
        </div>}
      </ConnectedDetail>

      <ActionConfirm
        open={confirm === "approve"}
        onClose={() => setConfirm(null)}
        actionId="deploy.approve"
        input={{ deploymentId: dep.id }}
        scope={scope}
        title="Approve this deployment"
        description={`It starts changing ${envName} immediately.`}
        confirmLabel="Approve and apply"
        onDone={onChanged}
      />
      <ActionConfirm
        open={confirm === "cancel"}
        onClose={() => setConfirm(null)}
        actionId="deploy.cancel"
        input={{ deploymentId: dep.id }}
        scope={scope}
        title="Cancel this deployment"
        confirmLabel="Cancel deployment"
        danger
        onDone={onChanged}
      />
      <ActionConfirm
        open={confirm === "rollback"}
        onClose={() => setConfirm(null)}
        actionId="deploy.rollback"
        // The revision THIS deployment replaced — not whatever the environment
        // happens to have replaced most recently.
        input={{ environmentId, toRevisionId: dep.previousRevisionId }}
        scope={scope}
        title={`Roll ${envName} back${previousNumber ? ` to r${previousNumber}` : ""}`}
        description="Runs as a normal deployment, with its own steps and logs. It restores the system definition, not data written since."
        confirmLabel="Roll back"
        danger
        typeToConfirm={isProd ? envName : undefined}
        onDone={onChanged}
      />
    </div>
  );
}
