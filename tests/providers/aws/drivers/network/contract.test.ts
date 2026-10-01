/**
 * Cross-cutting contracts of the network drivers: registry metadata and evidence
 * honesty, hostile graph text never becoming a tofu expression, the identifiers
 * and tags every observation carries (observability / drift v2), and the exact
 * attribute names the incident engine reads.
 */
import { ACMClient, DescribeCertificateCommand, ListCertificatesCommand, ListTagsForCertificateCommand } from "@aws-sdk/client-acm";
import { DescribeNatGatewaysCommand, DescribeSubnetsCommand, DescribeVpcsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { ListHostedZonesByNameCommand, ListResourceRecordSetsCommand, ListTagsForResourceCommand, Route53Client } from "@aws-sdk/client-route-53";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acmCertificateDriver,
  albDriver,
  networkDrivers,
  route53RecordDriver,
  route53ZoneDriver,
  securityGroupRuleDriver,
  subnetDriver,
  vpcDriver,
} from "@/lib/providers/aws/drivers/network";
import { resourceTags, tfLiteral } from "@/lib/providers/aws/drivers/shared";
import { NATIVE_TYPE_TABLE } from "@/lib/resources/native-types";
import type { Observation } from "@/lib/resources/types";
import { FakeAlb } from "../fixtures/alb";
import { compileCtx, driverCtx } from "../fixtures/env";
import { fixtureGraph, nodeOf } from "../fixtures/graph";
import { FakeAccount } from "../fixtures/security-groups";

const ec2 = mockClient(EC2Client);
const elb = mockClient(ElasticLoadBalancingV2Client);
const r53 = mockClient(Route53Client);
const acm = mockClient(ACMClient);
beforeEach(() => [ec2, elb, r53, acm].forEach((m) => m.reset()));
afterEach(() => [ec2, elb, r53, acm].forEach((m) => m.reset()));

describe("registry metadata", () => {
  it("one driver per native type of the table, ids `aws.<suffix>@1`, kinds consistent with the table", () => {
    expect(networkDrivers.map((d) => d.nativeType).sort()).toEqual(["aws:acm_certificate", "aws:alb", "aws:route53_record", "aws:route53_zone", "aws:security_group_rule", "aws:subnet", "aws:vpc"]);
    expect(new Set(networkDrivers.map((d) => d.id)).size).toBe(networkDrivers.length);
    for (const d of networkDrivers) {
      expect(d.provider).toBe("aws");
      expect(d.id).toBe(`aws.${d.nativeType.slice("aws:".length)}@1`);
      expect(NATIVE_TYPE_TABLE.aws[d.kind as keyof typeof NATIVE_TYPE_TABLE.aws]).toBe(d.nativeType);
    }
  });

  it("capabilities are honest: contract evidence only, every declared operation is implemented, nothing undeclared is", () => {
    for (const d of networkDrivers) {
      const c = d.capabilities;
      expect(Object.values(c.evidence).every((e) => e === "contract"), d.id).toBe(true);
      expect(!!d.compile).toBe(c.compile);
      expect(!!d.observe).toBe(c.observe);
      expect(!!d.runtime).toBe(c.runtime);
      expect(!!d.verify).toBe(c.verify);
      expect(!!d.discover).toBe(c.discover);
      expect(Object.keys(d.operations ?? {}).sort()).toEqual([...c.operations].sort());
      const claimed = ["compile", "observe", "runtime", "verify", "discover"].filter((k) => c[k as "compile"]).concat(c.operations);
      expect(Object.keys(c.evidence).sort()).toEqual(claimed.sort());
      if (c.observe) expect(d.expectedAttributes, d.id).toBeDefined();
    }
  });

  it("no network driver declares a mutating native operation (mutation is a tofu re-apply)", () => {
    expect(networkDrivers.flatMap((d) => d.capabilities.operations)).toEqual(["firewall.inspect"]);
  });
});

