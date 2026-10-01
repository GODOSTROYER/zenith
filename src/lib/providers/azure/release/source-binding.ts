/** Trusted C3 storage configuration. No desired manifest/spec chooses this binding. */
import type { Sql } from "@/lib/controlplane/types";
import { repos } from "@/lib/controlplane/db";
import { sourceStorageHost } from "../credentials";
import { AzureSourceStorageRefusedError, type AzureSourceStorageResolver } from "./source-storage";

type Scope = Parameters<AzureSourceStorageResolver>[0] & { connectionId?: string; resourceId?: string };
export function createAzureSourceStorageResolver(db: Sql): (scope: Scope) => ReturnType<AzureSourceStorageResolver> {
  return async (scope) => {
    const rows = await db.query<{ connection_id: string }>(
      "select connection_id from platform.reconcile_state where workspace_id = $1 and environment_id = $2 and provider = 'azure' and region = $3",
      [scope.workspaceId, scope.environmentId, scope.region],
    );
    if (rows.length !== 1 || !rows[0].connection_id || (scope.connectionId && rows[0].connection_id !== scope.connectionId)) return null;
    const connection = await repos.connections.get(db, scope.workspaceId, rows[0].connection_id);
    if (!connection || connection.workspaceId !== scope.workspaceId || connection.status !== "verified" || connection.config.provider !== "azure" || connection.config.mode !== "oidc_web_identity" || connection.config.subscriptionId.toLowerCase() !== scope.subscriptionId.toLowerCase() || connection.config.region !== scope.region) return null;
    const bindings = connection.config.sourceStorage;
    if (!bindings || !Object.hasOwn(bindings, scope.environmentId)) return null;
    const binding = { ...bindings[scope.environmentId] };
    try { sourceStorageHost(binding, scope.subscriptionId); }
    catch { throw new AzureSourceStorageRefusedError("Trusted Azure source storage binding is invalid or outside this subscription."); }
    const resource = await repos.resources.getByAddress(db, scope.workspaceId, scope.environmentId, binding.resourceAddress);
    const observation = resource ? await repos.observations.latestObservation(db, scope.workspaceId, resource.id) : null;
    const externalId = observation ? observation.presence === "present" && !observation.simulated ? observation.externalId : undefined : resource?.externalId;
    if (!resource || resource.workspaceId !== scope.workspaceId || resource.environmentId !== scope.environmentId || resource.provider !== "azure" || resource.kind !== "object_store" || resource.ownership !== "managed" || resource.status === "deleted" || resource.region !== scope.region || externalId?.toLowerCase() !== binding.accountResourceId.toLowerCase() || (scope.resourceId && resource.id !== scope.resourceId)) {
      throw new AzureSourceStorageRefusedError("Trusted Azure source storage binding does not match an owned resource in the granted environment.");
    }
    return binding;
  };
}
