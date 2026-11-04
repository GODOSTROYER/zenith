/**
 * Candidate enumeration and placed-graph construction for the solver.
 *
 * Three candidate shapes, all deterministic (ids are sorted, no randomness):
 * - `single:<provider>:<region>`: everything on one provider in one region.
 * - `multi:<provider>:<primary>+<secondary>`: one provider, two regions; the
 *   compute tier, load balancer and network are duplicated, databases get a
 *   read replica, caches and object stores get a copy, queues stay in the
 *   primary region. Global traffic steering (geo-DNS) is NOT priced.
 * - `mixed:<group>=<provider>/<region>,...`: several providers. Components are
 *   split into groups: `app` (compute and edge), `data` (databases, caches,
 *   object stores, queues) and one `pin:<provider>` group per provider a
 *   component is pinned to. Every group is placed in the anchor group's
 *   geography (or the nearest geography the provider has a region in), so the
 *   only cross-cloud hop modeled is same-metro or nearest-neighbour.
 *
 * The placed graph applies the availability requirements to the specs
 * (replicas, availability zones, database HA) and reports exactly what it
 * changed in `specOverrides`, so the priced topology can be reproduced.
 */
import type { PlacementConstraints } from "@/lib/placement/types";
import type { CostEdge, CostNode } from "@/lib/placement/cost";
import { nativeTypeFor } from "@/lib/placement/capabilities";
import { COMPUTE_KINDS, isFixed, tierOf, type PlacementComponent, type PlacementEdge } from "@/lib/placement/components";
import { geoRttMs, regionInfo, type Geo } from "@/lib/placement/latency";
import type { PortableKind } from "@/lib/resources/types";

export interface Site {
  provider: string;
  region: string;
}

export type Topology = "single_region" | "multi_region" | "cross_cloud";

export interface CandidateSpec {
  id: string;
  topology: Topology;
  /** group -> site. Single and multi-region candidates use the group `all`. */
  sites: Record<string, Site>;
  /** multi-region only */
  secondary?: Site;
  /** distinct providers, sorted */
  providers: string[];
}

/* ------------------------------ requirements ------------------------------ */

/** Availability target at which one region is no longer considered enough. */
export const MULTI_REGION_AVAILABILITY_TARGET = 99.99;
/** Availability target at which multi-AZ, replicated compute and HA data stores become mandatory. */
export const HIGH_AVAILABILITY_TARGET = 99.9;

export interface Requirements {
  azCount: number;
  minReplicas: number;
  dbHa: boolean;
  cacheHa: boolean;
  multiRegionRequired: boolean;
  /** human-readable reasons, one per rule that fired */
  reasons: string[];
}

/**
 * Availability rules (documented, deterministic):
 * - `tolerateSingleFailure`: >= 2 replicas per compute service and >= 2 AZs.
 * - availabilityTarget >= 99.9: >= 2 AZs, >= 2 replicas, HA database and cache.
 * - availabilityTarget >= 99.99: additionally 3 AZs and a second region.
 * - otherwise 1 AZ and the declared replicas (AWS load balancers still force 2 AZs).
 */
export function deriveRequirements(c: PlacementConstraints): Requirements {
  const r: Requirements = { azCount: 1, minReplicas: 1, dbHa: false, cacheHa: false, multiRegionRequired: false, reasons: [] };
  if (c.tolerateSingleFailure) {
    r.azCount = Math.max(r.azCount, 2);
    r.minReplicas = Math.max(r.minReplicas, 2);
    r.reasons.push("tolerateSingleFailure: at least 2 replicas per compute service across at least 2 availability zones");
  }
  const a = c.availabilityTarget;
  if (a !== undefined && a >= HIGH_AVAILABILITY_TARGET) {
    r.azCount = Math.max(r.azCount, 2);
    r.minReplicas = Math.max(r.minReplicas, 2);
    r.dbHa = true;
    r.cacheHa = true;
    r.reasons.push(`availabilityTarget ${a}%: at least 2 availability zones, 2 replicas, and high-availability databases and caches`);
  }
  if (a !== undefined && a >= MULTI_REGION_AVAILABILITY_TARGET) {
    r.azCount = Math.max(r.azCount, 3);
    r.multiRegionRequired = true;
    r.reasons.push(`availabilityTarget ${a}%: 3 availability zones and a second region (one region is a single failure domain)`);
  }
  return r;
}

