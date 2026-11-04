/**
 * The pure routing model of the load balancer: which routes each listener
 * serves, which target groups exist, what they are called, and what priority
 * each listener rule gets. `compileLoadBalancer` emits tofu from it and
 * `expectedAlbAttributes` turns the same model into comparable attributes, so
 * desired and observed can never be computed two different ways.
 *
 * Listener semantics (from `LoadBalancerSpec`, honoring route.tls per route):
 *   - an `https` listener serves the routes with `tls: true`;
 *   - an `http` listener that redirects (`redirectToHttps`) serves ONLY the
 *     routes with `tls: false` through listener rules and redirects everything
 *     else (default action) to HTTPS — a plain-HTTP host must keep working even
 *     when its neighbour is HTTPS-only;
 *   - an `http` listener that does not redirect serves every route;
 *   - every listener's default action is a fixed 404 (no route matched).
 *
 * Rule priorities are not sequential, so a change to one host never renumbers
 * another host's rules (the provider updates priorities one rule at a time and
 * a swap can collide): a host gets a slot (fnv1a(host) mod 4000, linear-probed
 * over hosts in sorted order on the rare collision) and a rule's priority is
 * `1 + slot·10 + rank`, rank 0 being that host's LONGEST path prefix — ALB
 * evaluates the lowest number first, and a longer prefix must win. Within one
 * host the ranks follow path specificity, so adding a LONGER prefix to a host
 * shifts that host's shorter ones by one. A host may have at most 10 routes.
 */
