/**
 * `aws:alb` compile: one internet-facing Application Load Balancer, its
 * listeners, target groups and listener rules.
 *
 *   aws_lb                     internet-facing, in the PUBLIC subnets the node
 *                              depends on (an ALB needs ≥ 2 subnets in ≥ 2
 *                              zones, so a graph with one zone is refused here
 *                              rather than at apply), `drop_invalid_header_fields`,
 *                              HTTP/2, IPv4; deletion protection ON when
 *                              `ctx.tags["zenith:env-class"] === "production"`
 *                              (the orchestrator sets that tag; absent = off)
 *   aws_security_group         the node's own group (shared/security-group.ts), no
 *                              baseline egress: the firewall rules add 80/443
 *                              ingress from the internet and egress to each target
 *   aws_lb_listener            :80 redirects to HTTPS (301) when `redirectToHttps`;
 *                              :443 uses `ELBSecurityPolicy-TLS13-1-2-2021-06`
 *                              and the certificate of the first TLS host, the
 *                              others attached with `aws_lb_listener_certificate`
 *                              (SNI); the default action of every listener is a
 *                              fixed 404 — traffic only reaches a target through
 *                              an explicit route
 *   aws_lb_target_group        one per (route target, port): `target_type = ip`
 *                              (Fargate/awsvpc), health check on `route.healthPath`
 *                              (default `/`), name ≤ 32 chars (alb-routes.ts), replaced
 *                              create-before-destroy under a new name
 *   aws_lb_listener_rule       host + path-prefix → forward, stable priorities
 *
 * Certificates come from the `tls_certificate` nodes in `dependsOn` through
 * `ctx.ref(<cert>, "arn")`: for DNS-automatic certificates that is the
 * VALIDATED ARN, so the listener is only created once the certificate is
 * issued. A `dns_manual` certificate is referenced by its pending ARN and the
 * HTTPS listener cannot be created until the user adds the DNS record — apply
 * fails at the listener until then (see acm-certificate.ts).
 *
 * NOT done, deliberately: access logs. They need a bucket policy granting the
 * regional Elastic Load Balancing principal `s3:PutObject`, which belongs to the
 * bucket's driver; enabling them is one block:
 * `access_logs { bucket = <bucket>, prefix = "alb", enabled = true }`.
 * The load balancer is IPv4-only (no `dualstack`), so DNS gets an A alias only.
 *
 * Published: `arn`, `dns_name`, `zone_id`, `arn_suffix`, `id`, `security_group_id`,
 * `target_group_arn:<target>` (+ `target_group_arn:<target>:<port>`), see refs.ts.
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { TlsCertificateSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import {
  DriverCompileError,
  FragmentBuilder,
  REF,
  addSecurityGroup,
  hash6,
  isProductionEnvironment,
  networkAddressOf,
  refExpr,
  resourceTags,
  securityGroupExpr,
  subnetsOf,
  targetGroupAttribute,
  tfLabel,
} from "../shared";
import { TLS_POLICY, assignPriorities, loadBalancerName, readLoadBalancerModel, ruleLabelHash, type ListenerModel, type RouteModel, type TargetGroupModel } from "./alb-routes";
import { zoneIndex } from "./zones";

const ACM_ARN = /^arn:aws(-cn|-us-gov)?:acm:[a-z0-9-]+:\d{12}:certificate\/[0-9a-f-]{36}$/;

interface CertRef {
  domain: string;
  arn: string;
  address: string;
}

function collectCertificates(node: ResourceNode, ctx: CompileContext, tlsHosts: string[]): Map<string, CertRef> {
  const byDomain = new Map<string, CertRef>();
  for (const dep of [...new Set(node.dependsOn)].sort()) {
    const n = ctx.node(dep);
    if (n?.kind !== "tls_certificate") continue;
    const domain = (n.spec as Partial<TlsCertificateSpec>).domain;
    if (typeof domain !== "string" || domain === "") continue;
    if (n.ownership !== "managed") {
      if (typeof n.externalRef !== "string" || !ACM_ARN.test(n.externalRef)) {
        throw new DriverCompileError("invalid_spec", node.address, `certificate ${n.address} is ${n.ownership} but its externalRef is not an ACM certificate ARN.`);
      }
      byDomain.set(domain.toLowerCase(), { domain, arn: n.externalRef, address: n.address });
      continue;
    }
    byDomain.set(domain.toLowerCase(), { domain, arn: refExpr(ctx.ref(n.address, REF.arn)), address: n.address });
  }
  for (const host of tlsHosts) {
    if (!byDomain.has(host)) throw new DriverCompileError("missing_node", node.address, `route host ${host} has tls on but the load balancer depends on no tls_certificate for it.`);
  }
  return byDomain;
}

export function compileLoadBalancer(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (node.ownership !== "managed") throw new DriverCompileError("policy_refused", node.address, `Zenith does not create a load balancer for a ${node.ownership} node.`);
  const model = readLoadBalancerModel(node, ctx.namePrefix);

  for (const g of model.targetGroups) {
    const t = ctx.node(g.target);
    if (!t) throw new DriverCompileError("missing_node", node.address, `route target ${g.target} is not in the graph.`);
    if (t.kind !== "container_service" || t.provider !== "aws" || t.ownership !== "managed") {
      throw new DriverCompileError("unsupported", node.address, `route target ${g.target} is a ${t.ownership} ${t.provider} ${t.kind}; only managed AWS container services can be load-balancer targets.`);
    }
  }
  const publicSubnets = subnetsOf(node, ctx, "public");
  const zones = new Set(publicSubnets.map((s) => (s.spec as { zone?: string }).zone).filter((z): z is string => zoneIndex(z) !== undefined));
  if (publicSubnets.length < 2 || zones.size < 2) {
    throw new DriverCompileError(
      "invalid_spec",
      node.address,
      `an Application Load Balancer needs public subnets in at least 2 zones; this graph gives it ${publicSubnets.length} subnet(s) in ${zones.size} zone(s). Raise the network's zone count to 2 or more.`
    );
  }
  const network = networkAddressOf(node, ctx);
  const tlsHosts = [...new Set(model.routes.filter((r) => r.tls).map((r) => r.host))].sort();
  const certs = collectCertificates(node, ctx, tlsHosts);
  const servedCerts = [...new Map(tlsHosts.map((h) => [certs.get(h)!.address, certs.get(h)!])).values()].sort((a, b) => (a.address < b.address ? -1 : 1));
  if (model.listeners.some((l) => l.protocol === "HTTPS") && servedCerts.length === 0) {
    throw new DriverCompileError("invalid_spec", node.address, "an https listener needs at least one route with tls on and its certificate.");
  }

  const L = tfLabel(node.address);
  const name = loadBalancerName(ctx.namePrefix, node.address);
  const tags = resourceTags(ctx.tags, node.address, name);
  const b = new FragmentBuilder(node.address);

  b.resource("aws_lb", L, {
    name,
    load_balancer_type: "application",
    internal: false,
    ip_address_type: "ipv4",
    security_groups: [securityGroupExpr(ctx, node.address)],
    subnets: publicSubnets.map((s) => refExpr(ctx.ref(s.address, REF.id))),
    drop_invalid_header_fields: true,
    enable_http2: true,
    enable_cross_zone_load_balancing: true,
    desync_mitigation_mode: "defensive",
    idle_timeout: 60,
    enable_deletion_protection: isProductionEnvironment(ctx.tags),
    tags,
  });
  addSecurityGroup(b, node, ctx);
  b.expose(REF.id, `aws_lb.${L}.id`);
  b.expose(REF.arn, `aws_lb.${L}.arn`);
  b.expose(REF.dnsName, `aws_lb.${L}.dns_name`);
  b.expose(REF.zoneId, `aws_lb.${L}.zone_id`);
  b.expose(REF.arnSuffix, `aws_lb.${L}.arn_suffix`);
  const lbArn = `\${aws_lb.${L}.arn}`;

  // --- target groups ---
  const vpcId = refExpr(ctx.ref(network, REF.id));
  const tgLabel = new Map<string, string>();
  const portsByTarget = new Map<string, number[]>();
  for (const g of model.targetGroups) portsByTarget.set(g.target, [...(portsByTarget.get(g.target) ?? []), g.port].sort((x, y) => x - y));
  for (const g of model.targetGroups) {
    const label = `${L}_tg_${tfLabel(g.target)}_${g.port}`;
    tgLabel.set(g.key, label);
    emitTargetGroup(b, label, g, vpcId, tags);
    b.expose(targetGroupAttribute(g.target, g.port), `aws_lb_target_group.${label}.arn`);
    if (portsByTarget.get(g.target)![0] === g.port) b.expose(targetGroupAttribute(g.target), `aws_lb_target_group.${label}.arn`);
  }

  // --- listeners, certificates, rules ---
  const priorities = assignPriorities(model.routes);
  const defaultCert = servedCerts[0];
  for (const l of model.listeners) {
    const lname = `${L}_${l.port}`;
    emitListener(b, lname, l, lbArn, defaultCert, tags);
    if (l.protocol === "HTTPS") {
      for (const c of servedCerts.slice(1)) {
        b.resource("aws_lb_listener_certificate", `${lname}_cert_${hash6(c.address)}`, { listener_arn: `\${aws_lb_listener.${lname}.arn}`, certificate_arn: c.arn });
      }
    }
    for (const r of l.routes) emitRule(b, lname, r, priorities, tgLabel.get(`${r.target}:${r.port}`)!, tags);
  }
  return b.build();
}

function emitTargetGroup(b: FragmentBuilder, label: string, g: TargetGroupModel, vpcId: string, lbTags: Record<string, string>): void {
  b.resource("aws_lb_target_group", label, {
    name: g.name,
    port: g.port,
    protocol: "HTTP",
    protocol_version: "HTTP1",
    target_type: "ip",
    vpc_id: vpcId,
    deregistration_delay: "30",
    health_check: [
      {
        enabled: true,
        path: g.healthPath,
        port: "traffic-port",
        protocol: "HTTP",
        matcher: "200-399",
        interval: 15,
        timeout: 5,
        healthy_threshold: 2,
        unhealthy_threshold: 3,
      },
    ],
    tags: { ...lbTags, Name: g.name, "zenith:target": g.target },
    lifecycle: { create_before_destroy: true },
  });
}

const FIXED_404 = [{ type: "fixed-response", fixed_response: [{ content_type: "text/plain", message_body: "Not Found", status_code: "404" }] }];

function emitListener(b: FragmentBuilder, label: string, l: ListenerModel, lbArn: string, cert: CertRef | undefined, tags: Record<string, string>): void {
  const base = { load_balancer_arn: lbArn, port: l.port, protocol: l.protocol, tags };
  if (l.protocol === "HTTPS") {
    b.resource("aws_lb_listener", label, { ...base, ssl_policy: TLS_POLICY, certificate_arn: (cert as CertRef).arn, default_action: FIXED_404 });
    return;
  }
  const action =
    l.redirectToPort !== undefined
      ? [{ type: "redirect", redirect: [{ port: String(l.redirectToPort), protocol: "HTTPS", status_code: "HTTP_301" }] }]
      : FIXED_404;
  b.resource("aws_lb_listener", label, { ...base, default_action: action });
}

function emitRule(b: FragmentBuilder, listener: string, r: RouteModel, priorities: Map<string, number>, tg: string, tags: Record<string, string>): void {
  const condition: Record<string, unknown>[] = [{ host_header: [{ values: [r.host] }] }];
  if (r.pathPrefix !== "/") condition.push({ path_pattern: [{ values: [r.pathPrefix, `${r.pathPrefix}/*`] }] });
  b.resource("aws_lb_listener_rule", `${listener}_r_${ruleLabelHash(r.host, r.pathPrefix)}`, {
    listener_arn: `\${aws_lb_listener.${listener}.arn}`,
    priority: priorities.get(`${r.host}${r.pathPrefix}`),
    condition,
    action: [{ type: "forward", target_group_arn: `\${aws_lb_target_group.${tg}.arn}` }],
    tags,
  });
}
