/**
 * Rollback: put an app back onto a release it already ran, without touching a
 * single record its users wrote.
 *
 * Rollback is not restore, and the difference is the whole point. Restore
 * replaces data with an older copy; rollback replaces *code* and leaves data
 * exactly where it is. That is only safe while the older code still
 * understands the current data, so the one check this file makes before the
 * swap is the schema comparison — a release built against schema 1 may serve
 * schema-1 data, and anything else is refused with the two versions named
 * rather than attempted and hoped for.
 *
 * The activation is the same compare-and-swap the publish pipeline uses, for
 * the same reason: two operators clicking at once must produce one winner and
 * one honest refusal, not two pointer writes.
 */
import { admitJob, authority, nowIso } from "@/lib/hosted/authority";
import {
  HostedError,
  type HostedJob,
  type Release,
  type ReleaseStatus,
  type Subject,
} from "@/lib/hosted/contracts";
import { assertPublishable } from "./publish";
import { releaseDeps } from "./deps";
import { rollbackIntent } from "./intent";
import {
  advanceTo,
  appendLog,
  emit,
  failJob,
  persist,
  phaseDataOf,
  reasonOf,
  requireApp,
  requireAppIn,
  seedPhaseData,
  type JobRun,
} from "./shared";

/** The phases a rollback moves through. */
export const ROLLBACK_PHASES = ["check", "activate"] as const;

/**
 * The statuses a release may be rolled back *to*.
 *
 * `verified` passed its probe but was never activated; `superseded` served
 * users until something newer replaced it; `rolled_back` served users and was
 * itself rolled back, which makes it a legitimate target for rolling forward
 * again. `candidate` has not been probed and `failed` is a release the system
 * already refused — putting either in front of users would undo the guarantee
 * the probe exists for. `active` is refused separately, because it is not a
 * rollback at all.
 */
export const ROLLBACK_SOURCE_STATUSES: ReadonlySet<ReleaseStatus> = new Set<ReleaseStatus>([
  "verified",
  "superseded",
  "rolled_back",
]);

/** What admitting a rollback needs. */
export interface AdmitRollbackInput {
  jobId: string;
  appId: string;
  workspaceId: string;
  actor: Subject;
  releaseId: string;
}

/** Queue a rollback, or return the job this id already names. */
export function admitRollback(input: AdmitRollbackInput): { job: HostedJob; created: boolean } {
  const app = requireAppIn(input.appId, input.workspaceId);
  assertPublishable(app);
  // Checked at admission as well as in the job, so an impossible rollback is
  // refused while the operator is still looking at the screen.
  assertRollbackTarget(app.id, input.releaseId, app.activeReleaseId);

  const { intent } = rollbackIntent({
    appId: input.appId,
    workspaceId: input.workspaceId,
    actor: input.actor,
    releaseId: input.releaseId,
  });
  const admitted = admitJob({
    id: input.jobId,
    kind: "rollback",
    workspaceId: input.workspaceId,
    appId: input.appId,
    actor: input.actor,
    intent,
  });
  if (admitted.created) {
    seedPhaseData(input.jobId, {
      releaseId: input.releaseId,
      logs: [`${nowIso()} admitted rollback of ${app.slug} to release ${input.releaseId}`],
    });
    return { job: authority().repos.jobs.get(input.jobId) ?? admitted.job, created: true };
  }
  return admitted;
}

/** The release a rollback may select, or the refusal saying why this one is not it. */
export function assertRollbackTarget(
  appId: string,
  releaseId: string,
  activeReleaseId: string | null
): Release {
  const release = authority().repos.releases.get(releaseId);
  if (!release || release.appId !== appId)
    throw new HostedError("not_found", `Release ${releaseId} is not a release of this app.`, {
      fix: "Pick a release from GET /api/hosted/apps/<id>/releases.",
    });
  if (release.id === activeReleaseId)
    throw new HostedError("conflict", `Release ${release.number} is already the release this app is serving.`, {
      fix: "Pick a different release, or publish a new one.",
      details: { releaseId, number: release.number },
    });
  if (!ROLLBACK_SOURCE_STATUSES.has(release.status))
    throw new HostedError(
      "conflict",
      `Release ${release.number} is ${release.status}, and only a release that passed its health probe may be rolled back to.`,
      {
        fix: `Pick a release whose status is ${[...ROLLBACK_SOURCE_STATUSES].join(", ")}. A ${release.status} release was never proven to serve this app.`,
        details: { releaseId, status: release.status },
      }
    );
  return release;
}

