/**
 * The no-lock-in export: real Terraform/OpenTofu for this environment.
 * Exports the deployed revision when there is one, otherwise the working copy
 * (labelled, so the caller never mistakes one for the other).
 */
import { db, inWorkspace, q } from "@/lib/db/store";
import { getProvider, providerRegistry } from "@/lib/providers/types";
import { ApiError, notFound, requireWorkspace, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (_req, { id }) => {
  const env = q.environment(id);
  // Scoped by the owning project's workspace: an id alone is not a read grant.
  if (!env || !inWorkspace(requireWorkspace().id, env.projectId))
    throw notFound(`Environment "${id}"`, "Open the project's Settings tab and pick an environment.");

  const connection = q.connection(env.connectionId);
  if (!connection)
    throw new ApiError(`Environment "${env.name}" has no cloud connection.`, 400, {
      fix: "Connect a cloud in workspace settings, then re-point this environment at it.",
    });

  if (!providerRegistry().has(connection.provider))
    throw new ApiError(`Provider "${connection.provider}" is not registered on this server.`, 500, {
      fix: "Restart the dev server; if it persists the provider adapter failed to load.",
    });
  const provider = getProvider(connection.provider);

  if (provider.availability === "planned")
    throw new ApiError(
      `${provider.displayName} is planned, not implemented — Zenith cannot generate an export bundle for it yet.`,
      400,
      { fix: "Export from a Sandbox or AWS (Preview) environment; both emit runnable infrastructure code." }
    );

  const deployed = env.deployedRevisionId ? q.revision(env.deployedRevisionId) : undefined;
  const project = db().projects.find((p) => p.id === env.projectId);
  if (!deployed && !project)
    throw notFound(`Project for environment "${env.name}"`, "Recreate the environment from a project.");

  const manifest = deployed?.manifest ?? project!.workingManifest;
  const bundle = provider.exportBundle(env, manifest);

  return {
    ...bundle,
    provider: provider.id,
    /** honest: says which manifest the files describe */
    source: deployed
      ? { kind: "revision" as const, revisionId: deployed.id, number: deployed.number }
      : { kind: "working" as const, note: "This environment has never been deployed; exporting the working copy." },
  };
});
