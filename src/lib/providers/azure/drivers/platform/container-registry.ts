/**
 * `azure:container_registry` — portable `container_registry` on Azure
 * Container Registry.
 *
 *   - admin user DISABLED (no shared username/password exists), anonymous pull
 *     disabled; access is Entra ID only: workload identities get `AcrPull`
 *     scoped to this registry (identity.ts), the deploy identity pushes via
 *     `AcrPush`-equivalent rights on builds run by the registry itself (ACR
 *     Tasks run as the registry);
 *   - Standard SKU. Premium (private link, retention policy, quarantine, zone
 *     redundancy, content trust) costs ~3× as much and is not selected
 *     implicitly; the registry keeps its public endpoint, protected by Entra
 *     authentication.
 *
 * `ContainerRegistrySpec.scanOnPush` is NOT realized here: ACR has no
 * per-registry scan switch; vulnerability scanning is Microsoft Defender for
 * Containers, a subscription-level plan this driver does not configure.
 * `verify` reports that check as `unknown` with the reason instead of passing
 * it. `immutableTags: false` is ACR's default and needs nothing.
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { block, fragment, resolveNetwork } from "@/lib/providers/azure/compile-util";
import { exportLocals, exportRef } from "@/lib/providers/azure/exports";
import { defineAzureDriver, pick, props } from "@/lib/providers/azure/kit";
import { azureTags, cloudName, tfLabel } from "@/lib/providers/azure/naming";
import { API } from "@/lib/providers/azure/platform";

export const CONTAINER_REGISTRY = { type: "Microsoft.ContainerRegistry/registries", apiVersion: API.containerRegistry } as const;

export function compileContainerRegistry(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const a = node.address;
  const net = resolveNetwork(node, ctx);
  const L = tfLabel(a, "acr");
  return fragment({
    resource: block("azurerm_container_registry", L, {
      name: cloudName(ctx, a, { max: 50, sep: "", suffix: "acr" }).padEnd(5, "0"),
      location: node.region,
      resource_group_name: exportRef(net, "rg_name"),
      sku: "Standard",
      admin_enabled: false,
      anonymous_pull_enabled: false,
      public_network_access_enabled: true,
      tags: azureTags(ctx, node),
    }),
    locals: exportLocals(a, {
      id: `\${azurerm_container_registry.${L}.id}`,
      name: `\${azurerm_container_registry.${L}.name}`,
      login_server: `\${azurerm_container_registry.${L}.login_server}`,
    }),
  });
}

export const containerRegistryDriver = defineAzureDriver({
  id: "azure.container_registry@1",
  kind: "container_registry",
  nativeType: "azure:container_registry",
  arm: CONTAINER_REGISTRY,
  compile: compileContainerRegistry,
  expected: () => ({ sku: "Standard", adminEnabled: false, anonymousPull: false }),
  read: (res) => ({
    sku: pick<string>(res.sku, "name"),
    adminEnabled: pick<boolean>(props(res), "adminUserEnabled"),
    anonymousPull: pick<boolean>(props(res), "anonymousPullEnabled") ?? false,
  }),
  native: (res) => ({ loginServer: props(res).loginServer, provisioningState: props(res).provisioningState, publicNetworkAccess: props(res).publicNetworkAccess }),
  checks: () => [
    {
      id: "scan_on_push",
      description: "images are scanned on push (spec.scanOnPush)",
      passed: "unknown" as const,
      detail: "ACR scanning is Microsoft Defender for Containers, a subscription-level plan this driver does not configure or read",
    },
  ],
});
