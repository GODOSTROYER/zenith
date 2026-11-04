/**
 * `azure:storage_container` — portable `object_store`: one storage ACCOUNT
 * (the taggable, billable, network-scoped unit) holding one blob CONTAINER.
 *
 * Posture (asserted by tests):
 *   - https only, minimum TLS 1.2, no anonymous access
 *     (`allow_nested_items_to_be_public = false`, container `private`);
 *   - SHARED KEY ACCESS DISABLED (`shared_access_key_enabled = false`): access
 *     is Entra ID only, through role assignments from `identity/*` grants
 *     (Storage Blob Data Reader / Contributor on this container). No account
 *     key or connection string is ever produced or referenced. The azurerm
 *     provider must therefore run with `storage_use_azuread` — the session's
 *     `childProcessEnv()` sets `ARM_STORAGE_USE_AZUREAD=true`;
 *   - PRIVATE ONLY: public network access disabled, default network action
 *     Deny, private endpoint for `blob` in the landing zone's endpoint subnet;
 *   - versioning = `spec.versioning`; 7-day soft delete for blobs/containers;
 *   - replication LRS unless `config.replication` ∈ {LRS, ZRS, GRS, GZRS};
 *   - `prevent_destroy` + `CanNotDelete` lock unless `deletionPolicy: allow`.
 *
 * Observation reads the account plus the blob service (versioning) and the
 * container, all through ARM; nothing touches the data plane.
 *
 * Honest limit: whether azurerm 5.x avoids data-plane calls for an account
 * whose public network access is disabled, when the runner is outside the
 * VNet, has not been verified live (contract + `tofu validate` only).
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { ObjectStoreSpec } from "@/lib/resources/specs";
import { AzureCompileError, block, configString, fragment, mergeBlocks, resolveNetwork, specOf } from "@/lib/providers/azure/compile-util";
import { exportLocals, exportRef } from "@/lib/providers/azure/exports";
import { defineAzureDriver, getById, locateByTags, pick, props, type AzureCtx, type Located } from "@/lib/providers/azure/kit";
import { armClient, type ArmResource, type Json } from "@/lib/providers/azure/arm";
import { azureTags, cloudName, scopedName, tfLabel } from "@/lib/providers/azure/naming";
import { API } from "@/lib/providers/azure/platform";
import { deletionLock, privateEndpoint, protectFromDestroy } from "@/lib/providers/azure/drivers/data/private-endpoint";

export const STORAGE_ACCOUNT = { type: "Microsoft.Storage/storageAccounts", apiVersion: API.storage } as const;

const REPLICATION = new Set(["LRS", "ZRS", "GRS", "GZRS"]);
export const containerName = (address: string): string => scopedName(address, { max: 63 }).replace(/^-+/, "c-").padEnd(3, "0");

export function replicationOf(node: ResourceNode): string {
  const r = configString(node, "replication")?.toUpperCase();
  if (r !== undefined && !REPLICATION.has(r)) throw new AzureCompileError(`config.replication must be one of ${[...REPLICATION].join(", ")}.`, node.address);
  return r ?? "LRS";
}

export function compileStorage(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const spec = specOf<ObjectStoreSpec>(node);
  const a = node.address;
  const net = resolveNetwork(node, ctx);
  const L = (part: string) => tfLabel(a, part);
  const acct = `azurerm_storage_account.${L("acct")}`;
  const resource = mergeBlocks(
    block("azurerm_storage_account", L("acct"), {
      name: cloudName(ctx, a, { max: 24, sep: "" }),
      location: node.region,
      resource_group_name: exportRef(net, "rg_name"),
      account_kind: "StorageV2",
      account_tier: "Standard",
      account_replication_type: replicationOf(node),
      https_traffic_only_enabled: true,
      min_tls_version: "TLS1_2",
      allow_nested_items_to_be_public: false,
      shared_access_key_enabled: false,
      default_to_oauth_authentication: true,
      cross_tenant_replication_enabled: false,
      local_user_enabled: false,
      sftp_enabled: false,
      is_hns_enabled: false,
      public_network_access: "Disabled",
      network_rules: { default_action: "Deny", bypass: ["AzureServices"] },
      blob_properties: {
        versioning_enabled: Boolean(spec.versioning),
        delete_retention_policy: { days: 7 },
        container_delete_retention_policy: { days: 7 },
      },
      tags: azureTags(ctx, node),
      lifecycle: { prevent_destroy: protectFromDestroy(spec.deletionPolicy) },
    }),
    block("azurerm_storage_container", L("ctr"), { name: containerName(a), storage_account_id: `\${${acct}.id}`, container_access_type: "private" }),
    privateEndpoint({ node, ctx, network: net, targetId: `\${${acct}.id}`, subresource: "blob", zone: "dns_blob_id" }),
    deletionLock(node, `\${${acct}.id}`, spec.deletionPolicy)
  );
  return fragment({
    resource,
    locals: exportLocals(a, {
      id: `\${${acct}.id}`,
      name: `\${${acct}.name}`,
      resource_manager_id: `\${azurerm_storage_container.${L("ctr")}.id}`,
    }),
  });
}

/* --------------------------------- observe ---------------------------------- */

