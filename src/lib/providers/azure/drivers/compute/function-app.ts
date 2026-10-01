/**
 * Linux Azure Functions on a Dedicated Linux B1 plan (image workloads).
 * Flex Consumption does not run custom containers; the portable artifact is
 * an image, so this driver uses Linux Functions, without Azure Files or keys.
 * Private Blob/Queue host storage uses the workload UAI; Key Vault references
 * and ACR pulls use the same identity. Only reference URIs appear in settings.
 * The caller supplies a dedicated Microsoft.Web/serverFarms private subnet.
 * A private endpoint handles ingress; VNet integration handles egress.
 * Runtime's ARM Running state is not proof of function execution or health.
 */
import type { ResourceNode } from "@/lib/resources/types";
import type { ArtifactSpec, EnvEntry } from "@/lib/resources/specs";
import type { CompileContext } from "@/lib/drivers/types";
import { block, dependencies, fragment, mergeBlocks, resolveNetwork, requireNode } from "@/lib/providers/azure/compile-util";
import { exportLocals, exportRef } from "@/lib/providers/azure/exports";
import { azureTags, cloudName, nodeNameOf, tfLabel } from "@/lib/providers/azure/naming";
import { defineAzureDriver, props, pick } from "@/lib/providers/azure/kit";
import { privateEndpoint } from "@/lib/providers/azure/drivers/data/private-endpoint";
import { privateSubnet, workloadIdentity, invalid, rejectCredentials, tfLiteral, readString, readBool, textSpec } from "@/lib/providers/azure/drivers/more-util";
import { ROLE } from "@/lib/providers/azure/platform";
import { armTemplate } from "@/lib/providers/azure/drivers/arm-template";

export const FUNCTION_APP = { type: "Microsoft.Web/sites", apiVersion: "2024-04-01" } as const;

function image(node: ResourceNode, ctx: CompileContext) {
  const artifact = node.spec.artifact as ArtifactSpec | undefined;
  if (artifact?.type === "built") {
    if (!artifact.registry) invalid(node, "a built Function artifact needs a registry.");
    const registry = requireNode(ctx, artifact.registry, "the function image registry", node.address);
    if (registry.provider !== "azure" || registry.kind !== "container_registry") invalid(node, "built functions require an Azure container registry.");
    const pipeline = requireNode(ctx, artifact.pipeline, "the function image pipeline", node.address);
    if (pipeline.kind !== "build_pipeline" || pipeline.provider !== "azure") invalid(node, "the function pipeline must be an Azure build pipeline.");
    return { registry_url: `https://${exportRef(registry.address, "login_server")}`, image_name: nodeNameOf(node.address), image_tag: "latest" };
  }
  if (artifact?.type !== "image" || typeof artifact.ref !== "string") invalid(node, "Linux Functions requires a container image artifact.");
  // Explicit host and tag; private non-ACR registries need credentials and are refused.
  const match = /^([a-z0-9.-]+)\/([a-z0-9/_-]+):([A-Za-z0-9_.-]+)$/.exec(artifact.ref);
  if (!match || !(match[1] === "mcr.microsoft.com" || match[1].endsWith(".azurecr.io"))) invalid(node, "the function image must use a tagged MCR or ACR image.");
  return { registry_url: `https://${match[1]}`, image_name: match[2], image_tag: match[3] };
}

function appSettings(node: ResourceNode, ctx: CompileContext, clientId: string): Record<string, string> {
  const env = node.spec.env ?? [];
  if (!Array.isArray(env)) invalid(node, "env must be an array of literal values or secret references.");
  const out: Record<string, string> = { AzureWebJobsStorage__credential: "managedidentity", AzureWebJobsStorage__clientId: clientId };
  for (const entry of [...env as EnvEntry[]].sort((a, b) => String(a.key).localeCompare(String(b.key), "en"))) {
    if (!entry || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.key) || entry.key in out || /^(AzureWebJobs|WEBSITE_|FUNCTIONS_|DOCKER_)/i.test(entry.key)) invalid(node, "invalid, duplicate or reserved function environment key.");
    if ("secretRef" in entry) {
      if ("value" in entry || typeof entry.secretRef !== "string") invalid(node, "secret entries must carry only a reference.");
      const matches = dependencies(node, ctx, (n) => n.kind === "secret" && n.provider === "azure" && n.spec.secretRef === entry.secretRef);
      if (matches.length !== 1) invalid(node, "the function secret must be an unambiguous Azure dependency.");
      const secret = matches[0];
      const uri = secret.ownership === "managed" ? exportRef(secret.address, "secret_uri") : secret.externalRef;
      if (!uri || (secret.ownership !== "managed" && !/^https:\/\/[a-z0-9-]+\.vault\.azure\.net\/secrets\/[a-zA-Z0-9-]+(?:\/[a-f0-9]{32})?$/.test(uri))) invalid(node, "the function secret must be a Key Vault secret URI.");
      out[entry.key] = `@Microsoft.KeyVault(SecretUri=${uri})`;
    } else {
      if (typeof entry.value !== "string" || /secret|password|token|api.?key|connection.?string/i.test(entry.key)) invalid(node, "sensitive function settings require secret references.");
      out[entry.key] = tfLiteral(entry.value);
    }
  }
  return out;
}

