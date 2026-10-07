/**
 * Read-only Azure DNS deletion guard for the record sets our driver compiles.
 * Historical graph nodes select the zone, routed app and landing environment;
 * full ARM reads must confirm subscription, id and workspace/environment tags.
 * The companion asuid TXT is checked too: it shares the DNS node's ownership.
 * Errors and target values never escape. Contract evidence only, no live run.
 */
import { isIP } from "node:net";
import type { ResourceNode } from "@/lib/resources/types";
import { armClient, armTypeOf, ARM_ORIGIN, RESOURCES_API, inSubscription, type ArmResource, type ArmClient } from "./arm";
import { getById, props, type AzureCtx } from "./kit";
import { resolveNetwork } from "./compile-util";
import { API } from "./platform";
import { makeProof, type DnsAssessment } from "../dns-teardown-proof";

const unsafe = () => ({ safe: false, reason: "DNS target ownership could not be confirmed." });
const domain = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const name = value.toLowerCase().replace(/\.$/, "");
  return name.length <= 253 && name.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) ? name : undefined;
};

/** Refuse malformed pages and nextLinks that change the scoped list endpoint. */
async function list(ctx: AzureCtx, arm: ArmClient, path: string, apiVersion: string, query?: Record<string, string>): Promise<ArmResource[] | undefined> {
  const items: ArmResource[] = [];
  for (let page = 0; page < 5; page++) {
    const response = await arm.get<{ value?: ArmResource[]; nextLink?: unknown }>(path, { apiVersion, query });
    const values = response.body.value;
    if (!Array.isArray(values) || !values.every((r) => r && typeof r.id === "string" && typeof r.name === "string" && typeof r.type === "string" && inSubscription(r.id, ctx.session.subscriptionId))) return undefined;
    items.push(...values);
    const next = response.body.nextLink;
    if (next === undefined || next === "") return items;
    if (typeof next !== "string") return undefined;
    const url = new URL(next);
    if (url.origin !== ARM_ORIGIN || url.pathname.toLowerCase() !== path.toLowerCase() || url.hash || url.username || url.password) return undefined;
    if (url.searchParams.has("api-version") && url.searchParams.get("api-version") !== apiVersion) return undefined;
    query = Object.fromEntries([...url.searchParams].filter(([key]) => key !== "api-version"));
  }
  return undefined;
}

