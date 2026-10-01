/**
 * `azure:application_gateway` — the portable `load_balancer`, realized by the
 * Container Apps ENVIRONMENT INGRESS, not by an Application Gateway.
 *
 * The native-type table names the row `azure:application_gateway`; this driver
 * registers under exactly that string, but it does NOT create a gateway:
 *
 *   - the environment's public entry point (external load balancer, static IP,
 *     default domain, managed TLS) already exists with the network node's
 *     Container Apps environment, at no fixed cost;
 *   - which apps it reaches is each app's own `ingress.external_enabled`, set
 *     only for apps a route targets (container-app.ts);
 *   - host names and certificates are custom domains on those apps with
 *     environment managed certificates (managed-certificate.ts), DNS by
 *     dns-record.ts.
 *
 * So `compile` declares nothing (an empty fragment) beyond validating that
 * every route target is an Azure container service in this graph. An
 * Application Gateway (WAF, path-based routing across services, private
 * front-ends) is NOT implemented; if it is ever added it needs its own native
 * type (`azure:application_gateway_v2`) or an explicit spec knob, because it
 * costs a fixed monthly amount that this mapping deliberately avoids.
 *
 * Observation: each routed app is located by its Zenith tags and read, so the
 * load balancer is "as configured" when every routed app has external ingress
 * and an FQDN, and every TLS route's host is bound with SNI. There is no
 * single ARM object for it; `externalId` is the first routed app's id.
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { LoadBalancerRoute, LoadBalancerSpec } from "@/lib/resources/specs";
import { AzureCompileError, fragment, requireNode, specOf } from "@/lib/providers/azure/compile-util";
import { defineAzureDriver, locateByTags, pick, props, type AzureCtx, type Located, type RuntimeRead } from "@/lib/providers/azure/kit";
import type { ArmResource, Json } from "@/lib/providers/azure/arm";
import { CONTAINER_APP } from "@/lib/providers/azure/drivers/compute/container-app";

export const LOAD_BALANCER_ADDRESS = "load_balancer/public";

function routesOf(node: ResourceNode): LoadBalancerRoute[] {
  const r = specOf<LoadBalancerSpec>(node).routes;
  return Array.isArray(r) ? r : [];
}

export function compileLoadBalancer(node: ResourceNode, ctx: CompileContext): TofuFragment {
  for (const route of routesOf(node)) {
    const target = requireNode(ctx, route.target, `the target of ${route.host}`, node.address);
    if (target.provider !== "azure" || target.kind !== "container_service") {
      throw new AzureCompileError(`route ${route.host} targets ${route.target} (${target.provider} ${target.kind}); Azure ingress only reaches Azure container services.`, node.address);
    }
  }
  return fragment({});
}

interface AppView {
  address: string;
  found: boolean;
  id?: string;
  external?: boolean;
  fqdn?: string;
  bound: string[];
}

async function locateRoutedApps(ctx: AzureCtx, node: ResourceNode): Promise<Located> {
  const targets = [...new Set(routesOf(node).map((r) => r.target))].sort().slice(0, 20);
  if (targets.length === 0) return { state: "missing" };
  const apps: AppView[] = [];
  for (const address of targets) {
    const located = await locateByTags(ctx, { ...node, address } as ResourceNode, CONTAINER_APP, undefined);
    if (located.state === "inaccessible" || located.state === "unknown") return located;
    if (located.state === "missing") {
      apps.push({ address, found: false, bound: [] });
      continue;
    }
    const domains = pick<Json[]>(props(located.resource), "configuration", "ingress", "customDomains") ?? [];
    apps.push({
      address,
      found: true,
      id: located.resource.id,
      external: pick<boolean>(props(located.resource), "configuration", "ingress", "external") === true,
      fqdn: pick<string>(props(located.resource), "configuration", "ingress", "fqdn"),
      bound: domains.filter((d) => d.bindingType === "SniEnabled").map((d) => String(d.name ?? "").toLowerCase()),
    });
  }
  const first = apps.find((a) => a.found);
  if (!first) return { state: "missing" };
  return { state: "found", resource: { id: first.id!, name: "container-apps-ingress", type: "zenith/container-apps-ingress", properties: { apps } as unknown as Json } satisfies ArmResource };
}

const appsOf = (res: ArmResource): AppView[] => (props(res).apps as AppView[] | undefined) ?? [];

function expectedLb(node: ResourceNode): Record<string, unknown> {
  const routes = routesOf(node);
  return {
    externalTargets: new Set(routes.map((r) => r.target)).size,
    tlsHostsBound: routes.filter((r) => r.tls).length,
  };
}

export const loadBalancerDriver = defineAzureDriver({
  id: "azure.application_gateway@1",
  kind: "load_balancer",
  nativeType: "azure:application_gateway",
  locate: (ctx, node) => locateRoutedApps(ctx, node),
  compile: compileLoadBalancer,
  expected: expectedLb,
  read: (res, node) => {
    const apps = appsOf(res);
    const routes = routesOf(node);
    const byAddress = new Map(apps.map((a) => [a.address, a]));
    return {
      externalTargets: apps.filter((a) => a.found && a.external).length,
      tlsHostsBound: routes.filter((r) => r.tls && byAddress.get(r.target)?.bound.includes(r.host.toLowerCase())).length,
    };
  },
  native: (res) => ({ implementation: "container-apps-environment-ingress", apps: appsOf(res).map((a) => ({ address: a.address, found: a.found, external: a.external, fqdn: a.fqdn, bound: a.bound })) }),
  runtime: async (_ctx, _node, res): Promise<RuntimeRead> => {
    const apps = appsOf(res);
    const serving = apps.filter((a) => a.found && a.external && a.fqdn).length;
    const signals = apps.filter((a) => !a.found || !a.external || !a.fqdn).map((a) => `route_target_not_serving:${a.address}`);
    return { health: serving === apps.length ? "healthy" : serving === 0 ? "unhealthy" : "degraded", counts: { routedApps: apps.length, serving }, signals };
  },
  serving: true,
});
