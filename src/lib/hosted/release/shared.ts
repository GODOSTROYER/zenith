/**
 * The plumbing every job kind in this directory shares: the phase step, the
 * lease, the bounded log, and the two refusals a worker owes its caller.
 *
 * Two rules are enforced here rather than in each pipeline, because a pipeline
 * that forgets either is the bug that loses a healthy app:
 *
 *  - **Every phase writes before it acts.** `advanceTo` records the phase and
 *    its `phaseData` and only then does the pipeline perform the side effect,
 *    so a crash resumes at the step that was in flight rather than at the step
 *    before it.
 *  - **A worker that lost its lease stops silently.** `jobs.advance` answers
 *    `false` when the fence token moved on, which means another worker claimed
 *    this job while we were asleep. Continuing would have two workers staging
 *    the same release, so `advanceTo` throws `LeaseLost`, `runJob` swallows it,
 *    and the job belongs to whoever holds it now. Silence is the correct
 *    behaviour: the new owner will report the outcome.
 *
 * Workstream W7 (hosted R3).
 */
import path from "node:path";
import { authority, nowIso } from "@/lib/hosted/authority";
import { HostedError, type HostedApp, type HostedJob } from "@/lib/hosted/contracts";
import { env } from "@/lib/env";
import { releaseDeps } from "./deps";
import type { RecordEventInput } from "@/lib/hosted/events";

/** A claimed job and the fence token its claimant holds. Every write is conditioned on it. */
export interface JobRun {
  job: HostedJob;
  fence: number;
  /** The phase this worker last recorded; `advanceTo` keeps it current. */
  phase: string;
}

/** Wrap a freshly claimed job so the pipeline can track where it is. */
export const runOf = (job: HostedJob, fence: number): JobRun => ({ job, fence, phase: job.phase });

/** Durable per-phase state. Keys are namespaced by what wrote them, never by the caller. */
export type PhaseData = Record<string, unknown>;

/** How long one claim owns a job before another worker may reclaim it. */
export const JOB_LEASE_MS = 60_000;

/** How often a running job pushes its lease forward. Comfortably inside the lease. */
export const JOB_HEARTBEAT_MS = 15_000;

/** The most log lines a job keeps. Older lines are dropped from the front. */
export const JOB_LOG_LINES = 200;

/**
 * Thrown when a durable write was refused because the fence token moved. Never
 * surfaced to a caller: it means "this job is somebody else's now".
 */
export class LeaseLost extends Error {
  constructor(readonly jobId: string) {
    super(`Job ${jobId} was re-claimed by another worker, so this one stopped without writing.`);
    this.name = "LeaseLost";
  }
}

/* --------------------------------- records -------------------------------- */

/** The app a job is about. Throws `not_found` when it has been deleted under us. */
export function requireApp(appId: string): HostedApp {
  const app = authority().repos.apps.get(appId);
  if (!app)
    throw new HostedError("not_found", `No hosted app ${appId} exists.`, {
      fix: "Check the app id in the URL, or list the workspace's apps with GET /api/hosted/apps.",
    });
  return app;
}

/** The app a job is about, refused when it belongs to a different workspace. */
export function requireAppIn(appId: string, workspaceId: string): HostedApp {
  const app = requireApp(appId);
  // A foreign id answers exactly as a missing one: knowing an id must not be
  // enough to learn that it exists in someone else's workspace.
  if (app.workspaceId !== workspaceId)
    throw new HostedError("not_found", `No hosted app ${appId} exists.`, {
      fix: "Check the app id in the URL, or list this workspace's apps with GET /api/hosted/apps.",
    });
  return app;
}

/** Scratch directory for one job: the submitted source and the tree it is expanded into. */
export const jobDir = (jobId: string): string => path.join(env().ORRERY_DATA, "jobs", jobId);

/** Where a submitted tarball is persisted so a restart can resume without the request body. */
export const jobSourcePath = (jobId: string): string => path.join(jobDir(jobId), "source.tgz");

/** Where a validated source is materialized for the build runner. */
export const jobWorkPath = (jobId: string): string => path.join(jobDir(jobId), "src");

/* ---------------------------------- phases -------------------------------- */

/** A job's durable phase state, copied so a pipeline can mutate it freely. */
export const phaseDataOf = (job: HostedJob): PhaseData => ({ ...job.phaseData });

/**
 * Write the phase data a job is admitted with.
 *
 * `admitJob` takes no `phaseData` and a queued job has no fence to advance
 * against, so what admission learned — which release a rollback names, where a
 * tarball was stored — is written straight to the row. Inside `tx()`, so it is
 * durable before the caller is told the job exists.
 *
 * ponytail: raw SQL for one column. Move to `admitJob({ …, phaseData })` if
 * W1 adds the argument.
 */
export function seedPhaseData(jobId: string, seed: PhaseData): void {
  authority().tx((db) => {
    db.prepare("UPDATE hosted_jobs SET phase_data = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(seed),
      nowIso(),
      jobId
    );
  });
}

