/**
 * Resolve a GCP node's VPC without relying on expansion to emit a direct
 * network dependency. A direct network on the node wins, then one on its
 * optional target; otherwise every subnet dependency of the node (or target)
 * must explicitly name the same graph node of kind `network`. Missing or
 * ambiguous subnet VPCs are refused. This is a pure graph lookup, not discovery.
 */
import type { CompileContext } from "@/lib/drivers/types";
import type { SubnetSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { GcpCompileError } from "../../errors";
import { depsOfKind } from "../../hcl";

export function networkOf(node: ResourceNode, ctx: CompileContext, target: ResourceNode = node): ResourceNode {
  const direct = depsOfKind(node, ctx, "network")[0] ?? depsOfKind(target, ctx, "network")[0];
  if (direct) return direct;

  const subnetNetworks = [...new Set(depsOfKind(target, ctx, "subnet")
    .map((subnet) => (subnet.spec as Partial<SubnetSpec>).network))];
  const network = subnetNetworks.length === 1 && typeof subnetNetworks[0] === "string"
    ? ctx.node(subnetNetworks[0]) : undefined;
  if (network?.kind === "network") return network;

  throw new GcpCompileError("missing_network", `${node.address}: no network dependency or single VPC named by its${target === node ? "" : " target's"} subnet dependencies.`);
}
