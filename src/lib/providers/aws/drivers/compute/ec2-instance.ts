/**
 * `aws:ec2_instance` — EXPERIMENTAL. Kind `compute_instance`.
 *
 * Expansion does not produce `compute_instance` nodes yet, so this driver
 * reads the private `ComputeInstanceSpec` (types.ts) from hand-built graphs.
 * Evidence is `contract` for everything and the driver marks itself
 * experimental with `capabilities.experimental`.
 *
 * The instance exists to be managed through the MACHINE PLANE (SSM), not SSH:
 *   - Amazon Linux 2023, resolved at PLAN time from the public SSM parameter
 *     `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-<arch>`;
 *     `ami` is in `ignore_changes`, so a newer AMI never replaces a running
 *     instance (patching is the machine plane's job, not a re-create);
 *   - no key pair, no inbound rule, no public IP; its security group (shared
 *     contract, see shared/security-group.ts) allows outbound HTTPS only,
 *     which is all the SSM agent needs through NAT;
 *   - an instance profile whose role has the AWS-managed
 *     `AmazonSSMManagedInstanceCore` policy (a named managed policy, not a
 *     wildcard statement of ours) and the `ZenithWorkloadBoundary` boundary;
 *   - IMDSv2 required (hop limit 1), encrypted gp3 root volume.
 *
 * Runtime/verify read instance state, status checks and whether the SSM agent
 * reports `Online`: an instance that runs but is not SSM-online cannot be
 * operated by Zenith, which `verify` reports as a failed check.
 */
