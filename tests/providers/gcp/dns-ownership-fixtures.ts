/** Fake Google REST contract for DNS ownership; no credentials or cloud calls. */
import { vi } from "vitest";
import type { GcpSession } from "@/lib/credentials/types";
import type { DriverContext } from "@/lib/drivers/types";
import { gcpLabels } from "@/lib/providers/gcp/naming";
import { mk } from "./_fixtures";

export function gcpDnsWorld(workspaceId = "ws-act-1", environmentId = "env-act-1") {
  const projectId = "acme-prod-123456";
  const node = mk("dns_record/app.example.com", "dns_record", { name: "app.example.com", zone: "dns_zone/example.com", target: "load_balancer/public", type: "alias", deletionPolicy: "allow" });
  const target = mk("load_balancer/public", "load_balancer", {});
  const zone = mk("dns_zone/example.com", "dns_zone", { name: "example.com" });
  const rule = { selfLink: `https://compute.googleapis.com/compute/v1/projects/${projectId}/global/forwardingRules/owned`, IPAddress: "203.0.113.10", loadBalancingScheme: "EXTERNAL_MANAGED", labels: gcpLabels({ "zenith:workspace": workspaceId, "zenith:environment": environmentId, "zenith:managed": "true", "zenith:resource": target.address }) };
  const state = {
    zones: { managedZones: [{ name: "owned-zone", dnsName: "example.com." }] } as Record<string, unknown>,
    record: { name: "app.example.com.", type: "A", rrdatas: ["203.0.113.10"] } as Record<string, unknown>,
    rules: { items: [structuredClone(rule)] } as Record<string, unknown>,
    rule: rule as Record<string, unknown>, status: 200, recordStatus: 200,
  };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method !== "GET") throw new Error("unexpected mutation");
    const path = new URL(url).pathname;
    const json = path.endsWith("/managedZones") ? state.zones : path.endsWith("/forwardingRules") ? state.rules : path.includes("/rrsets/") ? state.record : state.rule;
    return new Response(JSON.stringify(json), { status: path.includes("/rrsets/") ? state.recordStatus : state.status });
  });
  const session: GcpSession = { provider: "gcp", region: target.region, projectId, expiresAt: "2099-01-01T00:00:00.000Z", authorizedFetch: fetch, childProcessEnv: () => ({}) };
  const ctx: DriverContext<GcpSession> = { provider: "gcp", region: target.region, workspaceId, environmentId, session, signal: new AbortController().signal, log: vi.fn(), tags: {}, now: () => new Date("2026-10-01T00:00:00.000Z") };
  return { ctx, node, nodes: [node, target, zone], state, fetch };
}
