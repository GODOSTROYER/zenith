/**
 * Request-path traversal over the desired resource graph (spec §21, ADR-0014).
 *
 * Pure and deterministic: the same graph and entry always produce the same
 * ordered list of hops. No I/O, no clock.
 *
 *   dns_record → tls_certificate → (internet → lb firewall) → load_balancer
 *     → firewall(lb → service) → container_service [container, application]
 *       → for each dependency: firewall(service → dep) → dep
 *       → secrets the service reads → the service's identity
 *
 * Entry points: a `dns_record` (by address or host name), the `load_balancer`,
 * or a named `container_service` (by address or bare name). With no entry the
 * load balancer is used, else the first DNS record, else the first web
 * service, else the first container service. Anything else is rejected rather
 * than guessed at.
 *
 * Only edges and specs the expansion wrote are followed (`resolves_to`,
 * `secures`, `routes_to`, `connects_to`, `publishes_to`, `consumes_from`,
 * `reads_secret`, and firewall `spec.source`/`spec.target`), so a hop is on the
 * path because the graph says so, never because a name looks similar. Shared
 * nodes appear once, at their first position. A chain of services is followed
 * for at most `MAX_SERVICE_DEPTH` services (the entry service counts); a cycle
 * cannot loop because every address is visited once.
 */
import type { FirewallSpec } from "@/lib/resources/specs";
import type { ResourceEdge, ResourceGraph, ResourceNode } from "@/lib/resources/types";
import type { Hop } from "./types";

export type DependencyClass = "database" | "cache" | "queue" | "storage" | "service";

export interface PathStep {
  hop: Hop;
  /** graph address */
  address: string;
  kind: ResourceNode["kind"];
  /** why this node is on the path, in plain words */
  role: string;
  /** firewall steps: the rule exactly as the desired graph states it */
  rule?: { source: { address: string } | { cidr: string }; target: string; port: number; capability: string };
  /** steps that are (or protect) a dependency of a service: what class it is, and who depends on it */
  dependency?: { class: DependencyClass; address: string; client: string; /** the port the graph says the client uses (edge detail or firewall rule) */ port?: number };
  /** steps that hang off a service (secret, identity): the service they belong to */
  owner?: string;
}

export interface RequestPath {
  entry: { address: string; kind: string };
  steps: PathStep[];
  notes: string[];
}

export class TraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraversalError";
  }
}

export const MAX_SERVICE_DEPTH = 3;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const DEPENDENCY_KINDS = new Set(["postgres", "mysql", "redis", "queue", "pubsub", "object_store", "container_service"]);
const DEP_RELATIONS = new Set<ResourceEdge["relation"]>(["connects_to", "publishes_to", "consumes_from"]);

export function dependencyClassOf(kind: string): DependencyClass | undefined {
  switch (kind) {
    case "postgres":
    case "mysql":
      return "database";
    case "redis":
      return "cache";
    case "queue":
    case "pubsub":
      return "queue";
    case "object_store":
      return "storage";
    case "container_service":
      return "service";
    default:
      return undefined;
  }
}

/** The hop a node kind belongs to, or undefined when the kind is not on a request path. */
export function hopOfKind(kind: string): Hop | undefined {
  switch (kind) {
    case "dns_record":
      return "dns";
    case "tls_certificate":
      return "tls";
    case "load_balancer":
      return "load_balancer";
    case "firewall":
      return "firewall";
    case "container_service":
      return "container";
    case "compute_instance":
      return "compute";
    case "postgres":
    case "mysql":
      return "database";
    case "redis":
      return "cache";
    case "queue":
    case "pubsub":
      return "queue";
    case "object_store":
      return "storage";
    case "secret":
      return "secret";
    case "identity":
      return "identity";
    default:
      return undefined;
  }
}

/* -------------------------------- graph index ------------------------------- */

interface Index {
  nodes: Map<string, ResourceNode>;
  out: Map<string, ResourceEdge[]>;
  into: Map<string, ResourceEdge[]>;
  byKind: Map<string, ResourceNode[]>;
}

