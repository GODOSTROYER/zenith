/**
 * Ownership facts from the desired graph. Facts change who owns a field, so
 * they come only from the graph Zenith compiled, never from a request.
 */
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";
import type { OwnershipFacts } from "./types";

/** Native types that are live autoscalers of a workload. */
export const AUTOSCALER_NATIVE_TYPES: readonly string[] = ["k8s:HorizontalPodAutoscaler", "aws:appautoscaling_target"];

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const nameOf = (address: string): string => address.slice(address.lastIndexOf("/") + 1);

/** Addresses of workloads a native autoscaler node in this graph targets. */
export function autoscaledAddresses(graph: Pick<ResourceGraph, "nodes">): Set<string> {
  const out = new Set<string>();
  const byName = new Map<string, string[]>();
  for (const n of graph.nodes) byName.set(nameOf(n.address), [...(byName.get(nameOf(n.address)) ?? []), n.address]);
  for (const n of graph.nodes) {
    if (n.kind !== "provider_native" || !AUTOSCALER_NATIVE_TYPES.includes(n.nativeType)) continue;
    const config = isRecord(n.spec.config) ? n.spec.config : {};
    const target = config.target;
    if (typeof target !== "string") continue;
    if (graph.nodes.some((m) => m.address === target)) out.add(target);
    else for (const a of byName.get(target) ?? []) if (a.startsWith("service/")) out.add(a);
  }
  return out;
}

/** Facts for one node. `graph` adds autoscalers declared as separate native nodes. */
export function factsForNode(node: Pick<ResourceNode, "address" | "spec">, graph?: Pick<ResourceGraph, "nodes">): OwnershipFacts {
  const scaling = node.spec.autoscaling;
  const autoscaled = (isRecord(scaling) || scaling === true) || (graph !== undefined && autoscaledAddresses(graph).has(node.address));
  const artifact = node.spec.artifact;
  const releaseManaged = isRecord(artifact) && artifact.type === "built";
  return { ...(autoscaled ? { autoscaled: true } : {}), ...(releaseManaged ? { releaseManaged: true } : {}) };
}

/** Facts for every node of a graph, computed once. */
export function factsByAddress(graph: Pick<ResourceGraph, "nodes">): Map<string, OwnershipFacts> {
  const scaled = autoscaledAddresses(graph);
  return new Map(
    graph.nodes.map((n) => {
      const f = factsForNode(n);
      return [n.address, scaled.has(n.address) ? { ...f, autoscaled: true } : f] as const;
    })
  );
}
