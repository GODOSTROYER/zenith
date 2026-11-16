/** Fake ARM contract for DNS ownership; no credentials or Azure calls. */
import { vi } from "vitest";
import type { AzureSession } from "@/lib/credentials/types";
import type { AzureCtx } from "@/lib/providers/azure/kit";
import { mkNode, SUB } from "./_helpers";

export function azureDnsWorld(workspaceId = "ws-act-1", environmentId = "env-act-1", apex = false, staticSite = false) {
  const host = apex ? "example.com" : "app.example.com";
  const target = mkNode(staticSite ? "static_site/web" : "load_balancer/public", staticSite ? "static_site" : "load_balancer", staticSite ? "azure:static_web_app" : "azure:application_gateway", { routes: [{ host, target: "container_service/web" }] });
  const node = mkNode(`dns_record/${host}`, "dns_record", "azure:dns_record_set", { name: host, zone: "dns_zone/example.com", target: target.address, type: "alias", deletionPolicy: "allow" }, { dependsOn: ["network/main"] });
  const nodes = [node, target, mkNode("dns_zone/example.com", "dns_zone", "azure:dns_zone", { name: "example.com" }), mkNode("container_service/web", "container_service", "azure:container_app", {}), mkNode("network/main", "network", "azure:virtual_network", {})];
  const root = `/subscriptions/${SUB}/resourceGroups/owned/providers`;
  const tags = (address: string) => ({ "zenith:workspace": workspaceId, "zenith:environment": environmentId, "zenith:resource": address, "zenith:managed": "true" });
  const zone = { id: `${root}/Microsoft.Network/dnszones/example.com`, name: "example.com", type: "Microsoft.Network/dnszones" };
  const env = { id: `${root}/Microsoft.App/managedEnvironments/owned`, name: "owned", type: "Microsoft.App/managedEnvironments", tags: tags("network/main"), properties: { staticIp: "203.0.113.10", customDomainConfiguration: { customDomainVerificationId: "domain-proof-canary" } } };
  const app = { id: `${root}/Microsoft.App/containerApps/web`, name: "web", type: "Microsoft.App/containerApps", tags: tags("container_service/web"), properties: { managedEnvironmentId: env.id, configuration: { ingress: { fqdn: "owned.azurecontainerapps.io" } } } };
  const site = { id: `${root}/Microsoft.Web/staticSites/web`, name: "web", type: "Microsoft.Web/staticSites", tags: tags(target.address), properties: { defaultHostname: "owned.azurestaticapps.net" } };
  const record = { id: `${zone.id}/${apex ? "A/@" : "CNAME/app"}`, name: host, type: `Microsoft.Network/dnszones/${apex ? "A" : "CNAME"}`, tags: tags(node.address), properties: apex ? { ARecords: [{ ipv4Address: "203.0.113.10" }] } : { CNAMERecord: { cname: staticSite ? site.properties.defaultHostname : app.properties.configuration.ingress.fqdn } } };
  const txt = { id: `${zone.id}/TXT/${apex ? "asuid" : "asuid.app"}`, name: "txt", type: "Microsoft.Network/dnszones/TXT", tags: tags(node.address), properties: { TXTRecords: [{ value: ["domain-proof-canary"] }] } };
  const state = { zones: [zone] as unknown[], resources: structuredClone([app, env, site]) as unknown[], record: record as Record<string, unknown>, txt: txt as Record<string, unknown>, app: app as Record<string, unknown>, env: env as Record<string, unknown>, site: site as Record<string, unknown>, status: 200, recordStatus: 200, txtStatus: 200, nextLink: undefined as string | undefined };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method !== "GET") throw new Error("unexpected mutation");
    const u = new URL(url); const path = u.pathname;
    const resource = path.endsWith("/resources"); const zones = path.endsWith("/dnszones");
    const body = resource ? { value: state.resources, nextLink: state.nextLink } : zones ? { value: state.zones } : path === record.id ? state.record : path === txt.id ? state.txt : path === app.id ? state.app : path === env.id ? state.env : path === site.id ? state.site : {};
    return new Response(JSON.stringify(body), { status: path === record.id ? state.recordStatus : path === txt.id ? state.txtStatus : state.status });
  });
  const session: AzureSession = { provider: "azure", region: node.region, subscriptionId: SUB, expiresAt: "2099-01-01T00:00:00.000Z", authorizedFetch: fetch, childProcessEnv: () => ({}) };
  const ctx: AzureCtx = { provider: "azure", region: node.region, workspaceId, environmentId, session, signal: new AbortController().signal, log: vi.fn(), tags: { "zenith:environment": environmentId }, now: () => new Date("2026-10-01T00:00:00.000Z") };
  return { ctx, node, nodes, state, fetch };
}
