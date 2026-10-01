/**
 * `oci:load_balancer` — portable `load_balancer` on OCI (flexible load
 * balancer, layer 7).
 *
 * One node compiles to:
 *   oci_core_public_ip (RESERVED)      the stable address DNS points at; it
 *                                      survives load-balancer replacement and is
 *                                      published as `local.<label>_public_ip`
 *   oci_core_network_security_group    `<label>_nsg`; the `public_http` firewall
 *                                      nodes add tcp/80 and tcp/443 from the
 *                                      internet to it (the ONLY world-open rules)
 *   oci_load_balancer_load_balancer    shape "flexible" (10–100 Mbps), public,
 *                                      one regional public subnet, the NSG, the
 *                                      reserved IP
 *   backend sets + backends            one set per distinct target service;
 *                                      backends are the target's private IPs
 *                                      (`local.<target>_private_ips`), HTTP health
 *                                      check on the route's `healthPath`
 *   routing policy                     only when routes go to more than one
 *                                      target: host and path-prefix conditions,
 *                                      longest prefix first; requests matching no
 *                                      rule go to the first target's set
 *   rule set `redirect_https`          a 301 from http to https when a listener
 *                                      has `redirectToHttps`
 *   listeners                          HTTP on the listener's port; an HTTPS
 *                                      listener terminates TLS with the
 *                                      Certificates-service certificate
 *                                      (TLS 1.2/1.3 only)
 *
 * Fail closed:
 *   - an HTTPS listener with no certificate node, or with MORE THAN ONE, is
 *     refused. An OCI listener takes a single Certificates certificate; use one
 *     SAN certificate for several hosts (import it under each route hostname's
 *     certificate node name) or separate environments;
 *   - a route without a port, or to a target that is not a Zenith-managed
 *     container instance, is refused;
 *   - host and path values are validated before they are placed in a routing
 *     condition string (no quotes, no control characters).
 *
 * Honest limits: `route.tls = false` on one host still redirects to HTTPS when
 * the listener says so (the redirect is per listener, as expansion derives
 * it). The HTTPS certificate must already exist (see certificate.ts); the load
 * balancer service also needs a policy to read it (deploy/oci creates it).
 * Routing-condition syntax follows the public routing-policy language
 * reference and was not exercised against a tenancy.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { LoadBalancerRoute, LoadBalancerSpec } from "@/lib/resources/specs";
import type { HealthState, Observation, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { compartmentOf } from "../../context";
import { OciCompileError, OciUnsupportedError } from "../../errors";
import { ociCapabilities, ociDriverId } from "../../evidence";
import { auxName, auxRef, fnv6, interp, nameOf, networkOf, nodeCloudName, tfLabel, zenithTags } from "../../naming";
import {
  arrayOrItems,
  asArray,
  asNumber,
  asRecord,
  asString,
  attributesOf,
  discoverWith,
  locate,
  observationOf,
  runtimeOf,
  verifyWith,
  type LocateDef,
  type OciContext,
} from "../../observe-kit";
import { ociPath } from "../../services";
import { ociCall, type OciSession } from "../../transport";
import { addressList, assertPort, isManaged, readOnlyFragment, res, specOf } from "../shared";

export const LOAD_BALANCER_NATIVE_TYPE = "oci:load_balancer";
const ID = ociDriverId(LOAD_BALANCER_NATIVE_TYPE);

const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const PATH = /^\/[A-Za-z0-9/_.~%-]*$/;
const MIN_MBPS = 10;
const MAX_MBPS = 100;
const MAX_INSPECTED_SETS = 10;

/** LB entity names: letters, digits, `_`/`-`, at most 32 characters. */
export function lbName(prefix: string, raw: string): string {
  const base = `${prefix}_${raw}`.replace(/[^A-Za-z0-9_-]/g, "_");
  return base.length <= 32 ? base : `${base.slice(0, 25).replace(/[-_]+$/, "")}_${fnv6(base)}`;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Target {
  address: string;
  node: ResourceNode;
  replicas: number;
  port: number;
  healthPath: string;
  setName: string;
  setLabel: string;
  /** `oci_load_balancer_backend_set.<label>` */
  setAddress: string;
}

function validateRoute(node: ResourceNode, r: LoadBalancerRoute): void {
  if (typeof r.host !== "string" || !HOST.test(r.host)) throw new OciCompileError(`${node.address}: route host "${String(r.host).slice(0, 80)}" is not a plain hostname.`);
  if (typeof r.pathPrefix !== "string" || !PATH.test(r.pathPrefix)) throw new OciCompileError(`${node.address}: route path "${String(r.pathPrefix).slice(0, 80)}" contains characters that are not allowed in a routing condition.`);
  if (r.port === undefined) throw new OciCompileError(`${node.address}: the route to ${r.target} has no port, so the load balancer has no backend port.`);
  assertPort(node, r.port);
  if (r.healthPath !== undefined && !PATH.test(r.healthPath)) throw new OciCompileError(`${node.address}: healthPath "${r.healthPath.slice(0, 80)}" is not a valid path.`);
}

function targetsOf(node: ResourceNode, ctx: CompileContext, prefix: string, routes: LoadBalancerRoute[]): Target[] {
  const out = new Map<string, Target>();
  for (const r of [...routes].sort((a, b) => cmp(`${a.target}\0${a.pathPrefix}`, `${b.target}\0${b.pathPrefix}`))) {
    validateRoute(node, r);
    if (out.has(r.target)) {
      const t = out.get(r.target)!;
      if (t.port !== r.port) throw new OciUnsupportedError(`${node.address}: routes to ${r.target} use different ports (${t.port} and ${r.port}); one backend set has one backend port.`);
      continue;
    }
    const target = ctx.node(r.target);
    if (!target || target.nativeType !== "oci:container_instance" || target.ownership !== "managed") {
      throw new OciUnsupportedError(`${node.address}: route target ${r.target} is not a Zenith-managed container instance; the load balancer only fronts those.`);
    }
    const replicas = (target.spec as { replicas?: unknown }).replicas;
    if (typeof replicas !== "number" || !Number.isInteger(replicas) || replicas < 0) throw new OciCompileError(`${node.address}: target ${r.target} has no valid replica count.`);
    out.set(r.target, {
      address: r.target,
      node: target,
      replicas,
      port: r.port!,
      healthPath: r.healthPath ?? "/",
      setName: lbName("bs", nameOf(r.target)),
      setLabel: tfLabel(r.target),
      setAddress: res("oci_load_balancer_backend_set", node, `_bs_${tfLabel(r.target)}`).address,
    });
  }
  return [...out.values()];
}

/** `all(host eq 'h', path sw '/p')`; a "/" prefix adds no path clause. */
export function routeCondition(host: string, pathPrefix: string): string {
  const hostClause = `http.request.headers[(i 'host')] eq (i '${host}')`;
  if (pathPrefix === "" || pathPrefix === "/") return hostClause;
  return `all(${hostClause}, http.request.url.path sw '${pathPrefix}')`;
}

function certificateFor(node: ResourceNode, ctx: CompileContext, routes: LoadBalancerRoute[]): string | undefined {
  const wantsTls = routes.some((r) => r.tls);
  const certs = node.dependsOn.map((a) => ctx.node(a)).filter((n): n is ResourceNode => n !== undefined && n.kind === "tls_certificate");
  if (!wantsTls && certs.length === 0) return undefined;
  if (certs.length === 0) throw new OciCompileError(`${node.address}: a route asks for TLS but no tls_certificate node is among its dependencies.`);
  if (certs.length > 1) {
    throw new OciUnsupportedError(`${node.address}: ${certs.length} certificates (${certs.map((c) => c.address).join(", ")}) for one HTTPS listener. An OCI listener takes a single Certificates-service certificate; use one SAN certificate for all hosts or split the hosts across environments.`);
  }
  return certs[0].address;
}

export function compileLoadBalancer(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (!isManaged(node)) return readOnlyFragment();
  const spec = specOf<LoadBalancerSpec>(node);
  if (spec.scheme !== "internet-facing" || spec.tier !== "public") throw new OciUnsupportedError(`${node.address}: only internet-facing public load balancers are derived.`);
  if (!Array.isArray(spec.listeners) || spec.listeners.length === 0) throw new OciCompileError(`${node.address}: a load balancer needs at least one listener.`);
  if (!Array.isArray(spec.routes) || spec.routes.length === 0) throw new OciCompileError(`${node.address}: a load balancer needs at least one route.`);
  const listeners = [...spec.listeners].sort((a, b) => a.port - b.port);
  for (const l of listeners) {
    assertPort(node, l.port);
    if (l.protocol !== "http" && l.protocol !== "https") throw new OciCompileError(`${node.address}: listener protocol "${String(l.protocol)}" is not http or https.`);
  }
  if (new Set(listeners.map((l) => l.port)).size !== listeners.length) throw new OciCompileError(`${node.address}: two listeners share a port.`);

  const compartment = compartmentOf(ctx);
  const placement = networkOf(ctx, node, "public");
  const tags = zenithTags(ctx, node);
  const name = nodeCloudName(ctx, node, 100);
  const routes = [...spec.routes].sort((a, b) => cmp(`${a.host}\0${String(1000 - a.pathPrefix.length).padStart(4, "0")}\0${a.pathPrefix}`, `${b.host}\0${String(1000 - b.pathPrefix.length).padStart(4, "0")}\0${b.pathPrefix}`));
  const targets = targetsOf(node, ctx, ctx.namePrefix, routes);
  const cert = listeners.some((l) => l.protocol === "https") ? certificateFor(node, ctx, routes) : undefined;
  if (listeners.some((l) => l.protocol === "https") && !cert) throw new OciCompileError(`${node.address}: an HTTPS listener needs a tls_certificate dependency.`);

  const lb = res("oci_load_balancer_load_balancer", node);
  const ip = res("oci_core_public_ip", node, "_ip");
  const nsg = res("oci_core_network_security_group", node, "_nsg");
  const lbId = interp(`${lb.address}.id`);

  const resource: NonNullable<TofuFragment["resource"]> = {
    oci_core_public_ip: { [ip.label]: { compartment_id: compartment, lifetime: "RESERVED", display_name: `${name}-ip`, freeform_tags: tags } },
    oci_core_network_security_group: { [nsg.label]: { compartment_id: compartment, vcn_id: ctx.ref(placement.network, "id"), display_name: `${name}-nsg`, freeform_tags: tags } },
    oci_load_balancer_load_balancer: {
      [lb.label]: {
        compartment_id: compartment,
        display_name: name,
        shape: "flexible",
        shape_details: { minimum_bandwidth_in_mbps: MIN_MBPS, maximum_bandwidth_in_mbps: MAX_MBPS },
        subnet_ids: [ctx.ref(placement.subnets[0], "id")],
        is_private: false,
        network_security_group_ids: [interp(`${nsg.address}.id`)],
        reserved_ips: [{ id: interp(`${ip.address}.id`) }],
        freeform_tags: tags,
      },
    },
  };
  const addresses = [nsg.address, ip.address];

  // backend sets and backends
  const sets: Record<string, Record<string, unknown>> = {};
  const backends: Record<string, Record<string, unknown>> = {};
  for (const t of targets) {
    const set = res("oci_load_balancer_backend_set", node, `_bs_${t.setLabel}`);
    const be = res("oci_load_balancer_backend", node, `_be_${t.setLabel}`);
    sets[set.label] = {
      load_balancer_id: lbId,
      name: t.setName,
      policy: "ROUND_ROBIN",
      health_checker: { protocol: "HTTP", port: t.port, url_path: t.healthPath, return_code: 200, interval_ms: 10000, timeout_in_millis: 3000, retries: 3 },
    };
    backends[be.label] = {
      count: t.replicas,
      load_balancer_id: lbId,
      backendset_name: interp(`${set.address}.name`),
      ip_address: interp(`local.${auxName(t.address, "private_ips")}[count.index]`),
      port: t.port,
      weight: 1,
    };
    addresses.push(set.address, be.address);
  }
  resource.oci_load_balancer_backend_set = sets;
  resource.oci_load_balancer_backend = backends;

  // routing policy (only when more than one target): most specific route first
  const defaultSet = { address: targets[0].setAddress };
  let policyName: string | undefined;
  let policyAddress: string | undefined;
  if (targets.length > 1) {
    const policy = res("oci_load_balancer_load_balancer_routing_policy", node, "_routes");
    policyName = "zenith_routes";
    policyAddress = policy.address;
    const setOf = new Map(targets.map((t) => [t.address, t]));
    resource.oci_load_balancer_load_balancer_routing_policy = {
      [policy.label]: {
        load_balancer_id: lbId,
        name: policyName,
        condition_language_version: "V1",
        rules: routes.map((r, i) => ({
          name: `rule_${String(i + 1).padStart(3, "0")}`,
          condition: routeCondition(r.host, r.pathPrefix),
          actions: [{ name: "FORWARD_TO_BACKENDSET", backend_set_name: interp(`${setOf.get(r.target)!.setAddress}.name`) }],
        })),
      },
    };
    addresses.push(policy.address);
  }

  // http → https redirect rule set
  const redirect = listeners.some((l) => l.redirectToHttps === true);
  const redirectSet = res("oci_load_balancer_rule_set", node, "_redirect");
  if (redirect) {
    if (!listeners.some((l) => l.protocol === "https")) throw new OciCompileError(`${node.address}: redirectToHttps needs an HTTPS listener.`);
    resource.oci_load_balancer_rule_set = {
      [redirectSet.label]: {
        load_balancer_id: lbId,
        name: "redirect_https",
        items: [
          {
            action: "REDIRECT",
            conditions: [{ attribute_name: "PATH", attribute_value: "/", operator: "FORCE_LONGEST_PREFIX_MATCH" }],
            redirect_uri: { protocol: "https", port: 443, host: "{host}", path: "{path}", query: "{query}" },
            response_code: 301,
          },
        ],
      },
    };
    addresses.push(redirectSet.address);
  }

  // listeners
  const listenerBlocks: Record<string, Record<string, unknown>> = {};
  for (const l of listeners) {
    const lis = res("oci_load_balancer_listener", node, `_l_${l.port}`);
    const body: Record<string, unknown> = {
      load_balancer_id: lbId,
      name: `${l.protocol}_${l.port}`,
      port: l.port,
      protocol: "HTTP",
      default_backend_set_name: interp(`${defaultSet.address}.name`),
      ...(policyName ? { routing_policy_name: interp(`${policyAddress}.name`) } : {}),
    };
    if (l.protocol === "https") {
      body.ssl_configuration = { certificate_ids: [auxRef(cert!, "id")], protocols: ["TLSv1.2", "TLSv1.3"], server_order_preference: "ENABLED", verify_peer_certificate: false };
    } else if (l.redirectToHttps === true) {
      body.rule_set_names = [interp(`${redirectSet.address}.name`)];
      delete body.routing_policy_name; // the redirect answers before any routing
    }
    listenerBlocks[lis.label] = body;
    addresses.push(lis.address);
  }
  resource.oci_load_balancer_listener = listenerBlocks;

  return {
    resource,
    locals: {
      [auxName(node.address, "nsg_id")]: interp(`${nsg.address}.id`),
      [auxName(node.address, "public_ip")]: interp(`${ip.address}.ip_address`),
    },
    output: { [`${lb.label}_public_ip`]: { value: interp(`${ip.address}.ip_address`), description: `Reserved public IP of ${node.address}` } },
    addresses: addressList(lb.address, addresses),
  };
}

export function loadBalancerExpected(node: ResourceNode): Record<string, unknown> {
  const spec = specOf<LoadBalancerSpec>(node);
  return {
    shape: "flexible",
    isPrivate: false,
    listenerPorts: [...spec.listeners].map((l) => l.port).sort((a, b) => a - b),
    backendSetCount: new Set(spec.routes.map((r) => r.target)).size,
  };
}

/* --------------------------------- observe --------------------------------- */

const locateDef: LocateDef = {
  service: "loadbalancer",
  get: (id) => ({ path: ociPath("loadbalancer", "loadBalancers", id) }),
  list: (compartmentId) => ({ path: ociPath("loadbalancer", "loadBalancers"), query: { compartmentId } }),
  items: arrayOrItems,
  idOf: (i) => asString(asRecord(i)?.id),
};

export async function observeLoadBalancer(ctx: OciContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  const located = await locate(ctx, node, externalId, locateDef);
  if (located.presence !== "present" || !located.item) return observationOf(ctx, node, ID, located);
  const item = located.item;
  const at = ctx.now().toISOString();
  const listeners = asRecord(item.listeners);
  const ports = listeners ? Object.values(listeners).map((l) => asNumber(asRecord(l)?.port)).filter((p): p is number => p !== undefined).sort((a, b) => a - b) : undefined;
  const sets = asRecord(item.backendSets);
  const attributes = attributesOf(at, {
    shape: asString(item.shapeName),
    isPrivate: typeof item.isPrivate === "boolean" ? item.isPrivate : undefined,
    listenerPorts: ports,
    backendSetCount: sets ? Object.keys(sets).length : undefined,
  });
  return observationOf(ctx, node, ID, located, attributes, {
    lifecycleState: item.lifecycleState,
    shapeName: item.shapeName,
    ipAddresses: asArray(item.ipAddresses).slice(0, 4).map((a) => asString(asRecord(a)?.ipAddress)),
    backendSets: sets ? Object.keys(sets).slice(0, 10) : null,
  });
}

const HEALTH: Record<string, HealthState> = { OK: "healthy", WARNING: "degraded", CRITICAL: "unhealthy", UNKNOWN: "unknown" };

export async function runtimeLoadBalancer(ctx: OciContext, node: ResourceNode, externalId?: string): Promise<RuntimeState> {
  const located = await locate(ctx, node, externalId, locateDef);
  if (located.presence !== "present" || !located.externalId) return runtimeOf(ctx, node, ID, "unknown", {}, [`presence:${located.presence}`]);
  const region = node.region || ctx.region;
  const id = located.externalId;
  const overall = await ociCall(ctx, { service: "loadbalancer", region, method: "GET", path: ociPath("loadbalancer", "loadBalancers", id, "health") });
  if (!overall.ok) return runtimeOf(ctx, node, ID, "unknown", {}, [`health:${overall.outcome}`]);
  const body = asRecord(overall.body);
  const status = asString(body?.status) ?? "UNKNOWN";
  const signals = [`lb_health:${status}`];
  const counts: Record<string, number> = {};
  const total = asNumber(body?.totalBackendSetCount);
  if (total !== undefined) counts.backendSets = total;
  const critical = asArray(body?.criticalStateBackendSetNames).length;
  if (critical) {
    counts.backendSetsCritical = critical;
    signals.push(`backend_set_critical:${critical}`);
  }

  // per-set backend counts for the sets we can name, bounded
  const setNames = [...asArray(body?.criticalStateBackendSetNames), ...asArray(body?.warningStateBackendSetNames), ...asArray(body?.unknownStateBackendSetNames)].filter((n): n is string => typeof n === "string").slice(0, MAX_INSPECTED_SETS);
  let backends = 0;
  let badBackends = 0;
  for (const name of setNames) {
    const s = await ociCall(ctx, { service: "loadbalancer", region, method: "GET", path: ociPath("loadbalancer", "loadBalancers", id, "backendSets", name, "health") });
    if (!s.ok) continue;
    const sb = asRecord(s.body);
    backends += asNumber(sb?.totalBackendCount) ?? 0;
    badBackends += asArray(sb?.criticalStateBackendNames).length + asArray(sb?.unknownStateBackendNames).length;
  }
  if (setNames.length) {
    counts.backendsInUnhealthySets = backends;
    counts.backendsUnhealthy = badBackends;
    if (badBackends) signals.push(`backend_unhealthy:${badBackends}`);
  }
  return runtimeOf(ctx, node, ID, HEALTH[status] ?? "unknown", counts, signals);
}

export const loadBalancerDriver: ResourceDriver<OciSession> = {
  id: ID,
  provider: "oci",
  kind: "load_balancer",
  nativeType: LOAD_BALANCER_NATIVE_TYPE,
  capabilities: ociCapabilities({ compile: true, observe: true, runtime: true, verify: true, discover: true }),
  compile: compileLoadBalancer,
  observe: observeLoadBalancer,
  runtime: runtimeLoadBalancer,
  expectedAttributes: loadBalancerExpected,
  verify: async (ctx, node, observation, runtime) => verifyWith({ node, observation, expected: loadBalancerExpected(node), runtime, now: ctx.now() }),
  discover: (ctx) =>
    discoverWith(ctx, {
      ...locateDef,
      kind: "load_balancer",
      nativeType: LOAD_BALANCER_NATIVE_TYPE,
      nameOf: (i) => asString(i.displayName) ?? asString(i.id) ?? "load balancer",
      attributes: (i) => ({ state: asString(i.lifecycleState) ?? "", private: i.isPrivate === true }),
    }),
};
