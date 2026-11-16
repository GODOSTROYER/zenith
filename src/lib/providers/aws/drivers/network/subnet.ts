/**
 * `aws:subnet` (kind `subnet`): one subnet in one zone of a network.
 *
 * Compile: `data.aws_availability_zones` (state available, opt-in not required,
 * so Local Zones and Wavelength Zones never count) → the zone NAMES sorted →
 * indexed by the spec's zone letter (a → 0, b → 1, c → 2). The subnet is
 * `map_public_ip_on_launch = true` for the public tier and explicitly `false`
 * for the private tier, and is associated with the network's public route table
 * or, for the private tier, with the private route table of ITS zone (which is a
 * per-zone NAT route under `per_az`, a shared one otherwise — the network
 * driver publishes `private_route_table_id:<zone>` for every zone either way).
 *
 * Observe: DescribeSubnets (by `externalId`, else Zenith tags) and
 * DescribeAvailabilityZones (to turn the subnet's zone NAME back into the same
 * index the compile used, so `zoneIndex` compares like with like; if that call
 * is denied, `zoneIndex` is `unknown`, never guessed from the name's letter —
 * letters are per-account aliases).
 *
 * Published: `id`, `arn`, `availability_zone`.
 */
import { DescribeAvailabilityZonesCommand, DescribeSubnetsCommand, EC2Client, type Subnet } from "@aws-sdk/client-ec2";
import type { AwsSession } from "@/lib/credentials/types";
import type { CompileContext, DiscoveredResource, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { SubnetSpec } from "@/lib/resources/specs";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import {
  type AwsDriverContext,
  DriverCompileError,
  FragmentBuilder,
  REF,
  attempt,
  attributesFromAttempts,
  boundNative,
  classifyAwsError,
  cloudName,
  ec2TagFilters,
  failedObservation,
  fromAwsTagList,
  hasZenithManagedTag,
  matchesNodeTags,
  nodeName,
  nowIso,
  paginate,
  privateRouteTableAttribute,
  refExpr,
  resourceTags,
  standardVerification,
  tfLabel,
  verificationResult,
} from "../shared";
import { cidrContains, parseCidr } from "./cidr";
import { zoneIndex } from "./zones";

const SOURCE = "aws.subnet@1";
const SUBNET_ID = /^subnet-[0-9a-f]{8,17}$/;
const ATTRIBUTES = ["cidr", "mapPublicIpOnLaunch", "zoneIndex"] as const;

function readSubnetSpec(node: ResourceNode): SubnetSpec & { zoneIdx: number } {
  const s = node.spec as Partial<SubnetSpec>;
  if (s.tier !== "public" && s.tier !== "private") throw new DriverCompileError("invalid_spec", node.address, `spec.tier must be public or private, got ${JSON.stringify(s.tier)}.`);
  const idx = zoneIndex(s.zone);
  if (idx === undefined) throw new DriverCompileError("invalid_spec", node.address, `spec.zone must be a zone letter a–f, got ${JSON.stringify(s.zone)}.`);
  if (!parseCidr(s.cidr)) throw new DriverCompileError("invalid_spec", node.address, `spec.cidr must be a canonical IPv4 CIDR, got ${JSON.stringify(s.cidr)}.`);
  if (typeof s.network !== "string" || s.network === "") throw new DriverCompileError("invalid_spec", node.address, "spec.network must name the network this subnet belongs to.");
  return { tier: s.tier, zone: s.zone as string, cidr: s.cidr as string, network: s.network, zoneIdx: idx };
}

export function compileSubnet(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (node.ownership !== "managed") throw new DriverCompileError("policy_refused", node.address, `Zenith does not create a subnet for a ${node.ownership} node.`);
  const spec = readSubnetSpec(node);
  const network = ctx.node(spec.network);
  if (network !== undefined) {
    const outer = parseCidr((network.spec as { cidr?: string }).cidr);
    if (outer && !cidrContains(outer, parseCidr(spec.cidr)!)) {
      throw new DriverCompileError("invalid_spec", node.address, `subnet CIDR ${spec.cidr} is not inside the network's ${(network.spec as { cidr?: string }).cidr}.`);
    }
  }
  const L = tfLabel(node.address);
  const name = cloudName(ctx.namePrefix, `subnet-${nodeName(node.address)}`, 255);
  const b = new FragmentBuilder(node.address);
  const zoneExpr = `\${sort(data.aws_availability_zones.${L}_zones.names)[${spec.zoneIdx}]}`;
  b.resource("aws_subnet", L, {
    vpc_id: refExpr(ctx.ref(spec.network, REF.id)),
    cidr_block: spec.cidr,
    availability_zone: zoneExpr,
    map_public_ip_on_launch: spec.tier === "public",
    tags: resourceTags(ctx.tags, node.address, name),
  });
  b.data("aws_availability_zones", `${L}_zones`, {
    state: "available",
    filter: [{ name: "opt-in-status", values: ["opt-in-not-required"] }],
  });
  b.resource("aws_route_table_association", `${L}_rt`, {
    subnet_id: `\${aws_subnet.${L}.id}`,
    route_table_id: refExpr(ctx.ref(spec.network, spec.tier === "public" ? REF.publicRouteTableId : privateRouteTableAttribute(spec.zone))),
  });
  b.expose(REF.id, `aws_subnet.${L}.id`);
  b.expose(REF.arn, `aws_subnet.${L}.arn`);
  b.expose(REF.availabilityZone, `aws_subnet.${L}.availability_zone`);
  return b.build();
}

export function expectedSubnetAttributes(node: ResourceNode): Record<string, unknown> {
  const s = node.spec as Partial<SubnetSpec>;
  const idx = zoneIndex(s.zone);
  if ((s.tier !== "public" && s.tier !== "private") || typeof s.cidr !== "string" || idx === undefined) return {};
  return { cidr: s.cidr, mapPublicIpOnLaunch: s.tier === "public", zoneIndex: idx };
}

async function observeSubnet(ctx: AwsDriverContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  const ec2 = ctx.session.client(EC2Client);
  const opts = { abortSignal: ctx.signal };
  let subnets: Subnet[];
  try {
    const input = externalId !== undefined && SUBNET_ID.test(externalId) ? { SubnetIds: [externalId] } : { Filters: ec2TagFilters(ctx, node.address) };
    subnets = (await ec2.send(new DescribeSubnetsCommand(input), opts)).Subnets ?? [];
  } catch (error) {
    const failure = classifyAwsError(error, ctx.signal);
    if (failure.kind === "aborted") throw error;
    return failedObservation(ctx, node, SOURCE, ATTRIBUTES, failure, externalId);
  }
  const observedAt = nowIso(ctx);
  if (subnets.length !== 1) {
    const missing = subnets.length === 0;
    return {
      address: node.address,
      presence: missing ? "missing" : "unknown",
      attributes: Object.fromEntries(ATTRIBUTES.map((a) => [a, missing ? { state: "unknown" as const, reason: "not_applicable" as const } : { state: "unknown" as const, reason: "error" as const, detail: "more than one subnet carries this node's Zenith tags" }])),
      observedAt,
      source: SOURCE,
      simulated: false,
      ...(missing ? {} : { error: `${subnets.length} subnets carry the Zenith tags of ${node.address}; refusing to pick one.` }),
    };
  }
  const subnet = subnets[0];
  const tags = fromAwsTagList(subnet.Tags);
  const zones = await attempt(async () => {
    const r = await ec2.send(new DescribeAvailabilityZonesCommand({ Filters: [{ Name: "state", Values: ["available"] }, { Name: "opt-in-status", Values: ["opt-in-not-required"] }] }), opts);
    return (r.AvailabilityZones ?? []).map((z) => z.ZoneName).filter((n): n is string => typeof n === "string").sort();
  }, ctx.signal);
  const index = zones.ok && subnet.AvailabilityZone !== undefined ? zones.value.indexOf(subnet.AvailabilityZone) : undefined;
  const attributes = attributesFromAttempts(ctx, ATTRIBUTES, {
    cidr: { ok: true, value: subnet.CidrBlock },
    mapPublicIpOnLaunch: { ok: true, value: subnet.MapPublicIpOnLaunch },
    zoneIndex: zones.ok ? (index !== undefined && index >= 0 ? { ok: true, value: index } : undefined) : zones,
  });
  return {
    address: node.address,
    externalId: subnet.SubnetId,
    presence: "present",
    attributes,
    native: boundNative(
      {
        subnetId: subnet.SubnetId,
        vpcId: subnet.VpcId,
        state: subnet.State,
        availabilityZone: subnet.AvailabilityZone,
        availabilityZoneId: subnet.AvailabilityZoneId,
        availableIpAddressCount: subnet.AvailableIpAddressCount,
        tags,
        taggedForThisNode: matchesNodeTags(tags, ctx, node.address),
      },
      { priority: ["subnetId", "tags", "state"] }
    ),
    observedAt,
    source: SOURCE,
    simulated: false,
  };
}

async function discoverSubnets(ctx: AwsDriverContext): Promise<DiscoveredResource[]> {
  const ec2 = ctx.session.client(EC2Client);
  const { items } = await paginate(
    async (t) => {
      const r = await ec2.send(new DescribeSubnetsCommand({ NextToken: t }), { abortSignal: ctx.signal });
      return { items: r.Subnets ?? [], next: r.NextToken };
    },
    { maxPages: 10, signal: ctx.signal }
  );
  return items
    .filter((s): s is Subnet & { SubnetId: string } => typeof s.SubnetId === "string")
    .map((s) => {
      const tags = fromAwsTagList(s.Tags);
      return {
        provider: "aws" as const,
        kind: "subnet" as const,
        nativeType: "aws:subnet",
        externalId: s.SubnetId,
        name: tags.Name ?? s.SubnetId,
        region: ctx.region,
        zenithTagged: hasZenithManagedTag(tags),
        attributes: { vpcId: s.VpcId ?? "", cidr: s.CidrBlock ?? "", availabilityZone: s.AvailabilityZone ?? "", mapPublicIpOnLaunch: s.MapPublicIpOnLaunch === true },
      };
    });
}

export const subnetDriver: ResourceDriver<AwsSession> = {
  id: SOURCE,
  provider: "aws",
  kind: "subnet",
  nativeType: "aws:subnet",
  capabilities: {
    compile: true,
    observe: true,
    runtime: false,
    verify: true,
    discover: true,
    operations: [],
    evidence: { compile: "contract", observe: "contract", verify: "contract", discover: "contract" },
  },
  compile: compileSubnet,
  observe: observeSubnet,
  expectedAttributes: expectedSubnetAttributes,
  async verify(ctx, node, observation) {
    const base = standardVerification(ctx, node, observation, expectedSubnetAttributes(node), "the subnet");
    const state = observation.native?.state;
    if (observation.presence !== "present" || typeof state !== "string") return base;
    return verificationResult(ctx, node, [...base.checks, { id: "subnet_available", description: "the subnet is in state available", passed: state === "available", ...(state === "available" ? {} : { detail: `state is ${state}` }) }]);
  },
  discover: discoverSubnets,
};
