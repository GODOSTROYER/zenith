/**
 * `gcp:firewall_rule` — one `FirewallSpec` (ingress, tcp, one port, from a
 * node or a CIDR, to a node) realized as a VPC firewall rule.
 *
 * What GCP can actually enforce differs by target, so the driver picks the
 * enforcement point and says so:
 *
 *   target is a taggable workload     INGRESS allow `source_tags`/`source_ranges`
 *                                     → `target_tags` (network tags are derived
 *                                     from node addresses: `networkTag()`)
 *   target is Cloud SQL / Memorystore EGRESS allow from the SOURCE workload's tag
 *                                     to the target's private IP /32 (priority
 *                                     1000). VPC firewalls do not filter traffic
 *                                     into Google-managed producer networks, so
 *                                     the enforceable control is the client's
 *                                     egress, backed by the network-wide egress
 *                                     deny to the PSA range (`gcp:vpc_network`)
 *   capability `public_http`          no VPC rule at all. Internet traffic
 *                                     reaches Cloud Run through the global
 *                                     external load balancer and a serverless
 *                                     NEG, which VPC firewalls do not govern.
 *                                     The node compiles to an empty fragment;
 *                                     `observe` reports `enforcedBy: "none"`
 *                                     rather than pretending a rule exists.
 *
 * Open sources (`0.0.0.0/0`, `::/0`) are refused for anything but
 * `public_http`. The network carries no `labels`; tags live in `description`.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import type { FirewallSpec } from "@/lib/resources/specs";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import { GcpCompileError } from "../../errors";
import { cloudName, networkTag, parseTagDescription, tagDescription, tfLabel } from "../../naming";
import { COMPUTE, computeGlobal, contractCapabilities, managedOnly, specOf } from "../../driver-util";
import { lit, ref } from "../../hcl";
import { arr, computePath, makeReaders, rec, str, tail, type ReadSpec } from "../../read-kit";
import { networkOf } from "./network-of";

export const DRIVER_ID = "gcp.firewall_rule@1";

const CIDR4 = /^(?:\d{1,3}\.){3}\d{1,3}\/(?:\d|[12]\d|3[0-2])$/;

/** `public_http` is served by the LB/serverless NEG path; VPC firewalls do not apply. */
export const isVirtualRule = (node: ResourceNode): boolean => specOf<FirewallSpec>(node).capability === "public_http";

function desiredAttributes(node: ResourceNode): Record<string, unknown> {
  if (isVirtualRule(node)) return { enforcedBy: "none" };
  const s = specOf<FirewallSpec>(node);
  return { protocol: s.protocol, port: s.port, disabled: false };
}

/** Foreign (`referenced`/`external`) nodes carry only declared attributes; Zenith demands no configuration of them. */
const expectedAttributes = managedOnly(desiredAttributes);