describe("graph text is data, never an expression", () => {
  it("tfLiteral escapes interpolations and directives", () => {
    expect(tfLiteral("a ${b} %{c}")).toBe("a $${b} %%{c}");
    expect(tfLiteral("plain: /path-1")).toBe("plain: /path-1");
  });

  it("tags escape hostile values: a node address or tag value cannot start an interpolation", () => {
    const t = resourceTags({ "zenith:note": "${timestamp()}" }, "service/${file(\"/etc/passwd\")}", "x%{if true}");
    expect(JSON.stringify(t)).not.toMatch(/(^|[^$])\$\{/);
    expect(t["zenith:resource"]).toBe('service/$${file("/etc/passwd")}');
  });

  it("a firewall description or security-group description from the manifest compiles without any ${…}", () => {
    const g = fixtureGraph();
    const fw = nodeOf(g, "firewall/web-to-db");
    fw.spec = { ...fw.spec, description: "web ${timestamp()} %{ for x in y } db" };
    const f = securityGroupRuleDriver.compile!(fw, compileCtx(g));
    const text = JSON.stringify(f.resource);
    expect(text).not.toMatch(/\$\{(?!local\.)/); // the words survive as inert text; the interpolation does not
    expect(text).not.toContain("%{");
  });

  it("a compile error never carries unbounded manifest text", () => {
    const g = fixtureGraph();
    const n = nodeOf(g, "network/main");
    n.spec = { ...n.spec, cidr: "x".repeat(100_000) };
    try {
      vpcDriver.compile!(n, compileCtx(g));
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message.length).toBeLessThanOrEqual(400);
    }
  });
});

const tagList = (address: string) => [
  { Key: "zenith:workspace", Value: "ws_acme" },
  { Key: "zenith:environment", Value: "env_prod" },
  { Key: "zenith:resource", Value: address },
  { Key: "zenith:managed", Value: "true" },
];

describe("every observation carries the provider identifier and the provider tags", () => {
  const present = (o: Observation) => {
    expect(o.presence).toBe("present");
    expect(typeof o.externalId).toBe("string");
    expect(o.externalId).not.toBe("");
    expect(o.simulated).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(o.native ?? {}))).toBeLessThanOrEqual(4096);
  };
  const tagsOf = (o: Observation) => o.native!.tags as Record<string, string>;

  it("vpc: VPC id + tags", async () => {
    ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: "vpc-0abc1234def567890", CidrBlock: "10.0.0.0/16", Tags: tagList("network/main") }] });
    ec2.on(DescribeNatGatewaysCommand).resolves({ NatGateways: [] });
    const o = await vpcDriver.observe!(driverCtx(), nodeOf(fixtureGraph(), "network/main"));
    present(o);
    expect(o.externalId).toBe("vpc-0abc1234def567890");
    expect(tagsOf(o)["zenith:managed"]).toBe("true");
  });

  it("subnet: subnet id + tags", async () => {
    ec2.on(DescribeSubnetsCommand).resolves({ Subnets: [{ SubnetId: "subnet-0abc1234def567890", CidrBlock: "10.0.0.0/24", Tags: tagList("subnet/public-a") }] });
    const o = await subnetDriver.observe!(driverCtx(), nodeOf(fixtureGraph(), "subnet/public-a"));
    present(o);
    expect(o.externalId).toBe("subnet-0abc1234def567890");
    expect(tagsOf(o)["zenith:resource"]).toBe("subnet/public-a");
  });

  it("firewall: the target's security-group id + the group's tags", async () => {
    new FakeAccount().install(ec2);
    const o = await securityGroupRuleDriver.observe!(driverCtx(), nodeOf(fixtureGraph(), "firewall/lb-to-web"));
    present(o);
    expect(o.externalId).toMatch(/^sg-/);
    expect(tagsOf(o)["zenith:environment"]).toBe("env_prod");
  });

  it("load balancer: ARN, target-group ARNs, route → target-group map, tags", async () => {
    new FakeAlb().install(elb);
    const o = await albDriver.observe!(driverCtx(), nodeOf(fixtureGraph(), "load_balancer/public"));
    present(o);
    expect(o.externalId).toMatch(/^arn:aws:elasticloadbalancing:.*:loadbalancer\/app\//);
    expect(o.native!.targetGroupArns).toHaveLength(2);
    expect(Object.keys(o.native!.targetGroupsByRoute as object).sort()).toEqual(["app.acme.io/", "app.acme.io/api", "plain.acme.io/"]);
    expect(tagsOf(o)["zenith:managed"]).toBe("true");
  });

  it("zone: the bare hosted-zone id, plus its tags when they could be read (and none claimed when they could not)", async () => {
    r53.on(ListHostedZonesByNameCommand).resolves({ HostedZones: [{ CallerReference: "t", Id: "/hostedzone/Z0123456789ABC", Name: "acme.io.", Config: { PrivateZone: false } }] });
    r53.on(ListTagsForResourceCommand).resolves({ ResourceTagSet: { Tags: [{ Key: "team", Value: "web" }] } });
    const node = nodeOf(fixtureGraph(), "dns_zone/acme.io");
    const o = await route53ZoneDriver.observe!(driverCtx(), node);
    present(o);
    expect(o.externalId).toBe("Z0123456789ABC");
    expect(tagsOf(o)).toEqual({ team: "web" });
    expect(r53.commandCalls(ListTagsForResourceCommand)[0].args[0].input).toEqual({ ResourceType: "hostedzone", ResourceId: "Z0123456789ABC" });
    r53.on(ListTagsForResourceCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDenied" }));
    const denied = await route53ZoneDriver.observe!(driverCtx(), node);
    expect(denied.presence).toBe("present");
    expect(denied.native).not.toHaveProperty("tags");
  });

  it("record: the tofu import id; Route 53 records are untaggable so tags is {}", async () => {
    new FakeAlb().install(elb);
    r53.on(ListHostedZonesByNameCommand).resolves({ HostedZones: [{ CallerReference: "t", Id: "/hostedzone/Z0123456789ABC", Name: "acme.io.", Config: { PrivateZone: false } }] });
    r53.on(ListResourceRecordSetsCommand).resolves({ ResourceRecordSets: [{ Name: "app.acme.io.", Type: "A", AliasTarget: { DNSName: "x.elb.amazonaws.com.", HostedZoneId: "Z", EvaluateTargetHealth: true } }] });
    const o = await route53RecordDriver.observe!(driverCtx(), nodeOf(fixtureGraph(), "dns_record/app.acme.io"));
    present(o);
    expect(o.externalId).toBe("Z0123456789ABC_app.acme.io_A");
    expect(tagsOf(o)).toEqual({});
  });

  it("certificate: the ACM ARN + tags", async () => {
    const arn = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555";
    acm.on(ListCertificatesCommand).resolves({ CertificateSummaryList: [{ CertificateArn: arn, DomainName: "app.acme.io" }] });
    acm.on(ListTagsForCertificateCommand).resolves({ Tags: tagList("tls_certificate/app.acme.io") });
    acm.on(DescribeCertificateCommand).resolves({ Certificate: { CertificateArn: arn, DomainName: "app.acme.io", Status: "ISSUED", NotAfter: new Date("2027-01-01T00:00:00Z") } });
    const o = await acmCertificateDriver.observe!(driverCtx(), nodeOf(fixtureGraph(), "tls_certificate/app.acme.io"));
    present(o);
    expect(o.externalId).toBe(arn);
    expect(tagsOf(o)["zenith:resource"]).toBe("tls_certificate/app.acme.io");
  });

  it("secret-looking tag KEYS are redacted in native, and nothing credential-shaped survives an error summary", async () => {
    const canary = "CANARY-hunter2-abcdefghijklmnopqrstuvwxyz0123456789";
    ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: "vpc-0abc1234def567890", CidrBlock: "10.0.0.0/16", Tags: [...tagList("network/main"), { Key: "db_password", Value: canary }, { Key: "apiToken", Value: canary }] }] });
    ec2.on(DescribeNatGatewaysCommand).resolves({ NatGateways: [] });
    const o = await vpcDriver.observe!(driverCtx(), nodeOf(fixtureGraph(), "network/main"));
    expect(JSON.stringify(o)).not.toContain(canary);
    ec2.on(DescribeVpcsCommand).rejects(Object.assign(new Error(`bad request AKIAABCDEFGHIJKLMNOP ${canary}`), { name: "InternalFailure" }));
    const failed = await vpcDriver.observe!(driverCtx(), nodeOf(fixtureGraph(), "network/main"));
    expect(JSON.stringify(failed)).not.toContain(canary);
    expect(JSON.stringify(failed)).not.toContain("AKIAABCDEFGHIJKLMNOP");
  });
});

