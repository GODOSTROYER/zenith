/**
 * One job: its phase, its outcome, and the log lines that explain both.
 *
 * Owner only. Build logs quote whatever the source produced, and a publish
 * that failed says why in a runner's own words — neither is something a
 * workspace viewer needs, and both are things an app owner cannot debug
 * without.
 *
 * Workstream W7 (hosted R3).
 */
import { authority } from "@/lib/hosted/authority";
import { HostedError } from "@/lib/hosted/contracts";
import { jobLogs, requireOwnedApp } from "@/lib/hosted/release";
import { actorOf, hostedRoute, requireAppOwner, requireWorkspaceRole } from "@/lib/hosted/release/http";
import { requireWorkspace } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const GET = hostedRoute<{ appId: string; jobId: string }>(async (req, { appId, jobId }) => {
  const actor = await actorOf(req);
  requireWorkspaceRole(actor, "viewer");
  const app = requireOwnedApp(appId, requireWorkspace().id);
  requireAppOwner(app.id, actor);

  const job = authority().repos.jobs.get(jobId);
  // A job of another app answers exactly as a missing one: a job id must not
  // be a way to learn what other apps on this install are doing.
  if (!job || job.appId !== app.id)
    throw new HostedError("not_found", `No job ${jobId} exists for this app.`, {
      fix: "Use the job id the publish response returned, or list the app's recent jobs with GET /api/hosted/apps/<id>.",
    });

  return { job, logs: jobLogs(job.id) };
});
