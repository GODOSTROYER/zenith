/**
 * `gcp:global_http_lb` — a global external Application Load Balancer in front
 * of Cloud Run services (`load_balancer`).
 *
 * Compiles (the primary forwarding rule first):
 *   google_compute_global_address          reserved IPv4 (survives LB recreation; DNS points here)
 *   per distinct route target:
 *     google_compute_region_network_endpoint_group   SERVERLESS NEG → the Cloud Run service
 *     google_compute_backend_service                 EXTERNAL_MANAGED, request logging on
 *   google_compute_url_map                 host rules → path matchers (`pathPrefix`
 *                                          → `prefix` and `prefix/*`); the first
 *                                          route's backend is the default service
 *   google_compute_ssl_policy              MODERN profile, TLS ≥ 1.2
 *   per https listener: target_https_proxy (certificates from the node's
 *                       `tls_certificate` dependencies) + global_forwarding_rule
 *   per http listener:  target_http_proxy + global_forwarding_rule; with
 *                       `redirectToHttps` the proxy uses a second URL map that
 *                       answers 301 to https (query kept)
 *
 * The primary forwarding rule is the first https listener (else the first
 * listener); `ctx.ref(<lb>, "ip_address")` is the load balancer's IP.
 *
 * Honest limits:
 *   - Serverless NEGs have no health checks, so `healthPath` and `port` of a
 *     route are not used and `runtime` cannot report backend health; it
 *     reports the forwarding rule → proxy → URL map chain is intact, and says
 *     so in its signals.
 *   - Unmatched Host headers reach the first route's backend (a URL map must
 *     have a default); it is the same public service either way.
 *   - Each listener port is one forwarding rule; https needs a Google-managed
 *     certificate node among the dependencies, else compile refuses.
 *   - Cloud Armor, CDN and IAP are not configured.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import type { LoadBalancerRoute, LoadBalancerSpec } from "@/lib/resources/specs";
import type { Observation, ObservedValue, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { GcpCompileError } from "../../errors";
import { cloudName, fnv6, gcpLabels, nodeTags, nodeLabels, parseTagDescription, tagDescription, tfLabel, tfSub } from "../../naming";
import { COMPUTE, computeGlobal, contractCapabilities, specOf } from "../../driver-util";
import { dataFragment, depsOfKind, expr, lastSegment, lit, ref, safeRegion } from "../../hcl";
import { gcpGet } from "../../rest";
import { arr, computePath, makeReaders, num, rec, str, tail, type ReadSpec } from "../../read-kit";
import type { GcpDriverContext } from "../../types";
import { normalizeDomain } from "./managed-ssl-certificate";

export const DRIVER_ID = "gcp.global_http_lb@1";

const HTTP_PORTS = new Set([80, 8080]);
const HTTPS_PORTS = new Set([443, 8443]);

interface Plan {
  listeners: { port: number; protocol: "http" | "https"; redirectToHttps: boolean }[];
  routes: (LoadBalancerRoute & { host: string; pathPrefix: string })[];
  primary: { port: number; protocol: "http" | "https" };
}

function plan(node: ResourceNode): Plan {
  const s = specOf<LoadBalancerSpec>(node);
  const where = node.address;
  if (!Array.isArray(s.routes) || s.routes.length === 0) throw new GcpCompileError("no_routes", `${where}: a load balancer needs at least one route.`);
  if (!Array.isArray(s.listeners) || s.listeners.length === 0) throw new GcpCompileError("no_listeners", `${where}: a load balancer needs at least one listener.`);
  const listeners = s.listeners
    .map((l) => {
      if (l.protocol !== "http" && l.protocol !== "https") throw new GcpCompileError("invalid_listener", `${where}: listener protocol must be http or https.`);
      const okPort = l.protocol === "https" ? HTTPS_PORTS.has(l.port) : HTTP_PORTS.has(l.port);
      if (!okPort) throw new GcpCompileError("invalid_listener", `${where}: the global external LB serves ${l.protocol} on ${l.protocol === "https" ? "443 or 8443" : "80 or 8080"}, not ${String(l.port)}.`);
      return { port: l.port, protocol: l.protocol, redirectToHttps: l.redirectToHttps === true };
    })
    .sort((a, b) => (a.protocol === b.protocol ? a.port - b.port : a.protocol === "https" ? -1 : 1));
  if (new Set(listeners.map((l) => l.port)).size !== listeners.length) throw new GcpCompileError("invalid_listener", `${where}: two listeners use the same port.`);
  const seenPaths = new Set<string>();
  const routes = s.routes
    .map((r) => {
      const host = normalizeDomain(r.host, where);
      let pathPrefix = String(r.pathPrefix ?? "/");
      if (!pathPrefix.startsWith("/") || /[\s*?#]/.test(pathPrefix)) throw new GcpCompileError("invalid_route", `${where}: route path "${lit(pathPrefix).slice(0, 40)}" must start with / and contain no wildcards.`);
      if (pathPrefix.length > 1) pathPrefix = pathPrefix.replace(/\/+$/, "");
      const key = `${host}${pathPrefix}`;
      if (seenPaths.has(key)) throw new GcpCompileError("duplicate_route", `${where}: ${host}${pathPrefix} is routed twice.`);
      seenPaths.add(key);
      return { ...r, host, pathPrefix };
    })
    .sort((a, b) => (a.host === b.host ? (a.pathPrefix < b.pathPrefix ? -1 : 1) : a.host < b.host ? -1 : 1));
  return { listeners, routes, primary: { port: listeners[0].port, protocol: listeners[0].protocol } };
}

function expectedAttributes(node: ResourceNode): Record<string, unknown> {
  const p = plan(node);
  return { loadBalancingScheme: "EXTERNAL_MANAGED", portRange: String(p.primary.port), hosts: [...new Set(p.routes.map((r) => r.host))].sort() };
}

const slugOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);

function compile(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const L = tfLabel(node.address);
  if (node.ownership !== "managed") return dataFragment("google_compute_global_address", L, { name: lastSegment(node.externalRef, node.address) });
  safeRegion(ctx.region);
  const p = plan(node);
  const labels = nodeLabels(ctx.tags, node);
  const name = (suffix: string) => cloudName(ctx.namePrefix, node.address, { max: 63, suffix });
  const resource: NonNullable<TofuFragment["resource"]> = {};
  const addresses: string[] = [];
  const add = (type: string, label: string, body: Record<string, unknown>) => {
    (resource[type] ??= {})[label] = body;
    addresses.push(`${type}.${label}`);
  };

  /* primary forwarding rule first, so addresses[0] is what ctx.ref resolves */
  const fwdLabel = (l: { port: number; protocol: string }) => (l.port === p.primary.port && l.protocol === p.primary.protocol ? L : tfSub(node.address, `${l.protocol}_${l.port}`));
  const certs = depsOfKind(node, ctx, "tls_certificate");
  const httpsListeners = p.listeners.filter((l) => l.protocol === "https");
  if (httpsListeners.length > 0 && certs.length === 0) {
    throw new GcpCompileError("missing_certificate", `${node.address}: an https listener needs a tls_certificate node among its dependencies.`);
  }

  const ip = tfSub(node.address, "ip");
  const ipBody = { name: name("ip"), ip_version: "IPV4", address_type: "EXTERNAL", labels };

  /* backends: one NEG + backend service per distinct target */
  const targets = [...new Set(p.routes.map((r) => r.target))].sort();
  const backendRef = new Map<string, string>();
  const neg = new Map<string, string>();
  for (const t of targets) {
    if (!ctx.node(t)) throw new GcpCompileError("unknown_target", `${node.address}: route target ${lit(String(t)).slice(0, 60)} is not in the graph.`);
    const negLabel = tfSub(node.address, `neg_${tfLabel(t)}`);
    const beLabel = tfSub(node.address, `be_${tfLabel(t)}`);
    neg.set(t, negLabel);
    backendRef.set(t, expr(`google_compute_backend_service.${beLabel}.id`));
    // the NEG and backend service resources are added last, so the primary forwarding rule stays addresses[0]
  }

  const urlMapLabel = tfSub(node.address, "urlmap");
  const tlsPolicy = tfSub(node.address, "tls");
  const primaryListener = p.listeners[0];

  /* forwarding rules + proxies, primary first */
  const ordered = [primaryListener, ...p.listeners.slice(1)];
  for (const l of ordered) {
    const fl = fwdLabel(l);
    const secondary = fl !== L;
    const proxyLabel = tfSub(node.address, `${l.protocol}_proxy_${l.port}`);
    const fwdLabels = secondary ? gcpLabels({ ...nodeTags(ctx.tags, node), "zenith:resource": `${node.address}#${l.protocol}-${l.port}` }) : labels;
    if (l.protocol === "https") {
      add("google_compute_global_forwarding_rule", fl, {
        name: name(`${l.protocol}-${l.port}`),
        description: tagDescription(ctx.tags, node, `${l.protocol} ${l.port}`),
        labels: fwdLabels,
        load_balancing_scheme: "EXTERNAL_MANAGED",
        ip_protocol: "TCP",
        port_range: String(l.port),
        ip_address: expr(`google_compute_global_address.${ip}.id`),
        target: expr(`google_compute_target_https_proxy.${proxyLabel}.id`),
      });
    } else {
      add("google_compute_global_forwarding_rule", fl, {
        name: name(`${l.protocol}-${l.port}`),
        description: tagDescription(ctx.tags, node, `${l.protocol} ${l.port}`),
        labels: fwdLabels,
        load_balancing_scheme: "EXTERNAL_MANAGED",
        ip_protocol: "TCP",
        port_range: String(l.port),
        ip_address: expr(`google_compute_global_address.${ip}.id`),
        target: expr(`google_compute_target_http_proxy.${proxyLabel}.id`),
      });
    }
  }
  add("google_compute_global_address", ip, ipBody);

  for (const l of ordered) {
    const proxyLabel = tfSub(node.address, `${l.protocol}_proxy_${l.port}`);
    if (l.protocol === "https") {
      add("google_compute_target_https_proxy", proxyLabel, {
        name: name(`https-proxy-${l.port}`),
        url_map: expr(`google_compute_url_map.${urlMapLabel}.id`),
        ssl_certificates: certs.map((c) => ref(ctx, c.address, "id")),
        ssl_policy: expr(`google_compute_ssl_policy.${tlsPolicy}.id`),
      });
    } else if (l.redirectToHttps) {
      const redirect = tfSub(node.address, `redirect_${l.port}`);
      add("google_compute_url_map", redirect, {
        name: name(`redirect-${l.port}`),
        description: tagDescription(ctx.tags, node, "http to https redirect"),
        default_url_redirect: [{ https_redirect: true, redirect_response_code: "MOVED_PERMANENTLY_DEFAULT", strip_query: false }],
      });
      add("google_compute_target_http_proxy", proxyLabel, { name: name(`http-proxy-${l.port}`), url_map: expr(`google_compute_url_map.${redirect}.id`) });
    } else {
      add("google_compute_target_http_proxy", proxyLabel, { name: name(`http-proxy-${l.port}`), url_map: expr(`google_compute_url_map.${urlMapLabel}.id`) });
    }
  }
  if (httpsListeners.length > 0) add("google_compute_ssl_policy", tlsPolicy, { name: name("tls"), profile: "MODERN", min_tls_version: "TLS_1_2" });

  /* URL map: host rules and path matchers */
  const hosts = [...new Set(p.routes.map((r) => r.host))];
  const defaultService = backendRef.get(p.routes[0].target)!;
  add("google_compute_url_map", urlMapLabel, {
    name: name("urlmap"),
    description: tagDescription(ctx.tags, node, "host and path routing"),
    default_service: defaultService,
    host_rule: hosts.map((h) => ({ hosts: [h], path_matcher: `pm-${slugOf(h)}-${fnv6(h)}` })),
    path_matcher: hosts.map((h) => {
      const mine = p.routes.filter((r) => r.host === h);
      const root = mine.find((r) => r.pathPrefix === "/") ?? mine[0];
      const rules = mine.filter((r) => r.pathPrefix !== "/" && r !== root);
      return {
        name: `pm-${slugOf(h)}-${fnv6(h)}`,
        default_service: backendRef.get(root.target)!,
        ...(rules.length ? { path_rule: rules.map((r) => ({ paths: [r.pathPrefix, `${r.pathPrefix}/*`], service: backendRef.get(r.target)! })) } : {}),
      };
    }),
  });

  for (const t of targets) {
    const negLabel = neg.get(t)!;
    const beLabel = tfSub(node.address, `be_${tfLabel(t)}`);
    add("google_compute_region_network_endpoint_group", negLabel, {
      name: cloudName(ctx.namePrefix, node.address, { max: 63, suffix: `neg-${slugOf(t)}-${fnv6(t)}` }),
      region: ctx.region,
      network_endpoint_type: "SERVERLESS",
      cloud_run: [{ service: ref(ctx, t, "name") }],
    });
    add("google_compute_backend_service", beLabel, {
      name: cloudName(ctx.namePrefix, node.address, { max: 63, suffix: `be-${slugOf(t)}-${fnv6(t)}` }),
      load_balancing_scheme: "EXTERNAL_MANAGED",
      backend: [{ group: expr(`google_compute_region_network_endpoint_group.${negLabel}.id`) }],
      log_config: [{ enable: true, sample_rate: 1 }],
    });
  }

  return {
    resource,
    output: { [`${L}_ip_address`]: { value: expr(`google_compute_global_address.${ip}.address`), description: "point DNS A records here" } },
    addresses,
  };
}

