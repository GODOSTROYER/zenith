/**
 * Routing on the managed platform: hostnames from the managed domain, and
 * Gateway API `HTTPRoute` instead of `Ingress` when the substrate says gateway.
 *
 * Two steps, both pure:
 *   1. `rewriteRoutes` — the load balancer node's route hosts become
 *      `<service>.<env>.<workspace-slug>.<domain>` (a host already under the
 *      tenant's managed suffix is kept). The Kubernetes provider then renders
 *      its usual validated Ingress from the rewritten node.
 *   2. `ingressToRoutes` — that Ingress is translated to one HTTPRoute per host
 *      (Gateway API hostnames apply to every rule of a route, so different
 *      hosts need different routes) attached to the platform Gateway. In
 *      `ingress` mode the Ingress is kept, pointed at the substrate's class,
 *      and its `tls` block dropped (termination is the controller's).
 *
 * Why translate the rendered Ingress instead of rendering routes from the node:
 * the host, path and backend-port validation, the Service naming and the
 * cross-namespace checks already live in the Kubernetes provider's renderer;
 * reusing its output keeps one source of truth for what a route means.
 *
 * Custom domains are NOT served on the managed platform today: a host outside
 * the tenant's managed suffix is rewritten to the managed hostname and the
 * mapping is reported (`HostMapping`) so the UI can say where the app really
 * lives. The TLS lifecycle provisions an environment wildcard Certificate and
 * Gateway; wildcard DNS and the DNS-01 ClusterIssuer remain operator-provisioned.
 */
import { OWNERSHIP, dig, isRecord, type K8sObject } from "./k8s-port";
import { dnsLabelOf } from "./tenancy";
import { isManagedHost, managedHostname, serviceLabelOf, type ZenithSubstrate } from "./substrate";
import { TENANT_ANNOTATION, TENANT_LABEL, ZenithError, type ZenithTenant } from "./types";
import { environmentGatewayParent, environmentTlsNames } from "./tls";

export interface HostMapping {
  /** the host the manifest asked for */
  source: string;
  /** the hostname served on the managed platform */
  managed: string;
  /** the node address the route targets */
  target: string;
}

interface RouteLike {
  host: string;
  target: string;
  [extra: string]: unknown;
}

/** Rewrite every route's host to its managed hostname; returns the new routes and the mapping. */
export function rewriteRoutes(routes: unknown, tenant: ZenithTenant, substrate: ZenithSubstrate): { routes: unknown[]; mappings: HostMapping[] } {
  if (!Array.isArray(routes)) return { routes: [], mappings: [] };
  const out: unknown[] = [];
  const mappings: HostMapping[] = [];
  for (const r of routes) {
    if (!isRecord(r) || typeof r.host !== "string" || typeof r.target !== "string") {
      out.push(r); // the Kubernetes renderer rejects malformed routes with its own message
      continue;
    }
    const route = r as RouteLike;
    const managed = isManagedHost(route.host, tenant, substrate.baseDomain)
      ? route.host
      : managedHostname({ service: serviceLabelOf(route.target), environmentSlug: tenant.environmentSlug, workspaceSlug: tenant.workspaceSlug, baseDomain: substrate.baseDomain });
    out.push({ ...route, host: managed });
    mappings.push({ source: route.host, managed, target: route.target });
  }
  return { routes: out, mappings };
}

/** Distinct source hosts per managed host, sorted: what each HTTPRoute stands in for. */
export function sourceHostsByManaged(mappings: readonly HostMapping[]): Map<string, string[]> {
  const m = new Map<string, Set<string>>();
  for (const x of mappings) {
    const s = m.get(x.managed) ?? new Set<string>();
    s.add(x.source);
    m.set(x.managed, s);
  }
  return new Map([...m.entries()].map(([k, v]) => [k, [...v].sort()]));
}

export const HTTPROUTE_API_VERSION = "gateway.networking.k8s.io/v1";