function indexGraph(graph: ResourceGraph): Index {
  const nodes = new Map<string, ResourceNode>();
  for (const n of graph.nodes) nodes.set(n.address, n);
  const out = new Map<string, ResourceEdge[]>();
  const into = new Map<string, ResourceEdge[]>();
  for (const e of graph.edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    (into.get(e.to) ?? into.set(e.to, []).get(e.to)!).push(e);
  }
  const byKind = new Map<string, ResourceNode[]>();
  for (const n of [...graph.nodes].sort((a, b) => cmp(a.address, b.address)))
    (byKind.get(n.kind) ?? byKind.set(n.kind, []).get(n.kind)!).push(n);
  const order = (a: ResourceEdge, b: ResourceEdge) => cmp(`${a.from}\0${a.to}\0${a.relation}\0${a.detail ?? ""}`, `${b.from}\0${b.to}\0${b.relation}\0${b.detail ?? ""}`);
  for (const list of out.values()) list.sort(order);
  for (const list of into.values()) list.sort(order);
  return { nodes, out, into, byKind };
}

const kindList = (ix: Index, kind: string): ResourceNode[] => ix.byKind.get(kind) ?? [];

function firewallSpec(node: ResourceNode): FirewallSpec | undefined {
  const s = node.spec as Partial<FirewallSpec>;
  if (node.kind !== "firewall" || typeof s.port !== "number" || typeof s.target !== "string" || !s.source) return undefined;
  return s as FirewallSpec;
}

/** `sql:5432`, `cache:6379`, `http:8080` → the port */
const portOf = (detail: string | undefined): number | undefined => {
  const m = /:(\d{2,5})$/.exec(detail ?? "");
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 65535 ? n : undefined;
};

const sourceAddress = (s: FirewallSpec): string | undefined => ("address" in s.source ? s.source.address : undefined);

/* --------------------------------- entry ------------------------------------ */

const ENTRY_KINDS = new Set(["dns_record", "load_balancer", "container_service"]);

function resolveEntry(ix: Index, graph: ResourceGraph, entry: string | undefined): ResourceNode {
  if (entry === undefined || entry.trim() === "") {
    const lb = kindList(ix, "load_balancer")[0];
    const dns = kindList(ix, "dns_record")[0];
    const services = kindList(ix, "container_service");
    const web = services.find((s) => (s.spec as { workload?: string }).workload === "web");
    const pick = lb ?? dns ?? web ?? services[0];
    if (!pick) throw new TraversalError("The environment has no load balancer, DNS record or container service to start a request path from.");
    return pick;
  }
  const wanted = entry.trim();
  const direct = ix.nodes.get(wanted);
  if (direct) {
    if (!ENTRY_KINDS.has(direct.kind))
      throw new TraversalError(`${wanted} is a ${direct.kind}; an entry point must be a dns_record, the load_balancer or a container_service.`);
    return direct;
  }
  const lower = wanted.toLowerCase();
  const byHost = kindList(ix, "dns_record").find((n) => String((n.spec as { name?: string }).name ?? "").toLowerCase() === lower);
  if (byHost) return byHost;
  const byName = kindList(ix, "container_service").find((n) => n.address === `container_service/${wanted}` || n.address.endsWith(`/${wanted}`));
  if (byName) return byName;
  throw new TraversalError(`Entry "${wanted.slice(0, 120)}" is not an address, DNS host or service name in environment ${graph.environmentId}.`);
}

/* -------------------------------- builders ---------------------------------- */

interface Builder {
  ix: Index;
  steps: PathStep[];
  seen: Set<string>;
  notes: string[];
}

function push(b: Builder, step: PathStep, dedupeKey = `${step.hop}\0${step.address}`): boolean {
  if (b.seen.has(dedupeKey)) return false;
  b.seen.add(dedupeKey);
  b.steps.push(step);
  return true;
}

function nodeStep(node: ResourceNode, role: string, extra: Partial<PathStep> = {}): PathStep | undefined {
  const hop = hopOfKind(node.kind);
  if (!hop) return undefined;
  const fw = firewallSpec(node);
  return { hop, address: node.address, kind: node.kind, role, ...(fw ? { rule: { source: fw.source, target: fw.target, port: fw.port, capability: fw.capability } } : {}), ...extra };
}

/** Firewalls whose rule is `source → target`, in address order. */
function firewallsBetween(ix: Index, source: string, target: string): ResourceNode[] {
  return kindList(ix, "firewall").filter((f) => {
    const s = firewallSpec(f);
    return s !== undefined && s.target === target && sourceAddress(s) === source;
  });
}

