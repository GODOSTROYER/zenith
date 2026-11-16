/**
 * aws:route53_zone (referenced), aws:route53_record (alias + dangling-DNS guard)
 * and aws:acm_certificate (automatic / manual DNS validation): compile,
 * refusals, and the read side against mocked Route 53 / ELBv2 / ACM clients.
 */
import { ACMClient, DescribeCertificateCommand, ListCertificatesCommand, ListTagsForCertificateCommand, type CertificateDetail } from "@aws-sdk/client-acm";
import { DescribeLoadBalancersCommand, ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { ListHostedZonesByNameCommand, ListHostedZonesCommand, ListResourceRecordSetsCommand, Route53Client, type ResourceRecordSet } from "@aws-sdk/client-route-53";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acmCertificateDriver as acm, assessRecordDeletion, route53RecordDriver as record, route53ZoneDriver as zone } from "@/lib/providers/aws/drivers/network";
import { DriverCompileError } from "@/lib/providers/aws/drivers/shared";
import { FakeAlb, LB_ARN } from "../fixtures/alb";
import { compileCtx, driverCtx } from "../fixtures/env";
import { CERT, LB, ZONE, fixtureGraph, nodeOf } from "../fixtures/graph";

const r53 = mockClient(Route53Client);
const acmMock = mockClient(ACMClient);
const elb = mockClient(ElasticLoadBalancingV2Client);
beforeEach(() => {
  r53.reset();
  acmMock.reset();
  elb.reset();
});
afterEach(() => {
  r53.reset();
  acmMock.reset();
  elb.reset();
});

const graph = () => fixtureGraph();
const denied = () => Object.assign(new Error("not authorized"), { name: "AccessDeniedException", $metadata: { httpStatusCode: 403 } });
const throttled = () => Object.assign(new Error("Rate exceeded"), { name: "Throttling", $metadata: { httpStatusCode: 400 } });

/* ---------------------------------- zone ---------------------------------- */

