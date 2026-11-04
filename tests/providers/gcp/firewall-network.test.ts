/** Real firewall/network driver compilation; no provider API is exercised. */
import { describe, expect, it, vi } from "vitest";
import type { ResourceNode } from "@/lib/resources/types";
import { GcpCompileError } from "@/lib/providers/gcp/errors";
import { networkTag } from "@/lib/providers/gcp/naming";
import { compileContext, driverFor, mk } from "./_fixtures";

const mainNetwork = mk("network/main", "network", { cidr: "10.20.0.0/16", zones: 2, egress: { natGateways: "none" } });
const otherNetwork = mk("network/other", "network", { cidr: "10.30.0.0/16", zones: 2, egress: { natGateways: "none" } });
const subnet = (address: string, network?: string): ResourceNode => mk(address, "subnet", {
  tier: "private", zone: "a", cidr: "10.20.1.0/24", ...(network === undefined ? {} : { network }),
}, network === undefined ? [] : [network]);

function setup(subnets: ResourceNode[], options: { ruleDependencies?: string[]; targetDependencies?: string[] } = {}) {
  const source = mk("service/client", "container_service", {});
  const target = mk("service/web", "container_service", {}, options.targetDependencies ?? subnets.map((node) => node.address));
  const rule = mk("firewall/client-web", "firewall", {
    target: target.address, source: { address: source.address }, capability: "http", direction: "ingress", protocol: "tcp", port: 3000,
  }, options.ruleDependencies ?? [source.address, target.address]);
  const { ctx } = compileContext([mainNetwork, otherNetwork, source, target, rule, ...subnets]);
  // Observe calls while retaining the fixture's real network driver resolver.
  const ref = vi.fn(ctx.ref);
  ctx.ref = ref;
  return { ref, compile: () => driverFor(rule).compile!(rule, ctx) };
}

describe("GCP firewall network resolution", () => {
  it("resolves a workload's sole subnet to its explicitly named VPC", () => {
    const { compile, ref } = setup([subnet("subnet/private-a", mainNetwork.address)]);
    const fragment = compile();
    expect(fragment.addresses).toEqual(["google_compute_firewall.firewall_client_web"]);
    expect(fragment.resource!.google_compute_firewall.firewall_client_web).toMatchObject({
      network: "${google_compute_network.network_main.id}", direction: "INGRESS", priority: 1000,
      allow: [{ protocol: "tcp", ports: ["3000"] }],
      source_tags: [networkTag("service/client")], target_tags: [networkTag("service/web")],
    });
    expect(ref.mock.calls).toEqual([[mainNetwork.address, "id"]]);
  });

  it("resolves multiple subnets in one VPC exactly once", () => {
    const a = subnet("subnet/private-a", mainNetwork.address);
    const b = subnet("subnet/private-b", mainNetwork.address);
    const { compile, ref } = setup([a, b], { targetDependencies: [b.address, a.address] });
    expect(compile().resource!.google_compute_firewall.firewall_client_web.network).toBe("${google_compute_network.network_main.id}");
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
    const { compile, ref } = setup(subnets);
    expect(compile).toThrow(GcpCompileError);
    expect(compile).toThrow(expect.objectContaining({ code: "missing_network" }));
    expect(ref).not.toHaveBeenCalled();
  });

  it.each([
    { name: "the rule's direct network before the target's network", ruleDependencies: [otherNetwork.address, "service/web"], targetDependencies: [mainNetwork.address, "subnet/private-a", "subnet/private-b"], expectedNetwork: otherNetwork },
    { name: "the target's direct network before ambiguous subnets", ruleDependencies: ["service/web"], targetDependencies: [mainNetwork.address, "subnet/private-a", "subnet/private-b"], expectedNetwork: mainNetwork },
  ])("preserves $name", ({ ruleDependencies, targetDependencies, expectedNetwork }) => {
    const { compile, ref } = setup([subnet("subnet/private-a", mainNetwork.address), subnet("subnet/private-b", otherNetwork.address)], { ruleDependencies, targetDependencies });
    const expected = expectedNetwork === mainNetwork ? "${google_compute_network.network_main.id}" : "${google_compute_network.network_other.id}";
    expect(compile().resource!.google_compute_firewall.firewall_client_web.network).toBe(expected);
    expect(ref.mock.calls).toEqual([[expectedNetwork.address, "id"]]);
  });
});