describe("the attribute names the incident engine reads", () => {
  const known = (o: Observation, name: string) => (o.attributes[name]?.state === "known" ? (o.attributes[name] as { value: unknown }).value : undefined);

  it("certificate: status (ISSUED | PENDING_VALIDATION | …) and notAfter (ISO)", async () => {
    const arn = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555";
    acm.on(ListCertificatesCommand).resolves({ CertificateSummaryList: [{ CertificateArn: arn, DomainName: "app.acme.io" }] });
    acm.on(ListTagsForCertificateCommand).resolves({ Tags: tagList("tls_certificate/app.acme.io") });
    acm.on(DescribeCertificateCommand).resolves({ Certificate: { CertificateArn: arn, DomainName: "app.acme.io", Status: "PENDING_VALIDATION", NotAfter: new Date("2027-01-01T00:00:00Z") } });
    const o = await acmCertificateDriver.observe!(driverCtx(), nodeOf(fixtureGraph(), "tls_certificate/app.acme.io"));
    expect(known(o, "status")).toBe("PENDING_VALIDATION");
    expect(known(o, "notAfter")).toBe("2027-01-01T00:00:00.000Z");
    expect(Date.parse(known(o, "notAfter") as string)).not.toBeNaN();
  });

  it("load balancer: listeners as [{ port, protocol }] and state; runtime counts targets_healthy / targets_unhealthy", async () => {
    new FakeAlb().install(elb);
    const node = nodeOf(fixtureGraph(), "load_balancer/public");
    const o = await albDriver.observe!(driverCtx(), node);
    expect(known(o, "listeners")).toEqual([{ port: 80, protocol: "HTTP", redirect: true }, { port: 443, protocol: "HTTPS" }]);
    expect(known(o, "state")).toBe("active");
    const rt = await albDriver.runtime!(driverCtx(), node);
    expect(rt.counts).toMatchObject({ targets_healthy: 4, targets_unhealthy: 0 });
  });

  it("record: target is where the alias points", async () => {
    new FakeAlb().install(elb);
    r53.on(ListHostedZonesByNameCommand).resolves({ HostedZones: [{ CallerReference: "t", Id: "/hostedzone/Z0123456789ABC", Name: "acme.io.", Config: { PrivateZone: false } }] });
    r53.on(ListResourceRecordSetsCommand).resolves({ ResourceRecordSets: [{ Name: "app.acme.io.", Type: "A", AliasTarget: { DNSName: "elsewhere.example.net.", HostedZoneId: "Z", EvaluateTargetHealth: true } }] });
    const node = nodeOf(fixtureGraph(), "dns_record/app.acme.io");
    const o = await route53RecordDriver.observe!(driverCtx(), node);
    expect(known(o, "target")).toBe("elsewhere.example.net");
    expect(route53RecordDriver.expectedAttributes!(node).target).toBe("load_balancer/public");
  });

  it("firewall: one node = one ingress rule; present when found, missing when that exact rule is absent; port, protocol, source", async () => {
    const account = new FakeAccount();
    account.install(ec2);
    const node = nodeOf(fixtureGraph(), "firewall/web-to-db");
    const found = await securityGroupRuleDriver.observe!(driverCtx(), node);
    expect(found.presence).toBe("present");
    expect([known(found, "port"), known(found, "protocol"), known(found, "source")]).toEqual([5432, "tcp", "container_service/web"]);
    expect(securityGroupRuleDriver.expectedAttributes!(node)).toMatchObject({ port: 5432, protocol: "tcp", source: "container_service/web" });
    account.remove(account.ruleId("sg-00000000000000004", "ingress", 5432, "sg-00000000000000002"));
    const gone = await securityGroupRuleDriver.observe!(driverCtx(), node);
    expect(gone.presence).toBe("missing");
  });
});