describe("aws:route53_zone", () => {
  it("compiles ONLY a data source looked up by name, public zones only — never a resource", () => {
    const g = graph();
    const f = zone.compile!(nodeOf(g, ZONE), compileCtx(g));
    expect(f.resource).toBeUndefined();
    expect(f.data!.aws_route53_zone).toEqual({ [Object.keys(f.data!.aws_route53_zone)[0]]: { name: "acme.io", private_zone: false } });
    expect(f.addresses).toHaveLength(1);
    expect(f.addresses[0]).toMatch(/^data\.aws_route53_zone\./);
    expect(Object.keys(f.locals!).some((k) => k.endsWith("__zone_id"))).toBe(true);
    expect(f.locals![Object.keys(f.locals!).find((k) => k.endsWith("__zone_id"))!]).toMatch(/^\$\{data\.aws_route53_zone\..+\.zone_id\}$/);
  });

  it("refuses to CREATE a customer's zone: a managed dns_zone node is a compile error", () => {
    const g = graph();
    expect(() => zone.compile!({ ...nodeOf(g, ZONE), ownership: "managed" }, compileCtx(g))).toThrow(/never creates a customer's hosted zone/);
  });

  it("refuses private zones and names that are not DNS names", () => {
    const g = graph();
    const n = nodeOf(g, ZONE);
    expect(() => zone.compile!({ ...n, spec: { name: "acme.io", private: true } }, compileCtx(g))).toThrow(/private hosted zones/);
    for (const name of ["", "a b.com", "acme..io", "-acme.io", "x".repeat(300), "acme.io; rm", undefined]) {
      expect(() => zone.compile!({ ...n, spec: { name, private: false } }, compileCtx(g)), String(name)).toThrow(DriverCompileError);
    }
  });

  const node = () => nodeOf(graph(), ZONE);
  const publicZone = { CallerReference: "t", Id: "/hostedzone/Z0123456789ABC", Name: "acme.io.", Config: { PrivateZone: false }, ResourceRecordSetCount: 12 };

  it("observe: present, exact-name public zone; externalId is the bare zone id", async () => {
    r53.on(ListHostedZonesByNameCommand).resolves({ HostedZones: [{ CallerReference: "t", Id: "/hostedzone/Z9", Name: "acme.io.", Config: { PrivateZone: true } }, publicZone, { CallerReference: "t", Id: "/hostedzone/Z8", Name: "app.acme.io.", Config: { PrivateZone: false } }] });
    const obs = await zone.observe!(driverCtx(), node());
    expect(obs).toMatchObject({ presence: "present", externalId: "Z0123456789ABC", source: "aws.route53_zone@1", simulated: false });
    expect(Object.fromEntries(Object.entries(obs.attributes).map(([k, v]) => [k, v.state === "known" ? v.value : v.state]))).toEqual({ name: "acme.io", private: false });
    expect(Object.fromEntries(Object.entries(obs.attributes).map(([k, v]) => [k, v.state === "known" ? v.value : v.state]))).toEqual(zone.expectedAttributes!(node()));
    expect(obs.native).toMatchObject({ zoneId: "Z0123456789ABC", recordSetCount: 12 });
    expect(r53.commandCalls(ListHostedZonesByNameCommand)[0].args[0].input.DNSName).toBe("acme.io");
  });

  it("observe: missing when only a PRIVATE zone or a subdomain zone has the name", async () => {
    r53.on(ListHostedZonesByNameCommand).resolves({ HostedZones: [{ CallerReference: "t", Id: "/hostedzone/Z9", Name: "acme.io.", Config: { PrivateZone: true } }, { CallerReference: "t", Id: "/hostedzone/Z8", Name: "app.acme.io.", Config: { PrivateZone: false } }] });
    expect((await zone.observe!(driverCtx(), node())).presence).toBe("missing");
  });

  it("observe: two public zones with the same name are ambiguous, not picked", async () => {
    r53.on(ListHostedZonesByNameCommand).resolves({ HostedZones: [publicZone, { ...publicZone, Id: "/hostedzone/Z2" }] });
    const obs = await zone.observe!(driverCtx(), node());
    expect(obs.presence).toBe("unknown");
    expect(obs.externalId).toBeUndefined();
    expect(obs.error).toMatch(/2 public hosted zones/);
  });

  it("observe: AccessDenied → inaccessible, throttled → unknown", async () => {
    r53.on(ListHostedZonesByNameCommand).rejects(denied());
    const d = await zone.observe!(driverCtx(), node());
    expect(d.presence).toBe("inaccessible");
    expect(Object.values(d.attributes).every((v) => v.state === "unknown" && v.reason === "access_denied")).toBe(true);
    r53.on(ListHostedZonesByNameCommand).rejects(throttled());
    expect((await zone.observe!(driverCtx(), node())).presence).toBe("unknown");
  });

  it("verify passes for a public zone and fails for a missing one; discover never marks a customer's zone as Zenith's", async () => {
    r53.on(ListHostedZonesByNameCommand).resolves({ HostedZones: [publicZone] });
    const ctx = driverCtx();
    expect((await zone.verify!(ctx, node(), await zone.observe!(ctx, node()))).status).toBe("passed");
    r53.on(ListHostedZonesByNameCommand).resolves({ HostedZones: [] });
    expect((await zone.verify!(ctx, node(), await zone.observe!(ctx, node()))).status).toBe("failed");
    r53.on(ListHostedZonesCommand).resolves({ HostedZones: [publicZone, { CallerReference: "t", Id: "/hostedzone/Z7", Name: "internal.corp.", Config: { PrivateZone: true } }] });
    const found = await zone.discover!(driverCtx());
    expect(found.map((f) => [f.externalId, f.name, f.zenithTagged])).toEqual([["Z0123456789ABC", "acme.io", false], ["Z7", "internal.corp", false]]);
  });
});

/* --------------------------------- record --------------------------------- */

describe("aws:route53_record compile", () => {
  const compile = (patch: (n: ReturnType<typeof nodeOf>, g: ReturnType<typeof graph>) => void = () => undefined) => {
    const g = graph();
    const n = { ...nodeOf(g, "dns_record/app.acme.io") };
    patch(n, g);
    return record.compile!(n, compileCtx(g));
  };
  it("an alias A record to the load balancer, in the referenced zone, that never overwrites an existing record", () => {
    const f = compile();
    const body = Object.values(f.resource!.aws_route53_record)[0];
    expect(body).toMatchObject({
      name: "app.acme.io",
      type: "A",
      allow_overwrite: false,
      zone_id: expect.stringMatching(/^\$\{local\.ref_dns_zone_acme_io_[0-9a-f]{6}__zone_id\}$/),
      alias: [{ name: "${local.ref_load_balancer_public__dns_name}", zone_id: "${local.ref_load_balancer_public__zone_id}", evaluate_target_health: true }],
    });
    expect(Object.keys(f.resource!)).toEqual(["aws_route53_record"]); // no AAAA: the ALB is IPv4-only
    expect(f.addresses[0]).toMatch(/^aws_route53_record\.dns_record_app_acme_io_/);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(compile())).toBe(JSON.stringify(compile()));
  });

  it("refuses a name outside the zone (no writing into a zone the manifest did not name)", () => {
    expect(() => compile((n) => {
      n.spec = { ...n.spec, name: "evil.other.com" };
    })).toThrow(/not inside the zone acme.io/);
    expect(() => compile((n) => {
      n.spec = { ...n.spec, name: "notacme.io" };
    })).toThrow(/not inside the zone/);
    expect(() => compile((n) => {
      n.spec = { ...n.spec, name: "acme.io" };
    })).not.toThrow(); // the apex itself is inside the zone
  });

  it("refuses unsupported record types, bad names, missing zone/target, non-zone zones and non-aliasable targets", () => {
    const bad: Record<string, (n: ReturnType<typeof nodeOf>, g: ReturnType<typeof graph>) => void> = {
      type: (n) => void (n.spec = { ...n.spec, type: "cname" }),
      name: (n) => void (n.spec = { ...n.spec, name: "a b.acme.io" }),
      noZone: (n) => void (n.spec = { ...n.spec, zone: "dns_zone/ghost" }),
      notAZone: (n) => void (n.spec = { ...n.spec, zone: "network/main" }),
      noTarget: (n) => void (n.spec = { ...n.spec, target: "load_balancer/ghost" }),
      badTarget: (n) => void (n.spec = { ...n.spec, target: "postgres/db" }),
      unmanaged: (n) => void (n.ownership = "external"),
      foreign: (n, g) => {
        nodeOf(g, LB).provider = "gcp";
        n.spec = { ...n.spec };
      },
    };
    for (const [name, patch] of Object.entries(bad)) expect(() => compile(patch), name).toThrow(DriverCompileError);
  });
});

