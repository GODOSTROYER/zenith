/**
 * The cross-node reference protocol AWS drivers use.
 *
 * A driver never writes another node's tofu label. It asks
 * `ctx.ref(address, attribute)` for a tofu expression. What `attribute` names
 * is part of the TARGET driver's published surface:
 *
 *   - An attribute the target PUBLISHES is exposed as a tofu local named
 *     {@link refLocalName}(address, attribute) — `exposeRef` adds it to the
 *     target's fragment. The expression lives in the target's own fragment, so
 *     the target alone decides which resource/attribute it stands for (e.g. a
 *     certificate's `arn` is the *validated* ARN when DNS validation is
 *     automatic, so a listener cannot attach a certificate that is still pending).
 *   - A `ctx.ref` implementation is therefore name-based and needs no compile
 *     order: `ref(a, attr) = "${local." + refLocalName(a, attr) + "}"`. The
 *     orchestrator may alternatively resolve attributes the target's primary
 *     resource carries natively (`id`, `arn`, `dns_name`, `zone_id`) straight to
 *     `${<addresses[0]>.<attr>}`; every AWS driver lists its PRIMARY resource
 *     first in `TofuFragment.addresses` so both resolutions agree. Attributes
 *     that are not native to the primary resource (`security_group_id`,
 *     `target_group_arn:<target>`, `private_route_table_id:<zone>`, …) are
 *     resolvable only through the local.
 *
 * `refExpr` normalizes whatever `ctx.ref` returned into a `${…}` template so a
 * driver can use it as a whole attribute value or embed it in a longer template.
 */
import { tfLabel } from "./names";

/** The tofu local a node publishes for `attribute` (`load_balancer/public`, `dns_name` → `ref_load_balancer_public__dns_name`). */
export function refLocalName(address: string, attribute: string): string {
  return `ref_${tfLabel(address)}__${attribute.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
}

/** `${…}`-wrap a bare traversal; leave a value that already interpolates as it is. */
export function refExpr(ref: string): string {
  return ref.includes("${") ? ref : `\${${ref}}`;
}

/** The expression inside `${…}` (for use within a larger HCL expression, e.g. `[for …]`). */
export function bareExpr(ref: string): string {
  const m = /^\$\{([\s\S]+)\}$/.exec(ref);
  return m ? m[1] : ref;
}

/** Attribute names more than one driver agrees on. */
export const REF = {
  id: "id",
  arn: "arn",
  dnsName: "dns_name",
  zoneId: "zone_id",
  arnSuffix: "arn_suffix",
  securityGroupId: "security_group_id",
  internetGatewayId: "internet_gateway_id",
  publicRouteTableId: "public_route_table_id",
  availabilityZone: "availability_zone",
} as const;

/** `private_route_table_id:a` — the route table private subnets of zone `a` associate with. */
export const privateRouteTableAttribute = (zone: string): string => `private_route_table_id:${zone}`;

/**
 * `target_group_arn:container_service/web` — the ELBv2 target group the load
 * balancer created for route target `container_service/web`. When one target is
 * routed on several ports the attribute of the LOWEST port is the plain one
 * and `target_group_arn:<target>:<port>` names each.
 */
export function targetGroupAttribute(targetAddress: string, port?: number): string {
  return port === undefined ? `target_group_arn:${targetAddress}` : `target_group_arn:${targetAddress}:${port}`;
}
