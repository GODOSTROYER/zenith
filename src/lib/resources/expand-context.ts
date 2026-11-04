/**
 * Shared context for the expansion stages: the sorted manifest view, resolved
 * defaults (zones, availability, policies), per-node placement, and the
 * provider tuning lifted out of `providerConfig`. Kept apart from `expand.ts`
 * so each derivation stage stays small and testable by reading.
 */
import type { Binding, Manifest as ManifestV1, Resource, Route, Service } from "@/lib/domain/types";
import {
  isV2,
  resolvePolicies,
  type AnyManifest,
  type Constraints,
  type EffectivePolicies,
  type ManifestV2,
} from "./manifest-v2";
import { v1View } from "./upgrade";
import { assertHost, assertName, cmp, GraphBuilder, ManifestExpansionError, placeKey, uniqSorted, type Place } from "./expand-support";
import type { PortableKind, ProviderKey } from "./types";
import type { CronPolicySpec } from "./specs";

export interface ExpandEnv {
  id: string;
  name: string;
  class: "sandbox" | "staging" | "production";
  provider: ProviderKey;
  region: string;
  baseDomain: string;
}

/** A manifest service or resource with its resolved address and placement. */
export interface NodeInfo {
  id: string;
  name: string;
  address: string;
  place: Place;
  managed: boolean;
}

export interface SvcInfo extends NodeInfo {
  s: Service;
  kind: Extract<PortableKind, "container_service" | "scheduled_job" | "static_site">;
  /** env after secret handling: plain values and references, sorted by key */
  env: ({ key: string; value: string } | { key: string; secretRef: string })[];
  secretReads: { key: string; ref: string }[];
  /** ordering dependencies accumulated by binding/route analysis */
  deps: Set<string>;
  /** target address → verbs and reasons, for the identity node */
  grants: Map<string, { access: Set<string>; via: Set<string> }>;
  /** does the identity depend on the grant target (true for nodes Zenith creates) */
  grantDeps: Set<string>;
}

export interface ResInfo extends NodeInfo {
  r: Resource;
  /** false for kinds with no portable primitive (email) */
  modelled: boolean;
}

export interface Tuning {
  cidr?: string;
  natGateways?: "none" | "single" | "per_az";
  highAvailability?: boolean;
  postgresVersion?: string;
  platformVersion?: string;
  instanceClass?: (name: string) => string | undefined;
  dbClass?: string;
  namespace?: string;
  ingressClass?: string;
  storageClass?: string;
  ingress?: string;
  shape?: string;
  /** kubernetes: namespace egress isolation */
  egress?: "open" | "default-deny";
  /** kubernetes: CronJob behaviour for cron services */
  cronPolicy?: CronPolicySpec;
}

export interface Ctx {
  env: ExpandEnv;
  b: GraphBuilder;
  m: AnyManifest;
  v2?: ManifestV2;
  services: Service[];
  resources: Resource[];
  routes: Route[];
  bindings: Binding[];
  policies: EffectivePolicies;
  constraints: Constraints;
  zones: number;
  /** why `zones` is what it is; emitted as a note only when a network is actually derived */
  zoneNote: string;
  /** availabilityTarget >= 99.9 or tolerateSingleFailure */
  availabilityDemand: string | undefined;
  defaultPlace: Place;
  svcs: Map<string, SvcInfo>;
  ress: Map<string, ResInfo>;
  /** manifest node id or name → its primary node address (for native dependsOn) */
  addrByKey: Map<string, string>;
}

export const WORKLOAD_ADDR: Record<Service["kind"], SvcInfo["kind"]> = {
  web: "container_service",
  worker: "container_service",
  cron: "scheduled_job",
  static: "static_site",
};

const ZONE_LETTERS = ["a", "b", "c"] as const;
export const zoneLetter = (i: number): string => ZONE_LETTERS[i] ?? String(i);

export function tuningFor(v2: ManifestV2 | undefined, provider: ProviderKey): Tuning {
  const pc = v2?.providerConfig;
  if (!pc) return {};
  switch (provider) {
    case "aws":
    case "localstack": {
      const c = pc.aws;
      if (!c) return {};
      return {
        cidr: c.vpcCidr,
        natGateways: c.natGateways,
        highAvailability: c.multiAz,
        postgresVersion: c.rdsEngineVersion,
        platformVersion: c.fargatePlatformVersion,
        instanceClass: (n) => c.instanceClassOverrides?.[n],
      };
    }
    case "gcp": {
      const c = pc.gcp;
      return c ? { cidr: c.vpcCidr, highAvailability: c.highAvailability, dbClass: c.cloudSqlTier, ingress: c.cloudRunIngress } : {};
    }
    case "azure": {
      const c = pc.azure;
      return c ? { cidr: c.vnetCidr, highAvailability: c.zoneRedundant, dbClass: c.postgresSku } : {};
    }
    case "oci": {
      const c = pc.oci;
      return c ? { cidr: c.vcnCidr, shape: c.shape } : {};
    }
    case "kubernetes":
    case "zenith": {
      const c = pc.kubernetes;
      return c ? { namespace: c.namespace, ingressClass: c.ingressClass, storageClass: c.storageClass, egress: c.egress, cronPolicy: c.cronJob } : {};
    }
    default:
      return {};
  }
}

