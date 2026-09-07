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
 * probe → activate → cleanup`. Each phase records itself *before* its side
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
import { verifyForRelease } from "@/lib/hosted/artifacts";
import { NO_RUNNER_REASON } from "@/lib/hosted/build";
import {
  DEFAULT_LIMITS,
  HostedError,
  RECIPE_V1,
  type ArtifactProvenance,
  type BuildRunnerId,
  type CandidateProbeResult,
  type HostedApp,
  type HostedJob,
  type Release,
  type RuntimeCandidateRef,
  type Subject,
  type ValidatedSource,
} from "@/lib/hosted/contracts";
import { materializeSource, removeMaterialized, validateSource } from "@/lib/hosted/source";
import { retainedReleases } from "./apps";
import { releaseDeps } from "./deps";
import { fixtureDirectory, publishIntent, type PublishSource } from "./intent";
import {
  LeaseLost,
  advanceTo,
  appendLog,
  emit,
  failJob,
  jobDir,
  jobSourcePath,
  jobWorkPath,
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

/* ------------------------------- build slots ------------------------------ */

/**
 * Whether another build may start right now.
 *
 * Two ceilings, both read from the authority rather than from a counter in
 * this process: one build per app (which the `hosted_jobs` single-flight index
 * enforces on its own) and `buildsPilotWide` across the install, which nothing
 * else enforces and which is the whole reason a third app's publish waits in
 * the queue instead of racing two others for the same CPU.
 */
export function buildSlot(appId: string, jobId?: string): { ok: boolean; reason?: string } {
  const jobs = authority().repos.jobs;
  const running = jobs.runningFor(appId);
  if (running && running.id !== jobId)
    return {
      ok: false,
      reason: `${appId} already has job ${running.id} running (${running.phase}); hosted apps run ${DEFAULT_LIMITS.buildsPerApp} operation at a time.`,
    };
  // A job that already holds the slot it is asking about counts itself, so the
  // running total is compared with `>` when it does and `>=` when it does not.
  const count = jobs.countRunning();
  const held = jobId && running?.id === jobId ? 1 : 0;
  if (count - held >= DEFAULT_LIMITS.buildsPilotWide)
    return {
      ok: false,
      reason: `${count} builds are already running and this install allows ${DEFAULT_LIMITS.buildsPilotWide} at a time.`,
    };
  return { ok: true };
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
      switch (phase) {
        case "intake":
          await intake(run, data);
          break;
        case "build":
          await build(run, data);
          break;
        case "artifact":
          await storeArtifact(run, data);
          break;
        case "verify_artifact":
          await verifyArtifact(run, data);
          break;
        case "stage":
          releaseId = await stage(run, data);
          break;
        case "probe":
          await probe(run, data);
          break;
        case "activate":
          await activate(run, data);
          break;
        case "cleanup":
          await cleanup(run, data);
          break;
      }
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

/* ---------------------------------- phases -------------------------------- */

/** Validate the submitted source and write it into the job's work directory. */
async function intake(run: JobRun, data: PhaseData): Promise<void> {
  const source = readSource(run.job, data);
  let validated: ValidatedSource;
  try {
    validated = validateSource(source);
  } catch (err) {
    emit({
      event: "source.rejected",
      workspaceId: run.job.workspaceId,
      appId: run.job.appId,
      subject: run.job.actor,
      outcome: "denied",
      logicalId: run.job.id,
    });
    const reasons = err instanceof HostedError ? (err.details?.reasons as string[] | undefined) : undefined;
    for (const reason of reasons ?? []) appendLog(data, `source rejected: ${reason}`);
    throw err;
  }

  const work = jobWorkPath(run.job.id);
  removeMaterialized(work);
  materializeSource(validated, work);

  data.sourceDigest = validated.digest;
  data.sourceKind = validated.kind;
  data.sourceFiles = validated.files.length;
  data.sourceBytes = validated.totalBytes;
  data.materializedDir = work;
  data.appName = validated.manifest.name;
  appendLog(
    data,
    `intake accepted ${validated.files.length} files (${validated.totalBytes} bytes), source ${validated.digest.slice(0, 12)}`
  );
  await Promise.resolve();
}

/** Compile the materialized source with the runner this install selected. */
async function build(run: JobRun, data: PhaseData): Promise<void> {
  if (typeof data.artifactDigest === "string") {
    appendLog(data, `build skipped: artifact ${data.artifactDigest.slice(0, 12)} was already produced`);
    return;
  }

  const slot = buildSlot(run.job.appId, run.job.id);
  if (!slot.ok)
    throw new HostedError("conflict", slot.reason ?? "No build slot is free.", {
      fix: "Wait for the running build to finish and publish again; this install runs a bounded number of builds at once.",
    });

  const runner = releaseDeps.buildRunner();
  if (!runner)
    throw new HostedError("runtime_unavailable", "No build runner is configured, so nothing was built.", {
      fix: NO_RUNNER_REASON,
    });

  const availability = await runner.availability();
  if (!availability.available)
    throw new HostedError(
      "runtime_unavailable",
      `The ${runner.label} build runner cannot run here: ${availability.reason ?? "it reported itself unavailable."}`,
      { fix: availability.fix ?? NO_RUNNER_REASON }
    );

  const validated = validateSource({ kind: "directory", path: jobWorkPath(run.job.id) });
  if (validated.digest !== data.sourceDigest)
    throw new HostedError(
      "internal",
      "The materialized source no longer hashes to the digest intake recorded, so it was not built.",
      { fix: "Publish again. The job's work directory was modified after intake accepted it." }
    );

  emit({
    event: "build.started",
    workspaceId: run.job.workspaceId,
    appId: run.job.appId,
    subject: run.job.actor,
    outcome: "ok",
    logicalId: run.job.id,
    props: { runner: runner.id },
  });
  appendLog(data, `build started on ${runner.id} (${runner.boundary})`);

  const controller = new AbortController();
  const result = await runner.run(
    {
      jobId: run.job.id,
      appId: run.job.appId,
      source: validated,
      recipe: RECIPE_V1,
      limits: { timeoutMs: DEFAULT_LIMITS.buildTimeoutMs, maxLogBytes: 256_000, memoryMb: 1024 },
    },
    controller.signal
  );

  for (const line of result.logs.slice(-60)) appendLog(data, `[${line.stream}] ${line.line}`);
  data.buildMs = result.durationMs;
  data.buildRunner = result.runner;
  data.buildBoundary = result.boundary;

  // The build cost real machine time whether or not it produced anything, so
  // it is recorded either way; a ledger that only counts successes understates
  // exactly the spending a runaway build causes.
  try {
    releaseDeps.recordUsage({
      workspaceId: run.job.workspaceId,
      appId: run.job.appId,
      kind: "build_ms",
      amount: result.durationMs,
      note: `${result.runner} build for job ${run.job.id}`,
    });
  } catch (err) {
    appendLog(data, `usage not recorded: ${reasonOf(err)}`);
  }

  if (!result.ok || !result.outputDir) {
    emit({
      event: "build.failed",
      workspaceId: run.job.workspaceId,
      appId: run.job.appId,
      subject: run.job.actor,
      outcome: "error",
      logicalId: run.job.id,
      props: { runner: runner.id, durationMs: result.durationMs },
    });
    throw new HostedError(
      "unsupported_source",
      result.error ?? `The ${runner.label} runner ended without producing build output.`,
      {
        fix: "Read the job log (GET /api/hosted/apps/<id>/jobs/<jobId>), fix the source, and publish again. The app is still serving its previous release.",
      }
    );
  }

  emit({
    event: "build.succeeded",
    workspaceId: run.job.workspaceId,
    appId: run.job.appId,
    subject: run.job.actor,
    outcome: "ok",
    logicalId: run.job.id,
    props: { runner: runner.id, durationMs: result.durationMs },
  });
  data.outputDir = result.outputDir;
  appendLog(data, `build succeeded in ${result.durationMs} ms`);
}

/** Store the output tree under the SHA-256 of its own bytes and index it. */
async function storeArtifact(run: JobRun, data: PhaseData): Promise<void> {
  if (typeof data.artifactDigest === "string") return;

  const outputDir = typeof data.outputDir === "string" ? data.outputDir : undefined;
  if (!outputDir || !fs.existsSync(outputDir))
    throw new HostedError("internal", "The build output directory is gone, so no artifact could be stored.", {
      fix: "Publish again — the scratch directory a previous attempt built into no longer exists.",
    });

  const provenance: ArtifactProvenance = {
    sourceDigest: String(data.sourceDigest),
    sourceKind: data.sourceKind === "directory" ? "directory" : "tarball",
    jobId: run.job.id,
    recipe: RECIPE_V1,
    contractVersion: 1,
    schemaVersion: 1,
    builtBy: (data.buildRunner as BuildRunnerId | undefined) ?? "recipe-local",
    buildBoundary: String(data.buildBoundary ?? "unrecorded"),
    builtAt: nowIso(),
  };

  const artifact = await releaseDeps.artifactStore().put(outputDir, provenance);
  // The output tree only had to survive long enough to be copied into the
  // content-addressed store; keeping it would be a second, unversioned copy.
  removeMaterialized(outputDir);
  delete data.outputDir;

  // Content addressing means an identical build is the *same* artifact, whoever
  // produced it: re-publishing after a rollback, or two apps built from one
  // template, land on bytes an earlier job stored. The store keeps that job's
  // provenance, so this job records whether it created the artifact or joined
  // one — and `verify_artifact` checks accordingly.
  data.artifactJobId = artifact.provenance.jobId;
  data.artifactSourceDigest = artifact.provenance.sourceDigest;
  data.artifactReused = artifact.provenance.jobId !== run.job.id;

  authority().repos.artifacts.insert({
    digest: artifact.digest,
    byteSize: artifact.byteSize,
    fileCount: artifact.fileCount,
    provenance: artifact.provenance,
  });

  data.artifactDigest = artifact.digest;
  data.artifactBytes = artifact.byteSize;
  data.artifactFiles = artifact.fileCount;
  appendLog(
    data,
    `artifact ${artifact.digest.slice(0, 12)} stored (${artifact.fileCount} files, ${artifact.byteSize} bytes)`
  );
}

/** Recompute the stored bytes and check the provenance before a release may name them. */
async function verifyArtifact(run: JobRun, data: PhaseData): Promise<void> {
  if (data.artifactVerified === true) return;
  const digest = String(data.artifactDigest);
  const reused = data.artifactReused === true;
  // A fresh artifact is checked against what *this* job did: these bytes were
  // built now, from this source, by this job, and any disagreement is a
  // publisher failure. An artifact this job joined rather than created is
  // checked against its own immutable record instead — demanding that it name
  // this job would refuse every legitimate re-publish — and the recipe is
  // pinned to today's either way, which is the cross-check that matters.
  const verdict = await verifyForRelease(releaseDeps.artifactStore(), digest, {
    sourceDigest: reused ? String(data.artifactSourceDigest) : String(data.sourceDigest),
    jobId: reused ? String(data.artifactJobId) : run.job.id,
    recipe: RECIPE_V1,
  });
  if (!verdict.ok)
    throw new HostedError("internal", `The artifact did not pass publisher verification: ${verdict.detail}`, {
      fix: "Publish again. Nothing was activated, and the app is still serving its previous release.",
    });
  authority().repos.artifacts.markVerified(digest);
  data.artifactVerified = true;
  appendLog(
    data,
    reused
      ? `artifact ${digest.slice(0, 12)} was already stored by job ${String(data.artifactJobId)} and re-verified here: ${verdict.detail}`
      : `artifact verified: ${verdict.detail}`
  );
}

/** Record the candidate release and ask the runtime to stage it. */
async function stage(run: JobRun, data: PhaseData): Promise<string> {
  const a = authority();
  const app = requireApp(run.job.appId);
  const digest = String(data.artifactDigest);

  const known = typeof data.releaseId === "string" ? a.repos.releases.get(data.releaseId) : null;
  // The release row and the job's knowledge of it commit together. Inserting
  // first and recording afterwards would let a crash in between produce a
  // second release on the next attempt — a candidate nobody asked for, holding
  // a number that is now missing from the history.
  const release: Release =
    known ??
    a.tx(() => {
      const inserted = a.repos.releases.insert({
        id: crypto.randomUUID(),
        appId: app.id,
        number: a.repos.releases.nextNumber(app.id),
        artifactDigest: digest,
        jobId: run.job.id,
        runtime: app.runtime,
        status: "candidate",
      });
      data.releaseId = inserted.id;
      data.releaseNumber = inserted.number;
      // The fence this candidate is being built to replace. Read here, at the
      // moment the worker decided "this release supersedes what is live now",
      // and compared at activation — which may be minutes later. Re-reading it
      // then would make the compare-and-swap compare a value with itself and
      // guard nothing.
      data.observedFence = app.activeFence;
      if (!a.repos.jobs.advance(run.job.id, run.fence, "stage", data)) throw new LeaseLost(run.job.id);
      return inserted;
    });
  data.releaseId = release.id;
  data.releaseNumber = release.number;

  const artifact = await releaseDeps.artifactStore().get(digest);
  if (!artifact)
    throw new HostedError("internal", `Artifact ${digest} is indexed but not in the store.`, {
      fix: "Publish again; the artifact store and the control database disagree about this digest.",
    });

  const candidate = await releaseDeps.runtime().stageCandidate(app, release, artifact);
  data.candidateRef = candidate as unknown as Record<string, unknown>;
  // ponytail: `ReleasesRepo` has no runtime-ref setter, so the staged
  // identifiers are written here. Move to `releases.setRuntimeRef` when W1
  // adds one.
  a.tx((db) => {
    db.prepare("UPDATE releases SET runtime_ref = ? WHERE id = ?").run(
      JSON.stringify(candidate.ref ?? {}),
      release.id
    );
  });
  appendLog(data, `release ${release.number} staged as a candidate on ${app.runtime}`);
  return release.id;
}

/** Health and data round trip against the disposable test database. */
async function probe(run: JobRun, data: PhaseData): Promise<void> {
  if (data.probeOk === true) return;
  const a = authority();
  const app = requireApp(run.job.appId);
  const releaseId = String(data.releaseId);
  const candidate = data.candidateRef as unknown as RuntimeCandidateRef;

  const result: CandidateProbeResult = await releaseDeps.runtime().probeCandidate(app, candidate);
  a.repos.releases.setProbe(releaseId, result);
  for (const check of result.checks) appendLog(data, `probe ${check.id}: ${check.ok ? "ok" : "failed"} — ${check.detail}`);

  if (!result.ok) {
    const failed = result.checks.filter((check) => !check.ok).map((check) => `${check.id} (${check.detail})`);
    emit({
      event: "release.verified",
      workspaceId: run.job.workspaceId,
      appId: app.id,
      releaseId,
      subject: run.job.actor,
      outcome: "error",
      logicalId: run.job.id,
    });
    // The candidate is marked failed here rather than by the catch below, so
    // the message on the release is the probe's own words.
    throw new HostedError(
      "conflict",
      `The candidate release did not pass its health probe, so it was not activated: ${failed.join("; ") || "no check reported a reason"}.`,
      {
        fix: `${app.name} is still serving its previous release. Fix the app, then publish again.`,
        details: { releaseId, checks: result.checks },
      }
    );
  }

  a.repos.releases.setStatus(releaseId, "verified", { verifiedAt: result.checkedAt });
  data.probeOk = true;
  emit({
    event: "release.verified",
    workspaceId: run.job.workspaceId,
    appId: app.id,
    releaseId,
    subject: run.job.actor,
    outcome: "ok",
    logicalId: run.job.id,
    props: { checks: result.checks.length },
  });
}

/**
 * Point the app at the verified candidate — the one write in this file that
 * changes what users see.
 *
 * The compare-and-swap is the whole mechanism, and what it compares against is
 * the fence this worker read back at `stage`, not the one it can read now. A
 * publish takes minutes; the value that has to still be true is "the release I
 * am replacing is the release I was told to replace". If anything activated in
 * the meantime — a concurrent publish, a rollback, an operator — the swap
 * fails and this job reports that rather than quietly putting an older
 * candidate in front of users.
 */
async function activate(run: JobRun, data: PhaseData): Promise<void> {
  if (data.activated === true) return;
  const a = authority();
  const releaseId = String(data.releaseId);

  const swapped = a.tx(() => {
    const app = requireApp(run.job.appId);
    const release = a.repos.releases.get(releaseId);
    if (!release || release.appId !== app.id)
      throw new HostedError("not_found", `Release ${releaseId} does not belong to app ${app.id}.`, {
        fix: "Publish again; this job's candidate release is missing from the control database.",
      });
    const expected = typeof data.observedFence === "number" ? data.observedFence : app.activeFence;
    if (!a.repos.apps.setActiveRelease(app.id, releaseId, expected))
      throw new HostedError(
        "conflict",
        `Another activation moved ${app.name} while this publish was in flight, so release ${release.number} was not activated.`,
        {
          fix: "Check which release is live now (GET /api/hosted/apps/<id>/releases). Publish again if this one should replace it.",
          details: { appId: app.id, expectedFence: expected, currentFence: app.activeFence, releaseId },
        }
      );
    const at = nowIso();
    a.repos.releases.markSuperseded(app.id, releaseId, at);
    a.repos.releases.setStatus(releaseId, "active", { activatedAt: at });
    return { fence: expected + 1, release };
  });

  const app = requireApp(run.job.appId);
  await releaseDeps.runtime().activate(app, swapped.release, swapped.fence);

  data.activated = true;
  data.activeFence = swapped.fence;
  appendLog(data, `release ${swapped.release.number} activated at fence ${swapped.fence}`);
  emit({
    event: "release.activated",
    workspaceId: run.job.workspaceId,
    appId: app.id,
    releaseId,
    subject: run.job.actor,
    outcome: "ok",
    logicalId: run.job.id,
    props: { release: swapped.release.number, fence: swapped.fence },
  });
}

/** Remove the job's scratch space and whatever the runtime no longer needs. */
async function cleanup(run: JobRun, data: PhaseData): Promise<void> {
  removeMaterialized(jobDir(run.job.id));
  delete data.materializedDir;
  delete data.sourcePath;
  try {
    await releaseDeps.runtime().cleanup(requireApp(run.job.appId), retainedReleases(run.job.appId));
  } catch (err) {
    // A candidate left behind costs disk, not correctness. The release is
    // live; saying the publish failed now would be worse than a stray file.
    appendLog(data, `runtime cleanup deferred: ${reasonOf(err)}`);
  }
}

/* --------------------------------- sources -------------------------------- */

/** Where this job's source comes from, whichever way it was submitted. */
function readSource(job: HostedJob, data: PhaseData): Parameters<typeof validateSource>[0] {
  const source = data.source as { kind?: string; name?: string } | undefined;
  if (source?.kind === "fixture" && typeof source.name === "string")
    return { kind: "directory", path: fixtureDirectory(source.name) };

  const stored = typeof data.sourcePath === "string" ? data.sourcePath : jobSourcePath(job.id);
  if (!fs.existsSync(stored))
    throw new HostedError("unsupported_source", "The submitted source is no longer on disk, so it cannot be built.", {
      fix: "Publish again with the source attached; a queued job's package is kept under ORRERY_DATA/jobs and this one is gone.",
      details: { jobId: job.id },
    });
  return { kind: "tarball", bytes: fs.readFileSync(stored) };
}