export async function assessRecordDeletion(ctx: AzureCtx, node: ResourceNode, nodes: readonly ResourceNode[]): Promise<DnsAssessment> {
  try {
    if (ctx.provider !== "azure" || node.provider !== "azure" || node.nativeType !== "azure:dns_record_set" || node.kind !== "dns_record" || node.ownership !== "managed" || node.spec.type !== "alias") return unsafe();
    const target = nodes.find((n) => n.address === node.spec.target);
    const zoneNode = nodes.find((n) => n.address === node.spec.zone);
    const host = domain(node.spec.name);
    const apex = domain(zoneNode?.spec.name);
    if (!host || !apex || (host !== apex && !host.endsWith(`.${apex}`)) || zoneNode?.provider !== "azure" || zoneNode.nativeType !== "azure:dns_zone") return unsafe();
    if (!target || target.provider !== "azure" || target.ownership !== "managed") return unsafe();
    const staticSite = target.kind === "static_site" && target.nativeType === "azure:static_web_app";
    if (!staticSite && (target.kind !== "load_balancer" || target.nativeType !== "azure:application_gateway")) return unsafe();
    const arm = armClient(ctx.session, ctx.signal);
    const owns = (r: ArmResource, address: string, type: string) => inSubscription(r.id, ctx.session.subscriptionId) && armTypeOf(r.id) === type.toLowerCase() && r.tags?.["zenith:workspace"] === ctx.workspaceId && r.tags?.["zenith:environment"] === ctx.environmentId && r.tags?.["zenith:managed"] === "true" && r.tags?.["zenith:resource"] === address;
    const tagged = async (address: string, type: string, apiVersion: string): Promise<ArmResource | undefined> => {
      const n = nodes.find((n) => n.address === address);
      if (!n || n.provider !== "azure" || n.ownership !== "managed") return undefined;
      const resources = await list(ctx, arm, `/subscriptions/${ctx.session.subscriptionId}/resources`, RESOURCES_API, { $filter: `tagName eq 'zenith:resource' and tagValue eq '${address.replace(/'/g, "''")}'` });
      if (!resources) return undefined;
      const matches = resources.filter((r) => r.tags?.["zenith:resource"] === address && r.tags?.["zenith:environment"] === ctx.environmentId && r.type.toLowerCase() === type.toLowerCase());
      if (matches.length !== 1 || !owns(matches[0], address, type)) return undefined;
      const got = await getById(arm, matches[0].id, apiVersion);
      return got.state === "found" && got.resource.id.toLowerCase() === matches[0].id.toLowerCase() && owns(got.resource, address, type) ? got.resource : undefined;
    };
    const zones = await list(ctx, arm, `/subscriptions/${ctx.session.subscriptionId}/providers/Microsoft.Network/dnszones`, API.dns);
    if (!zones) return unsafe();
    const matches = zones.filter((z) => domain(z.name) === apex);
    if (matches.length !== 1) return unsafe();
    const zone = matches[0];
    if (!inSubscription(zone.id, ctx.session.subscriptionId) || armTypeOf(zone.id) !== "microsoft.network/dnszones" || (zoneNode.externalRef && zoneNode.externalRef.toLowerCase() !== zone.id.toLowerCase())) return unsafe();
    const rel = host === apex ? "@" : host.slice(0, -apex.length - 1);
    if (staticSite && rel === "@") return unsafe();
    const type = rel === "@" ? "A" : "CNAME";
    const recordId = `${zone.id}/${type}/${rel}`;
    if (node.externalRef && node.externalRef.toLowerCase() !== recordId.toLowerCase()) return unsafe();
    const record = await getById(arm, recordId, API.dns);
    if (record.state !== "missing" && (record.state !== "found" || record.resource.id.toLowerCase() !== recordId.toLowerCase() || !owns(record.resource, node.address, `Microsoft.Network/dnszones/${type}`))) return unsafe();
    // Resolve the actual endpoint, not the logical ingress node (which has no ARM resource).
    let endpoint: ArmResource | undefined;
    let environment: ArmResource | undefined;
    if (staticSite) {
      endpoint = await tagged(target.address, "Microsoft.Web/staticSites", "2023-12-01");
    } else {
      const routes = target.spec.routes;
      if (!Array.isArray(routes)) return unsafe();
      const route = routes.filter((r) => r && typeof r === "object" && domain(r.host) === host);
      if (route.length !== 1 || typeof route[0].target !== "string") return unsafe();
      const app = nodes.find((n) => n.address === route[0].target);
      if (app?.kind !== "container_service" || app.nativeType !== "azure:container_app") return unsafe();
      endpoint = await tagged(app.address, "Microsoft.App/containerApps", API.containerApps);
      const network = resolveNetwork(node, { node: (address) => nodes.find((n) => n.address === address), environmentId: ctx.environmentId, namePrefix: "unused", region: ctx.region, tags: ctx.tags, ref: () => { throw new Error("unused"); } });
      environment = await tagged(network, "Microsoft.App/managedEnvironments", API.containerApps);
      if (!environment || !endpoint || typeof props(endpoint).managedEnvironmentId !== "string" || String(props(endpoint).managedEnvironmentId).toLowerCase() !== environment.id.toLowerCase()) return unsafe();
    }
    if (!endpoint) return unsafe();
    if (record.state === "found") {
      const p = props(record.resource);
      if (type === "CNAME") {
        const config = props(endpoint).configuration as { ingress?: { fqdn?: unknown } } | undefined;
        const expected = domain(staticSite ? props(endpoint).defaultHostname : config?.ingress?.fqdn);
        const actual = domain((p.CNAMERecord as { cname?: unknown } | undefined)?.cname);
        if (!expected || actual !== expected) return unsafe();
      } else {
        const expected = environment && props(environment).staticIp;
        if (typeof expected !== "string" || isIP(expected) !== 4 || !Array.isArray(p.ARecords) || p.ARecords.length === 0 || !p.ARecords.every((r) => r && typeof r === "object" && r.ipv4Address === expected)) return unsafe();
      }
    }
    const markers: string[] = ["azure:record_tags", "azure:endpoint_tags", "azure:zone_in_subscription"];
    const live: string[] = [];
    if (record.state === "found") {
      const p = props(record.resource);
      if (type === "CNAME") live.push(String((p.CNAMERecord as { cname?: unknown } | undefined)?.cname).toLowerCase().replace(/\.$/, ""));
      else for (const r of p.ARecords as { ipv4Address?: unknown }[]) live.push(String(r.ipv4Address));
      markers.push("azure:value_matches_endpoint");
    }
    if (!staticSite) {
      const txtId = `${zone.id}/TXT/${rel === "@" ? "asuid" : `asuid.${rel}`}`;
      const txt = await getById(arm, txtId, API.dns);
      if (txt.state !== "missing") {
        if (txt.state !== "found" || txt.resource.id.toLowerCase() !== txtId.toLowerCase() || !owns(txt.resource, node.address, "Microsoft.Network/dnszones/TXT")) return unsafe();
        const expected = environment && props(environment).customDomainConfiguration as { customDomainVerificationId?: unknown } | undefined;
        const value = expected?.customDomainVerificationId;
        const records = props(txt.resource).TXTRecords;
        if (typeof value !== "string" || value.length === 0 || !Array.isArray(records) || records.length !== 1 || !Array.isArray(records[0]?.value) || !records[0].value.every((v: unknown) => typeof v === "string") || records[0].value.join("") !== value) return unsafe();
        markers.push("azure:asuid_txt_marker");
      }
    }
    return { safe: true, reason: "The DNS record sets are absent or point to scoped managed endpoints.", proof: makeProof({ provider: "azure", address: node.address, zone: apex, name: host, type, disposition: record.state === "found" ? "present" : "absent", values: live, ownership: markers, stateMatch: node.externalRef ? "externalRef" : "unrecorded" }) };
  } catch {
    return unsafe();
  }
}
