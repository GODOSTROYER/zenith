/**
 * Read-only Cloud DNS deletion guard. Every live A value must equal the IP of
 * the historical managed target's primary, scoped forwarding rule. Labels,
 * project identity and complete unique searches are required; unreadable or
 * malformed data fails closed. Only fixed reasons escape this broker callback.
 * Contract-tested with fake REST responses; no live cloud verification.
 */
import { isIP } from "node:net";
import type { GcpSession } from "@/lib/credentials/types";
import type { DriverContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { COMPUTE } from "./driver-util";
import { gcpLabels } from "./naming";
import { computePath, rec } from "./read-kit";
import { gcpGet, MAX_LIST_PAGES, type RestContext } from "./rest";
import { DNS } from "./drivers/edge/dns-managed-zone";

const unsafe = () => ({ safe: false, reason: "DNS target ownership could not be confirmed." });
const domain = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const name = value.toLowerCase().replace(/\.$/, "");
  return name.length <= 253 && name.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) ? name : undefined;
};

/** Ownership needs complete well-formed pages, not a best-effort inventory. */
async function list(ctx: RestContext, url: string, key: string): Promise<Record<string, unknown>[] | undefined> {
  const items: Record<string, unknown>[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await gcpGet(ctx, token ? `${url}&pageToken=${encodeURIComponent(token)}` : url);
    const values = result.json[key];
    if (result.outcome !== "ok" || !Array.isArray(values) || !values.every((v) => v !== null && typeof v === "object" && !Array.isArray(v))) return undefined;
    items.push(...values);
    const next = result.json.nextPageToken;
    if (next === undefined || next === "") return items;
    if (typeof next !== "string") return undefined;
    token = next;
  }
  return undefined;
}

export async function assessRecordDeletion(ctx: DriverContext<GcpSession>, node: ResourceNode, nodes: readonly ResourceNode[]): Promise<{ safe: boolean; reason: string }> {
  try {
    if (ctx.provider !== "gcp" || node.provider !== "gcp" || node.nativeType !== "gcp:dns_record_set" || node.kind !== "dns_record" || node.ownership !== "managed" || node.spec.type !== "alias") return unsafe();
    const target = nodes.find((n) => n.address === node.spec.target);
    const zoneNode = nodes.find((n) => n.address === node.spec.zone);
    const host = domain(node.spec.name);
    const apex = domain(zoneNode?.spec.name);
    if (!host || !apex || (host !== apex && !host.endsWith(`.${apex}`)) || zoneNode?.provider !== "gcp" || zoneNode.nativeType !== "gcp:dns_managed_zone") return unsafe();
    if (!target || target.provider !== "gcp" || target.kind !== "load_balancer" || target.nativeType !== "gcp:global_http_lb" || target.ownership !== "managed") return unsafe();
    const project = ctx.session.projectId;
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) return unsafe();
    const zones = await list(ctx, `${DNS}/projects/${project}/managedZones?maxResults=100`, "managedZones");
    if (!zones || !zones.every((z) => typeof z.name === "string" && domain(z.dnsName) !== undefined)) return unsafe();
    const matches = zones.filter((z) => domain(z.dnsName) === apex);
    if (matches.length !== 1 || typeof matches[0].name !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(matches[0].name)) return unsafe();
    const zone = matches[0].name;
    // A stored record id must agree with the declared zone, never select another.
    const recordId = `projects/${project}/managedZones/${zone}/rrsets/${host}./A`;
    if (node.externalRef !== undefined && node.externalRef !== recordId) return unsafe();
    if (zoneNode.externalRef !== undefined && zoneNode.externalRef !== `projects/${project}/managedZones/${zone}` && zoneNode.externalRef !== zone) return unsafe();
    const record = await gcpGet(ctx, `${DNS}/${recordId}`);
    if (record.outcome === "missing") return { safe: true, reason: "The record is absent in the readable zone." };
    if (record.outcome !== "ok" || domain(record.json.name) !== host || record.json.type !== "A" || !Array.isArray(record.json.rrdatas) || record.json.rrdatas.length === 0) return unsafe();
    const values: unknown[] = record.json.rrdatas;
    if (!values.every((v) => typeof v === "string" && isIP(v) === 4)) return unsafe();
    const expected = gcpLabels({ "zenith:workspace": ctx.workspaceId, "zenith:environment": ctx.environmentId, "zenith:managed": "true", "zenith:resource": target.address });
    const owns = (rule: Record<string, unknown>) => Object.entries(expected).every(([key, value]) => rec(rule.labels)[key] === value);
    const rules = await list(ctx, `${COMPUTE}/projects/${project}/global/forwardingRules?maxResults=500`, "items");
    if (!rules || !rules.every((r) => typeof r.selfLink === "string")) return unsafe();
    const owned = rules.filter(owns);
    if (owned.length !== 1 || typeof owned[0].selfLink !== "string") return unsafe();
    const id = computePath(owned[0].selfLink);
    if (!new RegExp(`^projects/${project}/global/forwardingRules/[a-z][a-z0-9-]{0,62}$`).test(id)) return unsafe();
    const live = await gcpGet(ctx, `${COMPUTE}/${id}`);
    if (live.outcome !== "ok" || !owns(live.json) || live.json.selfLink !== owned[0].selfLink || live.json.loadBalancingScheme !== "EXTERNAL_MANAGED") return unsafe();
    const ip = live.json.IPAddress;
    if (typeof ip !== "string" || isIP(ip) !== 4 || !values.every((v) => v === ip)) return unsafe();
    return { safe: true, reason: "Every record value points to the scoped managed load balancer." };
  } catch {
    return unsafe();
  }
}
