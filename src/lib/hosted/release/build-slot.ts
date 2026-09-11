/**
 * The build-slot ceiling, shared by the publish pipeline, its build phase and
 * the job runner. It lives apart from publish.ts so the phase that consults it
 * does not import the module that drives it.
 */
import { authority } from "@/lib/hosted/authority";
import { DEFAULT_LIMITS } from "@/lib/hosted/contracts";

/**
 * Whether another build may start right now.
 *
 * Two ceilings, both read from the authority rather than from a counter in
 * this process: one build per app (which the `hosted_jobs` single-flight index
 * enforces on its own) and `buildsPilotWide` across the install, which nothing
 * else enforces and which is the whole reason a third app's publish waits in
 * the queue instead of racing two others for the same CPU.
 */
export async function buildSlot(
  appId: string,
  jobId?: string
): Promise<{ ok: boolean; reason?: string }> {
  const jobs = authority().repos.jobs;
  const running = await jobs.runningFor(appId);
  if (running && running.id !== jobId)
    return {
      ok: false,
      reason: `${appId} already has job ${running.id} running (${running.phase}); hosted apps run ${DEFAULT_LIMITS.buildsPerApp} operation at a time.`,
    };
  // A job that already holds the slot it is asking about counts itself, so the
  // running total is compared with `>` when it does and `>=` when it does not.
  const count = await jobs.countRunning();
  const held = jobId && running?.id === jobId ? 1 : 0;
  if (count - held >= DEFAULT_LIMITS.buildsPilotWide)
    return {
      ok: false,
      reason: `${count} builds are already running and this install allows ${DEFAULT_LIMITS.buildsPilotWide} at a time.`,
    };
  return { ok: true };
}

