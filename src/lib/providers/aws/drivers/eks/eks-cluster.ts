/**
 * EKS compile-only driver: pinned Kubernetes version, private API by default,
 * KMS secrets encryption, private managed AL2023 nodes with encrypted gp3
 * disks/IMDSv2, all control-plane logs, and the Pod Identity agent add-on.
 * Pod identities and Kubernetes access entries are explicit follow-up resources;
 * installing the agent does not grant a workload or cluster creator access.
 *
 * The cluster publishes endpoint/server, CA data, name, OIDC issuer and SG ID
 * as non-secret locals for a Kubernetes connection. No token or kubeconfig is
 * generated. EKS SDK reads are unavailable in the installed dependency set,
 * so observe/runtime/verify/discover are honestly unimplemented. Contract only.
 * Private subnets need NAT or suitable AWS VPC endpoints for node bootstrap.
 * Native manifests may name generated subnet addresses in config.subnets;
 * hand-built graphs can instead carry direct subnet dependencies.
 */
import { z } from "zod";
import type { AwsSession } from "@/lib/credentials/types";
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import {
  DriverCompileError, FragmentBuilder, cloudName, nodeName, refExpr, resourceTags,
  securityGroupLabel, securityGroupName, subnetsOf, tfLabel,
} from "@/lib/providers/aws/drivers/shared";
import { parseCidr } from "@/lib/providers/aws/drivers/network/cidr";
import { assertAwsNode, KMS_KEY_ARN, neighbour, readSpec } from "@/lib/providers/aws/drivers/messaging/support";

export const EKS_CLUSTER_SCHEMA = z.object({
  version: z.string().regex(/^1\.[1-9][0-9]$/),
  subnets: z.array(z.string().regex(/^subnet\/[a-z0-9-]+$/)).max(16).optional(),
  kmsKeyArn: z.string().regex(KMS_KEY_ARN).optional(),
  encryption: z.literal(true).optional(),
  endpointPublicAccess: z.boolean().default(false),
  publicAccessCidrs: z.array(z.string().max(32)).max(50).default([]),
  nodeInstanceType: z.string().regex(/^[a-z][a-z0-9-]{0,14}\.[a-z0-9]{1,20}$/).default("t3.medium"),
  nodeMin: z.number().int().min(1).max(100).default(1),
  nodeDesired: z.number().int().min(1).max(100).default(2),
  nodeMax: z.number().int().min(1).max(100).default(3),
  nodeDiskGb: z.number().int().min(20).max(16384).default(20),
  podIdentityAddonVersion: z.string().regex(/^v\d+\.\d+\.\d+-eksbuild\.\d+$/).optional(),
}).strict();
export type EksClusterSpec = z.input<typeof EKS_CLUSTER_SCHEMA>;
export const EKS_LOG_TYPES = ["api", "audit", "authenticator", "controllerManager", "scheduler"] as const;

/**
 * Use the shared group's label/name/tags/reference contract. addSecurityGroup
 * currently refuses kubernetes_cluster, and its file is outside this job's
 * ownership. This small adapter creates the same rule-free group without lying
 * about the node's kind. The orchestrator can add the kind to the shared helper
 * and replace the resource/expose pair below with addSecurityGroup(...).
 */
function addClusterSecurityGroup(b: FragmentBuilder, node: ResourceNode, ctx: CompileContext, network: string): string[] {
  const label = securityGroupLabel(node.address);
  const sg = b.resource("aws_security_group", label, {
    name: securityGroupName(ctx, node.address),
    description: "Zenith EKS control plane and managed nodes",
    vpc_id: refExpr(ctx.ref(network, "id")),
    tags: resourceTags(ctx.tags, node.address, securityGroupName(ctx, node.address)),
  });
  b.expose("security_group_id", `${sg}.id`);
  const group = refExpr(`${sg}.id`);
  const tags = resourceTags(ctx.tags, node.address);
  // Self-only traffic covers kubelet, DNS, webhooks and pod-to-pod networking.
  // There is no inline rule and no ingress from a public or entire VPC CIDR.
  const ingress = b.resource("aws_vpc_security_group_ingress_rule", `${label}_self`, {
    security_group_id: group, referenced_security_group_id: group, ip_protocol: "-1", tags,
  });
  const egress = b.resource("aws_vpc_security_group_egress_rule", `${label}_self`, {
    security_group_id: group, referenced_security_group_id: group, ip_protocol: "-1", tags,
  });
  const https = b.resource("aws_vpc_security_group_egress_rule", `${label}_https`, {
    security_group_id: group, ip_protocol: "tcp", from_port: 443, to_port: 443, cidr_ipv4: "0.0.0.0/0",
    description: "HTTPS for private nodes to AWS APIs and registries through NAT", tags,
  });
  return [ingress, egress, https];
}