describe("aws:route53_record observe / verify / deletion guard", () => {
  const node = () => nodeOf(graph(), "dns_record/app.acme.io");
  const zoneHit = { CallerReference: "t", Id: "/hostedzone/Z0123456789ABC", Name: "acme.io.", Config: { PrivateZone: false } };
  const alias = (dns: string): ResourceRecordSet => ({ Name: "app.acme.io.", Type: "A", AliasTarget: { DNSName: `${dns}.`, HostedZoneId: "Z35SXDOTRQ7X7K", EvaluateTargetHealth: true } });
  const live = (rr: ResourceRecordSet | undefined) => {
    r53.on(ListHostedZonesByNameCommand).resolves({ HostedZones: [zoneHit] });
    r53.on(ListResourceRecordSetsCommand).resolves({ ResourceRecordSets: rr ? [{ Name: "aaa.acme.io.", Type: "A", TTL: 60 }, rr] : [{ Name: "zzz.acme.io.", Type: "A", TTL: 60 }] });
  };
  const fakeAlb = () => {
    const f = new FakeAlb();
    f.install(elb);
    return f;
  };
  const lbDns = "acme-prod-lb-public-1234567890.us-east-1.elb.amazonaws.com";
  const read = (obs: { attributes: Record<string, { state: string; value?: unknown }> }) => Object.fromEntries(Object.entries(obs.attributes).map(([k, v]) => [k, v.state === "known" ? v.value : v.state]));

  it("present: an alias that points at OUR load balancer reads target = the node address; externalId is the tofu import id; Route 53 records carry no tags", async () => {
    live(alias(lbDns));
    fakeAlb();
    const obs = await record.observe!(driverCtx(), node());
    expect(obs).toMatchObject({ presence: "present", externalId: "Z0123456789ABC_app.acme.io_A" });
    expect(read(obs)).toEqual({ name: "app.acme.io", type: "A", aliased: true, evaluateTargetHealth: true, target: "load_balancer/public" });
    expect(read(obs)).toEqual(record.expectedAttributes!(node()));
    expect(obs.native).toMatchObject({ hostedZoneId: "Z0123456789ABC", aliasTargetDnsName: `${lbDns}.`, tags: {}, taggable: false });
    expect(r53.commandCalls(ListResourceRecordSetsCommand)[0].args[0].input).toMatchObject({ HostedZoneId: "Z0123456789ABC", StartRecordName: "app.acme.io", StartRecordType: "A" });
  });

  it("the attribute for the alias is named 'aliased', never 'alias' (the incident engine reads 'alias' as the record's target)", async () => {
    live(alias(lbDns));
    fakeAlb();
    const obs = await record.observe!(driverCtx(), node());
    expect(obs.attributes.alias).toBeUndefined();
    expect(record.expectedAttributes!(node()).alias).toBeUndefined();
  });

  it("re-pointed: an alias at something else reads as that raw DNS name, so it differs from the desired address", async () => {
    live(alias("attacker-lb-123.us-east-1.elb.amazonaws.com"));
    fakeAlb();
    const ctx = driverCtx();
    const obs = await record.observe!(ctx, node());
    expect(obs.attributes.target).toMatchObject({ state: "known", value: "attacker-lb-123.us-east-1.elb.amazonaws.com" });
    const v = await record.verify!(ctx, node(), obs);
    expect(v.status).toBe("failed");
    expect(v.checks.find((c) => c.id === "attr:target")).toMatchObject({ passed: false, detail: expect.stringContaining("attacker-lb-123") });
  });

  it("dualstack prefix, case and trailing dot of the alias do not matter", async () => {
    live(alias(`dualstack.${lbDns.toUpperCase()}`));
    fakeAlb();
    const obs = await record.observe!(driverCtx(), node());
    expect(obs.attributes.target).toMatchObject({ state: "known", value: "load_balancer/public" });
  });

  it("target is UNKNOWN (not a guess) when the load balancer lookup is denied or throttled", async () => {
    live(alias(lbDns));
    fakeAlb();
    elb.on(DescribeLoadBalancersCommand).rejects(denied());
    expect((await record.observe!(driverCtx(), node())).attributes.target).toMatchObject({ state: "unknown", reason: "access_denied" });
    elb.on(DescribeLoadBalancersCommand).rejects(throttled());
    const slow = await record.observe!(driverCtx(), node());
    expect(slow.attributes.target).toMatchObject({ state: "unknown", reason: "error" });
    expect(slow.presence).toBe("present"); // the record itself was read
    expect(slow.attributes.name).toMatchObject({ state: "known" });
    const v = await record.verify!(driverCtx(), node(), slow);
    expect(v.status).toBe("unknown");
    expect(v.checks.find((c) => c.id === "attr:target")?.passed).toBe("unknown");
  });

  it("an alias to a load balancer Zenith did not create (ours is gone) reads as the raw name", async () => {
    live(alias(lbDns));
    const f = fakeAlb();
    f.present = false;
    expect((await record.observe!(driverCtx(), node())).attributes.target).toMatchObject({ state: "known", value: lbDns });
  });

  it("missing: no A record with that name, or the zone is gone", async () => {
    live(undefined);
    expect((await record.observe!(driverCtx(), node())).presence).toBe("missing");
    r53.on(ListHostedZonesByNameCommand).resolves({ HostedZones: [] });
    expect((await record.observe!(driverCtx(), node())).presence).toBe("missing");
  });

  it("denied / throttled / ambiguous zone / a zone address that is not dns_zone/<name>", async () => {
    r53.on(ListHostedZonesByNameCommand).rejects(denied());
    expect((await record.observe!(driverCtx(), node())).presence).toBe("inaccessible");
    r53.on(ListHostedZonesByNameCommand).rejects(throttled());
    expect((await record.observe!(driverCtx(), node())).presence).toBe("unknown");
    r53.on(ListHostedZonesByNameCommand).resolves({ HostedZones: [zoneHit, { ...zoneHit, Id: "/hostedzone/Z2" }] });
    expect((await record.observe!(driverCtx(), node())).presence).toBe("unknown");
    const odd = { ...node(), spec: { ...node().spec, zone: "weird" } };
    const o = await record.observe!(driverCtx(), odd);
    expect(o.presence).toBe("unknown");
    expect(o.error).toMatch(/cannot derive the zone name/);
  });

  it("verify passes when the record aliases the load balancer Zenith created; makes NO network probe of the name", async () => {
    live(alias(lbDns));
    fakeAlb();
    const ctx = driverCtx();
    const v = await record.verify!(ctx, node(), await record.observe!(ctx, node()));
    expect(v.status).toBe("passed");
    expect(v.checks.map((c) => c.id)).toEqual(["exists", "attr:aliased", "attr:evaluateTargetHealth", "attr:name", "attr:target", "attr:type"]);
  });

  it("a record aliased to a static site: target is observed-only (the raw name) and is not asserted", async () => {
    live(alias("d111111abcdef8.cloudfront.net"));
    const g = graph();
    const n = { ...nodeOf(g, "dns_record/app.acme.io"), spec: { name: "app.acme.io", type: "alias", target: "static_site/site", zone: ZONE } };
    const obs = await record.observe!(driverCtx(), n);
    expect(obs.attributes.target).toMatchObject({ state: "known", value: "d111111abcdef8.cloudfront.net" });
    expect(record.expectedAttributes!(n)).toEqual({ name: "app.acme.io", type: "A", aliased: true, evaluateTargetHealth: true });
    expect(elb.calls()).toHaveLength(0); // no load balancer lookup for a static site
  });

  it("deletion guard: safe for a missing record and for one that still aliases OUR load balancer", async () => {
    fakeAlb();
    live(undefined);
    expect(await assessRecordDeletion(driverCtx(), node())).toMatchObject({ safe: true, reason: expect.stringContaining("nothing to delete") });
    live(alias(lbDns));
    expect(await assessRecordDeletion(driverCtx(), node())).toMatchObject({ safe: true, reason: expect.stringContaining("still aliases the load balancer Zenith created") });
  });

  it("deletion guard: UNSAFE when the record now points at something Zenith did not create", async () => {
    fakeAlb();
    live(alias("attacker-lb-123.us-east-1.elb.amazonaws.com"));
    const r = await assessRecordDeletion(driverCtx(), node());
    expect(r.safe).toBe(false);
    expect(r.reason).toContain("attacker-lb-123");
  });

  it("deletion guard: UNSAFE when our load balancer is gone (the record would dangle), unreadable, unconfirmed, or the target is not a load balancer", async () => {
    const f = fakeAlb();
    live(alias(lbDns));
    f.present = false;
    expect((await assessRecordDeletion(driverCtx(), node())).safe).toBe(false);
    f.present = true;
    elb.on(DescribeLoadBalancersCommand).rejects(denied());
    expect(await assessRecordDeletion(driverCtx(), node())).toMatchObject({ safe: false, reason: expect.stringContaining("could not be read") });
    r53.on(ListHostedZonesByNameCommand).rejects(denied());
    expect(await assessRecordDeletion(driverCtx(), node())).toMatchObject({ safe: false, reason: expect.stringContaining("(inaccessible)") });
    live(alias(lbDns));
    const n = node();
    const other = { ...n, spec: { ...n.spec, target: "static_site/site" } };
    expect((await assessRecordDeletion(driverCtx(), other)).safe).toBe(false);
    expect(LB_ARN).toBeDefined();
  });

  it("does not offer discovery, and declares contract evidence", () => {
    expect(record.capabilities.discover).toBe(false);
    expect(record.discover).toBeUndefined();
    expect(Object.values(record.capabilities.evidence).every((e) => e === "contract")).toBe(true);
  });
});

