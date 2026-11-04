/**
 * The AWS-wide helpers in src/lib/providers/aws/drivers/shared: naming,
 * tags, error classification, pagination, bounded native bags, the reference
 * protocol, the fragment builder and the security-group ownership contract.
 */
import { describe, expect, it } from "vitest";
import type { CompileContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import {
  DriverCompileError,
  FragmentBuilder,
  addSecurityGroup,
  boundNative,
  chunk,
  classifyAwsError,
  cloudName,
  ec2TagFilters,
  elbv2ArnSuffix,
  fnv1a,
  fromAwsTagList,
  hash6,
  isZenithTagged,
  matchesNodeTags,
  networkAddressOf,
  paginate,
  parseArn,
  refExpr,
  refLocalName,
  resourceTags,
  scrubErrorText,
  securityGroupExpr,
  securityGroupLabel,
  subnetsOf,
  tfLabel,
  toAwsTagList,
  withSecurityGroup,
} from "@/lib/providers/aws/drivers/shared";

const node = (address: string, over: Partial<ResourceNode> = {}): ResourceNode => ({
  address,
  kind: "container_service",
  provider: "aws",
  region: "us-east-1",
  nativeType: "aws:ecs_service",
  ownership: "managed",
  spec: {},
  origin: [],
  dependsOn: [],
  specDigest: "0".repeat(64),
  labels: {},
  ...over,
});

function ctxFor(nodes: ResourceNode[]): CompileContext {
  const byAddress = new Map(nodes.map((n) => [n.address, n]));
  return {
    environmentId: "env_1",
    namePrefix: "acme-prod",
    region: "us-east-1",
    tags: { "zenith:workspace": "ws_1", "zenith:environment": "env_1", "zenith:managed": "true" },
    ref: (address, attribute) => `\${local.${refLocalName(address, attribute)}}`,
    node: (address) => byAddress.get(address),
  };
}

describe("fnv1a / hash6", () => {
  it("matches the FNV-1a 32-bit reference vectors over UTF-8 bytes", () => {
    expect(fnv1a("")).toBe("811c9dc5");
    expect(fnv1a("a")).toBe("e40c292c");
    expect(fnv1a("foobar")).toBe("bf9cf968");
    expect(hash6("foobar")).toBe("bf9cf9");
    expect(fnv1a("é")).toBe(fnv1a("é")); // deterministic for non-ASCII
  });
});

describe("tfLabel", () => {
  it("maps the manifest address alphabet losslessly to [a-z0-9_]", () => {
    expect(tfLabel("service/web")).toBe("service_web");
    expect(tfLabel("subnet/private-a")).toBe("subnet_private_a");
    expect(tfLabel("network/main")).toBe("network_main");
  });
  it("hashes addresses with other characters so two hosts cannot share a label", () => {
    const a = tfLabel("dns_record/a-b.example.com");
    const b = tfLabel("dns_record/a.b.example.com");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^dns_record_a_b_example_com_[0-9a-f]{6}$/);
  });
  it("never starts with a digit, is never empty and is bounded", () => {
    expect(tfLabel("9lives")).toBe("_9lives");
    expect(tfLabel("")).toBe("_");
    expect(tfLabel(`x/${"a".repeat(300)}`).length).toBeLessThanOrEqual(100);
    expect(tfLabel(`x/${"a".repeat(300)}`)).toMatch(/^[a-z_][a-z0-9_]*$/);
  });
});

describe("cloudName", () => {
  it("joins prefix and name without a suffix when nothing was cut", () => {
    expect(cloudName("acme-prod", "lb-public", 32)).toBe("acme-prod-lb-public");
  });
  it("truncates deterministically with a 6-hex suffix of the untruncated name", () => {
    const long = "service-with-a-really-quite-long-name";
    const n = cloudName("acme-prod", long, 32);
    expect(n.length).toBeLessThanOrEqual(32);
    expect(n).toMatch(/-[0-9a-f]{6}$/);
    expect(cloudName("acme-prod", long, 32)).toBe(n);
    expect(cloudName("acme-prod", `${long}x`, 32)).not.toBe(n); // differs in the hashed part
    expect(n).not.toMatch(/--/);
  });
  it("rewrites unsafe characters and records that with a hash", () => {
    const n = cloudName("acme", "Web App!", 32);
    expect(n).toMatch(/^acme-web-app-[0-9a-f]{6}$/);
  });
  it("turns address separators into hyphens without a hash", () => {
    expect(cloudName("acme", "container_service/web", 64)).toBe("acme-container-service-web");
  });
  it("respects the limit for every length up to 40", () => {
    for (let i = 1; i <= 40; i++) expect(cloudName("p", "n".repeat(i * 3), 32).length).toBeLessThanOrEqual(32);
  });
});

