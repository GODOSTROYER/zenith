/**
 * `azure:dns_zone` — portable `dns_zone`, always REFERENCED: Zenith never
 * creates or changes a customer's zone. Compile reads it as a `data` source
 * (`data.azurerm_dns_zone`), by name and, when the node's `externalRef` is the
 * zone's ARM id, by resource group too (otherwise the provider finds the zone
 * by name within the subscription, which fails on ambiguity rather than
 * guessing). A MANAGED zone node is a compile error.
 *
 * Observe/discover read Azure DNS zones (`Microsoft.Network/dnszones`) by the
 * node's `externalRef` or, without one, by name. Customer zones are not Zenith
 * tagged, so the tag-based lookup used elsewhere does not apply here.
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { DnsZoneSpec } from "@/lib/resources/specs";
import { AzureCompileError, fragment, specOf } from "@/lib/providers/azure/compile-util";
import { exportLocals } from "@/lib/providers/azure/exports";
import { defineAzureDriver, getById, locatedFromError, pick, props, type AzureCtx, type Located } from "@/lib/providers/azure/kit";
import { armClient, inSubscription, parseArmId, type ArmResource } from "@/lib/providers/azure/arm";
import { tfLabel } from "@/lib/providers/azure/naming";
import { API } from "@/lib/providers/azure/platform";

export const DNS_ZONE = { type: "Microsoft.Network/dnszones", apiVersion: API.dns } as const;

const ZONE_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function compileDnsZone(node: ResourceNode, _ctx: CompileContext): TofuFragment {
  const spec = specOf<DnsZoneSpec>(node);
  const a = node.address;
  if (node.ownership === "managed") throw new AzureCompileError("Zenith never creates a customer's DNS zone; the node must be referenced.", a);
  if (!ZONE_NAME.test(spec.name)) throw new AzureCompileError(`"${spec.name.slice(0, 80)}" is not a DNS zone name.`, a);
  const L = tfLabel(a, "zone");
  const parsed = node.externalRef ? parseArmId(node.externalRef) : undefined;
  if (node.externalRef && (!parsed || parsed.provider?.toLowerCase() !== "microsoft.network" || parsed.segments[0]?.type !== "dnszones")) {
    throw new AzureCompileError("externalRef must be the ARM id of an Azure DNS zone.", a);
  }
  return fragment({
    data: { azurerm_dns_zone: { [L]: { name: spec.name, ...(parsed?.resourceGroup ? { resource_group_name: parsed.resourceGroup } : {}) } } },
    locals: exportLocals(a, {
      zone_name: `\${data.azurerm_dns_zone.${L}.name}`,
      zone_rg: `\${data.azurerm_dns_zone.${L}.resource_group_name}`,
      id: `\${data.azurerm_dns_zone.${L}.id}`,
    }),
  });
}

async function locateZone(ctx: AzureCtx, node: ResourceNode, externalId?: string): Promise<Located> {
  const arm = armClient(ctx.session, ctx.signal);
  const id = externalId ?? node.externalRef;
  if (id) {
    if (!inSubscription(id, ctx.session.subscriptionId)) return { state: "unknown", detail: "the zone is not in this subscription" };
    return getById(arm, id, API.dns);
  }
  try {
    const { items } = await arm.list<ArmResource>(`/subscriptions/${ctx.session.subscriptionId}/providers/Microsoft.Network/dnszones`, { apiVersion: API.dns }, 5);
    const name = specOf<DnsZoneSpec>(node).name.toLowerCase();
    const matches = items.filter((z) => z.name?.toLowerCase() === name);
    if (matches.length === 0) return { state: "missing" };
    if (matches.length > 1) return { state: "unknown", detail: `ambiguous: ${matches.length} zones named ${name} in the subscription` };
    return getById(arm, matches[0].id, API.dns);
  } catch (e) {
    return locatedFromError(e, false);
  }
}

export const dnsZoneDriver = defineAzureDriver({
  id: "azure.dns_zone@1",
  kind: "dns_zone",
  nativeType: "azure:dns_zone",
  arm: DNS_ZONE,
  locate: locateZone,
  compile: compileDnsZone,
  expected: (node) => ({ name: specOf<DnsZoneSpec>(node).name, private: false }),
  read: (res) => ({ name: res.name?.toLowerCase(), private: pick<string>(props(res), "zoneType") === undefined ? false : pick<string>(props(res), "zoneType") === "Private" }),
  native: (res) => ({ nameServers: props(res).nameServers, numberOfRecordSets: props(res).numberOfRecordSets }),
});