/**
 * Record the phase this worker is about to enter, with everything it has
 * learned so far. Throws `LeaseLost` when the fence moved.
 */
export function advanceTo(run: JobRun, phase: string, data: PhaseData): void {
  // The trail of phases this job has entered, in order. It costs one short
  // string per step and it is the difference between "the job failed" and
  // "the job failed at probe, having got as far as stage".
  const trail = Array.isArray(data.phases) ? (data.phases as string[]) : [];
  if (trail[trail.length - 1] !== phase) trail.push(phase);
  data.phases = trail;
  if (!authority().repos.jobs.advance(run.job.id, run.fence, phase, data)) throw new LeaseLost(run.job.id);
  run.phase = phase;
}

/** Persist what the current phase produced without moving to the next one. */
export function persist(run: JobRun, data: PhaseData): void {
  advanceTo(run, run.phase, data);
}

/**
 * Push this claim's lease forward.
 *
 * `JobsRepo.advance` deliberately does not touch `lease_until` — it records
 * progress, not liveness — and a five-minute build inside a sixty-second lease
 * would otherwise be reclaimed halfway through and rebuilt by the next worker.
 * The statement is conditioned on the same fence every other write is, so a
 * worker that already lost the job cannot extend a lease it no longer holds.
 *
 * ponytail: raw SQL because the repository has no lease renewal yet. Move this
 * to `repos.jobs.renewLease(id, fence, leaseMs)` when W1 adds one.
 */
export function renewLease(run: JobRun, leaseMs: number = JOB_LEASE_MS): boolean {
  const now = nowIso();
  const result = authority()
    .db.prepare(
      "UPDATE hosted_jobs SET lease_until = ?, updated_at = ? WHERE id = ? AND fence_token = ? AND status = 'running'"
    )
    .run(nowIso(Date.parse(now) + leaseMs), now, run.job.id, run.fence);
  return Number(result.changes) === 1;
}

/* ----------------------------------- logs --------------------------------- */

/** Variable names whose value is probably a credential, whatever produced the line. */
const SECRET_ASSIGNMENT = /\b([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*\S+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** Provider key shapes that are recognisable on their own (OpenAI, Supabase, GitHub, …). */
const KEY_SHAPES = /\b(sk|pk|ghp|gho|ghs|github_pat|sb|e2b)[-_][A-Za-z0-9._-]{12,}/gi;

/**
 * One log line, with anything that looks like a credential replaced.
 *
 * Build logs are shown to an app owner and quoted into support threads, and a
 * runner's environment dump is exactly the kind of line that carries a token
 * nobody meant to publish. Redaction here is a net, not a proof: the real
 * guarantee is that no platform secret reaches a build at all (W2's clean
 * child environment). This is the second line of defence.
 */
export function redactLine(line: string): string {
  return line
    .replace(SECRET_ASSIGNMENT, (_match, name: string) => `${name}=•••`)
    .replace(BEARER, "Bearer •••")
    .replace(KEY_SHAPES, (match) => `${match.slice(0, 4)}•••`);
}

/** Append one line to a job's bounded, redacted log. Oldest lines fall off the front. */
export function appendLog(data: PhaseData, line: string): void {
  const lines = Array.isArray(data.logs) ? (data.logs as string[]) : [];
  lines.push(`${nowIso()} ${redactLine(line)}`);
  data.logs = lines.slice(-JOB_LOG_LINES);
}

/** Every line a job has kept, oldest first. */
export function logsOf(job: HostedJob): string[] {
  const lines = job.phaseData.logs;
  if (!Array.isArray(lines)) return [];
  return lines.filter((line): line is string => typeof line === "string").slice(-JOB_LOG_LINES);
}

/* ---------------------------------- events -------------------------------- */

/**
 * Record an analytics event. Never throws into a pipeline: a metric that could
 * fail a publish would be a worse bargain than no metric at all.
 */
export function emit(input: RecordEventInput): void {
  try {
    releaseDeps.recordEvent(input);
  } catch {
    /* the operation is what matters; the event log is best effort */
  }
}

/* -------------------------------- outcomes -------------------------------- */

/** The message a caller should see for any thrown value, with its fix when it has one. */
export function reasonOf(err: unknown): string {
  if (err instanceof HostedError) return err.fix ? `${err.message} ${err.fix}` : err.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Fail a job, keeping the log. Returns false when the fence had already moved,
 * in which case the new owner reports the outcome instead.
 */
export function failJob(run: JobRun, data: PhaseData, message: string): boolean {
  appendLog(data, `failed: ${message}`);
  // The log is part of the failure, so write it before the status: `fail`
  // clears the lease and a later `advance` would be refused.
  authority().repos.jobs.advance(run.job.id, run.fence, run.phase, data);
  return authority().repos.jobs.fail(run.job.id, run.fence, message);
}