/* -------------------------------- enumeration ----------------------------- */

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function singleSpec(provider: string, region: string): CandidateSpec {
  return { id: `single:${provider}:${region}`, topology: "single_region", sites: { all: { provider, region } }, providers: [provider] };
}

export function multiSpec(provider: string, primary: string, secondary: string): CandidateSpec {
  return {
    id: `multi:${provider}:${primary}+${secondary}`,
    topology: "multi_region",
    sites: { all: { provider, region: primary } },
    secondary: { provider, region: secondary },
    providers: [provider],
  };
}

/**
 * Two-region candidates for one provider: every unordered pair of distinct
 * geographies, primary = the region with the lower summed RTT to the users
 * (ties: lexicographic), so one candidate per pair.
 */
export function enumerateMulti(provider: string, regions: readonly string[], userRttSum: (provider: string, region: string) => number): CandidateSpec[] {
  const out: CandidateSpec[] = [];
  const sorted = [...regions].sort(cmp);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      const ga = regionInfo(provider, a)?.geo;
      const gb = regionInfo(provider, b)?.geo;
      if (!ga || !gb || ga === gb) continue;
      const sa = userRttSum(provider, a);
      const sb = userRttSum(provider, b);
      const [primary, secondary] = sa < sb || (sa === sb && a < b) ? [a, b] : [b, a];
      out.push(multiSpec(provider, primary, secondary));
    }
  }
  return out;
}

export interface MixedInput {
  /** groups present, each either free (choose a provider from `mixSet`) or fixed to a provider */
  groups: { name: string; provider?: string; regions?: readonly string[] }[];
  mixSet: readonly string[];
  regionsOf: (provider: string) => readonly string[];
}

function nearestRegions(provider: string, geo: Geo, regions: readonly string[]): string[] {
  const withGeo = regions.map((r) => ({ r, g: regionInfo(provider, r)?.geo })).filter((x): x is { r: string; g: Geo } => x.g !== undefined);
  const same = withGeo.filter((x) => x.g === geo).map((x) => x.r);
  if (same.length > 0) return same.sort(cmp);
  if (withGeo.length === 0) return [];
  const best = Math.min(...withGeo.map((x) => geoRttMs(geo, x.g)));
  return withGeo.filter((x) => geoRttMs(geo, x.g) === best).map((x) => x.r).sort(cmp);
}

/** Cross-cloud candidates: at least two distinct providers, every group in (or nearest to) the anchor group's geography. */
export function enumerateMixed(input: MixedInput): CandidateSpec[] {
  const groups = [...input.groups].sort((a, b) => cmp(a.name, b.name));
  if (groups.length === 0) return [];
  const anchorIdx = Math.max(0, groups.findIndex((g) => g.name === "app"));
  const anchor = groups[anchorIdx]!;
  const others = groups.filter((_, i) => i !== anchorIdx);
  const out = new Map<string, CandidateSpec>();

  const providersFor = (g: { provider?: string }) => (g.provider ? [g.provider] : [...input.mixSet].sort(cmp));

  for (const ap of providersFor(anchor)) {
    const anchorRegions = (anchor.regions ?? input.regionsOf(ap)).filter((r) => input.regionsOf(ap).includes(r));
    for (const ar of [...anchorRegions].sort(cmp)) {
      const geo = regionInfo(ap, ar)?.geo;
      if (!geo) continue;
      const choices: Site[][] = [];
      let feasible = true;
      for (const g of others) {
        const opts: Site[] = [];
        for (const p of providersFor(g)) {
          const pool = (g.regions ?? input.regionsOf(p)).filter((r) => input.regionsOf(p).includes(r));
          for (const r of nearestRegions(p, geo, pool)) opts.push({ provider: p, region: r });
        }
        if (opts.length === 0) feasible = false;
        choices.push(opts);
      }
      if (!feasible) continue;
      const walk = (i: number, acc: Site[]) => {
        if (i === choices.length) {
          const assigned: Record<string, Site> = { [anchor.name]: { provider: ap, region: ar } };
          others.forEach((g, k) => (assigned[g.name] = acc[k]!));
          const providers = [...new Set(Object.values(assigned).map((s) => s.provider))].sort(cmp);
          if (providers.length < 2) return; // not cross-cloud: covered by single-provider candidates
          const id = `mixed:${Object.keys(assigned).sort(cmp).map((k) => `${k}=${assigned[k]!.provider}/${assigned[k]!.region}`).join(",")}`;
          out.set(id, { id, topology: "cross_cloud", sites: assigned, providers });
          return;
        }
        for (const s of choices[i]!) walk(i + 1, [...acc, s]);
      };
      walk(0, []);
    }
  }
  return [...out.values()].sort((a, b) => cmp(a.id, b.id));
}

