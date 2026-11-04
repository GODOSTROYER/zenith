/**
 * Cross-node references made by the compute drivers.
 *
 * A compute node never hard-codes another node's tofu label: it asks
 * `ctx.ref(address, attribute)`. Which `attribute` strings the other drivers
 * must understand is an agreement between driver groups, so every one this
 * group uses is listed here, in one place, to be read against WS-AWS-NET's
 * and WS-AWS-DATA's drivers at integration:
 *
 *   network            `id`                       VPC id
 *   subnet             `id`                       subnet id
 *   identity           `arn`                      the task / function role ARN
 *   log_group          `name`                     log group name
 *   secret             `arn`                      Secrets Manager secret ARN
 *   container_registry `arn` `repository_url`     ECR repository ARN / URL
 *                      `name`                     repository name
 *   load_balancer      `target_group_arn:<target node address>`
 *                                                  ARN of the target group that forwards to that node
 *                      `listener_rule:<target node address>`
 *                                                  the listener rule object that makes the target group
 *                                                  attachable (the ECS service depends on it)
 *   static_site        `bucket` `bucket_arn`      own S3 bucket (read by a build pipeline)
 *   tls_certificate    `arn`                      ACM certificate ARN
 *
 * The node's OWN security group is emitted by the node's own driver
 * (`aws_security_group.<securityGroupLabel(address)>`), and firewall rules
 * (`firewall/*`) attach ingress to it by that label.
 */
import type { CompileContext } from "@/lib/drivers/types";
import type { PortableKind, ResourceNode } from "@/lib/resources/types";
import { subnetsOf } from "@/lib/providers/aws/drivers/shared";
import { ComputeCompileError } from "./tf";

/** Neighbours a node depends on, resolved through the compile context, sorted by address. */
export function dependencies(ctx: CompileContext, node: ResourceNode, kind: PortableKind): ResourceNode[] {
  const out: ResourceNode[] = [];
  for (const address of [...node.dependsOn].sort()) {
    const n = ctx.node(address);
    if (n && n.kind === kind) out.push(n);
  }
  return out;
}

export function requireOne(ctx: CompileContext, node: ResourceNode, kind: PortableKind, purpose: string): ResourceNode {
  const found = dependencies(ctx, node, kind);
  if (found.length === 0) throw new ComputeCompileError("missing_neighbour", `${node.address} needs a ${kind} node in its dependsOn (${purpose}); none is present.`);
  return found[0];
}

/** The private subnets of this node's network, in address order. */
export function privateSubnets(ctx: CompileContext, node: ResourceNode): ResourceNode[] {
  return subnetsOf(node, ctx, "private");
}
