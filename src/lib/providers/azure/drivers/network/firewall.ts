/**
 * `azure:network_security_rule` — one `FirewallSpec` becomes one inbound
 * `azurerm_network_security_rule` on the NSG of the subnet its target lives in.
 *
 *   target kind                          NSG
 *   container_service / scheduled_job /
 *   load_balancer / static_site          nsg-aca  (the Container Apps subnet)
 *   postgres / mysql                     nsg-pg   (deny-by-default, see network.ts)
 *   redis / queue / object_store/secret  nsg-pe   (private-endpoint subnet)
 *
 * Source: `{ address }` (another node) → the Container Apps subnet CIDR, since
 * workloads (and the load balancer, which is the Container Apps environment)
 * all run there; `{ cidr }` → that CIDR, or the `Internet` service tag for
 * 0.0.0.0/0.
 *
 * Refusals (compile errors, never warnings):
 *   - a public source CIDR for anything but `public_http` → load balancer:
 *     Zenith never opens a database, cache or workload port to the internet;
 *   - a source node in another provider (`crossBoundary: cross_cloud`): its
 *     address is not an Azure address, so no rule can be written for it.
 *
 * Honest limits:
 *   - Container Apps are isolated from each other by app ingress settings, not
 *     by NSG: all apps of an environment share one subnet, so an NSG rule to
 *     "web" is an allow for the whole environment subnet. Only PostgreSQL has a
 *     meaningful deny-by-default NSG.
 *   - Redis rules for tcp/6379 are emitted for tcp/6380: the non-TLS port is
 *     disabled, TLS is the only listener.
 *   - Rule priorities are hashed from the rule's address into 200–3999. Two
 *     rules on one NSG can collide (≈ n²/7600); `assertUniqueRulePriorities`
 *     detects it over a compiled graph, and apply would fail with
 *     `SecurityRuleConflict`, never silently.
 *
 * Non-taggable: observed through the GET of the tagged parent NSG.
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { FirewallSpec } from "@/lib/resources/specs";
import { AzureCompileError, block, fragment, requireNode, resolveNetwork, specOf } from "@/lib/providers/azure/compile-util";
import { exportRef } from "@/lib/providers/azure/exports";
import { defineAzureDriver, getById, pick, props, type AzureCtx, type Located } from "@/lib/providers/azure/kit";
import { armClient, type ArmResource, type Json } from "@/lib/providers/azure/arm";
import { fnv1a, nodeKindOf, scopedName, tfLabel } from "@/lib/providers/azure/naming";
import { API, isPrivateCidr } from "@/lib/providers/azure/platform";
import { findLandingZoneTagged } from "@/lib/providers/azure/drivers/network/landing";
import { PLATFORM } from "@/lib/providers/azure/drivers/network/network";
import { privateSubnet } from "@/lib/providers/azure/drivers/more-util";
import { locateByTags } from "@/lib/providers/azure/kit";
import { MYSQL } from "@/lib/providers/azure/drivers/data/mysql";

export type PlatformSubnetKey = "aca" | "pg" | "pe";

const TARGET_SUBNET: Readonly<Record<string, PlatformSubnetKey>> = {
  container_service: "aca",
  scheduled_job: "aca",
  load_balancer: "aca",
  postgres: "pg",
  redis: "pe",
  queue: "pe",
  pubsub: "pe",
  object_store: "pe",
  secret: "pe",
};

export function subnetKeyForKind(kind: string): PlatformSubnetKey | undefined {
  return TARGET_SUBNET[kind];
}

/** Workload-like kinds whose traffic originates in the Container Apps subnet. */
const SOURCE_IN_ACA = new Set(["container_service", "scheduled_job", "load_balancer"]);

/** The port actually listening on the target, given the portable rule's port. */
export function destinationPort(targetKind: string, port: number): number {
  return targetKind === "redis" && port === 6379 ? 6380 : port;
}

/** Deterministic priority in 200–3999 from the rule's address. */
export const rulePriority = (address: string): number => 200 + (fnv1a(address) % 3800);

