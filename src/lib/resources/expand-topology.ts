/**
 * Topology stage of expansion: the network and its subnets, one per place
 * (provider + region) that has something to run in it. See `expand.ts` for the
 * rules; this file only carves and records them.
 */
import { tuningFor, zoneLetter, type Ctx } from "./expand-context";
import { cmp, placeKey, slug, sortDeep, specDigestOf, subnetCidr, type Place } from "./expand-support";
import type { NetworkSpec, SubnetSpec } from "./specs";

export interface Topology {
  network: string;
  publicDeps: string[];
  privateDeps: string[];
}
export type Topologies = Map<string, Topology>;

/** Manifest ids that make each place need a network, for the network's `origin`. */
export function networkOrigins(ctx: Ctx, routeIds: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (p: Place, id: string) => out.set(placeKey(p), [...(out.get(placeKey(p)) ?? []), id]);
  for (const i of ctx.svcs.values()) if (i.managed && i.kind !== "static_site") add(i.place, i.id);
  for (const i of ctx.ress.values()) if (i.managed && i.modelled && (i.r.kind === "postgres" || i.r.kind === "redis")) add(i.place, i.id);
  for (const id of routeIds) add(ctx.defaultPlace, id);
  return out;
}

export function emitTopology(ctx: Ctx, places: Place[], origins: Map<string, string[]>): Topologies {
  const topo: Topologies = new Map();
  const b = ctx.b;
  if (places.length === 0) {
    b.note("topology", "no network derived; nothing in this manifest runs inside one.");
    return topo;
  }
  b.note("topology", ctx.zoneNote);
  const defaultKey = placeKey(ctx.defaultPlace);
  const ordered = [...places].sort((x, y) =>
    placeKey(x) === defaultKey ? -1 : placeKey(y) === defaultKey ? 1 : cmp(placeKey(x), placeKey(y))
  );
  const usedCidrs = new Map<string, string>();

  for (const place of ordered) {
    const key = placeKey(place);
    const isDefault = key === defaultKey;
    const tuning = tuningFor(ctx.v2, place.provider);
    const network = isDefault ? "network/main" : `network/${place.provider}-${place.region}`;
    const prefix = isDefault ? "" : `${place.provider}-${place.region}-`;
    const origin = origins.get(key) ?? [];

    if (place.provider === "kubernetes" || place.provider === "zenith") {
      const namespace = tuning.namespace ?? `zenith-${slug(ctx.env.name, 40)}`;
      const spec: NetworkSpec = { namespace, zones: ctx.zones, ...(place.provider === "kubernetes" && tuning.egress ? { isolation: { egress: tuning.egress } } : {}) };
      b.add({ address: network, kind: "network", place, spec: { ...spec }, origin });
      b.note("topology", `${network}: namespace ${namespace}; kubernetes has no subnet primitive, so ${ctx.zones} zone${ctx.zones === 1 ? "" : "s"} become topology spread on workloads.`);
      topo.set(key, { network, publicDeps: [network], privateDeps: [network] });
      continue;
    }

    let cidr = tuning.cidr;
    if (!cidr) for (let i = 0; ; i++) if (!usedCidrs.has(`10.${i}.0.0/16`)) { cidr = `10.${i}.0.0/16`; break; }
    const clash = usedCidrs.get(cidr!);
    if (clash) b.note("topology", `${network} and ${clash} both use ${cidr}; they cannot be peered or routed together.`);
    usedCidrs.set(cidr!, network);

    const natGateways = tuning.natGateways ?? (ctx.availabilityDemand && ctx.zones >= 2 ? "per_az" : "single");
    const spec: NetworkSpec = { cidr: cidr!, zones: ctx.zones, egress: { natGateways } };
    b.add({ address: network, kind: "network", place, spec: { ...spec }, origin });
    b.note(
      "topology",
      `${network}: ${cidr} across ${ctx.zones} zone${ctx.zones === 1 ? "" : "s"}, ${natGateways} NAT gateway${natGateways === "single" ? "" : "s"}${tuning.natGateways ? "" : " (default)"}.`
    );

    const publicDeps: string[] = [];
    const privateDeps: string[] = [];
    for (const tier of ["public", "private"] as const)
      for (let z = 0; z < ctx.zones; z++) {
        const address = `subnet/${prefix}${tier}-${zoneLetter(z)}`;
        const sub: SubnetSpec = { tier, zone: zoneLetter(z), cidr: subnetCidr(cidr!, (tier === "public" ? 0 : 10) + z), network };
        b.add({ address, kind: "subnet", place, spec: { ...sub }, origin, dependsOn: [network] });
        b.edge(network, address, "contains", tier);
        (tier === "public" ? publicDeps : privateDeps).push(address);
      }
    topo.set(key, { network, publicDeps, privateDeps });
  }
  return topo;
}

export const netDeps = (topo: Topologies, place: Place, tier: "public" | "private"): string[] => {
  const t = topo.get(placeKey(place));
  return t ? (tier === "public" ? t.publicDeps : t.privateDeps) : [];
};

export const contain = (ctx: Ctx, topo: Topologies, place: Place, address: string, tier: "public" | "private") => {
  const t = topo.get(placeKey(place));
  if (t) ctx.b.edge(t.network, address, "contains", tier);
};

/**
 * Pin each portable Kubernetes node to its place's network namespace. Drivers
 * read and operate a node without the graph the renderer had; keeping the
 * namespace in the spec makes both paths target the same objects. Networkless
 * nodes (for example a static-only manifest) use the same topology default.
 * Provider-native config and non-Kubernetes services are left to their drivers.
 */
export function propagateNamespaces(ctx: Ctx, topo: Topologies): void {
  for (const node of ctx.b.nodes.values()) {
    if ((node.provider !== "kubernetes" && node.provider !== "zenith") || node.kind === "provider_native" || !node.nativeType.startsWith("k8s:")) continue;
    // Build-only compiler nodes are not Kubernetes objects and have no namespace field.
    if (node.nativeType === "k8s:BuildRegistry" || node.nativeType === "k8s:BuildPipeline") continue;
    const network = topo.get(placeKey(node))?.network;
    const networkNamespace = network ? ctx.b.nodes.get(network)?.spec.namespace : undefined;
    const namespace = typeof networkNamespace === "string"
      ? networkNamespace
      : tuningFor(ctx.v2, node.provider).namespace ?? `zenith-${slug(ctx.env.name, 40)}`;
    node.spec = sortDeep({ ...node.spec, namespace });
    node.specDigest = specDigestOf(node);
  }
}
