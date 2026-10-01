/**
 * `aws:security_group_rule` compile: one `FirewallSpec` → security-group RULES.
 *
 * The groups themselves are owned by the protected/protecting nodes' own
 * drivers (see shared/security-group.ts); this driver only adds rules, always
 * as standalone `aws_vpc_security_group_*_rule` resources, never inline:
 *
 *   ingress   on the TARGET's group: tcp/<port> from the SOURCE's group
 *             (`referenced_security_group_id`), or from a CIDR
 *   egress    on the SOURCE's group: tcp/<port> to the TARGET's group — only for
 *             a node source. Workload groups have no other egress than tcp/443,
 *             the load balancer and datastores have none, so without this rule
 *             the ingress rule would be unreachable. A CIDR source (the internet)
 *             is not a Zenith group, so nothing is added on its side.
 *
 * Refusals (`DriverCompileError`), each a deliberate safety property:
 *   - a CIDR source that is not private (RFC 1918) unless it is exactly the
 *     public-web rule: capability `public_http`, target a `load_balancer`, port
 *     80 or 443. A database, a service or any other port can never be opened to
 *     a public range through a manifest;
 *   - `public_http` with a node source (the capability means "the internet");
 *   - a source or target that is not an AWS node Zenith manages, is in another
 *     region, or whose kind cannot own a security group;
 *   - `crossBoundary` rules (a security group cannot reference another cloud);
 *   - any direction other than ingress, any protocol other than tcp.
 * IPv6 sources are not supported (the load balancer is IPv4-only).
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { FirewallSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { DriverCompileError, FragmentBuilder, isSecurityGroupKind, resourceTags, securityGroupExpr, tfLabel } from "../shared";
import { isPrivateCidr, parseCidr } from "./cidr";

export const PUBLIC_HTTP_CAPABILITY = "public_http";
export const PUBLIC_HTTP_PORTS: readonly number[] = [80, 443];

/**
 * SG rule descriptions allow `a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*`, at most 255 characters. `$`, `{` and `}`
 * are dropped although legal: the description is free text from the manifest and must never
 * form a tofu interpolation (`${…}`).
 */