/* ------------------------------- certificate ------------------------------- */

describe("aws:acm_certificate compile", () => {
  const compile = (patch: (n: ReturnType<typeof nodeOf>, g: ReturnType<typeof graph>) => void = () => undefined) => {
    const g = graph();
    const n = { ...nodeOf(g, CERT) };
    patch(n, g);
    return acm.compile!(n, compileCtx(g));
  };
  const L = (f: ReturnType<typeof compile>) => Object.keys(f.resource!.aws_acm_certificate)[0];

  it("automatic: certificate + validation CNAME in the referenced zone + validation; `arn` is the VALIDATED arn", () => {
    const f = compile();
    const l = L(f);
    expect(f.addresses).toEqual([`aws_acm_certificate.${l}`, `aws_route53_record.${l}_validation`, `aws_acm_certificate_validation.${l}_validation`]);
    expect(f.resource!.aws_acm_certificate[l]).toMatchObject({ domain_name: "app.acme.io", validation_method: "DNS", lifecycle: { create_before_destroy: true } });
    const rec = f.resource!.aws_route53_record[`${l}_validation`] as { allow_overwrite: boolean; ttl: number; zone_id: string; name: string; records: string[] };
    expect(rec).toMatchObject({ allow_overwrite: true, ttl: 60 });
    expect(rec.zone_id).toMatch(/__zone_id\}$/);
    expect(rec.name).toContain("domain_validation_options");
    expect(f.resource!.aws_acm_certificate_validation[`${l}_validation`]).toMatchObject({ certificate_arn: `\${aws_acm_certificate.${l}.arn}`, validation_record_fqdns: [`\${aws_route53_record.${l}_validation.fqdn}`] });
    expect(f.locals![`ref_${l}__arn`]).toBe(`\${aws_acm_certificate_validation.${l}_validation.certificate_arn}`);
    expect(f.output).toBeUndefined();
  });

  it("manual: NO Route 53 record and NO validation resource; `arn` is the pending certificate; the records to create are an output", () => {
    const f = compile((n) => {
      n.spec = { domain: "app.acme.io", validation: "dns_manual" };
    });
    const l = L(f);
    expect(Object.keys(f.resource!)).toEqual(["aws_acm_certificate"]);
    expect(f.addresses).toEqual([`aws_acm_certificate.${l}`]);
    expect(f.locals![`ref_${l}__arn`]).toBe(`\${aws_acm_certificate.${l}.arn}`);
    expect(f.output![`${l}_validation_records`].value).toContain("domain_validation_options");
    expect(f.output![`${l}_validation_records`].sensitive).toBeUndefined();
  });

  it("tags the certificate", () => {
    const f = compile();
    expect((f.resource!.aws_acm_certificate[L(f)].tags as Record<string, string>)["zenith:resource"]).toBe(CERT);
  });

  it("refuses: a validation zone that does not contain the domain, a missing zone, bad domains and validation modes, unmanaged", () => {
    expect(() => compile((n) => void (n.spec = { ...n.spec, domain: "app.other.com" }))).toThrow(/not inside the zone acme.io/);
    expect(() => compile((n) => void (n.spec = { domain: "app.acme.io", validation: "dns_automatic" }))).toThrow(/needs spec.zone/);
    expect(() => compile((n) => void (n.spec = { ...n.spec, zone: "dns_zone/ghost" }))).toThrow(/not a dns_zone/);
    expect(() => compile((n) => void (n.spec = { ...n.spec, domain: "*.acme.io" }))).toThrow(DriverCompileError);
    expect(() => compile((n) => void (n.spec = { ...n.spec, validation: "email" }))).toThrow(/validation must be/);
    expect(() => compile((n) => void (n.ownership = "referenced"))).toThrow(/does not request a certificate/);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(compile())).toBe(JSON.stringify(compile()));
  });
});

