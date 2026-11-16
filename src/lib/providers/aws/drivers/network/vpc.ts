/**
 * `aws:vpc` (kind `network`): the VPC, its gateways, route tables, S3 gateway
 * endpoint and flow logs. Declarative lifecycle is `compile` (vpc-compile.ts);
 * everything here is read-only.
 *
 * Observed (EC2, read-only): DescribeVpcs (by `externalId`, else by the Zenith
 * tags — never by name), DescribeVpcAttribute ×2 (DNS support / hostnames),
 * DescribeInternetGateways, DescribeNatGateways, DescribeFlowLogs. Each read
 * degrades independently: a denied or throttled call makes ITS attribute
 * `unknown`, never "matches". Two VPCs carrying the same Zenith tags is reported
 * as `unknown` (ambiguous), not resolved by picking one.
 *
 * Evidence is `contract` throughout: the compile output is validated by
 * `tofu validate` against the real provider schema, and the reads are exercised
 * against mocked SDK clients; nothing has run against a live AWS account.
 */
import {
  DescribeFlowLogsCommand,
  DescribeInternetGatewaysCommand,
  DescribeNatGatewaysCommand,
  DescribeVpcAttributeCommand,
  DescribeVpcsCommand,
  EC2Client,
  type Vpc,
} from "@aws-sdk/client-ec2";
import type { AwsSession } from "@/lib/credentials/types";
import type { DiscoveredResource, ResourceDriver } from "@/lib/drivers/types";
import type { NetworkSpec } from "@/lib/resources/specs";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import {
  type AwsDriverContext,
  attempt,
  attributesFromAttempts,
  boundNative,
  classifyAwsError,
  ec2TagFilters,
  failedObservation,
  fromAwsTagList,
  hasZenithManagedTag,
  matchesNodeTags,
  nowIso,
  paginate,
  standardVerification,
  verificationResult,
  type AwsFailure,
} from "../shared";
import { compileVpc, natGatewayCount } from "./vpc-compile";

const SOURCE = "aws.vpc@1";
/** A usable IGW attachment reports `available` (EC2 docs) or `attached` (SDK enum). */
const ATTACHED = new Set(["available", "attached"]);
const VPC_ID = /^vpc-[0-9a-f]{8,17}$/;
const ATTRIBUTES = ["cidr", "dnsSupport", "dnsHostnames", "internetGatewayAttached", "natGateways", "flowLogsActive"] as const;
const NATIVE_PRIORITY = ["vpcId", "tags", "state"] as const;

/** Desired → comparable values, exactly the attribute names `observe` reads. Tolerant: an invalid spec yields `{}`, it never throws. */
export function expectedVpcAttributes(node: ResourceNode): Record<string, unknown> {
  const spec = node.spec as Partial<NetworkSpec>;
  if (typeof spec.cidr !== "string" || typeof spec.zones !== "number") return {};
  return {
    cidr: spec.cidr,
    dnsSupport: true,
    dnsHostnames: true,
    internetGatewayAttached: true,
    natGateways: natGatewayCount({ zones: spec.zones, egress: spec.egress }),
    flowLogsActive: true,
  };
}

async function findVpcs(ctx: AwsDriverContext, ec2: EC2Client, node: ResourceNode, externalId: string | undefined): Promise<Vpc[]> {
  const input = externalId !== undefined && VPC_ID.test(externalId) ? { VpcIds: [externalId] } : { Filters: ec2TagFilters(ctx, node.address) };
  const res = await ec2.send(new DescribeVpcsCommand(input), { abortSignal: ctx.signal });
  return res.Vpcs ?? [];
}

