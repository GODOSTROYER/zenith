"use client";
/**
 * A publish while it is happening: which phase the server is in, how long it
 * has been going, what it wrote, and — only once the server says `succeeded` —
 * the address the app now answers on.
 *
 * Nothing here is optimistic. The panel polls the job and reports the phase the
 * authority recorded; a failure shows every reason at once so a builder fixes
 * them in one pass, and Retry replays the same job id, which is what makes it
 * safe to press twice.
 *
 * Workstream W9 (hosted R3)
 */
import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink, RotateCcw, X } from "lucide-react";
import { cx, fmtDuration } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { LogViewer, type LogLine } from "@/components/ui/log-viewer";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { ErrorNote } from "@/components/screens/shared";
import { isTerminalJob, useHostedJob } from "@/lib/client/hosted";
import type { Release } from "@/lib/hosted/contracts";
import {
  JOB_STATUS_TEXT,
  jobElapsedMs,
  jobFailureReasons,
  parseJobLogLine,
  publishPhaseRows,
  type PhaseState,
} from "./phases";

export interface JobProgressProps {
  appId: string;
  jobId: string;
  appName: string;
  /** the private URL, for the moment the app goes live */
  url: string;
  /** what the API says is live now — read after the job settled, never guessed */
  activeRelease: Release | null;
  /** re-read the app once the job settles */
  onSettled?: () => void;
  /** same job id: the server resumes the publish it already has */
  onRetry: () => void;
  /** a new job id: a different publish */
  onPublishAgain: () => void;
  retrying?: boolean;
  onOpen: () => void;
  opening?: boolean;
}

const MARK: Record<PhaseState, string> = {
  done: "Done",
  current: "Running",
  pending: "Waiting",
  failed: "Failed",
};

function PhaseMark({ state }: { state: PhaseState }) {
  if (state === "done")
    return <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" aria-hidden="true" />;
  if (state === "failed")
    return <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-err" aria-hidden="true" />;
  if (state === "current") return <StatusDot status="running" className="mt-1" />;
  return (
    <span
      aria-hidden="true"
      className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-ink-faint"
    />
  );
}

export function JobProgress({
  appId,
  jobId,
  appName,
  url,
  activeRelease,
  onSettled,
  onRetry,
  onPublishAgain,
  retrying = false,
  onOpen,
  opening = false,
}: JobProgressProps) {
  const { data, error, loading } = useHostedJob(appId, jobId);
  const job = data?.job;
  const settled = job ? isTerminalJob(job.status) : false;

  // A ticking clock only while something is running; a finished job's duration
  // is fixed and re-rendering it every second would be noise.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (settled || !job) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [settled, job]);

  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (!job || !isTerminalJob(job.status)) return;
    if (announced.current === job.id + job.status) return;
    announced.current = job.id + job.status;
    onSettled?.();
  }, [job, onSettled]);

  if (loading && !job && !error)
    return (
      <Card title="Publishing" subtitle="Waiting for the server to report the first phase.">
        <div className="space-y-2">
          <Skeleton height={14} width="45%" />
          <Skeleton height={12} />
          <Skeleton height={12} width="80%" />
          <Skeleton height={120} />
        </div>
      </Card>
    );

  if (error && !job)
    return (
      <Card title="Publishing">
        <ErrorNote error={error} />
      </Card>
    );

  if (!job) return null;

  const rows = publishPhaseRows(job);
  const reasons = jobFailureReasons(job, data?.logs ?? []);
  const elapsed = fmtDuration(jobElapsedMs(job));
  // Every line here was written by Zenith's own job runner, so the viewer's
  // "Zenith" lane is the honest one to put them in.
  const logs: LogLine[] = (data?.logs ?? []).map((raw) => ({
    ...parseJobLogLine(raw),
    stream: "info" as const,
  }));

  return (
    <Card
      title={job.status === "succeeded" ? `${appName} is live` : `Publishing ${appName}`}
      subtitle={JOB_STATUS_TEXT[job.status]}
      actions={
        <span className="tnum text-[12.5px] text-ink-mute">
          {settled ? `Took ${elapsed}` : `Running for ${elapsed}`}
        </span>
      }
    >
      <div className="space-y-5">
        <ol className="space-y-2" aria-label="Publish phases">
          {rows.map((row) => (
            <li key={row.id} className="flex gap-2.5">
              <PhaseMark state={row.state} />
              <div className="min-w-0">
                <p
                  className={cx(
                    "text-[13px]",
                    row.state === "pending"
                      ? "text-ink-faint"
                      : row.state === "failed"
                        ? "text-err"
                        : "text-ink"
                  )}
                >
                  {row.label}
                  <span className="sr-only"> — {MARK[row.state]}</span>
                </p>
                {(row.state === "current" || row.state === "failed") && (
                  <p className="mt-0.5 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-mute">
                    {row.detail}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>

        {job.status === "failed" && (
          <Callout tone="err" title="This publish failed">
            <p>{job.error ?? "The server did not say what went wrong."}</p>
            {reasons.length > 0 && (
              <ul className="mt-2 space-y-1 border-l border-err/30 pl-3">
                {reasons.map((reason, i) => (
                  <li key={i}>{reason}</li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-ink-mute">
              Nothing changed. Whatever was live before this publish is still live.
            </p>
          </Callout>
        )}

        {job.status === "succeeded" && (
          <Callout tone="ok" title={activeRelease ? `Release ${activeRelease.number} is live` : "Published"}>
            <p>Everyone you have invited can open it at this address.</p>
            <p className="mt-1.5 font-mono text-[12.5px] break-all text-ink">{url}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                busy={opening}
                onClick={onOpen}
                icon={<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />}
              >
                Open app
              </Button>
              <CopyButton value={url} variant="quiet" label="Copy address" what="the app address" />
            </div>
          </Callout>
        )}

        <LogViewer
          lines={logs}
          label={`publish log for ${appName}`}
          height={220}
          emptyMessage="No output yet. Lines appear as the build writes them."
          downloadName={`${appName.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}-publish.log`}
        />

        {settled && (
          <div className="flex flex-wrap items-center gap-2">
            {job.status !== "succeeded" && (
              <Button
                variant="primary"
                size="sm"
                busy={retrying}
                onClick={onRetry}
                icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />}
              >
                Retry
              </Button>
            )}
            <Button variant="quiet" size="sm" onClick={onPublishAgain}>
              Publish again
            </Button>
            {job.status !== "succeeded" && (
              <span className="text-[12.5px] text-ink-mute">
                Retry sends the same publish again, so it can never start a second one. Publish again
                starts a new one.
              </span>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
