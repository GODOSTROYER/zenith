/**
 * aws:security_group_rule (kind firewall): compile (rules, egress companions,
 * refusals — above all public CIDRs), the normalized rule vocabulary, observe /
 * verify / firewall.inspect, and the security-group-break scenario: delete ONE
 * rule in the (fake) account and exactly that node reports it missing.
 */
import { DescribeSecurityGroupRulesCommand, DescribeSecurityGroupsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffRuleSets, normalizeRule, ruleKey, securityGroupRuleDriver as driver } from "@/lib/providers/aws/drivers/network";
import { DriverCompileError } from "@/lib/providers/aws/drivers/shared";
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";
import { compileCtx, driverCtx } from "../fixtures/env";
import { LB, fixtureGraph, makeNode, nodeOf } from "../fixtures/graph";
import { FakeAccount, SG } from "../fixtures/security-groups";

const ec2 = mockClient(EC2Client);
beforeEach(() => ec2.reset());
afterEach(() => ec2.reset());

const firewalls = (g: ResourceGraph) => g.nodes.filter((n) => n.kind === "firewall");

function withRule(spec: Record<string, unknown>, over: Partial<ResourceNode> = {}): { graph: ResourceGraph; node: ResourceNode } {
  const graph = fixtureGraph();
  const base = nodeOf(graph, "firewall/web-to-db");
  const node = { ...base, spec: { ...base.spec, ...spec }, ...over };
  return { graph, node };
}
const compile = (spec: Record<string, unknown> = {}, over: Partial<ResourceNode> = {}) => {
  const { graph, node } = withRule(spec, over);
  return driver.compile!(node, compileCtx(graph));
};