/* ----------------------------- placed graph ------------------------------- */

const CLONE_KINDS: ReadonlySet<string> = new Set([
  "container_service",
  "compute_instance",
  "load_balancer",
  "network",
  "subnet",
  "firewall",
  "tls_certificate",
  "log_group",
  "postgres",
  "mysql",
  "redis",
  "object_store",
]);
const REPLICATED_DATA: ReadonlySet<string> = new Set(["postgres", "mysql", "object_store"]);

export interface PlacedGraph {
  nodes: CostNode[];
  edges: CostEdge[];
  /** component address -> placement (clones included) */
  assignments: Record<string, { provider: string; region: string; nativeType: string }>;
  /** spec keys the solver changed, per component address */
  specOverrides: Record<string, Record<string, unknown>>;
  availabilityZones: number;
  warnings: string[];
}

export interface BuildArgs {
  components: readonly PlacementComponent[];
  edges: readonly PlacementEdge[];
  spec: CandidateSpec;
  req: Requirements;
  /** component address -> provider pin, from `resolvePins` */
  pins: ReadonlyMap<string, string>;
}

export function effectiveReplicas(c: PlacementComponent): number {
  const s = c.spec ?? {};
  const v = c.kind === "compute_instance" ? (s.count ?? s.replicas) : s.replicas;
  return typeof v === "number" && Number.isFinite(v) ? v : 1;
}

export function siteOf(c: PlacementComponent, spec: CandidateSpec, pins: ReadonlyMap<string, string>): Site {
  if (isFixed(c)) return { provider: c.pin!.provider, region: c.pin!.region! };
  if (spec.topology !== "cross_cloud") return spec.sites.all!;
  const pin = pins.get(c.address);
  if (pin) return spec.sites[`pin:${pin}`]!;
  return spec.sites[tierOf(c.kind)]!;
}

