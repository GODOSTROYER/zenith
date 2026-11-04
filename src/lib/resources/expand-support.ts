/**
 * Small pure helpers behind `expandManifest()`: canonical ordering, the graph
 * builder, naming, CIDR carving and DNS apex inference. Nothing here knows a
 * manifest shape beyond what its signature says.
 */
import { digest } from "@/lib/controlplane/digest";
import type { PortableKind, ProviderKey, ResourceEdge, ResourceGraph, ResourceNode, ResourceOwnership } from "./types";
import { resolveNativeType, unsupportedNativeType } from "./native-types";
import type { AnyManifest } from "./manifest-v2";

export class ManifestExpansionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestExpansionError";
  }
}

/* ------------------------------- ordering -------------------------------- */

export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Sorted, de-duplicated copy. */
export const uniqSorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort(cmp);

/**
 * Deep copy with object keys sorted and `undefined` dropped, so two graphs built
 * from equal inputs are byte-identical under `JSON.stringify`, not merely equal
 * under the digest's canonical form. Array order is the caller's to fix.
 */
export function sortDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortDeep) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort(cmp)) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortDeep(v);
    }
    return out as T;
  }
  return value;
}

/* ------------------------- manifest canonical form ------------------------ */

/**
 * The manifest with every order-insensitive list sorted. Two manifests that
 * differ only in the order of services, resources, routes, bindings, env vars
 * or native entries describe the same system and get the same digest. Lists
 * where order carries meaning (`placement.regions`: primary first) are kept.
 */
export function canonicalManifest(m: AnyManifest): unknown {
  const by = <T>(xs: readonly T[], key: (x: T) => string): T[] => [...xs].sort((a, b) => cmp(key(a), key(b)));
  const services = by(m.services, (s) => `${s.name}\0${s.id}`).map((s) => ({ ...s, env: by(s.env, (e) => e.key) }));
  const base = {
    ...m,
    services,
    resources: by(m.resources, (r) => `${r.name}\0${r.id}`),
    routes: by(m.routes, (r) => `${r.host.toLowerCase()}\0${r.pathPrefix}\0${r.id}`),
    bindings: by(m.bindings, (b) => b.id),
  };
  if (m.version === 2 && m.native) return { ...base, native: by(m.native, (n) => n.id) };
  return base;
}

/**
 * Digest of the manifest's content, independent of list order. This — not a
 * raw `digest(manifest)` — is what `ResourceGraph.manifestDigest` holds, so
 * compare against this function's output.
 */
export const manifestDigest = (m: AnyManifest): string => digest(canonicalManifest(m));

/* -------------------------------- placement ------------------------------- */

export interface Place {
  provider: ProviderKey;
  region: string;
}

export const placeKey = (p: Place): string => `${p.provider}/${p.region}`;

/* --------------------------------- builder -------------------------------- */

export interface NodeInput {
  address: string;
  kind: PortableKind | "provider_native";
  place: Place;
  ownership?: ResourceOwnership;
  externalRef?: string;
  spec: Record<string, unknown>;
  origin: string[];
  dependsOn?: string[];
  /** only for `provider_native`; portable kinds resolve through the mapping table */
  nativeType?: string;
}

export const specDigestOf = (n: Pick<ResourceNode, "kind" | "provider" | "region" | "nativeType" | "ownership" | "spec">): string =>
  digest({ kind: n.kind, provider: n.provider, region: n.region, nativeType: n.nativeType, ownership: n.ownership, spec: n.spec });

export const graphDigestOf = (nodes: readonly ResourceNode[], edges: readonly ResourceEdge[]): string => digest({ nodes, edges });

export class GraphBuilder {
  readonly nodes = new Map<string, ResourceNode>();
  private readonly edgeMap = new Map<string, ResourceEdge>();
  /** unordered node pairs that already have some edge, for the depends_on fill-in */
  private readonly linked = new Set<string>();
  private readonly noteSet = new Set<string>();

  constructor(private readonly environmentId: string) {}

  note(tag: string, message: string): void {
    this.noteSet.add(`${tag}: ${message}`);
  }

  has(address: string): boolean {
    return this.nodes.has(address);
  }

  add(input: NodeInput): ResourceNode {
    if (this.nodes.has(input.address))
      throw new ManifestExpansionError(`Two manifest nodes derive the same address "${input.address}". Rename one of them.`);
    const ownership = input.ownership ?? "managed";
    let nativeType = input.nativeType;
    if (nativeType === undefined) {
      if (input.kind === "provider_native") throw new ManifestExpansionError(`${input.address}: provider_native needs a nativeType.`);
      const r = resolveNativeType(input.place.provider, input.kind);
      nativeType = r.nativeType;
      if (!r.supported)
        this.note(
          "unsupported",
          `${input.address} has no native mapping on ${input.place.provider}; it is kept as ${unsupportedNativeType(input.place.provider, input.kind)} and nothing can realize it there yet.`
        );
    }
    const node: ResourceNode = {
      address: input.address,
      kind: input.kind,
      provider: input.place.provider,
      region: input.place.region,
      nativeType,
      ownership,
      ...(input.externalRef !== undefined ? { externalRef: input.externalRef } : {}),
      spec: sortDeep(input.spec),
      origin: uniqSorted(input.origin),
      dependsOn: uniqSorted((input.dependsOn ?? []).filter((d) => d !== input.address)),
      specDigest: "",
      labels: sortDeep({
        "zenith:environment": this.environmentId,
        "zenith:managed": String(ownership === "managed"),
        "zenith:resource": input.address,
      }),
    };
    node.specDigest = specDigestOf(node);
    this.nodes.set(node.address, node);
    return node;
  }