/* --------------------------------- reading --------------------------------- */

const spec: ReadSpec = {
  driverId: DRIVER_ID,
  nativeType: "gcp:global_http_lb",
  kind: "load_balancer",
  attributes: ["loadBalancingScheme", "portRange", "hosts", "certificateCount"],
  resolve: computeGlobal("forwardingRules", "forwarding rule"),
  list: {
    url: (ctx) => `${COMPUTE}/projects/${ctx.session.projectId}/global/forwardingRules?maxResults=500`,
    itemsKey: "items",
    labelsOf: (item) => ({ ...parseTagDescription(item.description), ...rec(item.labels) }),
  },
  extract(o) {
    const self = str(o.selfLink);
    const id = self ? computePath(self) : undefined;
    if (!id) throw new Error("no selfLink");
    return {
      externalId: id,
      name: tail(id),
      attributes: { loadBalancingScheme: str(o.loadBalancingScheme), portRange: str(o.portRange) },
      native: { ipProtocol: str(o.IPProtocol), targetPath: computePath(str(o.target) ?? ""), networkTier: str(o.networkTier), hasAddress: !!str(o.IPAddress) },
    };
  },
};

const readers = makeReaders(spec, expectedAttributes);

const PROXY = /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/global\/(targetHttpsProxies|targetHttpProxies)\/[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const URLMAP = /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/global\/urlMaps\/[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

/** Follow forwarding rule → proxy → URL map and add `hosts` / `certificateCount`. */
async function observe(ctx: GcpDriverContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  const obs = await readers.observe(ctx, node, externalId);
  if (obs.presence !== "present") return obs;
  const at = ctx.now().toISOString();
  const targetPath = typeof obs.native?.targetPath === "string" ? obs.native.targetPath : "";
  const unknown = (reason: "error" | "access_denied", detail: string): ObservedValue => ({ state: "unknown", reason, detail });
  let hosts: ObservedValue = unknown("error", "the forwarding rule has no target");
  let certs: ObservedValue = hosts;
  if (targetPath) {
    // the rule's own target link, re-validated against the session project before it is followed
    const pm = PROXY.exec(targetPath);
    if (!pm || pm[1] !== ctx.session.projectId) {
      hosts = unknown("error", "the forwarding rule's target is not a proxy in this project");
      certs = hosts;
    } else {
      const proxy = await gcpGet(ctx, `${COMPUTE}/${targetPath}`);
      if (proxy.outcome !== "ok") {
        const why = unknown(proxy.outcome === "inaccessible" ? "access_denied" : "error", proxy.detail ?? proxy.outcome);
        hosts = why;
        certs = why;
      } else {
        certs = { state: "known", value: arr(proxy.json.sslCertificates).length, observedAt: at };
        const mapPath = computePath(str(proxy.json.urlMap) ?? "");
        const um = URLMAP.exec(mapPath);
        if (!um || um[1] !== ctx.session.projectId) hosts = unknown("error", "the proxy's URL map is not in this project");
        else {
          const map = await gcpGet(ctx, `${COMPUTE}/${mapPath}`);
          if (map.outcome !== "ok") hosts = unknown(map.outcome === "inaccessible" ? "access_denied" : "error", map.detail ?? map.outcome);
          else {
            const all = arr(map.json.hostRules).flatMap((h) => arr(rec(h).hosts).map(String));
            hosts = { state: "known", value: [...new Set(all)].sort(), observedAt: at };
          }
        }
      }
    }
  }
  return { ...obs, attributes: { ...obs.attributes, hosts, certificateCount: certs } };
}

async function runtime(ctx: GcpDriverContext, node: ResourceNode, externalId?: string): Promise<RuntimeState> {
  const obs = await observe(ctx, node, externalId);
  const base = { address: node.address, observedAt: ctx.now().toISOString(), source: DRIVER_ID, simulated: false as const };
  if (obs.presence === "missing") return { ...base, health: "unhealthy", counts: {}, signals: ["not_found"] };
  if (obs.presence !== "present") return { ...base, health: "unknown", counts: {}, signals: [obs.presence === "inaccessible" ? "access_denied" : "read_error"] };
  const hosts = obs.attributes.hosts;
  const signals = ["serverless_neg:no_health_check"];
  if (hosts?.state !== "known") return { ...base, health: "degraded", counts: {}, signals: [...signals, "chain_unreadable"] };
  const count = Array.isArray(hosts.value) ? hosts.value.length : 0;
  return { ...base, health: count > 0 ? "healthy" : "degraded", counts: { hostRules: count, certificates: num(obs.attributes.certificateCount?.state === "known" ? obs.attributes.certificateCount.value : undefined) ?? 0 }, signals };
}

export const globalHttpLbDriver: ResourceDriver<GcpSession> = {
  id: DRIVER_ID,
  provider: "gcp",
  kind: "load_balancer",
  nativeType: "gcp:global_http_lb",
  capabilities: contractCapabilities({ runtime: true, discover: false }),
  compile,
  observe,
  runtime,
  verify: readers.verify,
  expectedAttributes,
};