export function sanitizeRuleDescription(text: unknown, fallback: string): string {
  const cleaned = typeof text === "string" ? text.replace(/[^a-zA-Z0-9. _\-:/()#,@[\]+=&;!*]/g, " ").replace(/\s+/g, " ").trim() : "";
  return (cleaned === "" ? fallback : cleaned).slice(0, 255);
}

function requireAwsSecurityGroupNode(ctx: CompileContext, owner: string, role: string, address: string, region: string): ResourceNode {
  const n = ctx.node(address);
  if (!n) throw new DriverCompileError("missing_node", owner, `the ${role} ${address} is not in the graph.`);
  if (n.provider !== "aws") throw new DriverCompileError("unsupported", owner, `the ${role} ${address} is a ${n.provider} node; a security group rule cannot reach another provider.`);
  if (n.ownership !== "managed") throw new DriverCompileError("unsupported", owner, `the ${role} ${address} is ${n.ownership}: Zenith owns no security group for it, so it cannot add a rule.`);
  if (!isSecurityGroupKind(n.kind)) throw new DriverCompileError("unsupported", owner, `the ${role} ${address} is a ${n.kind}, which has no security group.`);
  if (n.region !== region) throw new DriverCompileError("unsupported", owner, `the ${role} ${address} is in ${n.region}, not ${region}; security groups only reference groups of their own region.`);
  return n;
}

/** A CIDR may be a rule source only when it is private, or it is the public web rule. */
const isSecurityGroupCidrAllowed = (isPrivate: boolean, isPublicWeb: boolean): boolean => isPrivate || isPublicWeb;

export interface ValidFirewall {
  port: number;
  source: FirewallSpec["source"];
  target: ResourceNode;
  sourceNode?: ResourceNode;
  description: string;
}

/** Validate the spec against the graph. Everything the compile refuses is decided here. */
function failAt(address: string, code: "invalid_spec" | "unsupported" | "policy_refused", msg: string): never {
  throw new DriverCompileError(code, address, msg);
}

export function readFirewall(node: ResourceNode, ctx: CompileContext): ValidFirewall {
  const spec = node.spec as Partial<FirewallSpec>;
  if (spec.direction !== "ingress") failAt(node.address, "unsupported", `direction ${JSON.stringify(spec.direction)} is not supported; only ingress rules are compiled (egress is derived from them).`);
  if (spec.protocol !== "tcp") failAt(node.address, "unsupported", `protocol ${JSON.stringify(spec.protocol)} is not supported; only tcp rules are compiled.`);
  if (spec.crossBoundary !== undefined) failAt(node.address, "unsupported", `a ${spec.crossBoundary} rule cannot be expressed as a security-group rule.`);
  const port = spec.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) failAt(node.address, "invalid_spec", `port must be an integer from 1 to 65535, got ${JSON.stringify(port)}.`);
  if (typeof spec.target !== "string" || spec.target === "") failAt(node.address, "invalid_spec", "target must be the address of the protected node.");
  const source = spec.source;
  if (typeof source !== "object" || source === null) failAt(node.address, "invalid_spec", "source must be { address } or { cidr }.");

  const target = requireAwsSecurityGroupNode(ctx, node.address, "target", spec.target as string, node.region);
  const description = sanitizeRuleDescription(spec.description, `Zenith rule ${node.address}`);

  if ("cidr" in source) {
    const cidr = parseCidr(source.cidr);
    if (!cidr) failAt(node.address, "invalid_spec", `source.cidr must be a canonical IPv4 CIDR, got ${JSON.stringify(source.cidr)}.`);
    const isPublicWeb = spec.capability === PUBLIC_HTTP_CAPABILITY && target.kind === "load_balancer" && PUBLIC_HTTP_PORTS.includes(port as number);
    if (!isSecurityGroupCidrAllowed(isPrivateCidr(cidr), isPublicWeb)) {
      failAt(node.address, "policy_refused", `${source.cidr} is a public range: only the public_http rule to a load balancer on tcp/80 or tcp/443 may open a service to it (capability ${JSON.stringify(spec.capability)}, target ${target.kind}, port ${port}).`);
    }
    if (spec.capability === PUBLIC_HTTP_CAPABILITY && !isPublicWeb) failAt(node.address, "policy_refused", "public_http may only target a load balancer on tcp/80 or tcp/443.");
    return { port: port as number, source, target, description };
  }
  if (!("address" in source) || typeof source.address !== "string" || source.address === "") failAt(node.address, "invalid_spec", "source must be { address } or { cidr }.");
  if (spec.capability === PUBLIC_HTTP_CAPABILITY) failAt(node.address, "invalid_spec", "capability public_http means the public internet and needs a CIDR source, not a node.");
  const sourceNode = requireAwsSecurityGroupNode(ctx, node.address, "source", source.address, node.region);
  return { port: port as number, source, target, sourceNode, description };
}

export function compileFirewall(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (node.ownership !== "managed") throw new DriverCompileError("policy_refused", node.address, `Zenith does not add firewall rules for a ${node.ownership} node.`);
  const fw = readFirewall(node, ctx);
  const L = tfLabel(node.address);
  const tags = resourceTags(ctx.tags, node.address);
  const targetSg = securityGroupExpr(ctx, fw.target.address);
  const b = new FragmentBuilder(node.address);

  b.resource("aws_vpc_security_group_ingress_rule", L, {
    security_group_id: targetSg,
    ip_protocol: "tcp",
    from_port: fw.port,
    to_port: fw.port,
    ...("cidr" in fw.source ? { cidr_ipv4: fw.source.cidr } : { referenced_security_group_id: securityGroupExpr(ctx, fw.source.address) }),
    description: fw.description,
    tags,
  });

  if (fw.sourceNode) {
    b.resource("aws_vpc_security_group_egress_rule", `${L}_egress`, {
      security_group_id: securityGroupExpr(ctx, fw.sourceNode.address),
      ip_protocol: "tcp",
      from_port: fw.port,
      to_port: fw.port,
      referenced_security_group_id: targetSg,
      description: sanitizeRuleDescription(`egress: ${fw.description}`, `Zenith egress for ${node.address}`),
      tags,
    });
  }
  return b.build();
}