describe("tags", () => {
  it("round-trips AWS tag lists with stable ordering", () => {
    const list = toAwsTagList({ b: "2", a: "1" });
    expect(list).toEqual([{ Key: "a", Value: "1" }, { Key: "b", Value: "2" }]);
    expect(fromAwsTagList([{ Key: "b", Value: "2" }, { Value: "orphan" }, { Key: "a" }])).toEqual({ a: "", b: "2" });
  });
  it("resourceTags adds zenith:resource and Name and sorts keys", () => {
    const t = resourceTags({ "zenith:managed": "true" }, "service/web", "acme-web");
    expect(Object.keys(t)).toEqual(["Name", "zenith:managed", "zenith:resource"]);
    expect(t["zenith:resource"]).toBe("service/web");
  });
  it("matches objects by workspace + environment + resource, never by name", () => {
    const scope = { environmentId: "env_1", workspaceId: "ws_1", tags: {} };
    const mine = { "zenith:workspace": "ws_1", "zenith:environment": "env_1", "zenith:resource": "network/main", "zenith:managed": "true" };
    expect(matchesNodeTags(mine, scope, "network/main")).toBe(true);
    expect(matchesNodeTags(mine, scope, "network/other")).toBe(false);
    expect(matchesNodeTags({ ...mine, "zenith:workspace": "ws_2" }, scope, "network/main")).toBe(false);
    expect(matchesNodeTags({ ...mine, "zenith:environment": "env_2" }, scope, "network/main")).toBe(false);
    expect(isZenithTagged(mine, scope)).toBe(true);
    expect(isZenithTagged({ ...mine, "zenith:managed": "false" }, scope)).toBe(false);
    expect(isZenithTagged({ Name: "x" }, scope)).toBe(false);
  });
  it("builds EC2 tag filters scoped to the workspace", () => {
    const f = ec2TagFilters({ environmentId: "env_1", workspaceId: "ws_1", tags: { "zenith:workspace": "ws_1" } }, "network/main");
    expect(f).toContainEqual({ Name: "tag:zenith:resource", Values: ["network/main"] });
    expect(f).toContainEqual({ Name: "tag:zenith:workspace", Values: ["ws_1"] });
    expect(f).toContainEqual({ Name: "tag:zenith:environment", Values: ["env_1"] });
  });
});

describe("classifyAwsError", () => {
  const err = (name: string, status?: number, message = "boom") => Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status, requestId: "req-1" } });
  it("classifies access denied as inaccessible", () => {
    for (const name of ["AccessDenied", "AccessDeniedException", "UnauthorizedOperation", "AuthFailure"]) expect(classifyAwsError(err(name, 403)).kind).toBe("inaccessible");
  });
  it("classifies not-found families as missing", () => {
    for (const name of ["InvalidVpcID.NotFound", "LoadBalancerNotFound", "NoSuchHostedZone", "ResourceNotFoundException", "InvalidGroup.NotFound"]) {
      expect(classifyAwsError(err(name, 400)).kind).toBe("missing");
    }
    expect(classifyAwsError(err("SomethingElse", 404)).kind).toBe("missing");
  });
  it("classifies throttling as throttled, not missing or denied", () => {
    for (const name of ["Throttling", "ThrottlingException", "RequestLimitExceeded", "TooManyRequestsException"]) expect(classifyAwsError(err(name, 400)).kind).toBe("throttled");
    expect(classifyAwsError(err("Whatever", 429)).kind).toBe("throttled");
  });
  it("treats a fired signal as aborted and everything else as error", () => {
    const c = new AbortController();
    c.abort();
    expect(classifyAwsError(err("Whatever"), c.signal).kind).toBe("aborted");
    expect(classifyAwsError(err("AbortError")).kind).toBe("aborted");
    expect(classifyAwsError(err("InternalFailure", 500)).kind).toBe("error");
    expect(classifyAwsError("a string").kind).toBe("error");
    expect(classifyAwsError(undefined).code).toBe("Unknown");
  });
  it("carries the request id and scrubs credential-shaped tokens from the summary", () => {
    const f = classifyAwsError(err("Oops", 500, `bad key AKIAABCDEFGHIJKLMNOP and ${"x".repeat(60)}`));
    expect(f.requestId).toBe("req-1");
    expect(f.summary).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(f.summary).not.toContain("x".repeat(40));
    expect(scrubErrorText("a".repeat(500)).length).toBeLessThanOrEqual(240);
  });
});

