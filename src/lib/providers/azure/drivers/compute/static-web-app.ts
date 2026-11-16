/**
 * Standard Static Web Apps infrastructure with managed identity. Private by
 * default, with a private endpoint and an EXISTING partition-specific private
 * DNS zone (customer-owned and VNet-linked; avoids duplicate zone ownership
 * when multiple sites land in the same SWA partition). Public hosting needs an
 * explicit publicAccess=true. DNS nodes own CNAME + custom-domain binding.
 * No deployment token or repository credential is read/exported. Artifact
 * upload is not implemented: ARM provisioning is not evidence of a deployed
 * site, so runtime/serving verification stays unknown. Built pipelines for SWA
 * remain explicitly refused by acr-task.ts, which only builds containers.
 */
import { block, fragment, mergeBlocks, resolveNetwork } from "@/lib/providers/azure/compile-util";
import { exportLocals, exportRef } from "@/lib/providers/azure/exports";
import { azureTags, cloudName, tfLabel } from "@/lib/providers/azure/naming";
import { defineAzureDriver, props } from "@/lib/providers/azure/kit";
import { armIdSpec, boolSpec, readString, rejectCredentials, workloadIdentity } from "@/lib/providers/azure/drivers/more-util";
import { armTemplate } from "@/lib/providers/azure/drivers/arm-template";

export const STATIC_WEB_APP = { type: "Microsoft.Web/staticSites", apiVersion: "2023-12-01" } as const;

export const staticWebAppDriver = defineAzureDriver({
  id: "azure.static_web_app@1", kind: "static_site", nativeType: "azure:static_web_app", arm: STATIC_WEB_APP,
  compile: (node, ctx) => {
    rejectCredentials(node);
    const net = resolveNetwork(node, ctx);
    const identity = workloadIdentity(node, ctx);
    const isPublic = boolSpec(node, "publicAccess", false);
    const L = (p: string) => tfLabel(node.address, p);
    const tags = azureTags(ctx, node);
    const site = armTemplate(node, ctx, net, {
      type: STATIC_WEB_APP.type, apiVersion: STATIC_WEB_APP.apiVersion,
      name: cloudName(ctx, node.address, { max: 60, suffix: "site" }),
      properties: { publicNetworkAccess: isPublic ? "Enabled" : "Disabled", stagingEnvironmentPolicy: "Disabled" },
      sku: { name: "Standard", tier: "Standard" }, identity: { type: "UserAssigned", userAssignedIdentities: { [identity.id]: {} } },
      tags, hostnameProperty: "defaultHostname",
    });
    return fragment({ resource: mergeBlocks(
      site.resource,
      isPublic ? {} : block("azurerm_private_endpoint", L("pe"), {
        name: cloudName(ctx, node.address, { max: 80, suffix: "pe" }), location: node.region, resource_group_name: exportRef(net, "rg_name"), subnet_id: exportRef(net, "snet_pe_id"),
        private_service_connection: { name: "staticSites", private_connection_resource_id: site.id, subresource_names: ["staticSites"], is_manual_connection: false },
        private_dns_zone_group: { name: "default", private_dns_zone_ids: [armIdSpec(node, "privateDnsZoneId", "Microsoft.Network/privateDnsZones")] }, tags,
      })
    ), locals: exportLocals(node.address, { id: site.id, name: site.name, fqdn: site.fqdn }) });
  },
  expected: (node) => ({ publicNetworkAccess: boolSpec(node, "publicAccess", false) ? "Enabled" : "Disabled", sku: "Standard", identityType: "UserAssigned" }),
  read: (res) => ({ publicNetworkAccess: readString(props(res).publicNetworkAccess), sku: readString(res.sku?.name), identityType: readString(res.identity?.type) }),
  runtime: async () => ({ health: "unknown", counts: {}, signals: ["site_artifact_and_http_health_not_inspected"] }),
  serving: true,
  native: (res) => ({ provisioningState: props(res).provisioningState, defaultHostname: props(res).defaultHostname }),
});
