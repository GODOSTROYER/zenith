/**
 * The job runner: a 250 ms ticker that claims queued work, runs it, and keeps
 * its lease alive while it does.
 *
 * Modelled on the deployment engine's ticker (`src/lib/engine/engine.ts`) and
 * for the same reasons: one interval on `globalThis` so a hot reload cannot
 * start a second one, `unref`'d so it never holds a test or a script open, and
 * a first line that costs one comparison when there is nothing to do.
 *
 * What is different here is that the queue is durable and shared. The ticker
 * therefore does three things before it runs anything:
 *
 *  - **reclaims expired leases**, which is the only way a job whose worker was
 *    killed ever moves again;
 *  - **checks the build slots**, because the per-app single-flight index is
 *    enforced by SQLite but the pilot-wide ceiling is not enforced by anything
 *    else;
 *  - **claims through `jobs.claim`**, which bumps the fence token every write
 *    after it is conditioned on. A worker that comes back from a long sleep
 *    finds its writes refused rather than trampling the worker that took over.
 */
import { authority, authorityOpen, nowIso } from "@/lib/hosted/authority";
import { HostedError, type HostedJob } from "@/lib/hosted/contracts";
import { log } from "@/lib/log";
import { isServerless } from "@/lib/serverless";
import { runPublish } from "./publish";
import { buildSlot } from "./build-slot";
import { runRollback } from "./rollback";
import { runResume, runSuspend } from "./suspend";
import {
  JOB_HEARTBEAT_MS,
  JOB_LEASE_MS,
  logsOf,
  renewLease,
  runOf,
  type JobRun,
} from "./shared";

/** How often the ticker looks for work. The engine's cadence, for the same reasons. */
export const JOB_TICK_MS = 250;

type RunnerGlobals = typeof globalThis & {
  __zenithJobTicker?: ReturnType<typeof setInterval>;
  /** Jobs this process is inside right now, so one tick never starts a second run. */
  __zenithJobsInflight?: Set<string>;
};

const g = (): RunnerGlobals => globalThis as RunnerGlobals;

const inflight = (): Set<string> => (g().__zenithJobsInflight ??= new Set());

/**
 * This process's lease owner name. The pid is enough to tell two workers on
 * one host apart, and a lease is only ever compared for expiry, never for
 * ownership — a reclaim is deliberately blind to who held it.
 */
export const jobOwner = (): string => `zenith-jobs-${process.pid}`;

/** Start the ticker. Idempotent; called by `ensureHosted()` on every boot path. */
export function startHostedJobRunner(): void {
  const gl = g();
  if (gl.__zenithJobTicker) return;
  gl.__zenithJobsInflight ??= new Set();
  // A serverless instance has no life between requests, so a ticker there
  // never fires; see src/lib/serverless.ts. Look for work once instead.
  if (isServerless()) {
    void tickJobs();
    return;
  }
  gl.__zenithJobTicker = setInterval(tickJobs, JOB_TICK_MS);
  // Never hold the process open just to look for jobs (tests and scripts).
  (gl.__zenithJobTicker as { unref?: () => void }).unref?.();
}

/** Stop the ticker. Jobs already in flight finish; their writes are fenced. */
export function stopHostedJobRunner(): void {
  const gl = g();
  if (!gl.__zenithJobTicker) return;
  clearInterval(gl.__zenithJobTicker);
  delete gl.__zenithJobTicker;
}

/** True while this process is ticking. */
export const hostedJobRunnerRunning = (): boolean => g().__zenithJobTicker !== undefined;

/* ---------------------------------- ticker -------------------------------- */

/**
 * One pass: reclaim what died, then start whatever there is room for.
 *
 * Synchronous by signature and asynchronous underneath, exactly like the
 * engine's tick: a job that takes five minutes must not make the interval
 * wait for it, and a job that throws must not stop the next tick.
 */
export function tickJobs(): void {
  if (!authorityOpen()) return;
  const a = authority();
  let queued: { id: string; appId: string }[];
  try {
    a.repos.jobs.reclaimExpired();
    queued = queuedJobs();
  } catch (err) {
    log.error("hosted job tick failed to read the queue", { scope: "hosted", error: err });
    return;
  }
  if (queued.length === 0) return;

  const busy = inflight();
  for (const { id, appId } of queued) {
    if (busy.has(id)) continue;
    if (!buildSlot(appId).ok) continue;
    let claimed: JobRun | null;
    try {
      claimed = claimJob(id);
    } catch (err) {
      // Single flight: another job for this app got there first. Not an error,
      // just a job that waits for the next tick.
      if (!(err instanceof HostedError && err.code === "conflict"))
        log.error("hosted job claim failed", { scope: "hosted", error: err });
      continue;
    }
    if (!claimed) continue;
    void runClaimed(claimed);
  }
}

