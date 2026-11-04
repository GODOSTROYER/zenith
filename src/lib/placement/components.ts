/**
 * Placement components: the solver's view of a resource graph.
 *
 * A component is one graph node reduced to what placement needs (kind, size,
 * spec, ownership, an optional fixed location). Components that are not
 * `managed` already exist somewhere and cannot be moved; they carry a `pin`
 * with provider and region and are held fixed in every candidate.
 *
 * Pin keys in `PlacementConstraints.componentProviders` (for example
 * `{ database: "azure" }`) are resolved against components in this order:
 * exact address, short name (the last address segment, so `resource/db` is
 * `db`), kind (`postgres`), then the kind aliases below (`database` is
 * postgres and mysql, `web` is container services and compute instances). A
 * key that matches nothing is reported, never silently ignored.
 */
import type { PortableKind } from "@/lib/resources/types";
import type { PlacementSize } from "@/lib/placement/sizes";
import { isPlacementSize } from "@/lib/placement/sizes";

export interface PlacementComponent {
  address: string;
  /** short name for pin matching; defaults to the last address segment */
  name?: string;
  kind: PortableKind | "provider_native";
  size?: PlacementSize;
  /** portable spec keys the cost engine reads (see cost.ts) */
  spec?: Record<string, unknown>;
  ownership?: "managed" | "referenced" | "external";
  /**
   * Fixed location. With `region` the component is held exactly there (existing
   * resources); with only `provider` it is a provider pin the solver honors.
   */
  pin?: { provider: string; region?: string };
}

export interface PlacementEdge {
  from: string;
  to: string;
  relation?: string;
}

/** Minimal structural view of a ResourceGraph node / edge (satisfied by `ResourceGraph`). */
export interface GraphNodeLike {
  address: string;
  kind: PortableKind | "provider_native";
  provider: string;
  region: string;
  ownership?: "managed" | "referenced" | "external";
  spec?: Record<string, unknown>;
}
export interface GraphLike {
  nodes: readonly GraphNodeLike[];
  edges?: readonly { from: string; to: string; relation: string }[];
}

/** Stateful, data-holding kinds: they form the "data" tier for cross-cloud splits. */
export const DATA_KINDS: ReadonlySet<string> = new Set(["postgres", "mysql", "redis", "object_store", "queue", "pubsub", "volume"]);
export const COMPUTE_KINDS: ReadonlySet<string> = new Set(["container_service", "compute_instance", "scheduled_job", "function"]);

export type Tier = "app" | "data";

export function tierOf(kind: string): Tier {
  return DATA_KINDS.has(kind) ? "data" : "app";
}

export function isStateful(kind: string): boolean {
  return DATA_KINDS.has(kind) || kind === "secret";
}

export function shortName(address: string): string {
  const i = address.lastIndexOf("/");
  return i >= 0 ? address.slice(i + 1) : address;
}

const PIN_ALIASES: Record<string, readonly string[]> = {
  database: ["postgres", "mysql"],
  db: ["postgres", "mysql"],
  cache: ["redis"],
  storage: ["object_store"],
  bucket: ["object_store"],
  queue: ["queue", "pubsub"],
  messaging: ["queue", "pubsub"],
  web: ["container_service", "compute_instance", "function"],
  app: ["container_service", "compute_instance", "function"],
  api: ["container_service", "compute_instance", "function"],
  service: ["container_service", "compute_instance", "function"],
  compute: ["container_service", "compute_instance", "function"],
};

/** Convert a resource graph into placement components and edges. Provider-native nodes become fixed components. */
export function componentsFromGraph(graph: GraphLike): { components: PlacementComponent[]; edges: PlacementEdge[] } {
  const components = graph.nodes.map((n): PlacementComponent => {
    const ownership = n.ownership ?? "managed";
    const size = n.spec?.size;
    const fixed = ownership !== "managed" || n.kind === "provider_native";
    return {
      address: n.address,
      name: shortName(n.address),
      kind: n.kind,
      ...(isPlacementSize(size) ? { size } : {}),
      spec: n.spec ?? {},
      ownership,
      ...(fixed ? { pin: { provider: n.provider, region: n.region } } : {}),
    };
  });
  const edges = (graph.edges ?? []).map((e) => ({ from: e.from, to: e.to, relation: e.relation }));
  return { components, edges };
}

/** True for components the solver must not move. */
export function isFixed(c: PlacementComponent): boolean {
  return c.pin?.region !== undefined;
}

export function matchesPinKey(c: PlacementComponent, key: string): boolean {
  const k = key.trim().toLowerCase();
  if (c.address.toLowerCase() === k) return true;
  if ((c.name ?? shortName(c.address)).toLowerCase() === k) return true;
  if (c.kind === k) return true;
  return PIN_ALIASES[k]?.includes(c.kind) ?? false;
}

export interface ResolvedPins {
  /** component address -> pinned provider (lower-case) */
  byAddress: Map<string, string>;
  /** keys that matched no component */
  unresolved: string[];
  /** conflicting pins on one component */
  conflicts: string[];
}

/** Resolve `componentProviders` against components; also folds in each component's own `pin.provider`. */
export function resolvePins(components: readonly PlacementComponent[], pins: Record<string, string> | undefined): ResolvedPins {
  const byAddress = new Map<string, string>();
  const unresolved: string[] = [];
  const conflicts: string[] = [];
  const set = (addr: string, provider: string, why: string) => {
    const prev = byAddress.get(addr);
    if (prev !== undefined && prev !== provider) conflicts.push(`component ${addr} is pinned to both ${prev} and ${provider} (${why})`);
    else byAddress.set(addr, provider);
  };
  for (const c of components) if (c.pin) set(c.address, c.pin.provider.toLowerCase(), "existing resource");
  for (const key of Object.keys(pins ?? {}).sort()) {
    const provider = (pins ?? {})[key]!.trim().toLowerCase();
    const hits = components.filter((c) => matchesPinKey(c, key));
    if (hits.length === 0) unresolved.push(key);
    for (const c of hits) set(c.address, provider, `componentProviders.${key}`);
  }
  return { byAddress, unresolved, conflicts };
}

/** Default data-plane edges when the caller supplies none: load balancers route to compute, compute connects to every data component. */
export function deriveEdges(components: readonly PlacementComponent[]): PlacementEdge[] {
  const lbs = components.filter((c) => c.kind === "load_balancer");
  const compute = components.filter((c) => c.kind === "container_service" || c.kind === "compute_instance" || c.kind === "scheduled_job");
  const data = components.filter((c) => DATA_KINDS.has(c.kind) && c.kind !== "volume");
  const edges: PlacementEdge[] = [];
  for (const lb of lbs) for (const c of compute) edges.push({ from: lb.address, to: c.address, relation: "routes_to" });
  for (const c of compute) for (const d of data) edges.push({ from: c.address, to: d.address, relation: "connects_to" });
  return edges;
}
