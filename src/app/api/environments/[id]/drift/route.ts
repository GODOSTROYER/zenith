/**
 * Drift for one environment: what the provider finds, against the revision
 * that is actually deployed there.
 *
 *   GET /api/environments/:id/drift
 *     → { simulated, observedAt, items, provider, revision }
 *
 * Read-only, and hard read-only: it calls the adapter's `observe`, which is
 * contractually forbidden from mutating anything, and it writes nothing to the
 * store — no findings, no audit row, no cached result.
 *
 * `simulated` comes straight from the adapter and is the whole honesty story
 * for this route: true means the differences are a demonstration of what drift
 * looks like (the sandbox), false means something real was inspected
 * (LocalStack). A provider that cannot read at all refuses here rather than
 * returning an empty, reassuring list.
 */
import { computeDrift, type DriftResponse } from "@/lib/drift";
import { inWorkspace, q } from "@/lib/db/store";
import { ensureEngine } from "@/lib/engine/engine";
import { providerRegistry, type LiveState } from "@/lib/providers/types";
import { ApiError, notFound, requireWorkspace, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (_req, { id }) => {
  ensureEngine(); // adapters register on first touch

  const env = q.environment(id);
  // Scoped by the owning project's workspace: an id alone is not a read grant.
  if (!env || !inWorkspace(requireWorkspace().id, env.projectId))
    throw notFound(
      `Environment "${id}"`,
      "Pick an environment from the project's environment switcher, or create one in Settings → Environments."
    );

  const conn = q.connection(env.connectionId);
  if (!conn)
    throw new ApiError(`${env.name} has no cloud connection.`, 409, {
      fix: "Reconnect one in Settings → Connections, then check drift again.",
    });

  const adapter = providerRegistry().get(conn.provider);
  if (!adapter)
    throw new ApiError(`Provider "${conn.provider}" is not available in this build.`, 409, {
      fix: `Point ${env.name} at a connection whose provider this build ships.`,
    });

  const provider = {
    id: adapter.id,
    displayName: adapter.displayName,
    availability: adapter.availability,
  };

  if (!adapter.observe)
    throw new ApiError(
      `${adapter.displayName} cannot read back what it deployed, so Zenith has no way to tell whether ${env.name} has drifted.`,
      501,
      { fix: `Deploy this system to a sandbox or LocalStack environment to see drift.` }
    );

  if (!env.deployedRevisionId)
    throw new ApiError(`${env.name} has never been deployed, so there is nothing to compare against.`, 409, {
      fix: "Deploy a revision here first. Drift is the difference between what is deployed and what is there.",
    });

  const revision = q.revision(env.deployedRevisionId);
  if (!revision)
    throw new ApiError(
      `${env.name} points at revision "${env.deployedRevisionId}", which is not in the store.`,
      409,
      { fix: "Deploy the environment again to re-establish a known-good revision." }
    );

  let live: LiveState;
  try {
    live = await adapter.observe(env, revision.manifest);
  } catch (err) {
    // A provider that refuses on principle (AWS Preview reads no account) is
    // not the same failure as one that was asked and could not answer
    // (LocalStack stopped) — the status code says which.
    throw new ApiError(err instanceof Error ? err.message : String(err), provider.availability === "available" ? 502 : 501, {
      fix: "Nothing was read and nothing was written. Fix the cause above and check again.",
    });
  }

  // `satisfies` on purpose: DriftResponse is shared with the Observe screen and
  // the System Map, so a change here has to break the compile, not the page.
  return {
    simulated: live.simulated,
    observedAt: live.observedAt,
    items: computeDrift(revision.manifest, live),
    provider,
    /** what the comparison was made against, so the UI never has to guess */
    revision: { id: revision.id, number: revision.number },
  } satisfies DriftResponse;
});