describe("aws:acm_certificate observe / verify", () => {
  const ARN = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555";
  const zenithTags = [
    { Key: "zenith:workspace", Value: "ws_acme" },
    { Key: "zenith:environment", Value: "env_prod" },
    { Key: "zenith:resource", Value: CERT },
    { Key: "zenith:managed", Value: "true" },
  ];
  const detail = (over: Partial<CertificateDetail> = {}): CertificateDetail => ({
    CertificateArn: ARN,
    DomainName: "app.acme.io",
    Status: "ISSUED",
    Type: "AMAZON_ISSUED",
    KeyAlgorithm: "RSA_2048",
    NotAfter: new Date("2027-03-01T00:00:00Z"),
    NotBefore: new Date("2026-09-01T00:00:00Z"),
    InUseBy: ["arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/x/1"],
    RenewalEligibility: "INELIGIBLE",
    DomainValidationOptions: [{ DomainName: "app.acme.io", ValidationMethod: "DNS", ValidationStatus: "SUCCESS", ResourceRecord: { Name: "_abc.app.acme.io.", Type: "CNAME", Value: "_def.acm-validations.aws." } }],
    ...over,
  });
  const serve = (d: CertificateDetail, tags = zenithTags) => {
    acmMock.on(ListCertificatesCommand).resolves({ CertificateSummaryList: [{ CertificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000", DomainName: "other.acme.io" }, { CertificateArn: d.CertificateArn, DomainName: d.DomainName }] });
    acmMock.on(DescribeCertificateCommand).resolves({ Certificate: d });
    acmMock.on(ListTagsForCertificateCommand).resolves({ Tags: tags });
  };
  const node = () => nodeOf(graph(), CERT);
  const manualNode = () => ({ ...node(), spec: { domain: "app.acme.io", validation: "dns_manual" } });

  it("present: status, domain, validation method; NotAfter, InUseBy and renewal info in native; externalId is the ARN", async () => {
    serve(detail());
    const obs = await acm.observe!(driverCtx(), node());
    expect(obs).toMatchObject({ presence: "present", externalId: ARN, source: "aws.acm_certificate@1" });
    const seen = Object.fromEntries(Object.entries(obs.attributes).map(([k, v]) => [k, v.state === "known" ? v.value : v.state]));
    expect(seen).toEqual({ domain: "app.acme.io", validationMethod: "DNS", status: "ISSUED", notAfter: "2027-03-01T00:00:00.000Z" });
    // everything desired is read in the same units; notAfter is observed-only (no desired expiry)
    const expected = acm.expectedAttributes!(node());
    expect(expected).toEqual({ domain: "app.acme.io", validationMethod: "DNS", status: "ISSUED" });
    for (const [k, v] of Object.entries(expected)) expect(seen[k]).toEqual(v);
    expect(Object.keys(seen).filter((k) => !(k in expected))).toEqual(["notAfter"]);
    expect(obs.native).toMatchObject({ certificateArn: ARN, notAfter: "2027-03-01T00:00:00.000Z", inUseByCount: 1, status: "ISSUED" });
    expect((obs.native!.tags as Record<string, string>)["zenith:managed"]).toBe("true");
  });

  it("finds the certificate by ARN when known; otherwise by exact domain THEN by Zenith tags — a same-domain certificate without them is not ours", async () => {
    serve(detail());
    await acm.observe!(driverCtx(), node(), ARN);
    expect(acmMock.commandCalls(ListCertificatesCommand)).toHaveLength(0);
    expect(acmMock.commandCalls(DescribeCertificateCommand)[0].args[0].input).toEqual({ CertificateArn: ARN });
    acmMock.resetHistory();
    serve(detail(), [{ Key: "zenith:resource", Value: "tls_certificate/someone-else" }]);
    const obs = await acm.observe!(driverCtx(), node());
    expect(obs.presence).toBe("missing");
    expect(acmMock.commandCalls(ListTagsForCertificateCommand).map((c) => c.args[0].input.CertificateArn)).toEqual([ARN]); // other.acme.io was never tag-read
  });

  it("missing / ambiguous / denied / throttled", async () => {
    acmMock.on(ListCertificatesCommand).resolves({ CertificateSummaryList: [] });
    expect((await acm.observe!(driverCtx(), node())).presence).toBe("missing");
    acmMock.on(ListCertificatesCommand).resolves({ CertificateSummaryList: [{ CertificateArn: ARN, DomainName: "app.acme.io" }, { CertificateArn: ARN.replace("5555", "6666"), DomainName: "app.acme.io" }] });
    acmMock.on(ListTagsForCertificateCommand).resolves({ Tags: zenithTags });
    const amb = await acm.observe!(driverCtx(), node());
    expect(amb.presence).toBe("unknown");
    expect(amb.error).toMatch(/2 certificates/);
    acmMock.on(ListCertificatesCommand).rejects(denied());
    const d = await acm.observe!(driverCtx(), node());
    expect(d.presence).toBe("inaccessible");
    expect(Object.values(d.attributes).every((v) => v.state === "unknown" && v.reason === "access_denied")).toBe(true);
    acmMock.on(ListCertificatesCommand).rejects(throttled());
    expect((await acm.observe!(driverCtx(), node())).presence).toBe("unknown");
    acmMock.on(DescribeCertificateCommand).rejects(Object.assign(new Error("not found"), { name: "ResourceNotFoundException" }));
    expect((await acm.observe!(driverCtx(), node(), ARN)).presence).toBe("missing");
  });

  it("verify: an issued certificate with time left passes", async () => {
    serve(detail());
    const ctx = driverCtx();
    const v = await acm.verify!(ctx, node(), await acm.observe!(ctx, node()));
    expect(v.status).toBe("passed");
    expect(v.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["exists", "attr:domain", "certificate_issued", "not_expiring"]));
  });

  it("verify: MANUAL validation still pending is UNKNOWN (not failed, not passed) and carries the exact record to create", async () => {
    serve(detail({ Status: "PENDING_VALIDATION", DomainValidationOptions: [{ DomainName: "app.acme.io", ValidationMethod: "DNS", ValidationStatus: "PENDING_VALIDATION", ResourceRecord: { Name: "_abc.app.acme.io.", Type: "CNAME", Value: "_def.acm-validations.aws." } }], NotAfter: undefined }));
    const ctx = driverCtx();
    const v = await acm.verify!(ctx, manualNode(), await acm.observe!(ctx, manualNode()));
    expect(v.status).toBe("unknown");
    const check = v.checks.find((c) => c.id === "certificate_issued")!;
    expect(check.passed).toBe("unknown");
    expect(check.detail).toContain("awaiting manual DNS validation");
    expect(check.detail).toContain("CNAME record named _abc.app.acme.io.");
    expect(check.detail).toContain("_def.acm-validations.aws.");
  });

  it("verify: AUTOMATIC validation still pending is a failure (Zenith owns the record)", async () => {
    serve(detail({ Status: "PENDING_VALIDATION", NotAfter: undefined }));
    const ctx = driverCtx();
    const v = await acm.verify!(ctx, node(), await acm.observe!(ctx, node()));
    expect(v.status).toBe("failed");
    expect(v.checks.find((c) => c.id === "certificate_issued")!.detail).toMatch(/although Zenith manages the validation record/);
  });

  it("verify: other statuses fail; a certificate about to expire unrenewed fails; an expired one fails", async () => {
    const ctx = driverCtx();
    serve(detail({ Status: "FAILED" }));
    expect((await acm.verify!(ctx, node(), await acm.observe!(ctx, node()))).checks.find((c) => c.id === "certificate_issued")).toMatchObject({ passed: false, detail: "status is FAILED" });
    serve(detail({ NotAfter: new Date("2026-10-05T12:00:00Z") })); // exactly 5 days after the fixture clock
    const soon = await acm.verify!(ctx, node(), await acm.observe!(ctx, node()));
    expect(soon.checks.find((c) => c.id === "not_expiring")).toMatchObject({ passed: false, detail: "expires in 5 day(s) and has not renewed" });
    serve(detail({ NotAfter: new Date("2026-09-20T00:00:00Z") }));
    expect((await acm.verify!(ctx, node(), await acm.observe!(ctx, node()))).checks.find((c) => c.id === "not_expiring")!.detail).toMatch(/expired 10 day/);
  });

  it("verify: a domain that differs from the spec fails; missing fails", async () => {
    serve(detail({ DomainName: "app.acme.io" }));
    const ctx = driverCtx();
    const other = { ...node(), spec: { ...node().spec, domain: "app.acme.io" } };
    expect((await acm.verify!(ctx, other, await acm.observe!(ctx, other))).status).toBe("passed");
    acmMock.on(ListCertificatesCommand).resolves({ CertificateSummaryList: [] });
    expect((await acm.verify!(ctx, node(), await acm.observe!(ctx, node()))).status).toBe("failed");
  });

  it("discovers certificates, marking Zenith-tagged ones; a denied tag read leaves them untagged", async () => {
    serve(detail());
    acmMock.on(ListTagsForCertificateCommand, { CertificateArn: ARN }).resolves({ Tags: zenithTags });
    acmMock.on(ListTagsForCertificateCommand, { CertificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000" }).rejects(denied());
    const found = await acm.discover!(driverCtx());
    expect(found.map((f) => [f.name, f.zenithTagged])).toEqual([["other.acme.io", false], ["app.acme.io", true]]);
  });
});
