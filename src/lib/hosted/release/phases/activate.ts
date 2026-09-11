/**
 * `activate` — point the app at the verified candidate: the one write in the
 * publish pipeline that changes what users see.
 *
 * The compare-and-swap is the whole mechanism, and what it compares against is
 * the fence this worker read back at `stage`, not the one it can read now. A
 * publish takes minutes; the value that has to still be true is "the release I
 * am replacing is the release I was told to replace". If anything activated in
 * the meantime — a concurrent publish, a rollback, an operator — the swap
 * fails and this job reports that rather than quietly putting an older
 * candidate in front of users.
 */
import { authority, nowIso } from "@/lib/hosted/authority";
import { HostedError } from "@/lib/hosted/contracts";
import { releaseDeps } from "../deps";
import { appendLog, emit, requireApp, type JobRun, type PhaseData } from "../shared";

/** Point the app at the verified candidate, on the fence `stage` observed. */
export async function activate(run: JobRun, data: PhaseData): Promise<void> {
  if (data.activated === true) return;
  const a = authority();
  const releaseId = String(data.releaseId);

  const swapped = await a.tx(async (repos) => {
    const app = await requireApp(run.job.appId, repos);
    const release = await repos.releases.get(releaseId);
    if (!release || release.appId !== app.id)
      throw new HostedError("not_found", `Release ${releaseId} does not belong to app ${app.id}.`, {
        fix: "Publish again; this job's candidate release is missing from the control database.",
      });
    const expected = typeof data.observedFence === "number" ? data.observedFence : app.activeFence;
    if (!(await repos.apps.setActiveRelease(app.id, releaseId, expected)))
      throw new HostedError(
        "conflict",
        `Another activation moved ${app.name} while this publish was in flight, so release ${release.number} was not activated.`,
        {
          fix: "Check which release is live now (GET /api/hosted/apps/<id>/releases). Publish again if this one should replace it.",
          details: { appId: app.id, expectedFence: expected, currentFence: app.activeFence, releaseId },
        }
      );
    const at = nowIso();
    await repos.releases.markSuperseded(app.id, releaseId, at);
    await repos.releases.setStatus(releaseId, "active", { activatedAt: at });
    return { fence: expected + 1, release };
  });

  const app = await requireApp(run.job.appId);
  await releaseDeps.runtime().activate(app, swapped.release, swapped.fence);

  data.activated = true;
  data.activeFence = swapped.fence;
  appendLog(data, `release ${swapped.release.number} activated at fence ${swapped.fence}`);
  await emit({
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