const serviceKey = (s: { name: string; id: string }) => `${s.name}\0${s.id}`;

/**
 * Build the context: validate what would make addresses ambiguous, sort every
 * list so input order can never reach the output, resolve placement.
 */
export function buildContext(manifest: AnyManifest, env: ExpandEnv): Ctx {
  const view: ManifestV1 = v1View(manifest);
  const v2 = isV2(manifest) ? manifest : undefined;
  const b = new GraphBuilder(env.id);

  const services = [...view.services].sort((x, y) => cmp(serviceKey(x), serviceKey(y)));
  const resources = [...view.resources].sort((x, y) => cmp(serviceKey(x), serviceKey(y)));
  const routes = [...view.routes].sort((x, y) => cmp(`${x.host.toLowerCase()}\0${x.pathPrefix}\0${x.id}`, `${y.host.toLowerCase()}\0${y.pathPrefix}\0${y.id}`));

  const seenIds = new Set<string>();
  for (const n of [...services, ...resources, ...routes]) {
    if (seenIds.has(n.id)) throw new ManifestExpansionError(`Duplicate manifest node id "${n.id}"; ids must be unique across services, resources and routes.`);
    seenIds.add(n.id);
  }
  for (const s of services) assertName("Service", s.name);
  for (const r of resources) assertName("Resource", r.name);
  for (const r of routes) assertHost(r.host);
  const dupe = (xs: { name: string }[], what: string) => {
    const seen = new Set<string>();
    for (const x of xs) {
      if (seen.has(x.name)) throw new ManifestExpansionError(`Two ${what} share the name "${x.name}"; names must be unique.`);
      seen.add(x.name);
    }
  };
  dupe(services, "services");
  dupe(resources, "resources");

  const policies = resolvePolicies(manifest);
  const constraints: Constraints = v2?.constraints ?? {};
  const defaultPlace: Place = { provider: env.provider, region: env.region };

  const placeOfManifestNode = (id: string, name: string): Place => {
    const o = v2?.nodePlacement?.[id] ?? v2?.nodePlacement?.[name];
    if (!o) return defaultPlace;
    const region =
      o.region ??
      (o.provider === env.provider ? env.region : v2?.placement?.provider === o.provider ? v2.placement.regions[0] : undefined);
    if (!region)
      throw new ManifestExpansionError(
        `nodePlacement for "${name}" names provider ${o.provider} but no region, and nothing else in the manifest supplies one. Add a region to that entry.`
      );
    return { provider: o.provider, region };
  };

  const availabilityDemand =
    constraints.tolerateSingleFailure === true
      ? "tolerateSingleFailure is set"
      : (constraints.availabilityTarget ?? 0) >= 99.9
        ? `availabilityTarget is ${constraints.availabilityTarget}`
        : undefined;

  const explicitZones = v2?.placement?.zones;
  let zones = explicitZones ?? (env.class === "production" ? 2 : 1);
  let zoneNote: string;
  if (availabilityDemand && zones < 2) {
    zoneNote =
      explicitZones === undefined
        ? `2 zones because ${availabilityDemand} (a ${env.class} environment defaults to ${zones}).`
        : `placement.zones=${explicitZones} raised to 2 because ${availabilityDemand}; one zone cannot survive a zone loss.`;
    zones = 2;
  } else {
    zoneNote = `${zones} zone${zones === 1 ? "" : "s"}${explicitZones !== undefined ? " (placement.zones)" : ` (${env.class} default)`}.`;
  }

  const svcs = new Map<string, SvcInfo>();
  for (const s of services) {
    const kind = WORKLOAD_ADDR[s.kind];
    svcs.set(s.id, {
      id: s.id,
      name: s.name,
      address: `${kind}/${s.name}`,
      place: placeOfManifestNode(s.id, s.name),
      managed: s.ownership === "managed",
      s,
      kind,
      env: [],
      secretReads: [],
      deps: new Set(),
      grants: new Map(),
      grantDeps: new Set(),
    });
  }
  const ress = new Map<string, ResInfo>();
  for (const r of resources) {
    ress.set(r.id, {
      id: r.id,
      name: r.name,
      address: `${r.kind}/${r.name}`,
      place: placeOfManifestNode(r.id, r.name),
      managed: r.ownership === "managed",
      r,
      modelled: r.kind !== "email",
    });
  }

  // RDS subnet groups require two AZs even for a single-AZ DB instance.
  // ElastiCache failover also needs distinct AZs. This is a provider minimum,
  // independent of the environment class or an explicit one-zone placement.
  const awsData = [...ress.values()].filter((i) => {
    if (!i.managed || i.place.provider !== "aws") return false;
    if (i.r.kind === "postgres") return true;
    return i.r.kind === "redis" && (tuningFor(v2, "aws").highAvailability ?? availabilityDemand !== undefined);
  });
  if (awsData.length > 0) {
    const reason = `AWS RDS (Postgres/MySQL) subnet groups and highly available Redis require private subnets in at least 2 AZs (${awsData.map((i) => i.address).join(", ")})`;
    if (zones < 2) {
      zoneNote = `${zoneNote} ${explicitZones === undefined ? `${env.class} default` : `placement.zones=${explicitZones}`} raised to 2 because ${reason}.`;
      zones = 2;
    } else zoneNote += ` ${reason}.`;
  }

  const nm = (id: string): string =>
    svcs.get(id)?.name ?? ress.get(id)?.name ?? routes.find((r) => r.id === id)?.host.toLowerCase() ?? id;
  const bindings = [...view.bindings].sort((x, y) =>
    cmp(`${nm(x.from)}\0${nm(x.to)}\0${x.capability}\0${x.id}`, `${nm(y.from)}\0${nm(y.to)}\0${y.capability}\0${y.id}`)
  );

  // An AWS Application Load Balancer must span public subnets in at least 2
  // AZs. Expansion derives one from any http route to a managed web service
  // (see `emitRouting`), so the same condition raises the zone count here.
  if (defaultPlace.provider === "aws") {
    const routeIds = new Set(routes.map((r) => r.id));
    const lbTargets = uniqSorted(bindings
      .filter((bd) => routeIds.has(bd.from) && bd.capability === "http")
      .flatMap((bd) => { const s = svcs.get(bd.to); return s && s.managed && s.s.kind === "web" ? [s.address] : []; }));
    if (lbTargets.length > 0) {
      const reason = `an AWS Application Load Balancer requires public subnets in at least 2 AZs (routes to ${lbTargets.join(", ")})`;
      if (zones < 2) {
        zoneNote = `${zoneNote} ${explicitZones === undefined ? `${env.class} default` : `placement.zones=${explicitZones}`} raised to 2 because ${reason}.`;
        zones = 2;
      } else zoneNote += ` ${reason}.`;
    }
  }

  const addrByKey = new Map<string, string>();
  for (const i of [...svcs.values(), ...ress.values()].filter((i) => !("modelled" in i) || i.modelled)) {
    addrByKey.set(i.id, i.address);
    if (!addrByKey.has(i.name)) addrByKey.set(i.name, i.address);
  }

  // Environment wins over the manifest's own placement: it holds the connection.
  const p = v2?.placement;
  if (p && p.provider !== "auto" && p.provider !== env.provider)
    b.note("placement", `manifest placement.provider is ${p.provider} but this environment runs on ${env.provider}; the environment wins.`);
  else if (p && p.provider !== "auto" && !p.regions.includes(env.region))
    b.note("placement", `environment region ${env.region} is not in placement.regions [${p.regions.join(", ")}]; the environment wins.`);
  if (p?.provider === "auto") b.note("placement", `manifest placement.provider is auto; this environment's ${env.provider}/${env.region} is what the placement solver (or the user) chose.`);
  if (p?.residency?.length || constraints.budgetUsdMonthly !== undefined || constraints.latencyTargetMs !== undefined || constraints.userRegions?.length)
    b.note("constraints", "budget, latency, user-region and residency declarations are evaluated by placement and policy, not by expansion; they do not change this graph.");

  return { env, b, m: manifest, v2, services, resources, routes, bindings, policies, constraints, zones, zoneNote, availabilityDemand, defaultPlace, svcs, ress, addrByKey };
}

/** Distinct placements of nodes that need a network, plus the default one when a load balancer exists. */
export function placesNeedingNetwork(ctx: Ctx, hasLoadBalancer: boolean): Place[] {
  const needs = new Map<string, Place>();
  const consider = (p: Place) => needs.set(placeKey(p), p);
  for (const i of ctx.svcs.values()) if (i.managed && (i.kind === "container_service" || i.kind === "scheduled_job")) consider(i.place);
  for (const i of ctx.ress.values()) if (i.managed && i.modelled && (i.r.kind === "postgres" || i.r.kind === "redis")) consider(i.place);
  if (hasLoadBalancer) consider(ctx.defaultPlace);
  return [...needs.values()].sort((x, y) => cmp(placeKey(x), placeKey(y)));
}