export function ruleName(address: string): string {
  return scopedName(address, { max: 80 });
}

/** Source prefix an `{ cidr }` source compiles to. */
export const sourcePrefixForCidr = (cidr: string): string => (cidr === "0.0.0.0/0" ? "Internet" : cidr);

export function compileFirewall(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const spec = specOf<FirewallSpec>(node);
  const a = node.address;
  const target = requireNode(ctx, spec.target, "the firewall target", a);
  if (target.provider !== "azure") throw new AzureCompileError(`target ${spec.target} is on ${target.provider}, not Azure.`, a);
  const targetKey = subnetKeyForKind(target.kind);
  const mysqlSubnet = target.kind === "mysql" ? privateSubnet(target, ctx, "mysql") : undefined;
  if (!targetKey && !mysqlSubnet) throw new AzureCompileError(`no network security group placement for target kind "${target.kind}".`, a);
  const network = resolveNetwork(node, ctx);

  let sourcePrefix: string;
  if ("cidr" in spec.source) {
    const cidr = spec.source.cidr;
    if (!isPrivateCidr(cidr) && !(spec.capability === "public_http" && target.kind === "load_balancer")) {
      throw new AzureCompileError(`refusing a public source CIDR (${cidr}) for ${spec.capability} to ${target.kind}: only public_http to the load balancer may face the internet.`, a);
    }
    sourcePrefix = sourcePrefixForCidr(cidr);
  } else {
    const source = requireNode(ctx, spec.source.address, "the firewall source", a);
    if (source.provider !== "azure") {
      throw new AzureCompileError(`source ${spec.source.address} is on ${source.provider}; its address is unknown here, so no Azure rule can name it. Express cross-cloud access with an explicit CIDR.`, a);
    }
    if (source.kind === "function" || source.kind === "compute_instance" || source.kind === "kubernetes_cluster") {
      const sourceSubnet = privateSubnet(source, ctx, source.kind === "function" ? "functions" : undefined);
      sourcePrefix = exportRef(sourceSubnet.address, "cidr");
    } else {
      if (!SOURCE_IN_ACA.has(source.kind)) throw new AzureCompileError(`source kind "${source.kind}" has no subnet to name in a rule.`, a);
      sourcePrefix = exportRef(network, "cidr_aca");
    }
  }

  const L = (part: string) => tfLabel(a, part);
  const nsgName = mysqlSubnet ? exportRef(mysqlSubnet.address, "nsg_name") : exportRef(network, targetKey === "aca" ? "nsg_aca_name" : targetKey === "pg" ? "nsg_pg_name" : "nsg_pe_name");
  const destPrefix = mysqlSubnet ? exportRef(mysqlSubnet.address, "cidr") : exportRef(network, targetKey === "aca" ? "cidr_aca" : targetKey === "pg" ? "cidr_pg" : "cidr_pe");
  return fragment({
    resource: block("azurerm_network_security_rule", L("rule"), {
      name: ruleName(a),
      resource_group_name: exportRef(network, "rg_name"),
      network_security_group_name: nsgName,
      priority: rulePriority(a),
      direction: "Inbound",
      access: "Allow",
      protocol: "Tcp",
      source_port_range: "*",
      destination_port_range: String(destinationPort(target.kind, spec.port)),
      source_address_prefix: sourcePrefix,
      destination_address_prefix: destPrefix,
      description: spec.description.slice(0, 140),
    }),
  });
}

/**
 * Detect two rules on one NSG with the same priority across compiled
 * fragments. Returns human-readable conflicts; empty means none.
 */
export function assertUniqueRulePriorities(fragments: Iterable<TofuFragment>): string[] {
  const seen = new Map<string, string>();
  const conflicts: string[] = [];
  for (const f of fragments) {
    for (const [label, body] of Object.entries(f.resource?.azurerm_network_security_rule ?? {})) {
      const key = `${String(body.network_security_group_name)}|${String(body.direction)}|${String(body.priority)}`;
      const prior = seen.get(key);
      if (prior) conflicts.push(`${prior} and ${label} share priority ${String(body.priority)} on the same network security group`);
      else seen.set(key, label);
    }
  }
  return conflicts;
}

