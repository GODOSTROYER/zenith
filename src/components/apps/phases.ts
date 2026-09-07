/**
 * What a publish is doing, and how far it got. The phase ids are the release
 * workstream's (`intake → build → artifact → verify_artifact → stage → probe →
 * activate → cleanup`); the labels are what a builder reads.
 *
 * Pure — the job panel and its test share these without rendering anything.
 *
 * Workstream W9 (hosted R3)
 */
import type { HostedJob, JobStatus } from "@/lib/hosted/contracts/types";

export interface PublishPhase {
  id: string;
  label: string;
  /** what actually happens in this phase, one line */
  detail: string;
}

export const PUBLISH_PHASES: readonly PublishPhase[] = [
  { id: "intake", label: "Check the source", detail: "Unpack the archive and check it against the supported source rules." },
  { id: "build", label: "Build", detail: "Run the platform's pinned React + Vite recipe over your files." },
  { id: "artifact", label: "Store the files", detail: "Store the built files under their content hash, so the same bytes are always the same release." },
  { id: "verify_artifact", label: "Verify the files", detail: "Re-hash the stored bytes and compare them with what the build produced." },
  { id: "stage", label: "Stage the release", detail: "Register the new release without touching the one that is live." },
  { id: "probe", label: "Health checks", detail: "Load the app and run a data round trip against a throwaway test database." },
  { id: "activate", label: "Activate", detail: "Point the private URL at the new release." },
  { id: "cleanup", label: "Clean up", detail: "Remove the staging resources this publish no longer needs." },
] as const;

export type PhaseState = "done" | "current" | "pending" | "failed";

export interface PhaseRow extends PublishPhase {
  state: PhaseState;
}

/** Plain sentence for the state of the job as a whole. */
export const JOB_STATUS_TEXT: Record<JobStatus, string> = {
  queued: "Queued — waiting for a build slot.",
  running: "Running.",
  succeeded: "Published.",
  failed: "This publish failed. Nothing changed: the release that was live is still live.",
  cancelled: "This publish was cancelled. Nothing changed.",
};

/**
 * Every phase with where the job actually is. A job whose phase name is not one
 * of ours (a queued job with no phase yet, a future phase) leaves every row
 * pending rather than guessing which one is running.
 */
export function publishPhaseRows(job: Pick<HostedJob, "phase" | "status">): PhaseRow[] {
  const at = PUBLISH_PHASES.findIndex((p) => p.id === job.phase);
  return PUBLISH_PHASES.map((phase, i) => {
    if (job.status === "succeeded") return { ...phase, state: "done" as const };
    if (at < 0) return { ...phase, state: "pending" as const };
    if (i < at) return { ...phase, state: "done" as const };
    if (i > at) return { ...phase, state: "pending" as const };
    if (job.status === "failed") return { ...phase, state: "failed" as const };
    if (job.status === "running") return { ...phase, state: "current" as const };
    return { ...phase, state: "pending" as const };
  });
}

/** A rejected source writes one `source rejected: <reason>` line per problem. */
const REJECTION = /^source rejected:\s*(.+)$/;

/**
 * Everything the server said was wrong, so a builder fixes it all at once.
 *
 * The release runner records a rejected source as one log line per reason and
 * puts the summary in `job.error`; a job result may also carry them under
 * `details.reasons`. Both are read, in that order, and duplicates are dropped.
 */
export function jobFailureReasons(job: Pick<HostedJob, "result">, logs: string[] = []): string[] {
  const result = job.result as
    | { reasons?: unknown; details?: { reasons?: unknown } | null }
    | undefined
    | null;
  const carried = result?.details?.reasons ?? result?.reasons;
  const reasons = Array.isArray(carried)
    ? carried.filter((r): r is string => typeof r === "string")
    : [];
  for (const raw of logs) {
    const match = REJECTION.exec(parseJobLogLine(raw).line.trim());
    if (match) reasons.push(match[1]);
  }
  return [...new Set(reasons)];
}

/** Lines are stored as `<iso> <text>`; the gutter shows the time, not the prose. */
const LOG_LINE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+([\s\S]*)$/;

export function parseJobLogLine(raw: string): { ts?: string; line: string } {
  const match = LOG_LINE.exec(raw);
  return match ? { ts: match[1], line: match[2] } : { line: raw };
}

/** How long the job has been going, or how long it took once it settled. */
export function jobElapsedMs(
  job: Pick<HostedJob, "createdAt" | "finishedAt">,
  now: number = Date.now()
): number {
  const started = new Date(job.createdAt).getTime();
  if (Number.isNaN(started)) return 0;
  const ended = job.finishedAt ? new Date(job.finishedAt).getTime() : now;
  return Math.max(0, (Number.isNaN(ended) ? now : ended) - started);
}
