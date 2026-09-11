/**
 * Publish: source → build → artifact → verified release → activation, as a
 * durable job that can be interrupted at any point and resumed by a different
 * process without doing anything twice.
 *
 * The property this file exists to hold is narrow and absolute: **an app that
 * is serving a healthy release keeps serving it unless a candidate has been
 * built, stored, re-verified over its own bytes and probed.** Every phase
 * before `activate` therefore writes only to its own records — a job row, an
 * artifact, a candidate release — and the app's `activeReleaseId` is touched in
 * exactly one place, by exactly one statement: a compare-and-swap on the fence
 * the claimant holds. A worker that was asleep while somebody else published
 * loses that swap and fails its own job rather than replacing a newer release
 * with an older one.
 *
 * The phase order is `intake → build → artifact → verify_artifact → stage →
 * probe → activate → cleanup`, and it lives in `PUBLISH_PHASES` below; what
 * each phase *does* lives one file each under `phases/`, behind
 * `PUBLISH_PHASE_HANDLERS`. This file owns admission, the build ceiling, and
 * the loop that drives the map. Each phase records itself *before* its side
 * effect, so a crash resumes at the step that was in flight; each phase skips
 * itself when its output is already recorded, so resuming does not rebuild
 * what a previous attempt already produced. `finish` is not a phase — it is
 * the job's terminal write.
 *
 * Workstream W7 (hosted R3).
 */
import fs from "node:fs";
import path from "node:path";
import { authority, admitJob, nowIso } from "@/lib/hosted/authority";
import {
  HostedError,
  type HostedApp,
  type HostedJob,
  type Subject,
} from "@/lib/hosted/contracts";
import { releaseDeps } from "./deps";
import { publishIntent, type PublishSource } from "./intent";
import { PUBLISH_PHASE_HANDLERS } from "./phases";
import {
  advanceTo,
  appendLog,
  emit,
  failJob,
  jobSourcePath,
  persist,
  phaseDataOf,
  reasonOf,
  requireApp,
  requireAppIn,
  seedPhaseData,
  type JobRun,
  type PhaseData,
} from "./shared";

/** The publish phases, in the order they run. `queued` enters at the first one. */
export const PUBLISH_PHASES = [
  "intake",
  "build",
  "artifact",
  "verify_artifact",
  "stage",
  "probe",
  "activate",
  "cleanup",
] as const;

export type PublishPhase = (typeof PUBLISH_PHASES)[number];

/** What admitting a publish needs. `jobId` is the client's UUID and the idempotency key. */
export interface AdmitPublishInput {
  jobId: string;
  appId: string;
  workspaceId: string;
  actor: Subject;
  source: PublishSource;
}

/* -------------------------------- admission ------------------------------- */

/**
 * Admit a publish, or return the job this id already names.
 *
 * The submitted tarball is written to `<ORRERY_DATA>/jobs/<jobId>/source.tgz`
 * before this returns, so the request body is never the only copy: a restart
 * between the 202 and the first build resumes from disk rather than asking the
 * builder to upload again. The bytes are written *after* admission rather than
 * before it, so a second request re-using a job id with different content is
 * refused with `idempotency_conflict` without having overwritten the source
 * the original job is still using.
 */
