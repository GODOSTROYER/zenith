/** aws:subnet — zone selection, public/private behaviour, route-table association, reads. */
import { DescribeAvailabilityZonesCommand, DescribeSubnetsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { subnetDriver } from "@/lib/providers/aws/drivers/network";
import { DriverCompileError } from "@/lib/providers/aws/drivers/shared";
import type { ResourceNode } from "@/lib/resources/types";
import { compileCtx, driverCtx } from "../fixtures/env";
import { fixtureGraph, nodeOf } from "../fixtures/graph";

const ec2 = mockClient(EC2Client);
beforeEach(() => ec2.reset());
afterEach(() => ec2.reset());

const graph = fixtureGraph();
const compile = (address: string, patch: Record<string, unknown> = {}, g = graph) => {
  const n = { ...nodeOf(g, address) };
  n.spec = { ...n.spec, ...patch };
  return subnetDriver.compile!(n, compileCtx(g));
};

describe("aws:subnet compile", () => {
  it("public: maps public IPs on launch and associates with the network's public route table", () => {
    const f = compile("subnet/public-a");
    expect(f.addresses[0]).toBe("aws_subnet.subnet_public_a");
    const s = f.resource!.aws_subnet.subnet_public_a;
    expect(s).toMatchObject({ cidr_block: "10.0.0.0/24", map_public_ip_on_launch: true, vpc_id: "${local.ref_network_main__id}" });
    expect(f.resource!.aws_route_table_association.subnet_public_a_rt).toMatchObject({
      subnet_id: "${aws_subnet.subnet_public_a.id}",
      route_table_id: "${local.ref_network_main__public_route_table_id}",
    });
  });

  it("private: explicitly NOT public on launch, and uses its own zone's private route table", () => {
    const b = compile("subnet/private-b");
    expect(b.resource!.aws_subnet.subnet_private_b.map_public_ip_on_launch).toBe(false);
    expect(b.resource!.aws_route_table_association.subnet_private_b_rt.route_table_id).toBe("${local.ref_network_main__private_route_table_id_b}");
    expect(compile("subnet/private-a").resource!.aws_route_table_association.subnet_private_a_rt.route_table_id).toBe("${local.ref_network_main__private_route_table_id_a}");
  });

  it("picks the zone deterministically from the region's sorted available zones, indexed by the zone letter", () => {
    const z = compile("subnet/public-a").data!.aws_availability_zones.subnet_public_a_zones;
    expect(z).toEqual({ state: "available", filter: [{ name: "opt-in-status", values: ["opt-in-not-required"] }] });
    expect(compile("subnet/public-a").resource!.aws_subnet.subnet_public_a.availability_zone).toBe("${sort(data.aws_availability_zones.subnet_public_a_zones.names)[0]}");
    expect(compile("subnet/public-b").resource!.aws_subnet.subnet_public_b.availability_zone).toBe("${sort(data.aws_availability_zones.subnet_public_b_zones.names)[1]}");
    expect(compile("subnet/private-a", { zone: "c" }).resource!.aws_subnet.subnet_private_a.availability_zone).toContain(")[2]}");
  });

  it("publishes id, arn and availability_zone", () => {
    expect(Object.keys(compile("subnet/public-a").locals!)).toEqual(["ref_subnet_public_a__arn", "ref_subnet_public_a__availability_zone", "ref_subnet_public_a__id"]);
  });

  it("tags the subnet with the Zenith tags and its own address", () => {
    const tags = compile("subnet/public-a").resource!.aws_subnet.subnet_public_a.tags as Record<string, string>;
    expect(tags).toMatchObject({ "zenith:resource": "subnet/public-a", "zenith:environment": "env_prod", "zenith:managed": "true", Name: "acme-prod-subnet-public-a" });
  });

  it("is deterministic", () => {
    expect(JSON.stringify(compile("subnet/private-a"))).toBe(JSON.stringify(compile("subnet/private-a")));
  });

  it("refuses a bad tier, zone, cidr, missing network, a CIDR outside the network, and unmanaged nodes", () => {
    for (const bad of [{ tier: "dmz" }, { zone: "z" }, { zone: undefined }, { cidr: "10.0.0.0/33" }, { cidr: "10.0.0.7/24" }, { network: "" }]) {
      expect(() => compile("subnet/public-a", bad), JSON.stringify(bad)).toThrow(DriverCompileError);
    }
    expect(() => compile("subnet/public-a", { cidr: "192.168.0.0/24" })).toThrow(/not inside the network/);
    const n: ResourceNode = { ...nodeOf(graph, "subnet/public-a"), ownership: "referenced" };
    expect(() => subnetDriver.compile!(n, compileCtx(graph))).toThrow(/does not create a subnet/);
  });
});

const SUBNET_ID = "subnet-0abc1234def567890";
const tags = [
  { Key: "zenith:workspace", Value: "ws_acme" },
  { Key: "zenith:environment", Value: "env_prod" },
  { Key: "zenith:resource", Value: "subnet/private-b" },
  { Key: "zenith:managed", Value: "true" },
];
const node = () => nodeOf(fixtureGraph(), "subnet/private-b"); // zone b → index 1, private

function zones(...names: string[]) {
  ec2.on(DescribeAvailabilityZonesCommand).resolves({ AvailabilityZones: names.map((ZoneName) => ({ ZoneName, State: "available" })) });
}

describe("aws:subnet observe", () => {
  it("reports cidr, public-ip mapping and the zone INDEX (not the letter), externalId and tags", async () => {
    ec2.on(DescribeSubnetsCommand).resolves({ Subnets: [{ SubnetId: SUBNET_ID, VpcId: "vpc-1", CidrBlock: "10.0.11.0/24", MapPublicIpOnLaunch: false, AvailabilityZone: "us-east-1b", State: "available", Tags: tags }] });
    zones("us-east-1c", "us-east-1a", "us-east-1b");
    const obs = await subnetDriver.observe!(driverCtx(), node());
    expect(obs.presence).toBe("present");
    expect(obs.externalId).toBe(SUBNET_ID);
    expect(Object.fromEntries(Object.entries(obs.attributes).map(([k, v]) => [k, v.state === "known" ? v.value : v.state]))).toEqual({ cidr: "10.0.11.0/24", mapPublicIpOnLaunch: false, zoneIndex: 1 });
    expect(obs.attributes).toEqual(expect.objectContaining({}));
    expect(Object.keys(subnetDriver.expectedAttributes!(node())).sort()).toEqual(Object.keys(obs.attributes).sort());
    expect(subnetDriver.expectedAttributes!(node())).toEqual({ cidr: "10.0.11.0/24", mapPublicIpOnLaunch: false, zoneIndex: 1 });
    expect((obs.native!.tags as Record<string, string>)["zenith:managed"]).toBe("true");
  });

  it("letters are per-account aliases: in an account that only sees zones a and c, letter b is index 1 (us-west-1c)", async () => {
    ec2.on(DescribeSubnetsCommand).resolves({ Subnets: [{ SubnetId: SUBNET_ID, CidrBlock: "10.0.11.0/24", MapPublicIpOnLaunch: false, AvailabilityZone: "us-west-1c", Tags: tags }] });
    zones("us-west-1a", "us-west-1c");
    const obs = await subnetDriver.observe!(driverCtx(), node());
    expect(obs.attributes.zoneIndex).toMatchObject({ state: "known", value: 1 });
  });

  it("detects drift in the public-IP mapping and the CIDR", async () => {
    ec2.on(DescribeSubnetsCommand).resolves({ Subnets: [{ SubnetId: SUBNET_ID, CidrBlock: "10.0.99.0/24", MapPublicIpOnLaunch: true, AvailabilityZone: "us-east-1b", State: "available", Tags: tags }] });
    zones("us-east-1a", "us-east-1b");
    const ctx = driverCtx();
    const v = await subnetDriver.verify!(ctx, node(), await subnetDriver.observe!(ctx, node()));
    expect(v.status).toBe("failed");
    expect(v.checks.filter((c) => c.passed === false).map((c) => c.id).sort()).toEqual(["attr:cidr", "attr:mapPublicIpOnLaunch"]);
  });

  it("does not guess the zone when DescribeAvailabilityZones is denied: zoneIndex unknown, the rest known", async () => {
    ec2.on(DescribeSubnetsCommand).resolves({ Subnets: [{ SubnetId: SUBNET_ID, CidrBlock: "10.0.11.0/24", MapPublicIpOnLaunch: false, AvailabilityZone: "us-east-1b", Tags: tags }] });
    ec2.on(DescribeAvailabilityZonesCommand).rejects(Object.assign(new Error("denied"), { name: "UnauthorizedOperation", $metadata: { httpStatusCode: 403 } }));
    const obs = await subnetDriver.observe!(driverCtx(), node());
    expect(obs.attributes.zoneIndex).toMatchObject({ state: "unknown", reason: "access_denied" });
    expect(obs.attributes.cidr).toMatchObject({ state: "known" });
  });

  it("a zone outside the listing (a Local Zone subnet) is unknown, not index -1", async () => {
    ec2.on(DescribeSubnetsCommand).resolves({ Subnets: [{ SubnetId: SUBNET_ID, CidrBlock: "10.0.11.0/24", MapPublicIpOnLaunch: false, AvailabilityZone: "us-east-1-bos-1a", Tags: tags }] });
    zones("us-east-1a", "us-east-1b");
    expect((await subnetDriver.observe!(driverCtx(), node())).attributes.zoneIndex).toMatchObject({ state: "unknown", reason: "not_inspected" });
  });

  it("missing / ambiguous / denied / throttled", async () => {
    ec2.on(DescribeSubnetsCommand).resolves({ Subnets: [] });
    expect((await subnetDriver.observe!(driverCtx(), node())).presence).toBe("missing");
    ec2.on(DescribeSubnetsCommand).resolves({ Subnets: [{ SubnetId: "subnet-0000000a", Tags: tags }, { SubnetId: "subnet-0000000b", Tags: tags }] });
    const amb = await subnetDriver.observe!(driverCtx(), node());
    expect(amb.presence).toBe("unknown");
    expect(amb.error).toMatch(/2 subnets/);
    ec2.on(DescribeSubnetsCommand).rejects(Object.assign(new Error("denied"), { name: "UnauthorizedOperation" }));
    expect((await subnetDriver.observe!(driverCtx(), node())).presence).toBe("inaccessible");
    ec2.on(DescribeSubnetsCommand).rejects(Object.assign(new Error("slow"), { name: "Throttling" }));
    expect((await subnetDriver.observe!(driverCtx(), node())).presence).toBe("unknown");
  });

  it("uses the subnet id when one is known and the tags when it is not", async () => {
    ec2.on(DescribeSubnetsCommand).resolves({ Subnets: [] });
    await subnetDriver.observe!(driverCtx(), node(), SUBNET_ID);
    expect(ec2.commandCalls(DescribeSubnetsCommand)[0].args[0].input).toEqual({ SubnetIds: [SUBNET_ID] });
    ec2.resetHistory();
    await subnetDriver.observe!(driverCtx(), node());
    expect(ec2.commandCalls(DescribeSubnetsCommand)[0].args[0].input.Filters).toContainEqual({ Name: "tag:zenith:resource", Values: ["subnet/private-b"] });
  });

  it("discovers subnets and marks Zenith-tagged ones", async () => {
    ec2.on(DescribeSubnetsCommand).resolves({ Subnets: [{ SubnetId: SUBNET_ID, VpcId: "vpc-1", CidrBlock: "10.0.11.0/24", AvailabilityZone: "us-east-1b", Tags: tags }, { SubnetId: "subnet-00000002", VpcId: "vpc-2" }] });
    const found = await subnetDriver.discover!(driverCtx());
    expect(found.map((f) => [f.externalId, f.zenithTagged])).toEqual([[SUBNET_ID, true], ["subnet-00000002", false]]);
  });
});
