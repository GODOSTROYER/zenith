/**
 * Network topology lookups for drivers that live inside a VPC (workloads,
 * datastores, load balancers): which network a node belongs to and which
 * subnets it was wired to, read from the node's own `dependsOn` and the
 * neighbours' specs through `ctx.node` — never from another driver's labels.
 *
 * Graph expansion gives a workload `dependsOn: [subnet/private-a, …]` and a
 * load balancer `dependsOn: [subnet/public-a, …, tls_certificate/<host>]`; a
 * subnet's `spec.network` names its network. Both lookups are sorted by
 * address so the subnet order a driver emits is deterministic.
 */
import type { CompileContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { SubnetSpec } from "@/lib/resources/specs";
import { DriverCompileError } from "./errors";

type NodeLookup = Pick<CompileContext, "node">;

const byAddress = (a: ResourceNode, b: ResourceNode): number => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0);

/** The subnet nodes `node` depends on, optionally only one tier, sorted by address. */
export function subnetsOf(node: ResourceNode, ctx: NodeLookup, tier?: SubnetSpec["tier"]): ResourceNode[] {
  const out: ResourceNode[] = [];
  for (const dep of new Set(node.dependsOn)) {
    const d = ctx.node(dep);
    if (d?.kind !== "subnet") continue;
    if (tier !== undefined && (d.spec as Partial<SubnetSpec>).tier !== tier) continue;
    out.push(d);
  }
  return out.sort(byAddress);
}

/** The address of the network `node` lives in: its own dependency, or its subnets' `spec.network`. */
export function networkAddressOf(node: ResourceNode, ctx: NodeLookup): string {
  for (const dep of [...new Set(node.dependsOn)].sort()) {
    const d = ctx.node(dep);
    if (d?.kind === "network") return d.address;
  }
  for (const subnet of subnetsOf(node, ctx)) {
    const network = (subnet.spec as Partial<SubnetSpec>).network;
    if (typeof network === "string" && network !== "") return network;
  }
  throw new DriverCompileError("missing_node", node.address, "cannot determine its network: the node depends on neither a network nor a subnet that names one.");
}
