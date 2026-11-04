/** Fake OCI responses serialized through the actual oci.http transport. */
import { vi } from "vitest";
import type { OciSession } from "@/lib/credentials/types";
import type { DriverContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { createRunnerOciTransport, type OciHttpJobPayload, type OciHttpJobResult } from "@/lib/providers/oci/runner-transport";

export function ociDnsWorld(workspaceId = "ws-act-1", environmentId = "env-act-1", capability = "infrastructure.plan") {
  const region = "us-ashburn-1"; const compartmentOcid = "ocid1.compartment.oc1..owned1";
  const mk = (address: string, kind: ResourceNode["kind"], nativeType: string, spec: Record<string, unknown>): ResourceNode => ({ address, kind, nativeType, provider: "oci", ownership: "managed", region, spec, specDigest: "a".repeat(64), origin: [], dependsOn: [], labels: {} });
  const node = mk("dns_record/app.example.com", "dns_record", "oci:dns_rrset", { name: "app.example.com", zone: "dns_zone/example.com", target: "load_balancer/public", type: "alias", deletionPolicy: "allow" });
  const target = mk("load_balancer/public", "load_balancer", "oci:load_balancer", {});
  const zone = mk("dns_zone/example.com", "dns_zone", "oci:dns_zone", { name: "example.com" });
  const lb = { id: "ocid1.loadbalancer.oc1.iad.owned1", compartmentId: compartmentOcid, freeformTags: { zenith_workspace: workspaceId, zenith_environment: environmentId, zenith_managed: "true", zenith_resource: target.address }, isPrivate: false, lifecycleState: "ACTIVE", ipAddresses: [{ ipAddress: "203.0.113.10" }] };
  const state = {
    zone: { id: "ocid1.dns-zone.oc1.iad.owned1", name: "example.com", compartmentId: compartmentOcid } as Record<string, unknown>,
    records: { items: [{ domain: "app.example.com", rtype: "A", rdata: "203.0.113.10", ttl: 300 }] } as unknown,
    lbs: [structuredClone(lb)] as unknown, lb: lb as Record<string, unknown>,
    status: 200, zoneStatus: 200, recordStatus: 200, recordPage: undefined as string | undefined, lbPage: undefined as string | undefined,
  };
  const jobs: OciHttpJobPayload[] = [];
  const dispatch = vi.fn(async (payload: OciHttpJobPayload): Promise<OciHttpJobResult> => {
    jobs.push(payload);
    const rrset = payload.path.includes("/records/");
    const isZone = payload.service === "dns" && !rrset;
    const list = payload.path.endsWith("/loadBalancers");
    const body = rrset ? state.records : isZone ? state.zone : list ? state.lbs : state.lb;
    const page = rrset ? state.recordPage : list ? state.lbPage : undefined;
    return { status: rrset ? state.recordStatus : isZone ? state.zoneStatus : state.status, headers: page ? { "opc-next-page": page } : {}, bodyB64: Buffer.from(JSON.stringify(body), "utf8").toString("base64") };
  });
  const session: OciSession = { provider: "oci", region, compartmentOcid, expiresAt: "2099-01-01T00:00:00.000Z", capability, scope: { workspaceId, environmentId, resources: [] }, transport: createRunnerOciTransport(dispatch, { capability }) };
  const ctx: DriverContext<OciSession> = { provider: "oci", region, workspaceId, environmentId, session, signal: new AbortController().signal, log: vi.fn(), tags: {}, now: () => new Date("2026-10-01T00:00:00.000Z") };
  return { ctx, node, nodes: [node, target, zone], state, jobs, dispatch };
}