describe("paginate", () => {
  it("follows tokens to the last page", async () => {
    const pages: Record<string, { items: number[]; next?: string }> = { start: { items: [1, 2], next: "p2" }, p2: { items: [3], next: "p3" }, p3: { items: [4] } };
    const res = await paginate(async (t) => pages[t ?? "start"]);
    expect(res).toEqual({ items: [1, 2, 3, 4], truncated: false });
  });
  it("stops at maxPages and says so", async () => {
    let calls = 0;
    const res = await paginate(async () => ({ items: [++calls], next: `t${calls}` }), { maxPages: 3 });
    expect(calls).toBe(3);
    expect(res).toEqual({ items: [1, 2, 3], truncated: true });
  });
  it("does not spin on a token that never advances", async () => {
    let calls = 0;
    const res = await paginate(async () => ({ items: [++calls], next: "same" }), { maxPages: 50 });
    expect(calls).toBeLessThanOrEqual(3);
    expect(res.truncated).toBe(true);
  });
  it("throws AbortError when the signal has fired", async () => {
    const c = new AbortController();
    c.abort();
    await expect(paginate(async () => ({ items: [1] }), { signal: c.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
  it("chunks", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });
});

describe("arn helpers", () => {
  it("parses ARNs and derives ELBv2 CloudWatch dimension values", () => {
    const arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/web/50dc6c495c0c9188";
    expect(parseArn(arn)).toMatchObject({ partition: "aws", service: "elasticloadbalancing", region: "us-east-1", accountId: "123456789012" });
    expect(elbv2ArnSuffix(arn)).toBe("app/web/50dc6c495c0c9188");
    expect(elbv2ArnSuffix("arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/web/73e2d6bc24d8a067")).toBe("targetgroup/web/73e2d6bc24d8a067");
    expect(parseArn("not-an-arn")).toBeUndefined();
    expect(elbv2ArnSuffix("arn:aws:s3:::bucket")).toBeUndefined();
  });
});

describe("boundNative", () => {
  it("redacts secret-looking keys and cuts long strings and arrays", () => {
    const b = boundNative({ apiToken: "s3cr3t", nested: { password: "p", ok: "fine" }, long: "x".repeat(1000), list: Array.from({ length: 200 }, (_, i) => i) });
    expect(b.apiToken).toBe("[redacted]");
    expect((b.nested as Record<string, string>).password).toBe("[redacted]");
    expect((b.long as string).length).toBeLessThanOrEqual(300);
    expect((b.list as number[]).length).toBeLessThanOrEqual(50);
    expect(JSON.stringify(b)).not.toContain("s3cr3t");
  });
  it("stays within 4 KiB, keeping priority keys and marking truncation", () => {
    const big = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`field${i}`, "v".repeat(250)]));
    const b = boundNative({ ...big, tags: { "zenith:managed": "true" }, ids: ["a", "b"] }, { priority: ["tags", "ids"] });
    expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThanOrEqual(4096);
    expect(b._truncated).toBe(true);
    expect(b.tags).toEqual({ "zenith:managed": "true" });
    expect(b.ids).toEqual(["a", "b"]);
  });
  it("shrinks oversized priority keys as a last resort instead of overflowing", () => {
    const tags = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, "v".repeat(100)]));
    const b = boundNative({ tags }, { priority: ["tags"] });
    expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThanOrEqual(4096);
  });
  it("leaves small bags untouched", () => {
    expect(boundNative({ a: 1, b: "x" })).toEqual({ a: 1, b: "x" });
  });
});

describe("reference protocol", () => {
  it("names locals from the node label and the sanitized attribute", () => {
    expect(refLocalName("load_balancer/public", "dns_name")).toBe("ref_load_balancer_public__dns_name");
    expect(refLocalName("load_balancer/public", "target_group_arn:container_service/web")).toBe("ref_load_balancer_public__target_group_arn_container_service_web");
    expect(refLocalName("subnet/private-a", "id")).not.toBe(refLocalName("subnet/private-b", "id"));
  });
  it("wraps bare traversals and leaves templates alone", () => {
    expect(refExpr("aws_vpc.x.id")).toBe("${aws_vpc.x.id}");
    expect(refExpr("${aws_vpc.x.id}")).toBe("${aws_vpc.x.id}");
  });
});