describe("aws:security_group_rule compile", () => {
  it.each(["kubernetes_cluster", "provider_native"] as const)("allows an EKS %s owner through the same SG reference contract", (kind) => {
    const { graph, node } = withRule({});
    const target = graph.nodes.find((n) => n.address === (node.spec.target as string))!;
    target.kind = kind; target.nativeType = "aws:eks_cluster";
    expect(driver.compile!(node, compileCtx(graph)).addresses).toHaveLength(2);
    target.kind = "provider_native"; target.nativeType = "aws:sns_topic";
    expect(() => driver.compile!(node, compileCtx(graph))).toThrow(DriverCompileError);
  });
  it("node source: ingress on the target's group from the source's group, plus the source's egress to the target", () => {
    const f = compile();
    expect(f.addresses).toEqual(["aws_vpc_security_group_ingress_rule.firewall_web_to_db", "aws_vpc_security_group_egress_rule.firewall_web_to_db_egress"]);
    expect(f.resource!.aws_vpc_security_group_ingress_rule.firewall_web_to_db).toMatchObject({
      security_group_id: "${local.ref_postgres_db__security_group_id}",
      referenced_security_group_id: "${local.ref_container_service_web__security_group_id}",
      ip_protocol: "tcp",
      from_port: 5432,
      to_port: 5432,
    });
    expect(f.resource!.aws_vpc_security_group_egress_rule.firewall_web_to_db_egress).toMatchObject({
      security_group_id: "${local.ref_container_service_web__security_group_id}",
      referenced_security_group_id: "${local.ref_postgres_db__security_group_id}",
      from_port: 5432,
      to_port: 5432,
    });
  });

  it("uses no inline rules and no other provider resources: only standalone rule resources", () => {
    const f = compile();
    expect(Object.keys(f.resource!).sort()).toEqual(["aws_vpc_security_group_egress_rule", "aws_vpc_security_group_ingress_rule"]);
    expect(f.data).toBeUndefined();
  });

  it("the public web rule: a CIDR source on the load balancer's tcp/80 and tcp/443, with no egress companion", () => {
    const graph = fixtureGraph();
    for (const id of ["firewall/internet-to-lb-80", "firewall/internet-to-lb-443"]) {
      const f = driver.compile!(nodeOf(graph, id), compileCtx(graph));
      expect(Object.keys(f.resource!)).toEqual(["aws_vpc_security_group_ingress_rule"]);
      const rule = Object.values(f.resource!.aws_vpc_security_group_ingress_rule)[0];
      expect(rule).toMatchObject({ cidr_ipv4: "0.0.0.0/0", security_group_id: "${local.ref_load_balancer_public__security_group_id}" });
      expect(rule).not.toHaveProperty("referenced_security_group_id");
    }
  });

  it("the load balancer's egress to a target is emitted by the LB → target rule", () => {
    const graph = fixtureGraph();
    const f = driver.compile!(nodeOf(graph, "firewall/lb-to-web"), compileCtx(graph));
    expect(f.resource!.aws_vpc_security_group_egress_rule.firewall_lb_to_web_egress).toMatchObject({
      security_group_id: "${local.ref_load_balancer_public__security_group_id}",
      referenced_security_group_id: "${local.ref_container_service_web__security_group_id}",
      from_port: 3000,
    });
  });

  it("allows a PRIVATE CIDR source (e.g. a peered network) for any capability", () => {
    const f = compile({ source: { cidr: "10.20.0.0/16" }, capability: "sql" });
    expect(Object.values(f.resource!.aws_vpc_security_group_ingress_rule)[0]).toMatchObject({ cidr_ipv4: "10.20.0.0/16" });
  });

  describe("public CIDR refusal: anything but public_http → load balancer → tcp/80|443 is a compile error", () => {
    const refuse = (spec: Record<string, unknown>, pattern: RegExp) => {
      expect(() => compile(spec), JSON.stringify(spec)).toThrow(DriverCompileError);
      expect(() => compile(spec), JSON.stringify(spec)).toThrow(pattern);
    };
    it("a database open to the whole internet", () => {
      refuse({ source: { cidr: "0.0.0.0/0" }, capability: "sql" }, /public range/);
      refuse({ source: { cidr: "0.0.0.0/0" }, capability: "public_http" }, /public range/);
    });
    it("a service open to a public range", () => {
      refuse({ source: { cidr: "203.0.113.0/24" }, target: "container_service/web", port: 3000, capability: "http" }, /public range/);
    });
    it("the load balancer on any other port, or with another capability", () => {
      refuse({ source: { cidr: "0.0.0.0/0" }, target: LB, port: 8080, capability: "public_http" }, /public/);
      refuse({ source: { cidr: "0.0.0.0/0" }, target: LB, port: 22, capability: "public_http" }, /public/);
      refuse({ source: { cidr: "0.0.0.0/0" }, target: LB, port: 443, capability: "http" }, /public range/);
    });
    it("a range that only LOOKS private (partly outside RFC 1918)", () => {
      refuse({ source: { cidr: "10.0.0.0/7" }, capability: "sql" }, /public range/);
      refuse({ source: { cidr: "172.0.0.0/8" }, capability: "sql" }, /public range/);
      refuse({ source: { cidr: "192.169.0.0/16" }, capability: "sql" }, /public range/);
    });
    it("public_http with a node source, and IPv6 / malformed CIDRs", () => {
      refuse({ source: { address: "container_service/web" }, target: LB, port: 443, capability: "public_http" }, /needs a CIDR source/);
      refuse({ source: { cidr: "::/0" }, target: LB, port: 443, capability: "public_http" }, /canonical IPv4 CIDR/);
      refuse({ source: { cidr: "0.0.0.0/0; drop table" }, target: LB, port: 443, capability: "public_http" }, /canonical IPv4 CIDR/);
      refuse({ source: { cidr: "10.0.0.1/8" }, capability: "sql" }, /canonical IPv4 CIDR/);
    });
  });

  it("refuses other directions, protocols, ports, cross-boundary rules and malformed sources", () => {
    for (const bad of [{ direction: "egress" }, { protocol: "udp" }, { port: 0 }, { port: 70000 }, { port: 22.5 }, { crossBoundary: "cross_cloud" }, { target: "" }, { source: {} }, { source: null }]) {
      expect(() => compile(bad as Record<string, unknown>), JSON.stringify(bad)).toThrow(DriverCompileError);
    }
  });

  it("refuses endpoints Zenith cannot put a rule on: unknown, unmanaged, other provider/region, kinds without a group", () => {
    const graph = fixtureGraph();
    const compileWith = (spec: Record<string, unknown>) => driver.compile!({ ...nodeOf(graph, "firewall/web-to-db"), spec: { ...nodeOf(graph, "firewall/web-to-db").spec, ...spec } }, compileCtx(graph));
    expect(() => compileWith({ target: "postgres/ghost" })).toThrow(/not in the graph/);
    expect(() => compileWith({ source: { address: "container_service/ghost" } })).toThrow(/not in the graph/);
    expect(() => compileWith({ target: "dns_zone/acme.io" })).toThrow(/ownership|no security group|referenced/);
    expect(() => compileWith({ target: "subnet/public-a" })).toThrow(/no security group/);
    graph.nodes.push(makeNode("container_service/foreign", "container_service", {}, [], { provider: "gcp" }), makeNode("postgres/old", "postgres", {}, [], { ownership: "referenced" }), makeNode("container_service/eu", "container_service", {}, [], { region: "eu-west-1" }));
    expect(() => compileWith({ source: { address: "container_service/foreign" } })).toThrow(/gcp/);
    expect(() => compileWith({ target: "postgres/old" })).toThrow(/referenced/);
    expect(() => compileWith({ source: { address: "container_service/eu" } })).toThrow(/eu-west-1/);
  });

  it("refuses to compile for a node Zenith does not manage", () => {
    expect(() => compile({}, { ownership: "external" })).toThrow(/does not add firewall rules/);
  });

  it("sanitizes the description (no surprises from free text) and bounds it", () => {
    const f = compile({ description: "web → db \"quoted\" <script>alert(1)</script>\nsecond line" });
    const d = Object.values(f.resource!.aws_vpc_security_group_ingress_rule)[0].description as string;
    expect(d).not.toMatch(/[<>"\n→]/);
    expect(compile({ description: "x".repeat(1000) }).resource!.aws_vpc_security_group_ingress_rule.firewall_web_to_db.description).toHaveLength(255);
    expect(compile({ description: "" }).resource!.aws_vpc_security_group_ingress_rule.firewall_web_to_db.description).toBe("Zenith rule firewall/web-to-db");
  });

  it("is deterministic and tags the rules", () => {
    expect(JSON.stringify(compile())).toBe(JSON.stringify(compile()));
    const tags = compile().resource!.aws_vpc_security_group_ingress_rule.firewall_web_to_db.tags as Record<string, string>;
    expect(tags["zenith:resource"]).toBe("firewall/web-to-db");
  });
});

describe("normalized rules", () => {
  it("renders a stable one-line key and ignores descriptions", () => {
    const owner = new Map([[SG.lb, LB]]);
    const r = normalizeRule({ IsEgress: false, IpProtocol: "tcp", FromPort: 3000, ToPort: 3000, ReferencedGroupInfo: { GroupId: SG.lb }, Description: "anything" }, owner);
    expect(ruleKey(r)).toBe("ingress tcp/3000 sg:load_balancer/public");
    expect(ruleKey(normalizeRule({ IsEgress: true, IpProtocol: "tcp", FromPort: 80, ToPort: 90, CidrIpv4: "10.0.0.0/8" }, owner))).toBe("egress tcp/80-90 cidr:10.0.0.0/8");
    expect(ruleKey(normalizeRule({ IsEgress: true, IpProtocol: "-1", FromPort: -1, ToPort: -1, CidrIpv4: "0.0.0.0/0" }, owner))).toBe("egress all cidr:0.0.0.0/0");
    expect(ruleKey(normalizeRule({ IsEgress: false, IpProtocol: "icmp", FromPort: -1, ToPort: -1, CidrIpv6: "::/0" }, owner))).toBe("ingress icmp cidr6:::/0");
    expect(ruleKey(normalizeRule({ IsEgress: false, IpProtocol: "tcp", FromPort: 1, ToPort: 1, PrefixListId: "pl-123" }, owner))).toBe("ingress tcp/1 pl:pl-123");
    expect(ruleKey(normalizeRule({ IsEgress: false, IpProtocol: "tcp", FromPort: 1, ToPort: 1, ReferencedGroupInfo: { GroupId: "sg-foreign" } }, owner))).toBe("ingress tcp/1 sg:sg-foreign");
  });

  it("diffRuleSets separates present, missing and unexpected", () => {
    const observed = [
      { direction: "ingress" as const, protocol: "tcp", fromPort: 5432, toPort: 5432, peer: "sg:container_service/web" },
      { direction: "ingress" as const, protocol: "tcp", fromPort: 22, toPort: 22, peer: "cidr:0.0.0.0/0" },
    ];
    expect(diffRuleSets(["ingress tcp/5432 sg:container_service/web", "ingress tcp/5432 sg:container_service/api"], observed)).toEqual({
      present: ["ingress tcp/5432 sg:container_service/web"],
      missing: ["ingress tcp/5432 sg:container_service/api"],
      unexpected: ["ingress tcp/22 cidr:0.0.0.0/0"],
    });
  });
});

/* ------------------------------ observe / verify ---------------------------- */

const account = () => {
  const a = new FakeAccount();
  a.install(ec2);
  return a;
};
const node = (id: string) => nodeOf(fixtureGraph(), `firewall/${id}`);
const observe = (id: string, ctx = driverCtx(), externalId?: string) => driver.observe!(ctx, node(id), externalId);

describe("aws:security_group_rule observe", () => {
  it("present: the ingress and egress rules exist; externalId is the TARGET's group id; tags in native", async () => {
    account();
    const obs = await observe("web-to-db");
    expect(obs.presence).toBe("present");
    expect(obs.externalId).toBe(SG.db);
    expect(Object.fromEntries(Object.entries(obs.attributes).map(([k, v]) => [k, v.state === "known" ? v.value : v.state]))).toEqual({
      port: 5432,
      protocol: "tcp",
      source: "container_service/web",
      egressRule: "egress tcp/5432 sg:postgres/db",
    });
    expect(obs.native).toMatchObject({ securityGroupId: SG.db, sourceSecurityGroupId: SG.web, rulesTruncated: false });
    expect(obs.native!.ingressRuleId).toMatch(/^sgr-/);
    expect((obs.native!.tags as Record<string, string>)["zenith:resource"]).toBe("postgres/db");
    expect(obs.native!.targetIngress).toEqual(["ingress tcp/5432 sg:container_service/api", "ingress tcp/5432 sg:container_service/web"]);
  });

  it("expectedAttributes names exactly what observe reads, for node and CIDR sources", async () => {
    account();
    for (const id of ["web-to-db", "lb-to-web", "internet-to-lb-443"]) {
      const obs = await observe(id);
      expect(Object.keys(driver.expectedAttributes!(node(id))).sort()).toEqual(Object.keys(obs.attributes).sort());
      for (const [k, v] of Object.entries(obs.attributes)) expect(v.state === "known" && v.value, `${id} ${k}`).toEqual(driver.expectedAttributes!(node(id))[k]);
    }
    expect(driver.expectedAttributes!(node("internet-to-lb-443"))).toEqual({ port: 443, protocol: "tcp", source: "0.0.0.0/0" });
    expect(driver.expectedAttributes!(node("lb-to-web"))).toEqual({ port: 3000, protocol: "tcp", source: "load_balancer/public", egressRule: "egress tcp/3000 sg:container_service/web" });
  });

  it("finds the groups by the Zenith tags of the endpoint nodes, and by id when one is known", async () => {
    account();
    await observe("web-to-db");
    const calls = ec2.commandCalls(DescribeSecurityGroupsCommand).map((c) => c.args[0].input);
    expect(calls[0].Filters).toContainEqual({ Name: "tag:zenith:resource", Values: ["postgres/db"] });
    expect(calls[1].Filters).toContainEqual({ Name: "tag:zenith:resource", Values: ["container_service/web"] });
    ec2.resetHistory();
    await observe("web-to-db", driverCtx(), SG.db);
    expect(ec2.commandCalls(DescribeSecurityGroupsCommand)[0].args[0].input.GroupIds).toEqual([SG.db]);
  });

  it("SG-BREAK: delete ONE ingress rule and exactly that node reports it missing, every other rule node stays present", async () => {
    const a = account();
    const before = await Promise.all(firewalls(fixtureGraph()).map((n) => driver.observe!(driverCtx(), n)));
    expect(before.every((o) => o.presence === "present")).toBe(true);

    a.remove(a.ruleId(SG.web, "ingress", 3000, SG.lb)); // the LB → web ingress rule disappears
    const after = await Promise.all(firewalls(fixtureGraph()).map(async (n) => [n.address, await driver.observe!(driverCtx(), n)] as const));
    const broken = after.filter(([, o]) => o.presence !== "present");
    expect(broken.map(([addr]) => addr)).toEqual(["firewall/lb-to-web"]);
    const [, obs] = broken[0];
    expect(obs.presence).toBe("missing");
    expect(obs.externalId).toBe(SG.web); // the group still exists: only the rule is gone
    for (const a of ["port", "protocol", "source"]) expect(obs.attributes[a], a).toMatchObject({ state: "unknown", reason: "not_applicable" });
    expect(obs.attributes.egressRule).toMatchObject({ state: "known", value: "egress tcp/3000 sg:container_service/web" }); // the LB's egress is intact

    const ctx = driverCtx();
    const v = await driver.verify!(ctx, node("lb-to-web"), obs);
    expect(v.status).toBe("failed");
    expect(v.checks.find((c) => c.id === "ingress_rule_present")).toMatchObject({ passed: false, detail: "missing: ingress tcp/3000 sg:load_balancer/public" });
    expect(v.checks.find((c) => c.id === "security_group_exists")?.passed).toBe(true);
  });

  it("a missing egress companion is reported on the node whose source group lost it", async () => {
    const a = account();
    a.remove(a.ruleId(SG.web, "egress", 5432, SG.db));
    const obs = await observe("web-to-db");
    expect(obs.presence).toBe("present"); // the ingress rule is still there
    expect(obs.attributes.egressRule).toMatchObject({ state: "known", value: null });
    const v = await driver.verify!(driverCtx(), node("web-to-db"), obs);
    expect(v.checks.find((c) => c.id === "egress_rule_present")).toMatchObject({ passed: false, detail: "missing: egress tcp/5432 sg:postgres/db" });
    expect(v.status).toBe("failed");
  });

  it("a rule on the right port from the WRONG source is a missing rule, not a match", async () => {
    const a = account();
    a.remove(a.ruleId(SG.db, "ingress", 5432, SG.web));
    a.add({ SecurityGroupRuleId: "sgr-extra00000000001", GroupId: SG.db, IsEgress: false, IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, CidrIpv4: "0.0.0.0/0" });
    const obs = await observe("web-to-db");
    expect(obs.presence).toBe("missing");
    const v = await driver.verify!(driverCtx(), node("web-to-db"), obs);
    expect(v.checks.find((c) => c.id === "no_unexpected_public_ingress")).toMatchObject({ passed: false, detail: expect.stringContaining("ingress tcp/5432 cidr:0.0.0.0/0") });
  });

  it("the observed source is the owning node's address, the CIDR, or the raw sg id of a group Zenith does not own", async () => {
    const a = account();
    const cidr = await observe("internet-to-lb-80");
    expect(cidr.attributes.source).toMatchObject({ state: "known", value: "0.0.0.0/0" });
    const foreign = "sg-0foreign000000001";
    a.remove(a.ruleId(SG.web, "ingress", 3000, SG.lb));
    a.add({ SecurityGroupRuleId: "sgr-foreign0000000001", GroupId: SG.web, IsEgress: false, IpProtocol: "tcp", FromPort: 3000, ToPort: 3000, ReferencedGroupInfo: { GroupId: foreign } });
    const missing = await observe("lb-to-web");
    expect(missing.presence).toBe("missing"); // a rule on the same port from a group that is not the load balancer is not THIS rule
    expect(missing.native!.targetIngress).toContain("ingress tcp/3000 sg:" + foreign);
  });

  it("verify fails when a database group has ingress open to the internet, but never flags the load balancer's own public rules", async () => {
    const a = account();
    a.add({ SecurityGroupRuleId: "sgr-open000000000001", GroupId: SG.db, IsEgress: false, IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, CidrIpv4: "0.0.0.0/0" });
    const v = await driver.verify!(driverCtx(), node("web-to-db"), await observe("web-to-db"));
    expect(v.status).toBe("failed");
    expect(v.checks.find((c) => c.id === "no_unexpected_public_ingress")?.passed).toBe(false);
    const lb = await driver.verify!(driverCtx(), node("internet-to-lb-80"), await observe("internet-to-lb-80"));
    expect(lb.status).toBe("passed");
    expect(lb.checks.some((c) => c.id === "no_unexpected_public_ingress")).toBe(false);
  });

  it("verify passes on a healthy group", async () => {
    account();
    const v = await driver.verify!(driverCtx(), node("web-to-db"), await observe("web-to-db"));
    expect(v.status).toBe("passed");
    expect(v.checks.map((c) => c.id)).toEqual(["security_group_exists", "ingress_rule_present", "egress_rule_present", "no_unexpected_public_ingress"]);
  });

  it("the target's group is gone: missing, attributes not applicable", async () => {
    const a = account();
    a.groups = a.groups.filter((g) => g.id !== SG.db);
    const obs = await observe("web-to-db");
    expect(obs.presence).toBe("missing");
    expect(Object.values(obs.attributes).every((v) => v.state === "unknown" && v.reason === "not_applicable")).toBe(true);
    const v = await driver.verify!(driverCtx(), node("web-to-db"), obs);
    expect(v.checks[0]).toMatchObject({ id: "security_group_exists", passed: false });
  });

  it("two groups carry the endpoint's tags: ambiguous, unknown, nothing picked", async () => {
    const a = account();
    a.groups = [...a.groups, { ...a.groups[3], id: "sg-00000000000000099" }];
    const obs = await observe("web-to-db");
    expect(obs.presence).toBe("unknown");
    expect(obs.externalId).toBeUndefined();
    expect(obs.error).toMatch(/ambiguous/);
  });

  it("AccessDenied while listing rules: inaccessible with the group id kept, attributes unknown/access_denied", async () => {
    account();
    ec2.on(DescribeSecurityGroupRulesCommand).rejects(Object.assign(new Error("not authorized"), { name: "UnauthorizedOperation", $metadata: { httpStatusCode: 403 } }));
    const obs = await observe("web-to-db");
    expect(obs.presence).toBe("inaccessible");
    expect(obs.externalId).toBe(SG.db);
    expect(Object.values(obs.attributes).every((v) => v.state === "unknown" && v.reason === "access_denied")).toBe(true);
    const v = await driver.verify!(driverCtx(), node("web-to-db"), obs);
    expect(v.status).not.toBe("passed");
  });

  it("throttled while looking up the group: unknown, never 'no rule'", async () => {
    account();
    ec2.on(DescribeSecurityGroupsCommand).rejects(Object.assign(new Error("Rate exceeded"), { name: "Throttling", $metadata: { httpStatusCode: 400 } }));
    const obs = await observe("web-to-db");
    expect(obs.presence).toBe("unknown");
    expect(Object.values(obs.attributes).every((v) => v.state === "unknown")).toBe(true);
  });

  it("a NotFound when asked by group id is missing", async () => {
    account();
    expect((await observe("web-to-db", driverCtx(), "sg-0deadbeef0000000")).presence).toBe("missing");
  });

  it("follows pagination of rules and says so when it had to stop", async () => {
    const a = account();
    const all = a.rules;
    ec2.on(DescribeSecurityGroupRulesCommand).callsFake((input: { NextToken?: string }) => (input.NextToken ? { SecurityGroupRules: all.slice(6) } : { SecurityGroupRules: all.slice(0, 6), NextToken: "p2" }));
    const obs = await observe("web-to-db");
    expect(obs.presence).toBe("present");
    expect(ec2.commandCalls(DescribeSecurityGroupRulesCommand)).toHaveLength(2);
    ec2.on(DescribeSecurityGroupRulesCommand).callsFake(() => ({ SecurityGroupRules: [], NextToken: `t${Math.random()}` }));
    const endless = await observe("web-to-db");
    expect(endless.native!.rulesTruncated).toBe(true);
    expect(endless.presence).toBe("missing"); // bounded read: what it saw had no rule; rulesTruncated tells the consumer
  });

  it("an unusable spec is unknown, not a crash", async () => {
    const bad = { ...node("web-to-db"), spec: { direction: "ingress" } };
    const obs = await driver.observe!(driverCtx(), bad);
    expect(obs.presence).toBe("unknown");
    expect(obs.error).toBe("invalid firewall spec");
  });
});

describe("firewall.inspect", () => {
  it("returns the normalized rule list of the target's group with this node's expected rule present", async () => {
    account();
    const r = await driver.operations!["firewall.inspect"](driverCtx(), node("web-to-db"), {});
    expect(r.ok).toBe(true);
    expect(r.simulated).toBe(false);
    expect(r.requestIds).toEqual(["req-rules-1"]);
    expect(r.data).toMatchObject({
      securityGroupId: SG.db,
      owner: "postgres/db",
      ingress: ["ingress tcp/5432 sg:container_service/api", "ingress tcp/5432 sg:container_service/web"],
      egress: [],
      expected: { present: ["ingress tcp/5432 sg:container_service/web"], missing: [] },
      otherRules: ["ingress tcp/5432 sg:container_service/api"],
      truncated: false,
    });
  });

  it("names exactly which expected rule is missing", async () => {
    const a = account();
    a.remove(a.ruleId(SG.web, "ingress", 3000, SG.lb));
    const r = await driver.operations!["firewall.inspect"](driverCtx(), node("lb-to-web"), {});
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ securityGroupId: SG.web, ingress: [], expected: { present: [], missing: ["ingress tcp/3000 sg:load_balancer/public"] } });
    expect(r.summary).toMatch(/1 expected rule\(s\) missing/);
  });

  it("can inspect the SOURCE group (its egress) and refuses that for a CIDR source", async () => {
    account();
    const r = await driver.operations!["firewall.inspect"](driverCtx(), node("web-to-db"), { group: "source" });
    expect(r.data).toMatchObject({ securityGroupId: SG.web, owner: "container_service/web", expected: { present: ["egress tcp/5432 sg:postgres/db"], missing: [] } });
    expect(r.data!.egress).toEqual(["egress tcp/443 cidr:0.0.0.0/0", "egress tcp/5432 sg:postgres/db"]);
    const cidr = await driver.operations!["firewall.inspect"](driverCtx(), node("internet-to-lb-80"), { group: "source" });
    expect(cidr).toMatchObject({ ok: false, summary: expect.stringContaining("CIDR") });
  });

  it("reports failures as a bounded, scrubbed result instead of throwing, and never mutates", async () => {
    account();
    ec2.on(DescribeSecurityGroupRulesCommand).rejects(Object.assign(new Error(`denied for AKIAABCDEFGHIJKLMNOP ${"z".repeat(80)}`), { name: "UnauthorizedOperation", $metadata: { requestId: "req-9" } }));
    const r = await driver.operations!["firewall.inspect"](driverCtx(), node("web-to-db"), {});
    expect(r.ok).toBe(false);
    expect(r.summary).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(r.requestIds).toEqual(["req-9"]);
    const sent = ec2.calls().map((c) => c.args[0].constructor.name);
    expect(sent.every((n) => n.startsWith("Describe"))).toBe(true);
  });

  it("declares exactly one operation, a read, at contract evidence", () => {
    expect(driver.capabilities.operations).toEqual(["firewall.inspect"]);
    expect(Object.keys(driver.operations!)).toEqual(["firewall.inspect"]);
    expect(driver.capabilities.evidence["firewall.inspect"]).toBe("contract");
  });
});

describe("aws:security_group_rule discover", () => {
  it("lists groups as firewall candidates and marks the Zenith-tagged ones", async () => {
    const a = account();
    a.groups = [...a.groups, { id: "sg-0000000000000ffff", address: "", name: "default", tags: {} }];
    const found = await driver.discover!(driverCtx());
    expect(found).toHaveLength(5);
    expect(found.filter((f) => f.zenithTagged)).toHaveLength(4);
    expect(found[0]).toMatchObject({ kind: "firewall", nativeType: "aws:security_group_rule", provider: "aws" });
  });
});