export function buildPlacedGraph(args: BuildArgs): PlacedGraph {
  const { components, spec, req, pins } = args;
  const warnings: string[] = [];
  const overrides: Record<string, Record<string, unknown>> = {};
  const nodes: CostNode[] = [];
  const assignments: PlacedGraph["assignments"] = {};
  const placedSite = new Map<string, Site>();
  const hasNetwork = components.some((c) => c.kind === "network");
  const hasLb = (site: Site) => components.some((c) => c.kind === "load_balancer" && sameSite(siteOf(c, spec, pins), site));
  const azFor = (site: Site) => Math.max(req.azCount, site.provider === "aws" && hasLb(site) ? 2 : 1);
  let azMax = 1;

  const patch = (addr: string, key: string, value: unknown) => {
    (overrides[addr] ??= {})[key] = value;
  };

  const place = (c: PlacementComponent, site: Site, address: string, extra: Record<string, unknown>, ownershipOverride?: PlacementComponent["ownership"]) => {
    const base = { ...(c.spec ?? {}), ...extra };
    const native = nativeTypeFor(site.provider, c.kind as PortableKind) ?? (isFixed(c) ? "existing" : "unsupported");
    nodes.push({ address, kind: c.kind, provider: site.provider, region: site.region, spec: base, ownership: ownershipOverride ?? c.ownership ?? "managed" });
    assignments[address] = { provider: site.provider, region: site.region, nativeType: native };
    placedSite.set(address, site);
  };

  for (const c of [...components].sort((a, b) => cmp(a.address, b.address))) {
    const site = siteOf(c, spec, pins);
    const extra: Record<string, unknown> = {};
    const managed = (c.ownership ?? "managed") === "managed";
    if (managed && !isFixed(c)) {
      if ((c.kind === "container_service" || c.kind === "compute_instance") && effectiveReplicas(c) < req.minReplicas) {
        const key = c.kind === "compute_instance" && c.spec && "count" in c.spec ? "count" : "replicas";
        extra[key] = req.minReplicas;
        patch(c.address, key, req.minReplicas);
      }
      if ((c.kind === "postgres" || c.kind === "mysql") && req.dbHa && c.spec?.ha !== true && c.spec?.multiAz !== true) {
        extra.ha = true;
        patch(c.address, "ha", true);
      }
      if (c.kind === "redis" && req.cacheHa && c.spec?.ha !== true && effectiveReplicas(c) < 2) {
        extra.ha = true;
        patch(c.address, "ha", true);
      }
      if (c.kind === "network") {
        const az = azFor(site);
        const cur = c.spec?.azCount;
        if (cur !== az) {
          extra.azCount = az;
          patch(c.address, "azCount", az);
        }
        azMax = Math.max(azMax, az);
      }
    }
    place(c, site, c.address, extra);
  }

  // No network component at all: price one implicit private network per compute/LB site.
  if (!hasNetwork) {
    const seen = new Set<string>();
    for (const n of [...nodes]) {
      const managed = (n.ownership ?? "managed") === "managed";
      if (!managed || (!COMPUTE_KINDS.has(n.kind) && n.kind !== "load_balancer")) continue;
      const k = `${n.provider}|${n.region}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const az = azFor({ provider: n.provider, region: n.region });
      azMax = Math.max(azMax, az);
      const addr = `network/placement-${n.provider}-${n.region}`;
      nodes.push({ address: addr, kind: "network", provider: n.provider, region: n.region, spec: { azCount: az, natGateways: "single" }, ownership: "managed" });
      assignments[addr] = { provider: n.provider, region: n.region, nativeType: nativeTypeFor(n.provider, "network") ?? "unsupported" };
      placedSite.set(addr, { provider: n.provider, region: n.region });
    }
    if (seen.size > 0) warnings.push("The graph has no network component; an implicit private network with one NAT gateway per site was priced.");
  }

  const edges: CostEdge[] = args.edges.map((e) => ({ from: e.from, to: e.to, relation: e.relation ?? "connects_to" }));

  // Second region.
  if (spec.topology === "multi_region" && spec.secondary) {
    const sec = spec.secondary;
    const cloneOf = new Map<string, string>();
    for (const c of [...components].sort((a, b) => cmp(a.address, b.address))) {
      if (isFixed(c) || (c.ownership ?? "managed") !== "managed" || !CLONE_KINDS.has(c.kind)) continue;
      const addr = `${c.address}@${sec.region}`;
      cloneOf.set(c.address, addr);
      const extra: Record<string, unknown> = {};
      if (c.kind === "postgres" || c.kind === "mysql") {
        extra.ha = false;
        extra.replicaOf = c.address;
      }
      if (c.kind === "network") {
        const az = azFor(sec);
        extra.azCount = az;
        azMax = Math.max(azMax, az);
      }
      if ((c.kind === "container_service" || c.kind === "compute_instance") && effectiveReplicas(c) < req.minReplicas) {
        extra[c.kind === "compute_instance" && c.spec && "count" in c.spec ? "count" : "replicas"] = req.minReplicas;
      }
      place(c, sec, addr, extra);
    }
    for (const e of args.edges) {
      const a = cloneOf.get(e.from);
      if (!a) continue;
      edges.push({ from: a, to: cloneOf.get(e.to) ?? e.to, relation: e.relation ?? "connects_to" });
    }
    for (const c of components) {
      const clone = cloneOf.get(c.address);
      if (clone && REPLICATED_DATA.has(c.kind)) edges.push({ from: c.address, to: clone, relation: "publishes_to" });
    }
    warnings.push("Multi-region: compute, load balancer and network are duplicated; databases get a read replica and object stores a copy; writes still go to the primary region; global traffic steering (geo-DNS) is not priced.");
  }

  return { nodes, edges, assignments, specOverrides: overrides, availabilityZones: azMax, warnings };
}

export function sameSite(a: Site, b: Site): boolean {
  return a.provider === b.provider && a.region === b.region;
}
