/**
 * A fake ELBv2 account for the fixture graph's load balancer, served through
 * `aws-sdk-client-mock` with real input semantics (ARN / marker / listener /
 * target-group arguments are honored). Hand-written response shapes, not
 * derived from the driver's compile. Contract-level only.
 */
import {
  DescribeListenersCommand,
  DescribeLoadBalancerAttributesCommand,
  DescribeLoadBalancersCommand,
  DescribeRulesCommand,
  DescribeTagsCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
  type Listener,
  type LoadBalancer,
  type Rule,
  type TargetGroup,
  type TargetHealthDescription,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import type { AwsClientStub } from "aws-sdk-client-mock";
import { FIXTURE_ENVIRONMENT_ID, FIXTURE_WORKSPACE_ID } from "./graph";

const ACCOUNT = "123456789012";
const arn = (kind: string, name: string, id: string) => `arn:aws:elasticloadbalancing:us-east-1:${ACCOUNT}:${kind}/${name}/${id}`;

export const LB_ARN = `arn:aws:elasticloadbalancing:us-east-1:${ACCOUNT}:loadbalancer/app/acme-prod-lb-public/50dc6c495c0c9188`;
export const TG_WEB = arn("targetgroup", "acme-prod-tg-web-50e7e9", "73e2d6bc24d8a067");
export const TG_API = arn("targetgroup", "acme-prod-tg-api-0a1b2c", "83e2d6bc24d8a068");
export const L80 = arn("listener/app/acme-prod-lb-public", "50dc6c495c0c9188", "f2f7dc8efc522ab2");
export const L443 = arn("listener/app/acme-prod-lb-public", "50dc6c495c0c9188", "a3a8ed9fd6633bc3");

export const lbTags = (): Record<string, string> => ({
  "zenith:workspace": FIXTURE_WORKSPACE_ID,
  "zenith:environment": FIXTURE_ENVIRONMENT_ID,
  "zenith:resource": "load_balancer/public",
  "zenith:managed": "true",
});

const forward = (tg: string) => [{ Type: "forward" as const, TargetGroupArn: tg }];
const hostPath = (host: string, path?: string) => [
  { Field: "host-header", HostHeaderConfig: { Values: [host] } },
  ...(path ? [{ Field: "path-pattern", PathPatternConfig: { Values: [path, `${path}/*`] } }] : []),
];

export class FakeAlb {
  lb: LoadBalancer = {
    LoadBalancerArn: LB_ARN,
    LoadBalancerName: "acme-prod-lb-public",
    DNSName: "acme-prod-lb-public-1234567890.us-east-1.elb.amazonaws.com",
    CanonicalHostedZoneId: "Z35SXDOTRQ7X7K",
    Scheme: "internet-facing",
    Type: "application",
    VpcId: "vpc-0abc1234def567890",
    State: { Code: "active" },
    SecurityGroups: ["sg-00000000000000001"],
    AvailabilityZones: [
      { ZoneName: "us-east-1a", SubnetId: "subnet-a" },
      { ZoneName: "us-east-1b", SubnetId: "subnet-b" },
    ],
  };
  present = true;
  tags: Record<string, Record<string, string>> = { [LB_ARN]: lbTags() };
  listeners: Listener[] = [
    { ListenerArn: L80, LoadBalancerArn: LB_ARN, Port: 80, Protocol: "HTTP", DefaultActions: [{ Type: "redirect", RedirectConfig: { Port: "443", Protocol: "HTTPS", StatusCode: "HTTP_301" } }] },
    { ListenerArn: L443, LoadBalancerArn: LB_ARN, Port: 443, Protocol: "HTTPS", SslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06", DefaultActions: [{ Type: "fixed-response" }] },
  ];
  groups: TargetGroup[] = [
    { TargetGroupArn: TG_WEB, TargetGroupName: "acme-prod-tg-web-50e7e9", Port: 3000, HealthCheckPath: "/healthz" },
    { TargetGroupArn: TG_API, TargetGroupName: "acme-prod-tg-api-0a1b2c", Port: 8080, HealthCheckPath: "/health" },
  ];
  rules: Record<string, Rule[]> = {
    [L443]: [
      { RuleArn: `${L443}/r1`, Priority: "39621", Conditions: hostPath("app.acme.io", "/api"), Actions: forward(TG_API), IsDefault: false },
      { RuleArn: `${L443}/r2`, Priority: "39622", Conditions: hostPath("app.acme.io"), Actions: forward(TG_WEB), IsDefault: false },
      { RuleArn: `${L443}/d`, Priority: "default", Conditions: [], Actions: [{ Type: "fixed-response" }], IsDefault: true },
    ],
    [L80]: [
      { RuleArn: `${L80}/r1`, Priority: "14491", Conditions: hostPath("plain.acme.io"), Actions: forward(TG_WEB), IsDefault: false },
      { RuleArn: `${L80}/d`, Priority: "default", Conditions: [], Actions: [{ Type: "redirect" }], IsDefault: true },
    ],
  };
  attributes: Record<string, string> = { "routing.http.drop_invalid_header_fields.enabled": "true", "deletion_protection.enabled": "true" };
  health: Record<string, TargetHealthDescription[]> = {
    [TG_WEB]: [
      { Target: { Id: "10.0.10.11", Port: 3000 }, TargetHealth: { State: "healthy" } },
      { Target: { Id: "10.0.11.12", Port: 3000 }, TargetHealth: { State: "healthy" } },
    ],
    [TG_API]: [
      { Target: { Id: "10.0.10.21", Port: 8080 }, TargetHealth: { State: "healthy" } },
      { Target: { Id: "10.0.11.22", Port: 8080 }, TargetHealth: { State: "healthy" } },
    ],
  };

  constructor() {
    this.tags[TG_WEB] = { ...lbTags(), "zenith:target": "container_service/web" };
    this.tags[TG_API] = { ...lbTags(), "zenith:target": "container_service/api" };
  }

  /** a second, unrelated load balancer in the account */
  static other(): LoadBalancer {
    return { LoadBalancerArn: arn("loadbalancer/app", "someone-elses", "1111111111111111"), LoadBalancerName: "someone-elses", Type: "application", Scheme: "internet-facing", State: { Code: "active" } };
  }

  install(m: AwsClientStub<ElasticLoadBalancingV2Client>): void {
    const notFound = (what: string) => Object.assign(new Error(`${what} not found`), { name: what === "load balancer" ? "LoadBalancerNotFound" : "TargetGroupNotFound", $metadata: { httpStatusCode: 400 } });
    m.on(DescribeLoadBalancersCommand).callsFake((input: { LoadBalancerArns?: string[] }) => {
      if (input.LoadBalancerArns) {
        if (!this.present || !input.LoadBalancerArns.includes(LB_ARN)) throw notFound("load balancer");
        return { LoadBalancers: [this.lb] };
      }
      return { LoadBalancers: this.present ? [FakeAlb.other(), this.lb] : [FakeAlb.other()] };
    });
    m.on(DescribeTagsCommand).callsFake((input: { ResourceArns?: string[] }) => ({
      TagDescriptions: (input.ResourceArns ?? []).map((ResourceArn) => ({ ResourceArn, Tags: Object.entries(this.tags[ResourceArn] ?? {}).map(([Key, Value]) => ({ Key, Value })) })),
    }));
    m.on(DescribeListenersCommand).callsFake(() => ({ Listeners: this.listeners }));
    m.on(DescribeTargetGroupsCommand).callsFake(() => ({ TargetGroups: this.groups }));
    m.on(DescribeRulesCommand).callsFake((input: { ListenerArn?: string }) => ({ Rules: this.rules[input.ListenerArn ?? ""] ?? [] }));
    m.on(DescribeLoadBalancerAttributesCommand).callsFake(() => ({ Attributes: Object.entries(this.attributes).map(([Key, Value]) => ({ Key, Value })) }));
    m.on(DescribeTargetHealthCommand).callsFake((input: { TargetGroupArn?: string }) => ({ TargetHealthDescriptions: this.health[input.TargetGroupArn ?? ""] ?? [] }));
  }
}
