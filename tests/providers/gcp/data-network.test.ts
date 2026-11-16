/** Real Cloud SQL/Memorystore/network driver compilation; no cloud API is exercised. */
import { describe, expect, it, vi } from "vitest";
import type { ResourceNode } from "@/lib/resources/types";
import { GcpCompileError } from "@/lib/providers/gcp/errors";
import { compileContext, driverFor, environmentNodes, mk } from "./_fixtures";

const mainNetwork = mk("network/main", "network", { cidr: "10.20.0.0/16", zones: 2, egress: { natGateways: "none" } });
const otherNetwork = mk("network/other", "network", { cidr: "10.30.0.0/16", zones: 2, egress: { natGateways: "none" } });
const subnet = (address: string, network?: string): ResourceNode => mk(address, "subnet", {
  tier: "private", zone: "a", cidr: "10.20.1.0/24", ...(network === undefined ? {} : { network }),
}, network === undefined ? [] : [network]);

function setup(kind: "postgres" | "redis", subnets: ResourceNode[], dependencies = subnets.map((node) => node.address)) {
  const original = environmentNodes().find((node) => node.kind === kind)!;
  const node = { ...original, dependsOn: dependencies };
  const wrongKind = mk("service/client", "container_service", {});
  const { ctx } = compileContext([mainNetwork, otherNetwork, wrongKind, node, ...subnets]);
  // Observe calls without replacing the fixture's real network driver resolver.
  const ref = vi.fn(ctx.ref);
  ctx.ref = ref;
  return { ref, compile: () => driverFor(node).compile!(node, ctx) };
}

describe.each([
  { name: "Cloud SQL", kind: "postgres" as const },
  { name: "Memorystore", kind: "redis" as const },
])("GCP $name network resolution", ({ kind }) => {
  it("resolves a sole subnet's VPC and retains the direct-network fragment and PSA dependency", () => {
    const { compile, ref } = setup(kind, [subnet("subnet/private-a", mainNetwork.address)]);
    const fragment = compile();
    const direct = setup(kind, [], [mainNetwork.address]).compile();
    expect(fragment).toEqual(direct);
    const bodies = Object.values(fragment.resource!).flatMap((labels) => Object.values(labels));
    expect(bodies).toHaveLength(1);
    expect(bodies[0].depends_on).toEqual(["google_service_networking_connection.network_main_psa"]);
    if (kind === "postgres") {
      expect(bodies[0]).toMatchObject({ settings: [expect.objectContaining({
        ip_configuration: [{ ipv4_enabled: false, private_network: "${google_compute_network.network_main.id}", ssl_mode: "ENCRYPTED_ONLY" }],
        database_flags: [{ name: "cloudsql.iam_authentication", value: "on" }],
      })] });
    } else {
      expect(bodies[0]).toMatchObject({ authorized_network: "${google_compute_network.network_main.id}", connect_mode: "PRIVATE_SERVICE_ACCESS", transit_encryption_mode: "SERVER_AUTHENTICATION", auth_enabled: false });
    }
    expect(ref.mock.calls).toEqual([[mainNetwork.address, "id"]]);
  });

  it("resolves two subnets in one VPC once, independently of dependency order", () => {
    const a = subnet("subnet/private-a", mainNetwork.address);
    const b = subnet("subnet/private-b", mainNetwork.address);
    const { compile, ref } = setup(kind, [a, b], [b.address, a.address]);
    expect(compile()).toEqual(setup(kind, [a, b], [a.address, b.address]).compile());
    expect(ref.mock.calls).toEqual([[mainNetwork.address, "id"]]);
  });

  it("preserves a direct network dependency despite invalid or conflicting subnet VPCs", () => {
    const subnets = [subnet("subnet/private-a"), subnet("subnet/private-b", otherNetwork.address)];
    const { compile, ref } = setup(kind, subnets, [mainNetwork.address, ...subnets.map((node) => node.address)]);
    expect(compile()).toEqual(setup(kind, [], [mainNetwork.address]).compile());
    expect(ref.mock.calls).toEqual([[mainNetwork.address, "id"]]);
  });

  it.each([
    { name: "distinct VPCs", subnets: [subnet("subnet/private-a", mainNetwork.address), subnet("subnet/private-b", otherNetwork.address)] },
    { name: "a missing subnet.network", subnets: [subnet("subnet/private-a")] },
    { name: "a missing subnet.network beside a valid subnet", subnets: [subnet("subnet/private-a", mainNetwork.address), subnet("subnet/private-b")] },
    { name: "an absent VPC", subnets: [subnet("subnet/private-a", "network/absent")] },
    { name: "a non-network node", subnets: [subnet("subnet/private-a", "service/client")] },
    { name: "no subnet dependencies", subnets: [] },
  ])("refuses $name without resolving a guessed network", ({ subnets }) => {
    const { compile, ref } = setup(kind, subnets);
    expect(compile).toThrow(GcpCompileError);
    expect(compile).toThrow(expect.objectContaining({ code: "missing_network" }));
    expect(ref).not.toHaveBeenCalled();
  });
});
