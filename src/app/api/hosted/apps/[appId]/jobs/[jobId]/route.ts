/**
 * One job: its phase, its outcome, and the log lines that explain both.
 *
 * Owner only. Build logs quote whatever the source produced, and a publish
 * that failed says why in a runner's own words — neither is something a
 * workspace viewer needs, and both are things an app owner cannot debug
 * without.
 *
 * The owner check is sequenced rather than declared: the app has to be found
 * inside this workspace first, so an app id from another workspace answers
 * "not found" instead of "you are not its owner".
 */
import { authority } from "@/lib/hosted/authority";
import { HostedError, type HostedJobPayload } from "@/lib/hosted/contracts";
import { jobLogs, requireOwnedApp } from "@/lib/hosted/release";
import { hostedRoute, requireAppOwner } from "@/lib/server/hosted";
import { requireWorkspace } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const GET = hostedRoute<{ appId: string; jobId: string }>(
  { workspaceRole: "viewer" },
  async (req, { appId, jobId }, { actor }): Promise<HostedJobPayload> => {
    const app = await requireOwnedApp(appId, requireWorkspace().id);
    await requireAppOwner(app.id, req, { verify: "session", actor });

    const job = await authority().repos.jobs.get(jobId);
    // A job of another app answers exactly as a missing one: a job id must not
    // be a way to learn what other apps on this install are doing.
    if (!job || job.appId !== app.id)
      throw new HostedError("not_found", `No job ${jobId} exists for this app.`, {
        fix: "Use the job id the publish response returned, or list the app's recent jobs with GET /api/hosted/apps/<id>.",
      });

    return { job, logs: await jobLogs(job.id) };
  }
);