function compile(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const s = specOf<FirewallSpec>(node);
  if (node.ownership !== "managed") return { addresses: [] };
  if (isVirtualRule(node)) return { addresses: [] };
  if (s.protocol !== "tcp" || s.direction !== "ingress") throw new GcpCompileError("invalid_spec", `${node.address}: only ingress tcp rules are supported.`);
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) throw new GcpCompileError("invalid_spec", `${node.address}: port must be 1-65535.`);

  const target = ctx.node(s.target);
  if (!target) throw new GcpCompileError("unknown_target", `${node.address}: target ${lit(s.target)} is not in the graph.`);
  const network = networkOf(node, ctx, target);

  const L = tfLabel(node.address);
  const base: Record<string, unknown> = {
    name: cloudName(ctx.namePrefix, node.address, { max: 63 }),
    description: tagDescription(ctx.tags, node, lit(s.description ?? s.capability)),
    network: ref(ctx, network.address, "id"),
    priority: 1000,
    allow: [{ protocol: "tcp", ports: [String(s.port)] }],
  };

  const managedService = target.kind === "postgres" || target.kind === "mysql" || target.kind === "redis";
  let body: Record<string, unknown>;
  if (managedService) {
    if (!("address" in s.source)) throw new GcpCompileError("unsupported_source", `${node.address}: a CIDR source cannot be enforced toward ${target.kind}; name the client workload.`);
    const ip = ref(ctx, target.address, target.kind === "redis" ? "host" : "private_ip_address");
    body = {
      ...base,
      direction: "EGRESS",
      target_tags: [networkTag(s.source.address)],
      destination_ranges: [`${ip}/32`],
    };
  } else if ("address" in s.source) {
    body = { ...base, direction: "INGRESS", source_tags: [networkTag(s.source.address)], target_tags: [networkTag(s.target)] };
  } else {
    const cidr = s.source.cidr;
    if (cidr === "0.0.0.0/0" || cidr === "::/0") throw new GcpCompileError("open_source", `${node.address}: an open source is only allowed for public_http.`);
    if (!CIDR4.test(cidr)) throw new GcpCompileError("invalid_cidr", `${node.address}: "${lit(cidr)}" is not an IPv4 CIDR.`);
    body = { ...base, direction: "INGRESS", source_ranges: [cidr], target_tags: [networkTag(s.target)] };
  }
  return { resource: { google_compute_firewall: { [L]: body } }, addresses: [`google_compute_firewall.${L}`] };
}

const spec: ReadSpec = {
  driverId: DRIVER_ID,
  nativeType: "gcp:firewall_rule",
  kind: "firewall",
  attributes: ["protocol", "port", "disabled"],
  resolve: computeGlobal("firewalls", "firewall rule"),
  list: {
    url: (ctx) => `${COMPUTE}/projects/${ctx.session.projectId}/global/firewalls?maxResults=500`,
    itemsKey: "items",
    labelsOf: (item) => parseTagDescription(item.description),
  },
  extract(o) {
    const self = str(o.selfLink);
    const id = self ? computePath(self) : undefined;
    if (!id) throw new Error("no selfLink");
    const allowed = arr(o.allowed).map((a) => rec(a));
    const rule = allowed[0] ?? {};
    const ports = arr(rule.ports).map(String);
    // a rule that allows several ports, several protocols, or every port is reported as such, so it cannot
    // look like the single-port rule that was asked for
    const port: number | string | undefined = ports.length === 0 ? (allowed.length > 0 ? "all" : undefined) : ports.length === 1 && /^\d+$/.test(ports[0]) ? Number(ports[0]) : ports.join(",");
    return {
      externalId: id,
      name: tail(id),
      attributes: { protocol: allowed.length > 1 ? "multiple" : str(rule.IPProtocol), port, disabled: o.disabled === true },
      native: {
        direction: str(o.direction),
        priority: o.priority,
        sourceTags: arr(o.sourceTags).length,
        targetTags: arr(o.targetTags).length,
        sourceRanges: arr(o.sourceRanges).slice(0, 8),
        destinationRanges: arr(o.destinationRanges).slice(0, 8),
        allowedRules: arr(o.allowed).length,
      },
    };
  },
};

const readers = makeReaders(spec, expectedAttributes);

async function observe(...args: Parameters<typeof readers.observe>): Promise<Observation> {
  const [ctx, node, externalId] = args;
  if (isVirtualRule(node)) {
    const at = ctx.now().toISOString();
    return {
      address: node.address,
      presence: "present",
      attributes: { enforcedBy: { state: "known", value: "none", observedAt: at } },
      native: { reason: "public_http traffic reaches Cloud Run through the global external load balancer and a serverless NEG; VPC firewall rules do not apply" },
      observedAt: at,
      source: DRIVER_ID,
      simulated: false,
    };
  }
  return readers.observe(ctx, node, externalId);
}

export const firewallRuleDriver: ResourceDriver<GcpSession> = {
  id: DRIVER_ID,
  provider: "gcp",
  kind: "firewall",
  nativeType: "gcp:firewall_rule",
  capabilities: contractCapabilities({ discover: true }),
  compile,
  observe,
  verify: readers.verify,
  discover: readers.discover,
  expectedAttributes,
};