/** Queued jobs, oldest first. */
export function queuedJobs(limit = 50): { id: string; appId: string }[] {
  const rows = authority()
    .db.prepare("SELECT id, app_id FROM hosted_jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT ?")
    .all(limit);
  return rows.map((row) => ({ id: String(row.id), appId: String(row.app_id) }));
}

/**
 * Claim one queued job for this process, if the slots allow it.
 *
 * Returns null when the job is not queued (somebody else has it, or it already
 * finished) or when no build slot is free. Throws `conflict` when the app
 * already has a running job — the single-flight index, surfaced by
 * `jobs.claim`.
 */
export function claimJob(jobId: string, leaseMs: number = JOB_LEASE_MS): JobRun | null {
  const a = authority();
  const job = a.repos.jobs.get(jobId);
  if (!job || job.status !== "queued") return null;
  if (!buildSlot(job.appId).ok) return null;
  const claimed = a.repos.jobs.claim(jobId, jobOwner(), leaseMs);
  return claimed ? runOf(claimed.job, claimed.fence) : null;
}

/* --------------------------------- running -------------------------------- */

/** Dispatch one claimed job to the pipeline its kind names. */
export async function runClaimedJob(run: JobRun): Promise<void> {
  switch (run.job.kind) {
    case "publish":
      return runPublish(run);
    case "rollback":
      return runRollback(run);
    case "suspend":
      return runSuspend(run);
    case "resume":
      return runResume(run);
    default:
      // `export` and `restore` belong to W8; a worker that does not know a
      // kind must not silently succeed at it.
      authority().repos.jobs.fail(
        run.job.id,
        run.fence,
        `This build has no runner for ${run.job.kind} jobs, so nothing was done.`
      );
      return;
  }
}

/** Run a claimed job with a lease heartbeat under it, then release the slot. */
async function runClaimed(run: JobRun): Promise<void> {
  const busy = inflight();
  busy.add(run.job.id);
  const heartbeat = setInterval(() => {
    try {
      renewLease(run);
    } catch {
      /* the next fenced write will refuse anyway */
    }
  }, JOB_HEARTBEAT_MS);
  (heartbeat as { unref?: () => void }).unref?.();
  try {
    await runClaimedJob(run);
  } catch (err) {
    // Every pipeline records its own failure; reaching here means the failure
    // recording itself failed, which is a bug rather than an outcome.
    log.error("hosted job crashed outside its pipeline", {
      scope: "hosted",
      error: err,
      jobId: run.job.id,
    });
  } finally {
    clearInterval(heartbeat);
    busy.delete(run.job.id);
  }
}

/**
 * Claim and run one job to completion, awaited.
 *
 * The synchronous door into the same machine the ticker drives, so a test — or
 * a script draining a queue — can assert on the finished job rather than
 * polling for it. Returns the job as it stands afterwards.
 */
export async function runJobOnce(jobId: string, opts: { leaseMs?: number } = {}): Promise<HostedJob> {
  const a = authority();
  const run = claimJob(jobId, opts.leaseMs ?? JOB_LEASE_MS);
  if (!run) {
    const job = a.repos.jobs.get(jobId);
    if (!job)
      throw new HostedError("not_found", `No job ${jobId} exists.`, {
        fix: "Check the job id from the publish response.",
      });
    throw new HostedError("conflict", `Job ${jobId} is ${job.status}, so it cannot be claimed.`, {
      fix: "Only a queued job can be run. Reclaim expired leases first if a previous worker died holding it.",
      details: { jobId, status: job.status },
    });
  }
  const busy = inflight();
  busy.add(jobId);
  try {
    await runClaimedJob(run);
  } finally {
    busy.delete(jobId);
  }
  const finished = a.repos.jobs.get(jobId);
  if (!finished)
    throw new HostedError("internal", `Job ${jobId} vanished while it was running.`, {
      fix: "This is a bug: a running job's row was deleted. Check the control database.",
    });
  return finished;
}

/** A job's bounded, redacted log lines, oldest first. */
export function jobLogs(jobId: string): string[] {
  const job = authority().repos.jobs.get(jobId);
  if (!job) return [];
  return logsOf(job);
}

/**
 * Put every job whose lease has passed back on the queue, and say how many
 * moved. `now` is for tests, which cannot wait a minute for a lease to expire.
 */
export const reclaimExpiredJobs = (now: string = nowIso()): number =>
  authority().repos.jobs.reclaimExpired(now);