function internetFirewalls(ix: Index, target: string): ResourceNode[] {
  return kindList(ix, "firewall").filter((f) => {
    const s = firewallSpec(f);
    return s !== undefined && s.target === target && "cidr" in s.source;
  });
}

function addFirewalls(b: Builder, fws: ResourceNode[], role: string, dependency?: PathStep["dependency"]): void {
  for (const f of fws) {
    const step = nodeStep(f, role, dependency ? { dependency } : {});
    if (step) push(b, step);
  }
}

function addService(b: Builder, svc: ResourceNode, role: string, depth: number): void {
  const hop = hopOfKind(svc.kind);
  if (!hop) return;
  const visitedBefore = b.seen.has(`${hop}\0${svc.address}`);
  const step = nodeStep(svc, role);
  if (step) push(b, step);
  if (visitedBefore) return;
  if (svc.kind === "container_service" || svc.kind === "compute_instance")
    push(b, { hop: "application", address: svc.address, kind: svc.kind, role: `application logs of ${svc.address}` });

  // dependencies: a firewall rule (when the graph derived one) then the node itself
  const deps = (b.ix.out.get(svc.address) ?? []).filter((e) => DEP_RELATIONS.has(e.relation));
  const seenDep = new Set<string>();
  for (const e of deps) {
    if (seenDep.has(e.to)) continue;
    seenDep.add(e.to);
    const dep = b.ix.nodes.get(e.to);
    if (!dep || !DEPENDENCY_KINDS.has(dep.kind)) continue;
    const klass = dependencyClassOf(dep.kind)!;
    const fws = firewallsBetween(b.ix, svc.address, dep.address);
    const port = portOf(e.detail) ?? (fws.length ? firewallSpec(fws[0])?.port : undefined);
    const meta = { class: klass, address: dep.address, client: svc.address, ...(port !== undefined ? { port } : {}) };
    addFirewalls(b, fws, `ingress rule for ${svc.address} → ${dep.address}`, meta);
    if (dep.kind === "container_service") {
      if (depth < MAX_SERVICE_DEPTH) addService(b, dep, `dependency of ${svc.address}`, depth + 1);
      else b.notes.push(`${dep.address} is a dependency of ${svc.address} but lies beyond the traversal depth (${MAX_SERVICE_DEPTH}); it was not probed.`);
    } else {
      const ds = nodeStep(dep, `${klass} dependency of ${svc.address}`, { dependency: meta });
      if (ds) push(b, ds);
    }
  }

  // secrets the service reads, then its identity
  const secrets = new Map<string, string[]>();
  for (const e of b.ix.out.get(svc.address) ?? []) {
    if (e.relation !== "reads_secret") continue;
    const keys = secrets.get(e.to) ?? [];
    if (e.detail) keys.push(e.detail);
    secrets.set(e.to, keys);
  }
  for (const address of [...secrets.keys()].sort(cmp)) {
    const sn = b.ix.nodes.get(address);
    if (!sn) continue;
    const keys = secrets.get(address)!.sort(cmp);
    const ss = nodeStep(sn, `secret read by ${svc.address}${keys.length ? ` as ${keys.join(", ")}` : ""}`, { owner: svc.address });
    if (ss) push(b, ss);
  }
  for (const idn of kindList(b.ix, "identity").filter((n) => (n.spec as { workload?: string }).workload === svc.address)) {
    const is = nodeStep(idn, `workload identity of ${svc.address}`, { owner: svc.address });
    if (is) push(b, is);
  }
}

/** DNS records (optionally only some hosts) that resolve to `target`, and certificates securing it. */
function addEdgeHops(b: Builder, target: string, hosts: Set<string> | undefined): void {
  for (const e of b.ix.into.get(target) ?? []) {
    if (e.relation !== "resolves_to") continue;
    const n = b.ix.nodes.get(e.from);
    if (!n || n.kind !== "dns_record") continue;
    const name = String((n.spec as { name?: string }).name ?? "").toLowerCase();
    if (hosts && !hosts.has(name)) continue;
    const s = nodeStep(n, `DNS record ${name} resolving to ${target}`);
    if (s) push(b, s);
  }
  for (const e of b.ix.into.get(target) ?? []) {
    if (e.relation !== "secures") continue;
    const n = b.ix.nodes.get(e.from);
    if (!n || n.kind !== "tls_certificate") continue;
    const domain = String((n.spec as { domain?: string }).domain ?? "").toLowerCase();
    if (hosts && !hosts.has(domain)) continue;
    const s = nodeStep(n, `certificate for ${domain} securing ${target}`);
    if (s) push(b, s);
  }
}