/* --------------------------------- observe ---------------------------------- */

const expectedSource = (spec: FirewallSpec): string => ("cidr" in spec.source ? sourcePrefixForCidr(spec.source.cidr) : "landing_zone_subnet");

async function locateRule(ctx: AzureCtx, node: ResourceNode): Promise<Located> {
  const arm = armClient(ctx.session, ctx.signal);
  const spec = specOf<FirewallSpec>(node);
  if (nodeKindOf(spec.target) === "mysql") {
    const server = await locateByTags(ctx, { ...node, address: spec.target }, MYSQL);
    if (server.state !== "found") return server;
    const subnetId = pick<string>(props(server.resource), "network", "delegatedSubnetResourceId");
    if (!subnetId) return { state: "unknown", detail: "MySQL delegated subnet was not inspected" };
    const subnet = await getById(arm, subnetId, API.network);
    if (subnet.state !== "found") return subnet;
    const nsgId = pick<string>(props(subnet.resource), "networkSecurityGroup", "id");
    if (!nsgId) return { state: "unknown", detail: "MySQL subnet NSG was not inspected" };
    return getById(arm, `${nsgId}/securityRules/${ruleName(node.address)}`, API.network);
  }
  const key = subnetKeyForKind(nodeKindOf(spec.target));
  if (!key) return { state: "unknown", detail: `no NSG placement for target kind "${nodeKindOf(spec.target)}"` };
  const found = await findLandingZoneTagged(ctx, node, arm, "Microsoft.Network/networkSecurityGroups");
  if (!("matches" in found)) return found;
  const nsg = found.matches.filter((m) => m.name.toLowerCase() === PLATFORM.nsgs[key]);
  if (nsg.length === 0) return { state: "missing" };
  const got = await getById(arm, nsg[0].id, API.network);
  if (got.state !== "found") return got;
  const name = ruleName(node.address).toLowerCase();
  const rules = pick<Json[]>(props(got.resource), "securityRules") ?? [];
  const rule = rules.find((r) => String(r.name ?? "").toLowerCase() === name);
  if (!rule) return { state: "missing" };
  const resource: ArmResource = { id: String(rule.id ?? `${nsg[0].id}/securityRules/${name}`), name: String(rule.name), type: "Microsoft.Network/networkSecurityGroups/securityRules", properties: (rule.properties ?? {}) as Json };
  return { state: "found", resource };
}

export const firewallDriver = defineAzureDriver({
  id: "azure.network_security_rule@1",
  kind: "firewall",
  nativeType: "azure:network_security_rule",
  locate: (ctx, node) => locateRule(ctx, node),
  compile: compileFirewall,
  expected: (node) => {
    const spec = specOf<FirewallSpec>(node);
    return {
      direction: "Inbound",
      access: "Allow",
      protocol: "Tcp",
      port: destinationPort(nodeKindOf(spec.target), spec.port),
      source: expectedSource(spec),
    };
  },
  read: (res, node) => {
    const p = props(res);
    const spec = specOf<FirewallSpec>(node);
    const range = pick<string>(p, "destinationPortRange");
    const ranges = pick<string[]>(p, "destinationPortRanges");
    const portText = range ?? (Array.isArray(ranges) && ranges.length === 1 ? ranges[0] : undefined);
    const prefix = pick<string>(p, "sourceAddressPrefix");
    const source = "cidr" in spec.source ? prefix : prefix && prefix.includes("/") ? "landing_zone_subnet" : prefix;
    return {
      direction: pick(p, "direction"),
      access: pick(p, "access"),
      protocol: pick(p, "protocol"),
      port: portText !== undefined && /^\d+$/.test(portText) ? Number(portText) : undefined,
      source,
    };
  },
  native: (res) => ({ priority: props(res).priority, sourceAddressPrefix: props(res).sourceAddressPrefix, destinationAddressPrefix: props(res).destinationAddressPrefix, provisioningState: props(res).provisioningState }),
});