describe("FragmentBuilder", () => {
  it("keeps the primary resource first and sorts maps", () => {
    const b = new FragmentBuilder("network/main");
    b.resource("aws_vpc", "z", { cidr_block: "10.0.0.0/16" });
    b.resource("aws_internet_gateway", "a", { vpc_id: "${aws_vpc.z.id}" });
    b.data("aws_caller_identity", "me", {});
    b.expose("id", "aws_vpc.z.id");
    const f = b.build();
    expect(f.addresses).toEqual(["aws_vpc.z", "aws_internet_gateway.a", "data.aws_caller_identity.me"]);
    expect(Object.keys(f.resource!)).toEqual(["aws_internet_gateway", "aws_vpc"]);
    expect(f.locals).toEqual({ ref_network_main__id: "${aws_vpc.z.id}" });
  });
  it("refuses a tofu address defined twice", () => {
    const b = new FragmentBuilder("network/main");
    b.resource("aws_vpc", "x", {});
    expect(() => b.resource("aws_vpc", "x", {})).toThrow(DriverCompileError);
    b.local("l", 1);
    expect(() => b.local("l", 2)).toThrow(DriverCompileError);
  });
  it("round-trips through from()", () => {
    const b = new FragmentBuilder("service/web");
    b.resource("aws_thing", "t", { a: 1 });
    const again = FragmentBuilder.from("service/web", b.build());
    again.resource("aws_other", "o", {});
    expect(again.build().addresses).toEqual(["aws_thing.t", "aws_other.o"]);
  });
});

describe("security group ownership contract", () => {
  const network = node("network/main", { kind: "network", nativeType: "aws:vpc", spec: { cidr: "10.0.0.0/16", zones: 2, egress: { natGateways: "single" } } });
  const priv = node("subnet/private-a", { kind: "subnet", nativeType: "aws:subnet", dependsOn: ["network/main"], spec: { tier: "private", zone: "a", cidr: "10.0.10.0/24", network: "network/main" } });
  const pub = node("subnet/public-a", { kind: "subnet", nativeType: "aws:subnet", dependsOn: ["network/main"], spec: { tier: "public", zone: "a", cidr: "10.0.0.0/24", network: "network/main" } });
  const web = node("container_service/web", { dependsOn: ["subnet/private-a"] });
  const db = node("postgres/db", { kind: "postgres", nativeType: "aws:rds_instance", dependsOn: ["subnet/private-a"] });
  const ctx = ctxFor([network, priv, pub, web, db]);

  it("finds the network and subnets through dependsOn, sorted", () => {
    expect(networkAddressOf(web, ctx)).toBe("network/main");
    expect(subnetsOf(node("load_balancer/public", { dependsOn: ["subnet/public-a", "subnet/private-a"] }), ctx, "public").map((n) => n.address)).toEqual(["subnet/public-a"]);
    expect(() => networkAddressOf(node("service/orphan"), ctx)).toThrow(DriverCompileError);
  });

  it("a workload group: named, tagged, vpc-bound, https egress only, published as security_group_id", () => {
    const b = new FragmentBuilder(web.address);
    b.resource("aws_ecs_service", "container_service_web", {});
    addSecurityGroup(b, web, ctx);
    const f = b.build();
    expect(f.addresses).toEqual(["aws_ecs_service.container_service_web", "aws_security_group.container_service_web_sg", "aws_vpc_security_group_egress_rule.container_service_web_sg_https"]);
    const sg = f.resource!.aws_security_group.container_service_web_sg;
    expect(sg).toMatchObject({ name: "acme-prod-container-service-web", vpc_id: "${local.ref_network_main__id}" });
    expect(sg).not.toHaveProperty("ingress");
    expect(sg).not.toHaveProperty("egress");
    expect((sg.tags as Record<string, string>)["zenith:resource"]).toBe("container_service/web");
    expect(f.resource!.aws_vpc_security_group_egress_rule.container_service_web_sg_https).toMatchObject({ ip_protocol: "tcp", from_port: 443, to_port: 443, cidr_ipv4: "0.0.0.0/0" });
    expect(f.locals).toEqual({ ref_container_service_web__security_group_id: "${aws_security_group.container_service_web_sg.id}" });
    expect(securityGroupExpr(ctx, web.address)).toBe("${local.ref_container_service_web__security_group_id}");
    expect(securityGroupLabel(web.address)).toBe("container_service_web_sg");
  });

  it("a datastore group has no egress at all", () => {
    const f = withSecurityGroup({ resource: { aws_db_instance: { postgres_db: {} } }, addresses: ["aws_db_instance.postgres_db"] }, db, ctx);
    expect(f.addresses).toEqual(["aws_db_instance.postgres_db", "aws_security_group.postgres_db_sg"]);
    expect(f.resource!.aws_vpc_security_group_egress_rule).toBeUndefined();
  });

  it("refuses unmanaged nodes, other providers and kinds that cannot own a group", () => {
    const b = () => new FragmentBuilder("x");
    expect(() => addSecurityGroup(b(), { ...web, ownership: "referenced" }, ctx)).toThrow(/does not create security groups for referenced/);
    expect(() => addSecurityGroup(b(), { ...web, provider: "gcp" }, ctx)).toThrow(DriverCompileError);
    expect(() => addSecurityGroup(b(), node("queue/jobs", { kind: "queue" }), ctx)).toThrow(/does not own a security group/);
  });
});