/** The object name of the HTTPRoute serving a managed host. */
export const routeObjectName = (managedHost: string): string => dnsLabelOf(`route-${managedHost}`);

interface IngressPath {
  path: string;
  service: string;
  port: number;
}

function pathsOf(rule: unknown): IngressPath[] {
  const out: IngressPath[] = [];
  const paths = dig(rule, "http", "paths");
  for (const p of Array.isArray(paths) ? paths : []) {
    const service = dig(p, "backend", "service", "name");
    const port = dig(p, "backend", "service", "port", "number");
    const path = isRecord(p) ? p.path : undefined;
    if (typeof service === "string" && typeof port === "number" && typeof path === "string") out.push({ path, service, port });
  }
  return out;
}

/**
 * Translate a rendered Ingress into the managed platform's routing objects.
 * Returns the replacement objects (HTTPRoutes, or the retargeted Ingress).
 */
export function ingressToRoutes(ingress: K8sObject, substrate: ZenithSubstrate, sources: ReadonlyMap<string, string[]>, tenant: ZenithTenant): { objects: K8sObject[]; notes: string[] } {
  const address = ingress.metadata.annotations?.[OWNERSHIP.resourceAnnotation] ?? "";
  const spec = isRecord(ingress.spec) ? ingress.spec : {};
  const rules = Array.isArray(spec.rules) ? spec.rules : [];

  if (substrate.gateway.mode === "ingress") {
    const rest: Record<string, unknown> = { ...spec };
    delete rest.tls;
    delete rest.ingressClassName;
    const allSources = [...new Set([...sources.values()].flat())].sort();
    const retargeted: K8sObject = {
      ...ingress,
      metadata: {
        ...ingress.metadata,
        labels: { ...(ingress.metadata.labels ?? {}), [TENANT_LABEL.route]: "true" },
        annotations: { ...(ingress.metadata.annotations ?? {}), [TENANT_ANNOTATION.sourceHosts]: allSources.join(",") },
      },
      spec: { ingressClassName: substrate.gateway.ingressClass, ...rest },
    };
    return { objects: [retargeted], notes: [`${address}: Ingress kept (gateway mode "ingress"); TLS terminates at the ingress controller with the platform's certificates, not per-host secrets.`] };
  }

  const objects: K8sObject[] = [];
  for (const rule of rules) {
    const host = isRecord(rule) && typeof rule.host === "string" ? rule.host : undefined;
    if (host === undefined) throw new ZenithError("render_error", `${address}: an Ingress rule has no host; managed routes are always host-scoped.`);
    const paths = pathsOf(rule);
    if (paths.length === 0) throw new ZenithError("render_error", `${address}: the route for ${host} has no backends.`);
    const src = sources.get(host) ?? [host];
    objects.push({
      apiVersion: HTTPROUTE_API_VERSION,
      kind: "HTTPRoute",
      metadata: {
        name: routeObjectName(host),
        ...(ingress.metadata.namespace ? { namespace: ingress.metadata.namespace } : {}),
        labels: { ...(ingress.metadata.labels ?? {}), [TENANT_LABEL.route]: "true" },
        annotations: {
          ...(ingress.metadata.annotations ?? {}),
          [TENANT_ANNOTATION.sourceHosts]: src.join(","),
          [TENANT_ANNOTATION.workspaceId]: tenant.workspaceId,
        },
      },
      spec: {
        parentRefs: [environmentGatewayParent(tenant, substrate)],
        hostnames: [host],
        rules: paths.map((p) => ({
          matches: [{ path: { type: "PathPrefix", value: p.path } }],
          backendRefs: [{ name: p.service, port: p.port }],
        })),
      },
    });
  }
  return { objects, notes: [`${address}: Ingress translated to ${objects.length} Gateway API HTTPRoute(s) attached to ${substrate.gateway.namespace}/${environmentTlsNames(tenant, substrate).gateway}; TLS terminates at the environment's platform gateway.`] };
}
