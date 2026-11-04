/**
 * Hand-built graphs for the placement tests. Another workstream implements
 * `expandManifest`; these fixtures deliberately do not depend on it.
 */
import type { CostNode } from "@/lib/placement/cost";
import type { PlacementComponent, PlacementEdge } from "@/lib/placement/components";

export function node(address: string, kind: CostNode["kind"], provider: string, region: string, spec: Record<string, unknown> = {}, ownership: CostNode["ownership"] = "managed"): CostNode {
  return { address, kind, provider, region, spec, ownership };
}

/** One web service behind a load balancer, a Postgres database and an object store, all in one place. */
export function stackNodes(provider: string, region: string, over: { web?: Record<string, unknown>; db?: Record<string, unknown>; network?: Record<string, unknown> } = {}): CostNode[] {
  return [
    node("network/main", "network", provider, region, over.network ?? {}),
    node("load_balancer/edge", "load_balancer", provider, region),
    node("service/web", "container_service", provider, region, { size: "small", replicas: 1, ...over.web }),
    node("resource/db", "postgres", provider, region, { size: "small", storageGb: 20, ...over.db }),
    node("resource/assets", "object_store", provider, region, { storageGb: 10 }),
  ];
}

export const STACK_EDGES = [
  { from: "load_balancer/edge", to: "service/web", relation: "routes_to" },
  { from: "service/web", to: "resource/db", relation: "connects_to" },
  { from: "service/web", to: "resource/assets", relation: "connects_to" },
];

/** The same stack as solver components (provider/region are decided by the solver). */
export function stackComponents(over: { web?: Record<string, unknown>; db?: Record<string, unknown> } = {}): PlacementComponent[] {
  return [
    { address: "network/main", kind: "network", spec: {} },
    { address: "load_balancer/edge", kind: "load_balancer", spec: {} },
    { address: "service/web", kind: "container_service", size: "small", spec: { size: "small", replicas: 1, ...over.web } },
    { address: "resource/db", kind: "postgres", size: "small", spec: { size: "small", storageGb: 20, ...over.db } },
    { address: "resource/assets", kind: "object_store", spec: { storageGb: 10 } },
  ];
}

export const STACK_PLACEMENT_EDGES: PlacementEdge[] = STACK_EDGES;