import type { LoadBalancerRoute, LoadBalancerSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { DriverCompileError, cloudName, fnv1a, hash6, nodeName } from "../shared";

export const TLS_POLICY = "ELBSecurityPolicy-TLS13-1-2-2021-06";
export const MAX_ROUTES_PER_HOST = 10;
const PRIORITY_SLOTS = 4000;

const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const PATH = /^\/[A-Za-z0-9_\-./~@:+]*$/;
const HEALTH_PATH = /^\/[A-Za-z0-9_\-./~@:+?&=%]*$/;

export interface ListenerModel {
  port: number;
  protocol: "HTTP" | "HTTPS";
  /** default action is a 301 to HTTPS on this port */
  redirectToPort?: number;
  routes: RouteModel[];
}

export interface RouteModel {
  host: string;
  /** normalized: starts with `/`, no trailing slash except the root itself */
  pathPrefix: string;
  tls: boolean;
  target: string;
  port: number;
  healthPath?: string;
}

export interface TargetGroupModel {
  key: string;
  target: string;
  port: number;
  healthPath: string;
  /** cloud name, ≤ 32, suffix hashes the attributes that force replacement */
  name: string;
}

export interface LoadBalancerModel {
  listeners: ListenerModel[];
  routes: RouteModel[];
  targetGroups: TargetGroupModel[];
}

function normalizePath(owner: string, raw: unknown): string {
  if (typeof raw !== "string" || !PATH.test(raw)) throw new DriverCompileError("invalid_spec", owner, `route pathPrefix must start with "/" and use only letters, digits and _-./~@:+, got ${JSON.stringify(raw)}.`);
  return raw.length > 1 ? raw.replace(/\/+$/, "") || "/" : raw;
}

/** Validate `spec` and build the model. Throws `DriverCompileError` for anything AWS would reject or that would misroute. */
export function readLoadBalancerModel(node: ResourceNode, namePrefix: string): LoadBalancerModel {
  const spec = node.spec as Partial<LoadBalancerSpec>;
  const fail = (code: "invalid_spec" | "unsupported", msg: string): never => {
    throw new DriverCompileError(code, node.address, msg);
  };
  if (spec.scheme !== "internet-facing") fail("unsupported", `scheme ${JSON.stringify(spec.scheme)} is not supported; only internet-facing load balancers are compiled.`);
  if (!Array.isArray(spec.listeners) || spec.listeners.length === 0) fail("invalid_spec", "spec.listeners must list at least one listener.");
  if (!Array.isArray(spec.routes)) fail("invalid_spec", "spec.routes must be a list.");

  const routes: RouteModel[] = [];
  const seenRoute = new Set<string>();
  for (const r of (spec.routes ?? []) as Partial<LoadBalancerRoute>[]) {
    const host = typeof r.host === "string" ? r.host.toLowerCase() : "";
    if (!HOST.test(host)) fail("invalid_spec", `route host ${JSON.stringify(r.host)} is not a plain hostname.`);
    const pathPrefix = normalizePath(node.address, r.pathPrefix);
    if (typeof r.tls !== "boolean") fail("invalid_spec", `route ${host}${pathPrefix}: tls must be true or false.`);
    if (typeof r.target !== "string" || r.target === "") fail("invalid_spec", `route ${host}${pathPrefix}: target must be the address of a service.`);
    if (typeof r.port !== "number" || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535) {
      fail("invalid_spec", `route ${host}${pathPrefix} → ${r.target} has no valid port (${JSON.stringify(r.port)}); a target group needs one.`);
    }
    if (r.healthPath !== undefined && (typeof r.healthPath !== "string" || !HEALTH_PATH.test(r.healthPath) || r.healthPath.length > 1024)) {
      fail("invalid_spec", `route ${host}${pathPrefix}: healthPath ${JSON.stringify(r.healthPath)} is not a path.`);
    }
    const id = `${host}${pathPrefix}`;
    if (seenRoute.has(id)) fail("invalid_spec", `two routes serve ${id}.`);
    seenRoute.add(id);
    routes.push({ host, pathPrefix, tls: r.tls as boolean, target: r.target as string, port: r.port as number, ...(r.healthPath ? { healthPath: r.healthPath } : {}) });
  }
  routes.sort((a, b) => cmp(a.host, b.host) || b.pathPrefix.length - a.pathPrefix.length || cmp(a.pathPrefix, b.pathPrefix));
  const perHost = new Map<string, number>();
  for (const r of routes) perHost.set(r.host, (perHost.get(r.host) ?? 0) + 1);
  for (const [host, n] of perHost) if (n > MAX_ROUTES_PER_HOST) fail("invalid_spec", `${host} has ${n} routes; at most ${MAX_ROUTES_PER_HOST} per host.`);

  const ports = new Set<number>();
  const rawListeners = [...(spec.listeners ?? [])].sort((a, b) => (a?.port ?? 0) - (b?.port ?? 0));
  const httpsPort = rawListeners.find((l) => l?.protocol === "https")?.port;
  const listeners: ListenerModel[] = [];
  for (const l of rawListeners) {
    if (typeof l?.port !== "number" || !Number.isInteger(l.port) || l.port < 1 || l.port > 65535) fail("invalid_spec", `listener port ${JSON.stringify(l?.port)} is not a port number.`);
    if (l.protocol !== "http" && l.protocol !== "https") fail("invalid_spec", `listener ${l.port}: protocol ${JSON.stringify(l.protocol)} must be http or https.`);
    if (ports.has(l.port)) fail("invalid_spec", `two listeners use port ${l.port}.`);
    ports.add(l.port);
    if (l.redirectToHttps && (l.protocol !== "http" || httpsPort === undefined)) fail("invalid_spec", `listener ${l.port}: redirectToHttps needs an http listener and an https listener to redirect to.`);
    const served = l.protocol === "https" ? routes.filter((r) => r.tls) : l.redirectToHttps ? routes.filter((r) => !r.tls) : routes;
    listeners.push({ port: l.port, protocol: l.protocol === "https" ? "HTTPS" : "HTTP", ...(l.redirectToHttps ? { redirectToPort: httpsPort } : {}), routes: served });
  }
  if (httpsPort === undefined && routes.some((r) => r.tls)) fail("invalid_spec", "a route has tls on but there is no https listener.");

  // One target group per (target, port). The health path is the first declared one in route order.
  const groups = new Map<string, TargetGroupModel>();
  for (const r of routes) {
    const key = `${r.target}:${r.port}`;
    const existing = groups.get(key);
    if (existing) {
      if (existing.healthPath === "/" && r.healthPath) existing.healthPath = r.healthPath;
      continue;
    }
    groups.set(key, { key, target: r.target, port: r.port, healthPath: r.healthPath ?? "/", name: targetGroupName(namePrefix, r.target, r.port) });
  }
  const targetGroups = [...groups.values()].sort((a, b) => cmp(a.key, b.key));
  return { listeners, routes, targetGroups };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `<prefix>-tg-<target>-<hash6(port|protocol|type)>`, ≤ 32. The hash is of the
 * attributes that force a target group to be replaced, so a replacement gets a
 * NEW name and `create_before_destroy` cannot collide with the group it replaces.
 */
export function targetGroupName(namePrefix: string, target: string, port: number): string {
  return `${cloudName(namePrefix, `tg-${nodeName(target)}`, 25)}-${hash6(`${port}|HTTP|ip`)}`;
}

/** The load balancer's own name: ≤ 32, `[a-z0-9-]`, never starting with `internal-` (reserved by ELB). */
export function loadBalancerName(namePrefix: string, address: string): string {
  const name = cloudName(namePrefix, `lb-${nodeName(address)}`, 32);
  return name.startsWith("internal-") ? `z${name}`.slice(0, 32) : name;
}

/** Stable rule priorities, keyed `host + pathPrefix`. See the module comment. */
export function assignPriorities(routes: readonly RouteModel[]): Map<string, number> {
  const byHost = new Map<string, RouteModel[]>();
  for (const r of routes) byHost.set(r.host, [...(byHost.get(r.host) ?? []), r]);
  const used = new Set<number>();
  const out = new Map<string, number>();
  for (const host of [...byHost.keys()].sort()) {
    let slot = parseInt(fnv1a(host), 16) % PRIORITY_SLOTS;
    while (used.has(slot)) slot = (slot + 1) % PRIORITY_SLOTS;
    used.add(slot);
    [...(byHost.get(host) as RouteModel[])]
      .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length || cmp(a.pathPrefix, b.pathPrefix))
      .forEach((r, rank) => out.set(`${r.host}${r.pathPrefix}`, 1 + slot * 10 + rank));
  }
  return out;
}

/* ------------------------- comparable desired values ------------------------ */

/**
 * One entry per listener, sorted by port: `{ port: 443, protocol: "HTTPS" }`, and `redirect: true` on a
 * listener whose default action redirects to HTTPS. The shape the incident engine reads (`port` per entry).
 */
export interface ListenerEntry {
  port: number;
  protocol: "HTTP" | "HTTPS";
  redirect?: true;
}

export function listenerEntries(model: LoadBalancerModel): ListenerEntry[] {
  return model.listeners.map((l): ListenerEntry => ({ port: l.port, protocol: l.protocol, ...(l.redirectToPort !== undefined ? { redirect: true as const } : {}) })).sort((x, y) => x.port - y.port);
}

/** `container_service/web:3000:/healthz` — one per target group, sorted. */
export function targetGroupKeys(model: LoadBalancerModel): string[] {
  return model.targetGroups.map((g) => `${g.target}:${g.port}:${g.healthPath}`).sort();
}

/** `443 app.acme.io/api -> container_service/web:3000` — one per listener rule, sorted. */
export function routeKeys(model: LoadBalancerModel): string[] {
  return model.listeners.flatMap((l) => l.routes.map((r) => `${l.port} ${r.host}${r.pathPrefix} -> ${r.target}:${r.port}`)).sort();
}

/** Tolerant desired-state model for `expectedAttributes`: `undefined` when the spec is unusable (it never throws). */
export function tryModel(node: ResourceNode): LoadBalancerModel | undefined {
  try {
    return readLoadBalancerModel(node, "x");
  } catch {
    return undefined;
  }
}

/** Plain-hash label for one listener rule: stable across route reordering. */
export const ruleLabelHash = (host: string, pathPrefix: string): string => hash6(`${host}${pathPrefix}`);