  edge(from: string, to: string, relation: ResourceEdge["relation"], detail?: string): void {
    const e: ResourceEdge = { from, to, relation, ...(detail !== undefined ? { detail } : {}) };
    this.edgeMap.set(`${from}\0${to}\0${relation}\0${detail ?? ""}`, e);
    this.linked.add(`${from}\0${to}`).add(`${to}\0${from}`);
  }

  /** Is there any edge between the two addresses, in either direction? */
  connected(a: string, b: string): boolean {
    return this.linked.has(`${a}\0${b}`);
  }

  edgeList(): ResourceEdge[] {
    return [...this.edgeMap.values()];
  }

  noteList(): string[] {
    return [...this.noteSet].sort(cmp);
  }
}

export function finalizeGraph(
  b: GraphBuilder,
  environmentId: string,
  manifestDigestValue: string
): ResourceGraph {
  const nodes = [...b.nodes.values()].sort((x, y) => cmp(x.address, y.address));
  for (const n of nodes)
    for (const d of n.dependsOn)
      if (!b.nodes.has(d)) throw new ManifestExpansionError(`Internal: ${n.address} depends on ${d}, which expansion did not create.`);

  // Every remaining ordering dependency becomes a `depends_on` edge unless a
  // more specific relation already links the pair (in either direction).
  for (const n of nodes) for (const d of n.dependsOn) if (!b.connected(n.address, d)) b.edge(n.address, d, "depends_on");

  const edges = b
    .edgeList()
    .sort((x, y) => cmp(`${x.from}\0${x.to}\0${x.relation}\0${x.detail ?? ""}`, `${y.from}\0${y.to}\0${y.relation}\0${y.detail ?? ""}`));
  for (const e of edges)
    if (!b.nodes.has(e.from) || !b.nodes.has(e.to))
      throw new ManifestExpansionError(`Internal: edge ${e.from} → ${e.to} (${e.relation}) points at a node expansion did not create.`);

  return {
    version: 1,
    environmentId,
    manifestDigest: manifestDigestValue,
    nodes,
    edges,
    graphDigest: graphDigestOf(nodes, edges),
    notes: b.noteList(),
  };
}

/* --------------------------------- naming --------------------------------- */

export const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

export function assertName(kind: string, name: string): string {
  if (!NAME_RE.test(name))
    throw new ManifestExpansionError(`${kind} name "${name}" is not a valid node name (lowercase letters, digits and dashes, starting with a letter).`);
  return name;
}

export function assertHost(host: string): string {
  const h = host.toLowerCase();
  if (!HOST_RE.test(h)) throw new ManifestExpansionError(`Route host "${host}" is not a plain hostname.`);
  return h;
}

/** `kind/name` → `name` */
export const nameOf = (address: string): string => address.slice(address.indexOf("/") + 1);
export const kindOfAddress = (address: string): string => address.slice(0, address.indexOf("/"));

/** A lowercase dns-label-ish slug; never empty, never starts with a digit. */
export function slug(raw: string, max = 32): string {
  let s = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!s) s = "x";
  if (!/^[a-z]/.test(s)) s = `s-${s}`;
  return s.slice(0, max).replace(/-+$/g, "") || "x";
}

/** Address for a secret reference: readable key plus a digest of the full reference, so distinct refs never collide. */
export function secretAddress(ref: string): string {
  const last = ref.split(/[/:]/).filter(Boolean).pop() ?? "secret";
  return `secret/${slug(last, 40)}-${digest(ref).slice(0, 8)}`;
}

/* --------------------------------- CIDRs ---------------------------------- */

const ipToInt = (ip: string): number => ip.split(".").reduce((acc, o) => acc * 256 + Number(o), 0);
const intToIp = (n: number): string => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");

/**
 * The `index`-th /(N+8) slice of a /N network (N in 16..20, guaranteed by the
 * schema; the guard covers hand-built inputs). Public subnets use indices
 * 0..2, private ones 10..12, leaving room between.
 */
export function subnetCidr(vpcCidr: string, index: number): string {
  const [ip, bitsText] = vpcCidr.split("/");
  const bits = Number(bitsText);
  if (!(bits >= 8 && bits <= 20) || ip.split(".").length !== 4)
    throw new ManifestExpansionError(`Cannot carve subnets from "${vpcCidr}"; use a /16 to /20 network.`);
  const size = 2 ** (32 - (bits + 8));
  const base = Math.floor(ipToInt(ip) / 2 ** (32 - bits)) * 2 ** (32 - bits);
  return `${intToIp(base + index * size)}/${bits + 8}`;
}

/* ------------------------------ DNS apex ---------------------------------- */

/** Common two-label public suffixes. NOT a public-suffix list: see `apexOf`. */
const SECOND_LEVEL = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "co.in",
  "com.br", "com.mx", "co.za", "com.sg", "com.cn", "com.tr", "co.kr", "com.hk",
]);

/**
 * The zone a host lives in. Hosts under the environment's base domain belong to
 * that zone. Anything else is inferred from the last two labels (three for the
 * common two-label suffixes above): a HEURISTIC — no public-suffix list ships
 * here — so callers record it as one.
 */
export function apexOf(host: string, baseDomain: string): { apex: string; inferred: boolean } {
  const h = host.toLowerCase();
  const base = baseDomain.toLowerCase();
  if (base && (h === base || h.endsWith(`.${base}`))) return { apex: base, inferred: false };
  const labels = h.split(".");
  if (labels.length <= 2) return { apex: h, inferred: true };
  const last2 = labels.slice(-2).join(".");
  return { apex: SECOND_LEVEL.has(last2) ? labels.slice(-3).join(".") : last2, inferred: true };
}
