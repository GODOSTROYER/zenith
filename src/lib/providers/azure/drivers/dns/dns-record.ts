/**
 * `azure:dns_record_set` — portable `dns_record` (`type: "alias"`) in a
 * REFERENCED Azure DNS zone.
 *
 * An alias to the load balancer means "this host reaches the Container Apps
 * ingress", realized the way Container Apps custom domains require:
 *   - subdomain → CNAME to the routed app's generated FQDN (the managed
 *     certificate flow needs the CNAME to point DIRECTLY at it);
 *   - zone apex → A record to the environment's static IP;
 *   - always a TXT `asuid[.<name>]` with the environment's custom-domain
 *     verification id, which proves ownership to Container Apps.
 * The routed app is found from the load balancer's routes (host → target);
 * a record whose host no route serves is a compile error.
 *
 * Record sets are taggable, but Azure DNS child resources are not reliably
 * listed by the tag search, so observe finds the zone (longest suffix of the
 * host among the subscription's zones) and reads the record set by name.
 * Expected attributes are the record type and TTL; the value (an FQDN or IP
 * known only after apply) is not compared.
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { DnsRecordSpec, DnsZoneSpec, LoadBalancerSpec } from "@/lib/resources/specs";
import { AzureCompileError, block, fragment, mergeBlocks, requireNode, resolveNetwork, specOf } from "@/lib/providers/azure/compile-util";
import { exportLocals, exportRef } from "@/lib/providers/azure/exports";
import { defineAzureDriver, getById, locatedFromError, pick, props, type AzureCtx, type Located } from "@/lib/providers/azure/kit";
import { armClient, type ArmResource } from "@/lib/providers/azure/arm";
import { azureTags, tfLabel } from "@/lib/providers/azure/naming";
import { API } from "@/lib/providers/azure/platform";

export const DNS_TTL = 300;

/** Record name relative to its zone: `@` for the apex. */
export function relativeName(host: string, zoneName: string, where?: string): string {
  const h = host.toLowerCase();
  const z = zoneName.toLowerCase();
  if (h === z) return "@";
  if (h.endsWith(`.${z}`)) return h.slice(0, h.length - z.length - 1);
  throw new AzureCompileError(`${host} is not inside zone ${zoneName}.`, where);
}

export function compileDnsRecord(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const spec = specOf<DnsRecordSpec>(node);
  const a = node.address;
  const zone = requireNode(ctx, spec.zone, "the record's zone", a);
  const zoneName = specOf<DnsZoneSpec>(zone).name;
  const lb = requireNode(ctx, spec.target, "the record's target", a);
  if (lb.kind !== "load_balancer" || lb.provider !== "azure") throw new AzureCompileError(`target ${spec.target} is not an Azure load balancer.`, a);
  const route = (specOf<LoadBalancerSpec>(lb).routes ?? []).find((r) => r.host.toLowerCase() === spec.name.toLowerCase());
  if (!route) throw new AzureCompileError(`no route of ${spec.target} serves ${spec.name}.`, a);
  const net = resolveNetwork(node, ctx);
  const rel = relativeName(spec.name, zoneName, a);
  const L = (part: string) => tfLabel(a, part);
  const tags = azureTags(ctx, node);
  const common = { zone_name: exportRef(spec.zone, "zone_name"), resource_group_name: exportRef(spec.zone, "zone_rg"), ttl: DNS_TTL, tags };
  const txt = block("azurerm_dns_txt_record", L("txt"), { ...common, name: rel === "@" ? "asuid" : `asuid.${rel}`, record: [{ value: exportRef(net, "cae_verification_id") }] });
  const address =
    rel === "@"
      ? block("azurerm_dns_a_record", L("a"), { ...common, name: "@", records: [exportRef(net, "cae_static_ip")] })
      : block("azurerm_dns_cname_record", L("cname"), { ...common, name: rel, record: exportRef(route.target, "fqdn") });
  return fragment({
    resource: mergeBlocks(address, txt),
    locals: exportLocals(a, { fqdn: rel === "@" ? `\${azurerm_dns_a_record.${L("a")}.fqdn}` : `\${azurerm_dns_cname_record.${L("cname")}.fqdn}` }),
  });
}

/* --------------------------------- observe ---------------------------------- */

async function zoneFor(ctx: AzureCtx, host: string): Promise<{ zone: ArmResource; rel: string } | Located> {
  const arm = armClient(ctx.session, ctx.signal);
  try {
    const { items } = await arm.list<ArmResource>(`/subscriptions/${ctx.session.subscriptionId}/providers/Microsoft.Network/dnszones`, { apiVersion: API.dns }, 5);
    const h = host.toLowerCase();
    const candidates = items.filter((z) => typeof z.name === "string" && (h === z.name.toLowerCase() || h.endsWith(`.${z.name.toLowerCase()}`))).sort((x, y) => y.name.length - x.name.length);
    if (candidates.length === 0) return { state: "missing" };
    const zone = candidates[0];
    return { zone, rel: relativeName(h, zone.name) };
  } catch (e) {
    return locatedFromError(e, false);
  }
}

async function locateRecord(ctx: AzureCtx, node: ResourceNode): Promise<Located> {
  const host = specOf<DnsRecordSpec>(node).name;
  const z = await zoneFor(ctx, host);
  if (!("zone" in z)) return z;
  const type = z.rel === "@" ? "A" : "CNAME";
  return getById(armClient(ctx.session, ctx.signal), `${z.zone.id}/${type}/${z.rel}`, API.dns);
}

export const dnsRecordDriver = defineAzureDriver({
  id: "azure.dns_record_set@1",
  kind: "dns_record",
  nativeType: "azure:dns_record_set",
  locate: (ctx, node) => locateRecord(ctx, node),
  compile: compileDnsRecord,
  expected: () => ({ ttl: DNS_TTL }),
  read: (res) => ({ ttl: pick<number>(props(res), "TTL") }),
  native: (res) => ({ fqdn: props(res).fqdn, cname: pick(props(res), "CNAMERecord", "cname"), aRecords: pick(props(res), "ARecords") }),
  checks: async (ctx, node) => {
    // the ownership TXT record next to the address record
    const host = specOf<DnsRecordSpec>(node).name;
    const z = await zoneFor(ctx, host);
    if (!("zone" in z)) return [{ id: "ownership_txt", description: "the asuid verification TXT record exists", passed: "unknown" as const, detail: z.state }];
    const got = await getById(armClient(ctx.session, ctx.signal), `${z.zone.id}/TXT/${z.rel === "@" ? "asuid" : `asuid.${z.rel}`}`, API.dns);
    return [{ id: "ownership_txt", description: "the asuid verification TXT record exists", passed: got.state === "found" ? true : got.state === "missing" ? false : ("unknown" as const), detail: got.state }];
  },
});
