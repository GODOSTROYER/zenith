/**
 * `azure:subnet` — the portable `subnet/<tier>-<zone>` nodes.
 *
 * Each becomes a plain `azurerm_subnet` with `spec.cidr` and its own network
 * security group, inside the environment VNet. Two honest facts about the
 * mapping:
 *
 *   - Azure subnets are regional, not zonal. The portable node's `zone`
 *     (`a`/`b`/`c`) only distinguishes the address range; zone placement of
 *     zonal resources is decided by the resource (PostgreSQL HA, Redis zones),
 *     not by the subnet.
 *   - The subnets the Azure services actually need (Container Apps
 *     infrastructure, PostgreSQL delegated, private endpoints) are DEDICATED
 *     and delegated, which a role-less portable subnet cannot express. They are
 *     declared by the network node (see `network.ts`); the subnets here are
 *     the address space expansion asked for, available for workloads Zenith
 *     places in them later (VMs, AKS node pools).
 *
 * Non-taggable: the subnet is found through its tagged parent VNet and read by
 * its prefix-free scoped name.
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { SubnetSpec } from "@/lib/resources/specs";
import { block, fragment, mergeBlocks, requireNode, specOf } from "@/lib/providers/azure/compile-util";
import { exportLocals, exportRef } from "@/lib/providers/azure/exports";
import { defineAzureDriver, findTagged, getById, pick, props, unknownRead, type AzureCtx, type Located } from "@/lib/providers/azure/kit";
import { armClient } from "@/lib/providers/azure/arm";
import { azureTags, scopedName, tfLabel } from "@/lib/providers/azure/naming";
import { API } from "@/lib/providers/azure/platform";

export const SUBNET_NAME_MAX = 80;

export function compileSubnet(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const spec = specOf<SubnetSpec>(node);
  const a = node.address;
  requireNode(ctx, spec.network, "the subnet's network", a);
  const L = (part: string) => tfLabel(a, part);
  const name = scopedName(a, { max: SUBNET_NAME_MAX });
  const rg = exportRef(spec.network, "rg_name");
  const resource = mergeBlocks(
    block("azurerm_subnet", L("snet"), {
      name,
      resource_group_name: rg,
      virtual_network_name: exportRef(spec.network, "vnet_name"),
      address_prefixes: [spec.cidr],
    }),
    block("azurerm_network_security_group", L("nsg"), {
      name: scopedName(a, { max: SUBNET_NAME_MAX, suffix: "nsg" }),
      location: node.region,
      resource_group_name: rg,
      tags: azureTags(ctx, node),
    }),
    block("azurerm_subnet_network_security_group_association", L("assoc"), {
      subnet_id: `\${azurerm_subnet.${L("snet")}.id}`,
      network_security_group_id: `\${azurerm_network_security_group.${L("nsg")}.id}`,
    })
  );
  return fragment({ resource, locals: exportLocals(a, { id: `\${azurerm_subnet.${L("snet")}.id}`, name: `\${azurerm_subnet.${L("snet")}.name}` }) });
}

/** Find the subnet under its tagged VNet. */
async function locateSubnet(ctx: AzureCtx, node: ResourceNode, externalId?: string): Promise<Located> {
  const arm = armClient(ctx.session, ctx.signal);
  if (externalId) return getById(arm, externalId, API.network);
  const spec = specOf<SubnetSpec>(node);
  const found = await findTagged(ctx, spec.network, arm, "Microsoft.Network/virtualNetworks");
  if (!("matches" in found)) return found;
  if (found.matches.length === 0) return { state: "missing" };
  if (found.matches.length > 1) return { state: "unknown", detail: `ambiguous: ${found.matches.length} virtual networks carry the tags of ${spec.network}` };
  return getById(arm, `${found.matches[0].id}/subnets/${scopedName(node.address, { max: SUBNET_NAME_MAX })}`, API.network);
}

export const subnetDriver = defineAzureDriver({
  id: "azure.subnet@1",
  kind: "subnet",
  nativeType: "azure:subnet",
  locate: locateSubnet,
  compile: compileSubnet,
  expected: (node) => ({ cidr: specOf<SubnetSpec>(node).cidr }),
  read: (res) => {
    const single = pick<string>(props(res), "addressPrefix");
    const many = pick<string[]>(props(res), "addressPrefixes");
    if (single) return { cidr: single };
    if (Array.isArray(many) && many.length === 1) return { cidr: many[0] };
    return { cidr: unknownRead("not_inspected", "no address prefix in the response") };
  },
  native: (res) => ({ provisioningState: props(res).provisioningState, nsg: pick(props(res), "networkSecurityGroup", "id"), delegations: pick(props(res), "delegations") }),
});
