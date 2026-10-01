/**
 * Read-only OCI DNS deletion guard using the broker's runner transport.
 * A readable exact compartment zone is required even for a missing rrset;
 * every A value must match the uniquely tagged managed historical LB. Complete
 * pagination, full LB identity and scoped tags are required. Fixed reasons
 * contain neither cloud values nor transport errors. Contract evidence only.
 */
import { isIP } from "node:net";
import type { DriverContext } from "@/lib/drivers/types";
import type { OciSession } from "@/lib/credentials/types";
import type { ResourceNode } from "@/lib/resources/types";
import { asRecord, listAll, tagsOf } from "./observe-kit";
import { isOcid, ociPath } from "./services";
import { ociCall } from "./transport";

const unsafe = () => ({ safe: false, reason: "DNS target ownership could not be confirmed." });
// DNS zone OCIDs contain a hyphen in their resource type; the generic OCI
// helper accepts only underscore/alphanumeric resource types.
const zoneId = (value: unknown): value is string => typeof value === "string" && /^ocid1\.dns-zone\.[a-z0-9]+\.[a-z0-9-]*\.[A-Za-z0-9]{6,120}$/.test(value);
const domain = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const name = value.toLowerCase().replace(/\.$/, "");
  return name.length <= 253 && name.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) ? name : undefined;
};
const collection = (body: unknown): unknown[] => {
  const items = Array.isArray(body) ? body : asRecord(body)?.items;
  if (!Array.isArray(items) || !items.every((item) => asRecord(item) !== undefined)) throw new Error("invalid collection");
  return items;
};

export async function assessRecordDeletion(ctx: DriverContext<OciSession>, node: ResourceNode, nodes: readonly ResourceNode[]): Promise<{ safe: boolean; reason: string }> {
  try {
    if (ctx.provider !== "oci" || ctx.session.scope.workspaceId !== ctx.workspaceId || ctx.session.scope.environmentId !== ctx.environmentId || node.provider !== "oci" || node.kind !== "dns_record" || node.nativeType !== "oci:dns_rrset" || node.ownership !== "managed" || node.spec.type !== "alias") return unsafe();
    const target = nodes.find((n) => n.address === node.spec.target);
    const zoneNode = nodes.find((n) => n.address === node.spec.zone);
    const host = domain(node.spec.name);
    const apex = domain(zoneNode?.spec.name);
    if (!host || !apex || (host !== apex && !host.endsWith(`.${apex}`)) || zoneNode?.provider !== "oci" || zoneNode.nativeType !== "oci:dns_zone") return unsafe();
    if (!target || target.provider !== "oci" || target.kind !== "load_balancer" || target.nativeType !== "oci:load_balancer" || target.ownership !== "managed") return unsafe();
    const region = node.region || ctx.region;
    if (target.region !== region || !isOcid(ctx.session.compartmentOcid)) return unsafe();
    const query = { compartmentId: ctx.session.compartmentOcid, scope: "GLOBAL" };
    const zone = await ociCall(ctx, { service: "dns", region, method: "GET", path: ociPath("dns", "zones", apex), query });
    const z = zone.ok && asRecord(zone.body);
    if (!z || domain(z.name) !== apex || z.compartmentId !== ctx.session.compartmentOcid || !zoneId(z.id) || (zoneNode.externalRef && zoneNode.externalRef !== z.id)) return unsafe();
    // Zone names keep the runner's existing trusted name-to-compartment binding.
    const path = ociPath("dns", "zones", apex, "records", host, "A");
    if (node.externalRef !== undefined && node.externalRef !== `${apex}/${host}/A`) return unsafe();
    const records = await listAll(ctx, { service: "dns", region, method: "GET", path, query }, collection);
    // A failure on any page cannot prove absence (OCI's 404 is ambiguous).
    if (!records.ok) return unsafe();
    if (records.truncated) return unsafe();
    if (records.items.length === 0) return { safe: true, reason: "The record is absent in the readable compartment zone." };
    const values = records.items.map((item) => asRecord(item)!);
    if (!values.every((r) => domain(r.domain) === host && r.rtype === "A" && typeof r.rdata === "string" && isIP(r.rdata) === 4)) return unsafe();
    const owns = (r: Record<string, unknown>) => {
      const tags = tagsOf(r);
      return r.compartmentId === ctx.session.compartmentOcid && tags.zenith_workspace === ctx.workspaceId && tags.zenith_environment === ctx.environmentId && tags.zenith_managed === "true" && tags.zenith_resource === target.address;
    };
    const lbs = await listAll(ctx, { service: "loadbalancer", region, method: "GET", path: ociPath("loadbalancer", "loadBalancers"), query: { compartmentId: ctx.session.compartmentOcid } }, collection);
    if (!lbs.ok || lbs.truncated) return unsafe();
    if (!lbs.items.every((item) => isOcid(asRecord(item)?.id) && asRecord(item)?.compartmentId === ctx.session.compartmentOcid)) return unsafe();
    const matches = lbs.items.map((item) => asRecord(item)!).filter(owns);
    if (matches.length !== 1 || !isOcid(matches[0].id)) return unsafe();
    const live = await ociCall(ctx, { service: "loadbalancer", region, method: "GET", path: ociPath("loadbalancer", "loadBalancers", matches[0].id) });
    const lb = live.ok && asRecord(live.body);
    if (!lb || lb.id !== matches[0].id || !owns(lb) || lb.isPrivate !== false || lb.lifecycleState !== "ACTIVE" || !Array.isArray(lb.ipAddresses)) return unsafe();
    const ips = lb.ipAddresses.map((item) => asRecord(item));
    if (ips.length === 0 || !ips.every((ip) => typeof ip?.ipAddress === "string" && isIP(ip.ipAddress) === 4)) return unsafe();
    if (!values.every((r) => ips.some((ip) => ip?.ipAddress === r.rdata))) return unsafe();
    return { safe: true, reason: "Every record value points to the scoped managed load balancer." };
  } catch {
    return unsafe();
  }
}
