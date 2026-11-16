/**
 * Observe-side helpers for finding the environment landing zone.
 *
 * `DriverContext` carries no graph, so an `observe` for a node that lives
 * inside the landing zone (a subnet, a firewall rule, a container app's
 * environment) finds the zone the way expansion names it: the network node is
 * `network/main` for the environment's default place, `network/azure-<region>`
 * for a node placed elsewhere. Lookups are by Zenith tag, never by name.
 */
import type { ResourceNode } from "@/lib/resources/types";
import type { ArmClient, ArmResource } from "@/lib/providers/azure/arm";
import { findTagged, type AzureCtx, type Located } from "@/lib/providers/azure/kit";

/** Candidate network addresses for a node, most likely first. */
export function networkCandidates(node: Pick<ResourceNode, "kind" | "address" | "region" | "spec" | "dependsOn">): string[] {
  if (node.kind === "network") return [node.address];
  const out: string[] = [];
  if (typeof node.spec.network === "string") out.push(node.spec.network);
  for (const d of node.dependsOn) if (d.startsWith("network/")) out.push(d);
  out.push("network/main", `network/azure-${node.region}`);
  return [...new Set(out)];
}

/**
 * Resources of `type` tagged as belonging to the node's network node. Returns
 * the first candidate network that has any; an error `Located` is returned
 * only when every candidate failed the same way.
 */
export async function findLandingZoneTagged(
  ctx: AzureCtx,
  node: Pick<ResourceNode, "kind" | "address" | "region" | "spec" | "dependsOn">,
  arm: ArmClient,
  type: string
): Promise<{ matches: ArmResource[]; network: string } | Located> {
  const candidates = networkCandidates(node);
  let failure: Located | undefined;
  for (const network of candidates) {
    const r = await findTagged(ctx, network, arm, type);
    if ("matches" in r) {
      if (r.matches.length > 0) return { matches: r.matches, network };
    } else failure = r;
  }
  // nothing found anywhere: report the last failure if a call failed, else "no matches"
  return failure ?? { matches: [], network: candidates[0] };
}