async function observeVpc(ctx: AwsDriverContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  const ec2 = ctx.session.client(EC2Client);
  let vpcs: Vpc[];
  try {
    vpcs = await findVpcs(ctx, ec2, node, externalId);
  } catch (error) {
    const failure: AwsFailure = classifyAwsError(error, ctx.signal);
    if (failure.kind === "aborted") throw error;
    return failedObservation(ctx, node, SOURCE, ATTRIBUTES, failure, externalId);
  }
  const observedAt = nowIso(ctx);
  if (vpcs.length === 0) {
    return {
      address: node.address,
      presence: "missing",
      attributes: Object.fromEntries(ATTRIBUTES.map((a) => [a, { state: "unknown" as const, reason: "not_applicable" as const }])),
      observedAt,
      source: SOURCE,
      simulated: false,
    };
  }
  if (vpcs.length > 1) {
    return {
      address: node.address,
      presence: "unknown",
      attributes: Object.fromEntries(ATTRIBUTES.map((a) => [a, { state: "unknown" as const, reason: "error" as const, detail: "more than one VPC carries this node's Zenith tags" }])),
      native: boundNative({ vpcIds: vpcs.map((v) => v.VpcId) }),
      observedAt,
      source: SOURCE,
      simulated: false,
      error: `${vpcs.length} VPCs carry the Zenith tags of ${node.address}; refusing to pick one.`,
    };
  }

  const vpc = vpcs[0];
  const vpcId = vpc.VpcId as string;
  const tags = fromAwsTagList(vpc.Tags);
  const opts = { abortSignal: ctx.signal };
  const vpcFilter = [{ Name: "vpc-id", Values: [vpcId] }];
  const [dnsSupport, dnsHostnames, igws, nats, flows] = await Promise.all([
    attempt(async () => (await ec2.send(new DescribeVpcAttributeCommand({ VpcId: vpcId, Attribute: "enableDnsSupport" }), opts)).EnableDnsSupport?.Value, ctx.signal),
    attempt(async () => (await ec2.send(new DescribeVpcAttributeCommand({ VpcId: vpcId, Attribute: "enableDnsHostnames" }), opts)).EnableDnsHostnames?.Value, ctx.signal),
    attempt(
      async () =>
        (await paginate(async (t) => {
          const r = await ec2.send(new DescribeInternetGatewaysCommand({ Filters: [{ Name: "attachment.vpc-id", Values: [vpcId] }], NextToken: t }), opts);
          return { items: r.InternetGateways ?? [], next: r.NextToken };
        }, { maxPages: 3, signal: ctx.signal })).items,
      ctx.signal
    ),
    attempt(
      async () =>
        (await paginate(async (t) => {
          const r = await ec2.send(new DescribeNatGatewaysCommand({ Filter: vpcFilter, NextToken: t }), opts);
          return { items: r.NatGateways ?? [], next: r.NextToken };
        }, { maxPages: 3, signal: ctx.signal })).items,
      ctx.signal
    ),
    attempt(
      async () =>
        (await paginate(async (t) => {
          const r = await ec2.send(new DescribeFlowLogsCommand({ Filter: [{ Name: "resource-id", Values: [vpcId] }], NextToken: t }), opts);
          return { items: r.FlowLogs ?? [], next: r.NextToken };
        }, { maxPages: 3, signal: ctx.signal })).items,
      ctx.signal
    ),
  ]);

  const attached = igws.ok ? igws.value.filter((g) => (g.Attachments ?? []).some((a) => a.VpcId === vpcId && ATTACHED.has(a.State as string))) : [];
  const liveNats = nats.ok ? nats.value.filter((n) => n.State === "pending" || n.State === "available") : [];
  const activeFlows = flows.ok ? flows.value.filter((f) => f.FlowLogStatus === "ACTIVE" && f.LogDestinationType === "cloud-watch-logs") : [];
  const attributes = attributesFromAttempts(ctx, ATTRIBUTES, {
    cidr: { ok: true, value: vpc.CidrBlock },
    dnsSupport,
    dnsHostnames,
    internetGatewayAttached: igws.ok ? { ok: true, value: attached.length > 0 } : igws,
    natGateways: nats.ok ? { ok: true, value: liveNats.length } : nats,
    flowLogsActive: flows.ok ? { ok: true, value: activeFlows.length > 0 } : flows,
  });

  return {
    address: node.address,
    externalId: vpcId,
    presence: "present",
    attributes,
    native: boundNative(
      {
        vpcId,
        state: vpc.State,
        isDefault: vpc.IsDefault,
        ownerId: vpc.OwnerId,
        dhcpOptionsId: vpc.DhcpOptionsId,
        tags,
        taggedForThisNode: matchesNodeTags(tags, ctx, node.address),
        internetGatewayIds: attached.map((g) => g.InternetGatewayId),
        natGateways: liveNats.map((n) => ({ id: n.NatGatewayId, state: n.State, subnetId: n.SubnetId })),
        flowLogIds: activeFlows.map((f) => f.FlowLogId),
      },
      { priority: NATIVE_PRIORITY }
    ),
    observedAt,
    source: SOURCE,
    simulated: false,
  };
}

async function discoverVpcs(ctx: AwsDriverContext): Promise<DiscoveredResource[]> {
  const ec2 = ctx.session.client(EC2Client);
  const { items } = await paginate(
    async (t) => {
      const r = await ec2.send(new DescribeVpcsCommand({ NextToken: t }), { abortSignal: ctx.signal });
      return { items: r.Vpcs ?? [], next: r.NextToken };
    },
    { maxPages: 10, signal: ctx.signal }
  );
  return items
    .filter((v): v is Vpc & { VpcId: string } => typeof v.VpcId === "string")
    .map((v) => {
      const tags = fromAwsTagList(v.Tags);
      return {
        provider: "aws" as const,
        kind: "network" as const,
        nativeType: "aws:vpc",
        externalId: v.VpcId,
        name: tags.Name ?? v.VpcId,
        region: ctx.region,
        zenithTagged: hasZenithManagedTag(tags),
        attributes: { cidr: v.CidrBlock ?? "", isDefault: v.IsDefault === true, state: v.State ?? "unknown" },
      };
    });
}

export const vpcDriver: ResourceDriver<AwsSession> = {
  id: SOURCE,
  provider: "aws",
  kind: "network",
  nativeType: "aws:vpc",
  capabilities: {
    compile: true,
    observe: true,
    runtime: false,
    verify: true,
    discover: true,
    operations: [],
    evidence: { compile: "contract", observe: "contract", verify: "contract", discover: "contract" },
  },
  compile: compileVpc,
  observe: observeVpc,
  expectedAttributes: expectedVpcAttributes,
  async verify(ctx, node, observation) {
    const base = standardVerification(ctx, node, observation, expectedVpcAttributes(node), "the VPC");
    const state = observation.native?.state;
    if (observation.presence !== "present" || typeof state !== "string") return base;
    const checks = [...base.checks, { id: "vpc_available", description: "the VPC is in state available", passed: state === "available", ...(state === "available" ? {} : { detail: `state is ${state}` }) }];
    return verificationResult(ctx, node, checks);
  },
  discover: discoverVpcs,
};