export async function admitPublish(
  input: AdmitPublishInput
): Promise<{ job: HostedJob; created: boolean }> {
  const app = requireAppIn(input.appId, input.workspaceId);
  assertPublishable(app);

  const paused = releaseDeps.buildsPaused(input.workspaceId);
  if (paused.paused)
    throw new HostedError(
      "conflict",
      paused.reason ??
        "Builds are paused for this workspace because spending reached 90 % of the approved envelope.",
      {
        fix: "Raise ZENITH_SPEND_ENVELOPE_USD after agreeing a new envelope, or wait for the next billing period. Running apps keep serving either way.",
        details: { workspaceId: input.workspaceId },
      }
    );

  const intent = publishIntent({
    appId: input.appId,
    workspaceId: input.workspaceId,
    actor: input.actor,
    source: input.source,
  });

  const admitted = admitJob({
    id: input.jobId,
    kind: "publish",
    workspaceId: input.workspaceId,
    appId: input.appId,
    actor: input.actor,
    intent: intent.intent,
  });
  if (!admitted.created) return admitted;

  const seed: PhaseData = {
    source:
      input.source.kind === "fixture"
        ? { kind: "fixture", name: input.source.name }
        : {
            kind: "tarball",
            sha256: intent.tarball?.sha256,
            // Display only, and not part of the intent: see `PublishSource`.
            filename: input.source.filename ?? null,
          },
    logs: [`${nowIso()} admitted publish job ${input.jobId} for app ${app.slug}`],
  };

  try {
    if (intent.tarball) {
      const target = jobSourcePath(input.jobId);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, intent.tarball.bytes);
      seed.sourcePath = target;
      seed.sourceSha256 = intent.tarball.sha256;
    }
  } catch (err) {
    // A job whose source was never written cannot run, and leaving it queued
    // would have a worker discover that minutes later. Cancel it here, where
    // the caller is still listening.
    authority().repos.jobs.cancel(
      input.jobId,
      `The submitted source could not be stored: ${reasonOf(err)}`
    );
    throw new HostedError("internal", "The submitted source could not be written to disk, so this publish was not queued.", {
      fix: "Check free space and permissions on ORRERY_DATA, then publish again. Nothing about the app was changed.",
      details: { jobId: input.jobId },
    });
  }

  seedPhaseData(input.jobId, seed);

  emit({
    event: "source.accepted",
    workspaceId: input.workspaceId,
    appId: input.appId,
    subject: input.actor,
    outcome: "ok",
    logicalId: input.jobId,
    props: { source: input.source.kind },
  });

  return { job: authority().repos.jobs.get(input.jobId) ?? admitted.job, created: true };
}

/** An app that is not `active` refuses work rather than queueing it for later. */
export function assertPublishable(app: HostedApp): void {
  if (app.state === "active") return;
  if (app.state === "suspended")
    throw new HostedError("suspended", `${app.name} is suspended, so it does not accept new releases.`, {
      fix: "Resume the app first (POST /api/hosted/apps/<id>/resume). Its data, grants and artifacts were kept.",
      details: { appId: app.id, state: app.state, reason: app.stateReason },
    });
  throw new HostedError("recovering", `${app.name} is ${app.state}, so it does not accept new releases.`, {
    fix: "Wait for the app to return to the active state, then publish again.",
    details: { appId: app.id, state: app.state, reason: app.stateReason },
  });
}

/* --------------------------------- pipeline ------------------------------- */

/**
 * Run a claimed publish job from wherever it is to wherever it can get.
 *
 * Never throws for an operational failure: a build that did not run, a probe
 * that did not pass and a fence that moved are all recorded on the job and on
 * the candidate release. It returns early and silently when the lease was lost,
 * because the worker that took the job over is the one that owes an answer.
 */
export async function runPublish(run: JobRun): Promise<void> {
  const data = phaseDataOf(run.job);
  const a = authority();
  let releaseId = typeof data.releaseId === "string" ? data.releaseId : undefined;

  try {
    const app = requireApp(run.job.appId);
    assertPublishable(app);

    for (const phase of resumeFrom(run.job, data)) {
      advanceTo(run, phase, data);
      // Only `stage` answers with anything: the id of the candidate release it
      // recorded, which the terminal write below reports.
      const produced = await PUBLISH_PHASE_HANDLERS[phase](run, data);
      if (typeof produced === "string") releaseId = produced;
      persist(run, data);
    }

    appendLog(data, `published release ${String(data.releaseNumber ?? "?")} (${String(releaseId)})`);
    advanceTo(run, "finish", data);
    a.repos.jobs.finish(run.job.id, run.fence, {
      releaseId,
      releaseNumber: data.releaseNumber,
      artifactDigest: data.artifactDigest,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "LeaseLost") return;
    const message = reasonOf(err);
    // The candidate is the only release this job may mark: the active one is
    // somebody else's release and stays exactly as it was.
    const candidateId = typeof data.releaseId === "string" ? data.releaseId : releaseId;
    if (candidateId) {
      const release = a.repos.releases.get(candidateId);
      if (release && release.status !== "active")
        a.repos.releases.setStatus(candidateId, "failed", { error: message });
    }
    failJob(run, data, message);
  }
}

/** The phases still to run, given what the job has already recorded. */
function resumeFrom(job: HostedJob, data: PhaseData): PublishPhase[] {
  const recorded = PUBLISH_PHASES.indexOf(job.phase as PublishPhase);
  let start = recorded < 0 ? 0 : recorded;
  // A resumed job past the build with no artifact to show for it never got
  // one: its output directory was scratch space that a restart removed. Go
  // back to intake rather than trying to store bytes that are not there.
  if (!data.artifactDigest && start > PUBLISH_PHASES.indexOf("build")) start = 0;
  return PUBLISH_PHASES.slice(start) as PublishPhase[];
}