export const functionAppDriver = defineAzureDriver({
  id: "azure.function_app@1", kind: "function", nativeType: "azure:function_app", arm: FUNCTION_APP,
  accepts: (res) => typeof res.kind === "string" && res.kind.toLowerCase().split(",").includes("functionapp"),
  compile: (node, ctx) => {
    rejectCredentials(node);
    const subnet = privateSubnet(node, ctx, "functions");
    const identity = workloadIdentity(node, ctx);
    const net = resolveNetwork(subnet, ctx);
    const L = (p: string) => tfLabel(node.address, p);
    const tags = azureTags(ctx, node);
    const common = { resource_group_name: exportRef(net, "rg_name"), location: node.region, tags };
    const acct = `azurerm_storage_account.${L("host")}`;
    const plan = textSpec(node, "instanceClass", "B1");
    if (!["B1", "B2", "B3", "P1v3", "P2v3", "P3v3"].includes(plan)) invalid(node, "function instanceClass must be a Dedicated Linux plan SKU.");
    const docker = image(node, ctx);
    const settings = appSettings(node, ctx, identity.clientId);
    settings.AzureWebJobsStorage__accountName = `\${${acct}.name}`;
    settings.FUNCTIONS_EXTENSION_VERSION = "~4";
    const app = armTemplate(node, ctx, net, {
      type: FUNCTION_APP.type, apiVersion: FUNCTION_APP.apiVersion, name: cloudName(ctx, node.address, { max: 32, suffix: "fn" }),
      kind: "functionapp,linux,container", identity: { type: "UserAssigned", userAssignedIdentities: { [identity.id]: {} } }, tags,
      hostnameProperty: "defaultHostName",
      children: ["ftp", "scm"].map((name) => ({ type: "basicPublishingCredentialsPolicies", apiVersion: FUNCTION_APP.apiVersion, name, properties: { allow: false }, dependsOn: ["[resourceId('Microsoft.Web/sites', parameters('name'))]"] })),
      properties: {
        serverFarmId: `\${azurerm_service_plan.${L("plan")}.id}`, reserved: true,
        keyVaultReferenceIdentity: identity.id, virtualNetworkSubnetId: exportRef(subnet.address, "id"), publicNetworkAccess: "Disabled", httpsOnly: true, vnetImagePullEnabled: true,
        siteConfig: { alwaysOn: true, minTlsVersion: "1.2", scmMinTlsVersion: "1.2", ftpsState: "Disabled", vnetRouteAllEnabled: true, acrUseManagedIdentityCreds: true, acrUserManagedIdentityID: identity.clientId,
          linuxFxVersion: `DOCKER|${docker.registry_url.slice("https://".length)}/${docker.image_name}:${docker.image_tag}`,
          appSettings: Object.entries(settings).map(([name, value]) => ({ name, value })),
        },
      },
      dependsOn: [`azurerm_role_assignment.${L("host_role_0")}`, `azurerm_role_assignment.${L("host_role_1")}`, `azurerm_private_endpoint.${L("pe_blob")}`, `azurerm_private_endpoint.${L("pe_queue")}`],
    });
    return fragment({ resource: mergeBlocks(
      block("azurerm_storage_account", L("host"), { ...common, name: cloudName(ctx, node.address, { max: 24, sep: "", suffix: "host" }), account_tier: "Standard", account_replication_type: "LRS", account_kind: "StorageV2", min_tls_version: "TLS1_2", https_traffic_only_enabled: true, shared_access_key_enabled: false, allow_nested_items_to_be_public: false, public_network_access_enabled: false, default_to_oauth_authentication: true }),
      ...(["blob", "queue"] as const).map((service) => privateEndpoint({ node: { ...node, address: node.address }, ctx, network: net, targetId: `\${${acct}.id}`, subresource: service, zone: service === "blob" ? "dns_blob_id" : "dns_queue_id" })),
      ...([ROLE.blobOwner, ROLE.storageQueueContributor]).map((role, i) => block("azurerm_role_assignment", L(`host_role_${i}`), { scope: `\${${acct}.id}`, role_definition_name: role, principal_id: exportRef(identity.address, "principal_id"), principal_type: "ServicePrincipal" })),
      block("azurerm_service_plan", L("plan"), { ...common, name: cloudName(ctx, node.address, { max: 40, suffix: "plan" }), os_type: "Linux", sku_name: plan }),
      app.resource,
      privateEndpoint({ node, ctx, network: net, targetId: app.id, subresource: "sites", zone: "dns_web_id" })
    ), locals: exportLocals(node.address, { id: app.id, name: app.name, fqdn: app.fqdn }) });
  },
  expected: () => ({ httpsOnly: true, publicNetworkAccess: "Disabled", identityType: "UserAssigned", vnetIntegrated: true, kind: "functionapp,linux,container" }),
  read: (res) => ({ httpsOnly: readBool(props(res).httpsOnly), publicNetworkAccess: readString(props(res).publicNetworkAccess), identityType: readString(res.identity?.type), vnetIntegrated: typeof props(res).virtualNetworkSubnetId === "string" ? true : props(res).virtualNetworkSubnetId === null ? false : undefined, kind: readString(res.kind) }),
  runtime: async (_ctx, _node, res) => ({ health: props(res).state === "Stopped" ? "unhealthy" : "unknown", counts: {}, signals: props(res).state === "Running" ? ["arm_running", "function_execution_not_inspected"] : ["function_state_not_ready"] }),
  checks: (_ctx, _node, res) => [{ id: "key_vault_identity", description: "Key Vault references use an attached user-assigned identity", passed: typeof props(res).keyVaultReferenceIdentity !== "string" ? "unknown" : pick(res.identity, "userAssignedIdentities", String(props(res).keyVaultReferenceIdentity)) !== undefined }],
  serving: true,
  native: (res) => ({ state: props(res).state, provisioningState: props(res).provisioningState }),
});