const routeHost = (detail: string | undefined): string => (detail ?? "").split("/")[0].toLowerCase();

function addLoadBalancer(b: Builder, lb: ResourceNode, only: string | undefined): void {
  addFirewalls(b, internetFirewalls(b.ix, lb.address), `internet ingress rule to ${lb.address}`);
  const s = nodeStep(lb, "public entry of the environment");
  if (s) push(b, s);
  const routed = new Set<string>();
  for (const e of b.ix.out.get(lb.address) ?? []) {
    if (e.relation !== "routes_to" || routed.has(e.to)) continue;
    if (only !== undefined && e.to !== only) continue;
    routed.add(e.to);
    const target = b.ix.nodes.get(e.to);
    if (!target) continue;
    addFirewalls(b, firewallsBetween(b.ix, lb.address, target.address), `ingress rule for ${lb.address} → ${target.address}`, { class: "service", address: target.address, client: lb.address });
    if (target.kind === "container_service") addService(b, target, `routed target of ${lb.address}`, 1);
    else {
      const ts = nodeStep(target, `routed target of ${lb.address}`);
      if (ts) push(b, ts);
      else b.notes.push(`${target.address} (${target.kind}) is routed to by ${lb.address} but has no probeable hop.`);
    }
  }
}

function routedHosts(ix: Index, lb: string, service: string): Set<string> {
  const hosts = new Set<string>();
  for (const e of ix.out.get(lb) ?? []) if (e.relation === "routes_to" && e.to === service) hosts.add(routeHost(e.detail));
  return hosts;
}

/* ---------------------------------- public ---------------------------------- */

export function traverse(graph: ResourceGraph, entry?: string): RequestPath {
  const ix = indexGraph(graph);
  const start = resolveEntry(ix, graph, entry);
  const b: Builder = { ix, steps: [], seen: new Set(), notes: [] };

  if (start.kind === "dns_record") {
    const name = String((start.spec as { name?: string }).name ?? "").toLowerCase();
    const target = (ix.out.get(start.address) ?? []).find((e) => e.relation === "resolves_to")?.to;
    const s = nodeStep(start, `DNS record ${name}`);
    if (s) push(b, s);
    if (!target) b.notes.push(`${start.address} resolves to nothing in the graph; the path ends at DNS.`);
    else {
      addEdgeHops(b, target, new Set([name])); // the record itself is already first; this adds the cert for the same host
      const t = ix.nodes.get(target)!;
      if (t.kind === "load_balancer") addLoadBalancer(b, t, undefined);
      else if (t.kind === "container_service") addService(b, t, `target of ${start.address}`, 1);
      else b.notes.push(`${start.address} points at ${t.address} (${t.kind}); the path ends there.`);
    }
  } else if (start.kind === "load_balancer") {
    addEdgeHops(b, start.address, undefined);
    addLoadBalancer(b, start, undefined);
  } else {
    // a named service: the load balancers that route to it (with the hosts that reach it), then the service
    const lbs = (ix.into.get(start.address) ?? []).filter((e) => e.relation === "routes_to").map((e) => e.from);
    const uniqueLbs = [...new Set(lbs)].sort(cmp);
    if (uniqueLbs.length === 0) b.notes.push(`${start.address} is not routed to by a load balancer; the path starts at the service.`);
    for (const lbAddress of uniqueLbs) {
      const lb = ix.nodes.get(lbAddress);
      if (!lb) continue;
      addEdgeHops(b, lb.address, routedHosts(ix, lb.address, start.address));
      addLoadBalancer(b, lb, start.address);
    }
    addService(b, start, "the named service", 1);
  }
  return { entry: { address: start.address, kind: start.kind }, steps: b.steps, notes: b.notes };
}