/**
 * Run a claimed rollback.
 *
 * Two phases. `check` re-reads the target and compares schema versions — the
 * app may have been published to since the operator pressed the button, and
 * the answer that mattered then may not be the answer now. `activate` swaps
 * the pointer under the fence and marks the release it displaced
 * `rolled_back`, which is the status that distinguishes "we chose to leave
 * this one" from "something newer arrived".
 */
export async function runRollback(run: JobRun): Promise<void> {
  const data = phaseDataOf(run.job);
  const a = authority();

  try {
    const app = requireApp(run.job.appId);
    assertPublishable(app);
    const releaseId = String(data.releaseId ?? intentReleaseId(run.job));

    advanceTo(run, "check", data);
    const target = assertRollbackTarget(app.id, releaseId, app.activeReleaseId);
    data.releaseId = target.id;
    data.releaseNumber = target.number;

    const current = await releaseDeps.appSchemaVersion(app.id);
    if (current !== target.schemaVersion)
      throw new HostedError(
        "conflict",
        `Release ${target.number} was built for data schema ${target.schemaVersion} and this app's records are on schema ${current}, so rolling back to it would put code in front of data it does not understand.`,
        {
          fix: "Roll back to a release built for the current schema, or publish a new release. No records were read or changed.",
          details: { releaseId: target.id, releaseSchema: target.schemaVersion, appSchema: current },
        }
      );
    data.schemaVersion = current;
    // The fence the operator's decision was made against; compared, not
    // re-read, when the pointer moves below.
    data.observedFence = app.activeFence;
    appendLog(data, `rollback target release ${target.number} matches data schema ${current}`);
    persist(run, data);

    advanceTo(run, "activate", data);
    const swapped = a.tx(() => {
      const fresh = requireApp(app.id);
      const expected = typeof data.observedFence === "number" ? data.observedFence : fresh.activeFence;
      if (!a.repos.apps.setActiveRelease(fresh.id, target.id, expected))
        throw new HostedError(
          "conflict",
          `Another activation moved ${fresh.name} while this rollback was in flight, so nothing was changed.`,
          {
            fix: "Check which release is live now (GET /api/hosted/apps/<id>/releases), then roll back again if this one should still replace it.",
            details: { appId: fresh.id, expectedFence: expected, currentFence: fresh.activeFence, releaseId: target.id },
          }
        );
      const at = nowIso();
      // The release being left is `rolled_back`, not `superseded`: nothing
      // newer arrived, somebody chose to step off it.
      if (fresh.activeReleaseId && fresh.activeReleaseId !== target.id)
        a.repos.releases.setStatus(fresh.activeReleaseId, "rolled_back", { supersededAt: at });
      a.repos.releases.markSuperseded(fresh.id, target.id, at);
      a.repos.releases.setStatus(target.id, "active", { activatedAt: at });
      return { fence: expected + 1, from: fresh.activeReleaseId };
    });

    await releaseDeps.runtime().activate(requireApp(app.id), target, swapped.fence);
    data.activated = true;
    data.activeFence = swapped.fence;
    data.rolledBackFrom = swapped.from;
    appendLog(data, `release ${target.number} is live again at fence ${swapped.fence}; no record was touched`);
    emit({
      event: "release.rolled_back",
      workspaceId: run.job.workspaceId,
      appId: app.id,
      releaseId: target.id,
      subject: run.job.actor,
      outcome: "ok",
      logicalId: run.job.id,
      props: { release: target.number, fence: swapped.fence },
    });

    advanceTo(run, "finish", data);
    a.repos.jobs.finish(run.job.id, run.fence, {
      releaseId: target.id,
      releaseNumber: target.number,
      rolledBackFrom: swapped.from,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "LeaseLost") return;
    // A rollback never marks a release failed: every release it touches was
    // already proven once, and the refusal is about this attempt, not them.
    failJob(run, data, reasonOf(err));
  }
}

/** The release a rollback job named, recovered from its stored phase data. */
function intentReleaseId(job: HostedJob): string {
  const releaseId = job.phaseData.releaseId;
  if (typeof releaseId === "string") return releaseId;
  throw new HostedError("invalid_input", `Rollback job ${job.id} does not name a release.`, {
    fix: "Start the rollback again with { jobId, releaseId }.",
  });
}
