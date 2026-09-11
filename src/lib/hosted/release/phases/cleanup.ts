/**
 * `cleanup` — remove the job's scratch space and whatever the runtime no
 * longer needs.
 *
 * The release is live by the time this runs, so a failure here is logged and
 * swallowed: a candidate left behind costs disk, not correctness.
 */
import { removeMaterialized } from "@/lib/hosted/source";
import { retainedReleases } from "../apps";
import { releaseDeps } from "../deps";
import { appendLog, jobDir, reasonOf, requireApp, type JobRun, type PhaseData } from "../shared";

/** Remove the job's scratch space and whatever the runtime no longer needs. */
export async function cleanup(run: JobRun, data: PhaseData): Promise<void> {
  removeMaterialized(jobDir(run.job.id));
  delete data.materializedDir;
  delete data.sourcePath;
  try {
    await releaseDeps
      .runtime()
      .cleanup(await requireApp(run.job.appId), await retainedReleases(run.job.appId));
  } catch (err) {
    // A candidate left behind costs disk, not correctness. The release is
    // live; saying the publish failed now would be worse than a stray file.
    appendLog(data, `runtime cleanup deferred: ${reasonOf(err)}`);
  }
}
