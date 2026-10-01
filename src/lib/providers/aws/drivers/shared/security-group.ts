/**
 * Security-group ownership contract (AWS network / compute / data drivers).
 *
 * DECISION: every node that lives in a VPC and can be the source or target of a
 * firewall rule owns exactly ONE `aws_security_group`, defined by THAT NODE'S
 * OWN driver, through {@link addSecurityGroup} / {@link withSecurityGroup}.
 * The `aws:security_group_rule` (firewall) driver only adds RULES to those
 * groups. Why not let the firewall driver own the groups: each firewall node
 * compiles alone, several firewall nodes target one workload, and the workspace
 * assembler rejects two fragments defining one tofu address — there is no
 * single firewall node that could safely own "the" group of a target. Why not
 * the network driver: it cannot enumerate the graph.
 *
 * What a driver in SECURITY_GROUP_KINDS must do in `compile`:
 *
 *     const b = new FragmentBuilder(node.address);
 *     … define the primary resource first …
 *     addSecurityGroup(b, node, ctx);                    // or withSecurityGroup(fragment, node, ctx)
 *     … and attach it: security_groups = [securityGroupExpr(ctx, node.address)]
 *
 * The group is published under the ref attribute `security_group_id`
 * (REF.securityGroupId), so the node's own resource AND every firewall rule use
 * `ctx.ref(node.address, "security_group_id")`. The group is created with NO
 * inline rules (`aws_vpc_security_group_*_rule` resources are the only rules,
 * so nothing drifts against inline blocks) and with no egress except the
 * baseline below. AWS creates a VPC security group with an allow-all egress
 * rule; the provider removes it on create when no `egress` is configured.
 *
 *   load_balancer, postgres, mysql, redis, kubernetes_cluster / native EKS
 *       no baseline egress. The load balancer's egress to its targets is added
 *       by the firewall rule for each (LB → workload); datastores never initiate.
 *       EKS adds its explicit self and HTTPS rules in its own driver.
 *   container_service, scheduled_job, compute_instance
 *       tcp/443 to 0.0.0.0/0 (ECR, CloudWatch, Secrets Manager, STS and other
 *       AWS APIs through NAT, plus outbound HTTPS). Egress to datastores and
 *       other workloads is added per firewall rule, not opened here.
 *
 * Group names are `<namePrefix>-<kind>-<name>` (≤ 255, cloudName rules) and
 * descriptions are constant per address (a description change forces
 * replacement). The group is tagged with `ctx.tags` + `zenith:resource` = the
 * OWNING node's address, which is how the firewall driver's `observe` finds it.
 */
import type { CompileContext } from "@/lib/drivers/types";
import type { PortableKind, ResourceNode } from "@/lib/resources/types";
import { DriverCompileError } from "./errors";
import { FragmentBuilder } from "./fragment";
import { addressSlug, cloudName, tfLabel, tfLiteral } from "./names";
import { REF, refExpr } from "./refs";
import { resourceTags } from "./tags";
import { networkAddressOf } from "./topology";
import type { TofuFragment } from "@/lib/drivers/types";

export const SECURITY_GROUP_KINDS: readonly PortableKind[] = ["load_balancer", "container_service", "scheduled_job", "compute_instance", "postgres", "mysql", "redis", "kubernetes_cluster"];

export type SecurityGroupEgress = "none" | "https_anywhere";

export const isSecurityGroupKind = (kind: string): boolean => (SECURITY_GROUP_KINDS as readonly string[]).includes(kind);

/** Native escape-hatch nodes may own a group only for the exact EKS type. */
export const isSecurityGroupNode = (node: Pick<ResourceNode, "kind" | "nativeType">): boolean =>
  isSecurityGroupKind(node.kind) || (node.kind === "provider_native" && node.nativeType === "aws:eks_cluster");

/** The baseline egress for a node kind (see the module comment). */
export function defaultSecurityGroupEgress(kind: string): SecurityGroupEgress {
  return kind === "container_service" || kind === "scheduled_job" || kind === "compute_instance" ? "https_anywhere" : "none";
}

/** The tofu label of the node's `aws_security_group`. */
export const securityGroupLabel = (address: string): string => `${tfLabel(address)}_sg`;

/** The cloud-side group name for a node. */
export const securityGroupName = (ctx: Pick<CompileContext, "namePrefix">, address: string): string => cloudName(ctx.namePrefix, addressSlug(address), 255);

/** A `${…}` expression for the security group id of the node at `address` (owned by that node's driver). */
export const securityGroupExpr = (ctx: Pick<CompileContext, "ref">, address: string): string => refExpr(ctx.ref(address, REF.securityGroupId));

/**
 * Add the node's security group (and baseline egress rule) to `b`. Returns the
 * group's tofu address (`aws_security_group.service_web_sg`). Refuses nodes
 * Zenith does not manage, nodes of another provider and kinds that cannot own a group.
 */
export function addSecurityGroup(b: FragmentBuilder, node: ResourceNode, ctx: CompileContext, opts: { egress?: SecurityGroupEgress } = {}): string {
  if (node.provider !== "aws") throw new DriverCompileError("unsupported", node.address, `an AWS security group cannot be created for a ${node.provider} node.`);
  if (node.ownership !== "managed") throw new DriverCompileError("policy_refused", node.address, `Zenith does not create security groups for ${node.ownership} nodes.`);
  if (!isSecurityGroupNode(node)) throw new DriverCompileError("unsupported", node.address, `kind ${node.kind} does not own a security group.`);

  const label = securityGroupLabel(node.address);
  const name = securityGroupName(ctx, node.address);
  const vpc = refExpr(ctx.ref(networkAddressOf(node, ctx), REF.id));
  const tags = resourceTags(ctx.tags, node.address, name);
  const address = b.resource("aws_security_group", label, {
    name,
    description: tfLiteral(`Zenith managed security group for ${node.address}`).slice(0, 255),
    vpc_id: vpc,
    tags,
  });
  const egress = opts.egress ?? defaultSecurityGroupEgress(node.kind);
  if (egress === "https_anywhere") {
    b.resource("aws_vpc_security_group_egress_rule", `${label}_https`, {
      security_group_id: `\${aws_security_group.${label}.id}`,
      ip_protocol: "tcp",
      from_port: 443,
      to_port: 443,
      cidr_ipv4: "0.0.0.0/0",
      description: "HTTPS to AWS APIs, the image registry and the internet through NAT",
      tags: resourceTags(ctx.tags, node.address),
    });
  }
  b.expose(REF.securityGroupId, `aws_security_group.${label}.id`);
  return address;
}

/** `addSecurityGroup` onto a finished fragment; returns a new fragment, the input is not modified. */
export function withSecurityGroup(fragment: TofuFragment, node: ResourceNode, ctx: CompileContext, opts: { egress?: SecurityGroupEgress } = {}): TofuFragment {
  const b = FragmentBuilder.from(node.address, fragment);
  addSecurityGroup(b, node, ctx, opts);
  return b.build();
}