import { DescribeInstanceStatusCommand, DescribeInstancesCommand, EC2Client, type Instance } from "@aws-sdk/client-ec2";
import { DescribeInstanceInformationCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { AwsSession } from "@/lib/credentials/types";
import type { CompileContext, DiscoveredResource, ResourceDriver } from "@/lib/drivers/types";
import type { HealthState, Observation, ResourceNode, RuntimeState } from "@/lib/resources/types";
import {
  attempt,
  attributesOf,
  boundNative,
  cloudName,
  ec2TagFilters,
  failedObservation,
  hasZenithManagedTag,
  nodeName,
  paginate,
  runtimeState,
  securityGroupLabel,
  standardVerification,
  subnetsOf,
  addSecurityGroup,
  tfLabel,
} from "@/lib/providers/aws/drivers/shared";
import { compileNode, intField, specOf } from "./support/driver-util";
import { ComputeCompileError, Frag, TfRef, assumeRoleJson, attr, boundaryArn, cat, environmentData, rawRef, refOf, tagsFor } from "./support/tf";
import { failureOf, tagsOf, type AwsCtx } from "./support/sdk";
import type { ComputeInstanceSpec } from "./types";
import { DRIVER_IDS } from "./types";

const ID = DRIVER_IDS.ec2Instance;
const INSTANCE_TYPE = /^[a-z][a-z0-9-]{0,14}\.[a-z0-9]{1,20}$/;

export const AL2023_PARAMETER = (arch: "x86_64" | "arm64"): string => `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-${arch}`;

function normalized(node: ResourceNode) {
  const spec = specOf<ComputeInstanceSpec>(node);
  const instanceType = spec.instanceType ?? "t3.small";
  if (!INSTANCE_TYPE.test(instanceType)) throw new ComputeCompileError("invalid_spec", `instanceType "${String(instanceType).slice(0, 30)}" is not an EC2 instance type.`);
  const architecture = spec.architecture ?? "x86_64";
  if (architecture !== "x86_64" && architecture !== "arm64") throw new ComputeCompileError("invalid_spec", "architecture must be x86_64 or arm64.");
  // Graviton families end their generation digit with `g` (t4g, m7g, c7gn …)
  const graviton = /^[a-z]+\d+g[a-z]*\./.test(instanceType);
  if (graviton !== (architecture === "arm64")) throw new ComputeCompileError("invalid_spec", `instanceType ${instanceType} is ${graviton ? "arm64" : "x86_64"} but architecture is ${architecture}.`);
  return { instanceType, architecture, rootVolumeGb: intField(node, spec.rootVolumeGb, "rootVolumeGb", 20, 8, 16384) };
}

/* --------------------------------- compile -------------------------------- */

const compile = (node: ResourceNode, ctx: CompileContext) =>
  compileNode(node, () => {
    const { instanceType, architecture, rootVolumeGb } = normalized(node);
    const label = tfLabel(node.address);
    const name = nodeName(node.address);
    const subnet = subnetsOf(node, ctx, "private")[0];
    if (!subnet) throw new ComputeCompileError("missing_neighbour", `${node.address} needs a private subnet in its dependsOn.`);
    const b = new Frag(node.address);
    const env = environmentData(b, label, ctx.region);

    const ami = b.data("aws_ssm_parameter", `${label}_ami`, { name: AL2023_PARAMETER(architecture) });
    const roleName = cloudName(ctx.namePrefix, `${name}-ec2`, 64);
    const role = b.resource("aws_iam_role", label, {
      name: roleName,
      assume_role_policy: assumeRoleJson("ec2.amazonaws.com"),
      permissions_boundary: boundaryArn(env),
      tags: tagsFor(ctx, node, roleName),
    });
    const ssm = b.resource("aws_iam_role_policy_attachment", `${label}_ssm`, {
      role: attr(role, "name"),
      policy_arn: cat("arn:", env.partition, ":iam::aws:policy/AmazonSSMManagedInstanceCore"),
    });
    const profile = b.resource("aws_iam_instance_profile", label, { name: cloudName(ctx.namePrefix, `${name}-ec2`, 128), role: attr(role, "name"), tags: tagsFor(ctx, node) });
    addSecurityGroup(b.inner, node, ctx);
    const sg: TfRef = rawRef(`aws_security_group.${securityGroupLabel(node.address)}.id`);

    const iname = cloudName(ctx.namePrefix, name, 255);
    const instance = b.resource("aws_instance", label, {
      ami: attr(ami, "insecure_value"),
      instance_type: instanceType,
      subnet_id: refOf(ctx, subnet.address, "id"),
      vpc_security_group_ids: [sg],
      iam_instance_profile: attr(profile, "name"),
      associate_public_ip_address: false,
      monitoring: false,
      metadata_options: [{ http_endpoint: "enabled", http_tokens: "required", http_put_response_hop_limit: 1, instance_metadata_tags: "disabled" }],
      root_block_device: [{ volume_type: "gp3", volume_size: rootVolumeGb, encrypted: true, delete_on_termination: true }],
      tags: tagsFor(ctx, node, iname),
      volume_tags: tagsFor(ctx, node, iname),
      lifecycle: { ignore_changes: ["ami"] },
      depends_on: [ssm.expr],
    });
    b.expose("id", attr(instance, "id"));
    b.expose("arn", attr(instance, "arn"));
    return b.build(instance);
  });

/* --------------------------------- expected ------------------------------- */

function expected(node: ResourceNode): Record<string, unknown> {
  return { instanceType: normalized(node).instanceType, imdsV2Required: true, publicIpAssigned: false, instanceProfileAttached: true };
}

/* --------------------------------- observe -------------------------------- */

const LIVE_STATES = ["pending", "running", "stopping", "stopped", "shutting-down"];

async function locate(ctx: AwsCtx, node: ResourceNode, externalId?: string): Promise<{ instance?: Instance; failure?: { kind: "missing" | "error"; code: string; summary: string } }> {
  const ec2 = ctx.session.client(EC2Client);
  if (externalId !== undefined && !/^i-[0-9a-f]{8,17}$/.test(externalId)) return { failure: { kind: "error", code: "InvalidExternalId", summary: "externalId is not an EC2 instance id." } };
  const res = await ec2.send(
    new DescribeInstancesCommand(
      externalId
        ? { InstanceIds: [externalId] }
        : { Filters: [...ec2TagFilters(ctx, node.address), { Name: "instance-state-name", Values: LIVE_STATES }] }
    ),
    { abortSignal: ctx.signal }
  );
  const all = (res.Reservations ?? []).flatMap((r) => r.Instances ?? []).filter((i) => i.State?.Name !== "terminated");
  if (all.length > 1) return { failure: { kind: "error", code: "Ambiguous", summary: `${all.length} instances carry the tags of ${node.address}.` } };
  if (all.length === 0) return { failure: { kind: "missing", code: "InstanceNotFound", summary: "No live instance carries this node's Zenith tags." } };
  return { instance: all[0] };
}

const observe: NonNullable<ResourceDriver<AwsSession>["observe"]> = async (ctx, node, externalId): Promise<Observation> => {
  const names = Object.keys(expected(node));
  let found: Awaited<ReturnType<typeof locate>>;
  try {
    found = await locate(ctx, node, externalId);
  } catch (e) {
    return failedObservation(ctx, node, ID, names, failureOf(ctx, e), externalId);
  }
  const i = found.instance;
  if (!i) return failedObservation(ctx, node, ID, names, found.failure!, externalId);
  const attributes = attributesOf(ctx, names, {
    ...(i.InstanceType ? { instanceType: i.InstanceType } : {}),
    ...(i.MetadataOptions?.HttpTokens ? { imdsV2Required: i.MetadataOptions.HttpTokens === "required" } : {}),
    publicIpAssigned: Boolean(i.PublicIpAddress),
    instanceProfileAttached: Boolean(i.IamInstanceProfile?.Arn),
  });
  return {
    address: node.address,
    externalId: i.InstanceId,
    presence: "present",
    attributes,
    native: boundNative({ instanceId: i.InstanceId, state: i.State?.Name, subnetId: i.SubnetId, vpcId: i.VpcId, availabilityZone: i.Placement?.AvailabilityZone, imageId: i.ImageId, iamInstanceProfile: i.IamInstanceProfile?.Arn, tags: tagsOf(i.Tags) }, { priority: ["instanceId", "state", "tags"] }),
    observedAt: ctx.now().toISOString(),
    source: ID,
    simulated: false,
  };
};

const runtime: NonNullable<ResourceDriver<AwsSession>["runtime"]> = async (ctx, node, externalId): Promise<RuntimeState> => {
  let found: Awaited<ReturnType<typeof locate>>;
  try {
    found = await locate(ctx, node, externalId);
  } catch (e) {
    const f = failureOf(ctx, e);
    return runtimeState(ctx, node, ID, "unknown", {}, [f.kind === "inaccessible" ? "access_denied" : `read_failed:${f.code}`]);
  }
  const i = found.instance;
  if (!i?.InstanceId) return runtimeState(ctx, node, ID, found.failure?.kind === "missing" ? "unhealthy" : "unknown", {}, [found.failure?.kind === "missing" ? "instance_missing" : `read_failed:${found.failure?.code}`]);
  const state = i.State?.Name ?? "unknown";
  const signals = [`state:${state}`];
  let health: HealthState = state === "running" ? "healthy" : state === "pending" ? "degraded" : "unhealthy";

  if (state === "running") {
    const ec2 = ctx.session.client(EC2Client);
    const status = await attempt(() => ec2.send(new DescribeInstanceStatusCommand({ InstanceIds: [i.InstanceId!], IncludeAllInstances: false }), { abortSignal: ctx.signal }), ctx.signal);
    if (status.ok) {
      const s = status.value.InstanceStatuses?.[0];
      const inst = s?.InstanceStatus?.Status;
      const sys = s?.SystemStatus?.Status;
      if (inst) signals.push(`instance_status:${inst}`);
      if (sys) signals.push(`system_status:${sys}`);
      if (inst === "impaired" || sys === "impaired") health = "unhealthy";
      else if (inst === "initializing" || sys === "initializing" || !s) health = health === "healthy" ? "degraded" : health;
    } else signals.push("status_checks_unreadable");

    const ssm = ctx.session.client(SSMClient);
    const ping = await attempt(() => ssm.send(new DescribeInstanceInformationCommand({ Filters: [{ Key: "InstanceIds", Values: [i.InstanceId!] }] }), { abortSignal: ctx.signal }), ctx.signal);
    if (ping.ok) {
      const p = ping.value.InstanceInformationList?.[0]?.PingStatus;
      signals.push(`ssm:${p ?? "NotRegistered"}`);
      if (p !== "Online" && health === "healthy") health = "degraded";
    } else signals.push("ssm_unreadable");
  }
  return runtimeState(ctx, node, ID, health, {}, signals);
};

const discover: NonNullable<ResourceDriver<AwsSession>["discover"]> = async (ctx): Promise<DiscoveredResource[]> => {
  const ec2 = ctx.session.client(EC2Client);
  const { items } = await paginate<Instance>(
    async (token) => {
      const res = await ec2.send(new DescribeInstancesCommand({ Filters: [{ Name: "instance-state-name", Values: LIVE_STATES }], MaxResults: 100, ...(token ? { NextToken: token } : {}) }), { abortSignal: ctx.signal });
      return { items: (res.Reservations ?? []).flatMap((r) => r.Instances ?? []), next: res.NextToken };
    },
    { maxPages: 3, signal: ctx.signal }
  );
  return items
    .filter((i) => i.InstanceId)
    .map((i) => {
      const tags = tagsOf(i.Tags);
      return {
        provider: "aws" as const,
        kind: "compute_instance" as const,
        nativeType: "aws:ec2_instance",
        externalId: i.InstanceId!,
        name: tags.Name ?? i.InstanceId!,
        region: ctx.region,
        zenithTagged: hasZenithManagedTag(tags),
        attributes: { instanceType: i.InstanceType ?? "unknown", state: i.State?.Name ?? "unknown" },
      };
    })
    .sort((a, b) => (a.externalId < b.externalId ? -1 : 1));
};

export const ec2InstanceDriver: ResourceDriver<AwsSession> = {
  id: ID,
  provider: "aws",
  kind: "compute_instance",
  nativeType: "aws:ec2_instance",
  capabilities: {
    experimental: true,
    compile: true,
    observe: true,
    runtime: true,
    verify: true,
    discover: true,
    operations: [],
    evidence: { compile: "contract", observe: "contract", runtime: "contract", verify: "contract", discover: "contract" },
  },
  compile,
  observe,
  runtime,
  discover,
  expectedAttributes: expected,
  verify: async (ctx, node, observation, rt) => {
    const base = standardVerification(ctx, node, observation, expected(node), "The EC2 instance");
    if (observation.presence !== "present") return base;
    const state = rt ?? (await runtime(ctx, node, observation.externalId));
    const signals = state.signals;
    const running = signals.includes("state:running");
    const checks = [
      ...base.checks,
      { id: "running", description: "The instance is running", passed: state.health === "unknown" ? ("unknown" as const) : running, ...(running ? {} : { detail: signals.join(", ") }) },
      {
        id: "ssm_online",
        description: "The SSM agent reports Online (the machine plane can reach the instance)",
        passed: signals.includes("ssm:Online") ? true : signals.some((s) => s.startsWith("ssm:")) ? false : ("unknown" as const),
        ...(signals.includes("ssm:Online") ? {} : { detail: signals.filter((s) => s.startsWith("ssm")).join(", ") || "not read" }),
      },
    ];
    return { ...base, checks, status: checks.some((c) => c.passed === false) ? "failed" : checks.some((c) => c.passed === "unknown") ? "unknown" : "passed" };
  },
};