export function compileEksCluster(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (node.ownership !== "managed") return { addresses: [] };
  assertAwsNode(node, ctx);
  const spec = readSpec(node, EKS_CLUSTER_SCHEMA);
  if (spec.nodeMin > spec.nodeDesired || spec.nodeDesired > spec.nodeMax) {
    throw new DriverCompileError("invalid_spec", node.address, "node counts must satisfy min <= desired <= max.");
  }
  // The AMI is deliberately AL2023 x86_64; don't silently attach an ARM shape.
  if (/^[a-z]+\d+g[a-z]*\./.test(spec.nodeInstanceType)) {
    throw new DriverCompileError("unsupported", node.address, "the managed node group requires an x86_64 instance type.");
  }
  const cidrs = [...new Set(spec.publicAccessCidrs)].sort();
  if (spec.endpointPublicAccess ? cidrs.length === 0 || cidrs.some((cidr) => { const parsed = parseCidr(cidr); return !parsed || parsed.prefix < 8; }) : cidrs.length !== 0) {
    throw new DriverCompileError("policy_refused", node.address, "public access requires explicit canonical IPv4 CIDRs of /8 or narrower; private-only clusters must omit them.");
  }
  if (spec.kmsKeyArn && !spec.kmsKeyArn.includes(`:kms:${node.region}:`)) {
    throw new DriverCompileError("invalid_spec", node.address, "the secrets encryption key must be in the cluster's region.");
  }
  const subnets = [...new Map([...subnetsOf(node, ctx), ...(spec.subnets ?? []).map((address) => neighbour(node, ctx, address, "aws:subnet"))]
    .map((subnet) => [subnet.address, subnet])).values()].sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  if (subnets.length < 2 || subnets.some((subnet) => subnet.spec.tier !== "private" || !/^[a-f]$/.test(String(subnet.spec.zone)))) {
    throw new DriverCompileError("invalid_spec", node.address, "EKS requires at least two private subnets with declared zone letters.");
  }
  for (const subnet of subnets) neighbour(node, ctx, subnet.address, "aws:subnet");
  if (new Set(subnets.map((subnet) => subnet.spec.zone)).size < 2) {
    throw new DriverCompileError("invalid_spec", node.address, "EKS subnets must span at least two availability zones.");
  }
  const network = subnets[0].spec.network;
  if (typeof network !== "string" || subnets.some((subnet) => subnet.spec.network !== network)) {
    throw new DriverCompileError("invalid_spec", node.address, "all EKS subnets must name the same network.");
  }
  neighbour(node, ctx, network, "aws:vpc");

  const label = tfLabel(node.address);
  const name = cloudName(ctx.namePrefix, nodeName(node.address), 100);
  const b = new FragmentBuilder(node.address);
  const cluster = `aws_eks_cluster.${label}`;
  const account = `data.aws_caller_identity.${label}.account_id`;
  const partition = `data.aws_partition.${label}.partition`;
  const tags = resourceTags(ctx.tags, node.address);
  const subnetIds = subnets.map((subnet) => refExpr(ctx.ref(subnet.address, "id")));
  const keyArn = spec.kmsKeyArn ?? refExpr(`aws_kms_key.${label}.arn`);
  b.resource("aws_eks_cluster", label, {
    name, version: spec.version, role_arn: refExpr(`aws_iam_role.${label}_cluster.arn`),
    enabled_cluster_log_types: [...EKS_LOG_TYPES],
    access_config: [{ authentication_mode: "API", bootstrap_cluster_creator_admin_permissions: false }],
    vpc_config: [{
      subnet_ids: subnetIds, security_group_ids: [refExpr(`aws_security_group.${securityGroupLabel(node.address)}.id`)],
      endpoint_private_access: true, endpoint_public_access: spec.endpointPublicAccess,
      ...(spec.endpointPublicAccess ? { public_access_cidrs: cidrs } : {}),
    }],
    encryption_config: [{ provider: [{ key_arn: keyArn }], resources: ["secrets"] }],
    tags,
    depends_on: [`aws_iam_role_policy_attachment.${label}_cluster`, `aws_cloudwatch_log_group.${label}`],
  });
  b.data("aws_caller_identity", label, {});
  b.data("aws_partition", label, {});
  if (!spec.kmsKeyArn) b.resource("aws_kms_key", label, {
    description: "Zenith EKS secrets encryption", enable_key_rotation: true, deletion_window_in_days: 30, tags,
    lifecycle: { prevent_destroy: true },
  });
  b.resource("aws_cloudwatch_log_group", label, { name: `/aws/eks/${name}/cluster`, retention_in_days: 30, tags });
  const boundary = `arn:${refExpr(partition)}:iam::${refExpr(account)}:policy/ZenithWorkloadBoundary`;
  const role = (suffix: string, principal: string) => b.resource("aws_iam_role", `${label}_${suffix}`, {
    name: cloudName(ctx.namePrefix, `${nodeName(node.address)}-${suffix}`, 64), permissions_boundary: boundary,
    assume_role_policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: principal }, Action: "sts:AssumeRole" }] }), tags,
  });
  const clusterRole = role("cluster", "eks.amazonaws.com");
  const nodeRole = role("nodes", "ec2.amazonaws.com");
  const attach = (suffix: string, roleAddress: string, policy: string) => b.resource("aws_iam_role_policy_attachment", `${label}_${suffix}`, {
    role: refExpr(`${roleAddress}.name`), policy_arn: `arn:${refExpr(partition)}:iam::aws:policy/${policy}`,
  });
  attach("cluster", clusterRole, "AmazonEKSClusterPolicy");
  const nodePolicies = [
    attach("worker", nodeRole, "AmazonEKSWorkerNodePolicy"),
    attach("cni", nodeRole, "AmazonEKS_CNI_Policy"),
    attach("registry", nodeRole, "AmazonEC2ContainerRegistryReadOnly"),
  ];
  const rules = addClusterSecurityGroup(b, node, ctx, network);
  const template = b.resource("aws_launch_template", label, {
    name: cloudName(ctx.namePrefix, `${nodeName(node.address)}-nodes`, 128),
    vpc_security_group_ids: [refExpr(`aws_security_group.${securityGroupLabel(node.address)}.id`)],
    metadata_options: [{ http_endpoint: "enabled", http_tokens: "required", http_put_response_hop_limit: 2 }],
    block_device_mappings: [{ device_name: "/dev/xvda", ebs: [{ encrypted: true, volume_type: "gp3", volume_size: spec.nodeDiskGb, delete_on_termination: true }] }],
    tag_specifications: [{ resource_type: "instance", tags }, { resource_type: "volume", tags }], tags,
  });
  const group = b.resource("aws_eks_node_group", label, {
    cluster_name: refExpr(`${cluster}.name`), node_group_name: cloudName(ctx.namePrefix, `${nodeName(node.address)}-nodes`, 63),
    node_role_arn: refExpr(`${nodeRole}.arn`), subnet_ids: subnetIds,
    ami_type: "AL2023_x86_64_STANDARD", capacity_type: "ON_DEMAND", instance_types: [spec.nodeInstanceType],
    version: spec.version,
    launch_template: [{ id: refExpr(`${template}.id`), version: refExpr(`${template}.latest_version`) }],
    scaling_config: [{ min_size: spec.nodeMin, desired_size: spec.nodeDesired, max_size: spec.nodeMax }],
    update_config: [{ max_unavailable: 1 }], tags, depends_on: [...nodePolicies, ...rules],
  });
  b.resource("aws_eks_addon", `${label}_pod_identity`, {
    cluster_name: refExpr(`${cluster}.name`), addon_name: "eks-pod-identity-agent",
    ...(spec.podIdentityAddonVersion ? { addon_version: spec.podIdentityAddonVersion } : {}),
    tags, depends_on: [group],
  });
  for (const [attribute, expression] of Object.entries({
    id: `${cluster}.id`, arn: `${cluster}.arn`, name: `${cluster}.name`, cluster_name: `${cluster}.name`,
    endpoint: `${cluster}.endpoint`, server: `${cluster}.endpoint`,
    ca_data: `${cluster}.certificate_authority[0].data`, certificate_authority_data: `${cluster}.certificate_authority[0].data`,
    oidc_issuer: `${cluster}.identity[0].oidc[0].issuer`,
  })) b.expose(attribute, expression);
  return b.build();
}

export const eksClusterDriver: ResourceDriver<AwsSession> = {
  id: "aws.eks_cluster@1", provider: "aws", kind: "kubernetes_cluster", nativeType: "aws:eks_cluster",
  capabilities: {
    compile: true, observe: false, runtime: false, verify: false, discover: false,
    operations: [], evidence: { compile: "contract" },
  },
  compile: compileEksCluster,
};