async function locateStorage(ctx: AzureCtx, node: ResourceNode, externalId?: string): Promise<Located> {
  const found = await locateByTags(ctx, node, STORAGE_ACCOUNT, externalId);
  if (found.state !== "found") return found;
  const arm = armClient(ctx.session, ctx.signal);
  const extra: Json = {};
  const blob = await getById(arm, `${found.resource.id}/blobServices/default`, API.storage);
  if (blob.state === "found") extra.zenithBlobService = props(blob.resource);
  const ctr = await getById(arm, `${found.resource.id}/blobServices/default/containers/${containerName(node.address)}`, API.storage);
  extra.zenithContainerState = ctr.state;
  if (ctr.state === "found") extra.zenithContainer = props(ctr.resource);
  return { state: "found", resource: { ...found.resource, properties: { ...props(found.resource), ...extra } } };
}

export function expectedStorage(node: ResourceNode): Record<string, unknown> {
  const spec = specOf<ObjectStoreSpec>(node);
  return {
    versioning: Boolean(spec.versioning),
    httpsOnly: true,
    minimumTls: "TLS1_2",
    anonymousAccess: false,
    sharedKeyAccess: false,
    publicNetworkAccess: "Disabled",
  };
}

function readStorage(res: ArmResource): Record<string, unknown> {
  const p = props(res);
  const versioning = pick<boolean>(p, "zenithBlobService", "isVersioningEnabled");
  return {
    versioning: versioning ?? (pick(p, "zenithBlobService") === undefined ? undefined : false),
    httpsOnly: pick<boolean>(p, "supportsHttpsTrafficOnly"),
    minimumTls: pick<string>(p, "minimumTlsVersion"),
    anonymousAccess: pick<boolean>(p, "allowBlobPublicAccess"),
    sharedKeyAccess: pick<boolean>(p, "allowSharedKeyAccess"),
    publicNetworkAccess: pick<string>(p, "publicNetworkAccess"),
  };
}

export const storageDriver = defineAzureDriver({
  id: "azure.storage_container@1",
  kind: "object_store",
  nativeType: "azure:storage_container",
  arm: STORAGE_ACCOUNT,
  locate: locateStorage,
  compile: compileStorage,
  expected: expectedStorage,
  read: readStorage,
  native: (res) => ({
    provisioningState: props(res).provisioningState,
    primaryBlobEndpoint: pick(props(res), "primaryEndpoints", "blob"),
    container: props(res).zenithContainerState,
    encryptionBlob: pick(props(res), "encryption", "services", "blob", "enabled"),
  }),
  checks: (_ctx, _node, res) => {
    const state = props(res).zenithContainerState;
    return [{ id: "container", description: "the blob container exists", passed: state === "found" ? true : state === "missing" ? false : "unknown", detail: `container ${String(state ?? "not read")}` }];
  },
});
