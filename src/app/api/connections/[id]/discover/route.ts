/**
 * Resources that already exist where a connection points, for reference-import.
 *
 *   GET /api/connections/:id/discover
 *     ?region=<region>       defaults to the connection's own region
 *     ?projectId=<id>        hide what that project already references
 *     → { simulated, resources, provider, region }
 *
 * Read-only. Listing is not importing: nothing here touches a manifest. The
 * import happens through `project.importResources`, which plans first like
 * every other manifest edit.
 *
 * `simulated` is the adapter's own answer — true for the sandbox's invented
 * set, false for LocalStack's real endpoint listing — and the import dialog
 * repeats it in words before anything is added.
 */
import { inWorkspace, q } from "@/lib/db/store";
import { ensureEngine } from "@/lib/engine/engine";
import { providerRegistry, type Discovery } from "@/lib/providers/types";
import { ApiError, notFound, requireWorkspace, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (req, { id }) => {
  ensureEngine(); // adapters register on first touch

  const conn = q.connection(id);
  // Connections carry their workspace directly — an id alone is not a read grant.
  if (!conn || conn.workspaceId !== requireWorkspace().id)
    throw notFound(`Connection "${id}"`, "Pick one from Settings → Connections.");

  const adapter = providerRegistry().get(conn.provider);
  if (!adapter)
    throw new ApiError(`Provider "${conn.provider}" is not available in this build.`, 409, {
      fix: "Use a connection whose provider this build ships.",
    });

  const provider = {
    id: adapter.id,
    displayName: adapter.displayName,
    availability: adapter.availability,
  };
  const region = req.nextUrl.searchParams.get("region") || conn.region;

  if (!adapter.discover)
    throw new ApiError(
      `${adapter.displayName} cannot list what already exists in your account.`,
      501,
      { fix: "Import existing infrastructure from Terraform instead — the map's import dialog reads a .tf file." }
    );

  let found: Discovery;
  try {
    found = await adapter.discover(conn, region);
  } catch (err) {
    throw new ApiError(err instanceof Error ? err.message : String(err), provider.availability === "available" ? 502 : 501, {
      fix: "Nothing was read and nothing was written. Fix the cause above and try again.",
    });
  }

  // Already-referenced resources are dropped rather than shown as importable:
  // the adapter has a connection, not a manifest, so this is the first place
  // that can tell. `project.importResources` de-duplicates again on the way in.
  const projectId = req.nextUrl.searchParams.get("projectId");
  const project = projectId ? q.project(projectId) : undefined;
  const known =
    project && inWorkspace(conn.workspaceId, project.id)
      ? new Set(
          project.workingManifest.resources
            .map((r) => r.externalRef)
            .filter((ref): ref is string => !!ref)
        )
      : new Set<string>();

  return {
    simulated: found.simulated,
    resources: found.resources.filter((r) => !known.has(r.externalRef)),
    /** how many were hidden because this project already references them */
    alreadyReferenced: found.resources.filter((r) => known.has(r.externalRef)).length,
    provider,
    region,
  };
});
