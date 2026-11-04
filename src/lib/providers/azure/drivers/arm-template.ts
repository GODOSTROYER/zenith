/**
 * Secret-free ARM resources managed by pinned AzureRM template deployments.
 * Some dedicated AzureRM resources fetch publishing keys or kubeconfig during
 * refresh. Incremental templates avoid those calls without introducing an
 * unpinned provider or native lifecycle writes. AzureRM's default template
 * deletion removes the declared nested resource; never disable that feature.
 * All values are ARM parameters (external bracket strings are data). Only
 * resource ID and hostname are outputs; no list* expressions are permitted.
 * Trade-off: OpenTofu plans template changes, not individual ARM properties;
 * driver observe/verify supplies comparison of the provider configuration.
 */
import type { CompileContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { block } from "@/lib/providers/azure/compile-util";
import { exportRef } from "@/lib/providers/azure/exports";
import { cloudName, tfLabel } from "@/lib/providers/azure/naming";
import { tfLiteral } from "@/lib/providers/azure/drivers/more-util";

export function armTemplate(node: ResourceNode, ctx: CompileContext, network: string, input: {
  type: "Microsoft.Web/sites" | "Microsoft.Web/staticSites" | "Microsoft.ContainerService/managedClusters";
  apiVersion: string;
  name: string;
  properties: Record<string, unknown>;
  identity: Record<string, unknown>;
  tags: Record<string, string>;
  sku?: Record<string, unknown>;
  kind?: string;
  hostnameProperty: "defaultHostname" | "defaultHostName" | "privateFQDN";
  dependsOn?: string[];
  children?: Record<string, unknown>[];
}) {
  const label = tfLabel(node.address, "deployment");
  const addr = `azurerm_resource_group_template_deployment.${label}`;
  const tags = Object.fromEntries(Object.entries(input.tags).map(([key, value]) => [tfLiteral(key), tfLiteral(value)]));
  const values: Record<string, unknown> = { name: input.name, location: tfLiteral(node.region), properties: input.properties, identity: input.identity, tags, ...(input.sku ? { sku: input.sku } : {}), ...(input.kind ? { kind: input.kind } : {}) };
  const template = {
    $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
    contentVersion: "1.0.0.0",
    parameters: Object.fromEntries(Object.keys(values).map((key) => [key, { type: typeof values[key] === "string" ? "string" : "object" }])),
    resources: [{ type: input.type, apiVersion: input.apiVersion, ...Object.fromEntries(Object.keys(values).map((key) => [key, `[parameters('${key}')]`])), ...(input.children ? { resources: input.children } : {}) }],
    outputs: {
      resourceId: { type: "string", value: `[resourceId('${input.type}', parameters('name'))]` },
      hostname: { type: "string", value: `[reference(resourceId('${input.type}', parameters('name')), '${input.apiVersion}').${input.hostnameProperty}]` },
    },
  };
  return {
    resource: block("azurerm_resource_group_template_deployment", label, {
      name: cloudName(ctx, node.address, { max: 64, suffix: "deploy" }), resource_group_name: exportRef(network, "rg_name"),
      deployment_mode: "Incremental", template_content: JSON.stringify(template),
      parameters_content: JSON.stringify(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]))),
      ...(input.dependsOn?.length ? { depends_on: input.dependsOn } : {}),
    }),
    id: `\${jsondecode(${addr}.output_content).resourceId.value}`,
    fqdn: `\${jsondecode(${addr}.output_content).hostname.value}`,
    name: input.name,
  };
}
