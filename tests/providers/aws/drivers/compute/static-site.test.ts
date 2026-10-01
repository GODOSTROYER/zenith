/**
 * `aws:s3_static_site`: a private bucket behind CloudFront with an Origin
 * Access Control. Compile structure and the (tag + S3 based) read side.
 */
import { GetBucketEncryptionCommand, GetPublicAccessBlockCommand, S3Client } from "@aws-sdk/client-s3";
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { TofuFragment } from "@/lib/drivers/types";
import { CACHING_OPTIMIZED_POLICY_ID, distributionIdOf, s3StaticSiteDriver as driver } from "@/lib/providers/aws/drivers/compute/s3-static-site";
import { DriverCompileError, refLocalName } from "@/lib/providers/aws/drivers/compute/support/aws-shared";
import { TLS_ADDRESS, buildFullFixture, mkCompileContext, mkDriverContext, zenithTagList } from "./fixtures";

const s3 = mockClient(S3Client);
const tagging = mockClient(ResourceGroupsTaggingAPIClient);
afterAll(() => {
  s3.restore();
  tagging.restore();
});
beforeEach(() => {
  s3.reset();
  tagging.reset();
});

type Body = Record<string, unknown>;
const res = (f: TofuFragment, type: string, label: string): Body => (f.resource as Record<string, Record<string, Body>>)[type][label];
const fx = buildFullFixture();
const node = fx.site;
const compiled = driver.compile!(node, mkCompileContext(fx.byAddress));
const dist = res(compiled, "aws_cloudfront_distribution", "static_site_docs");

describe("compile", () => {
  it("serves a private bucket through ONE CloudFront distribution via Origin Access Control, never a public-read bucket", () => {
    expect(compiled.addresses[0]).toBe("aws_cloudfront_distribution.static_site_docs");
    const bucket = "static_site_docs_site";
    expect(res(compiled, "aws_s3_bucket_public_access_block", bucket)).toEqual({ bucket: `\${aws_s3_bucket.${bucket}.id}`, block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true });
    expect(res(compiled, "aws_s3_bucket_ownership_controls", bucket).rule).toEqual([{ object_ownership: "BucketOwnerEnforced" }]);
    expect(compiled.resource).not.toHaveProperty("aws_s3_bucket_website_configuration");
    expect(JSON.stringify(compiled)).not.toMatch(/public-read|"acl"|AllUsers|"Principal":"\*"|"Principal":\{"AWS":"\*"\}/);

    const oac = res(compiled, "aws_cloudfront_origin_access_control", "static_site_docs");
    expect(oac).toMatchObject({ origin_access_control_origin_type: "s3", signing_behavior: "always", signing_protocol: "sigv4" });
    const origin = (dist.origin as Body[])[0];
    expect(origin).toMatchObject({ domain_name: `\${aws_s3_bucket.${bucket}.bucket_regional_domain_name}`, origin_access_control_id: "${aws_cloudfront_origin_access_control.static_site_docs.id}" });
    expect(origin).not.toHaveProperty("s3_origin_config");
    expect(origin).not.toHaveProperty("custom_origin_config");
  });

  it("only the CloudFront service principal, for this distribution, may read; the wildcard is the object-key suffix", () => {
    const policy = JSON.parse(res(compiled, "aws_s3_bucket_policy", "static_site_docs").policy as string);
    expect(policy.Statement).toEqual([
      {
        Sid: "CloudFrontReadObjects",
        Effect: "Allow",
        Principal: { Service: "cloudfront.amazonaws.com" },
        Action: "s3:GetObject",
        Resource: "${aws_s3_bucket.static_site_docs_site.arn}/*",
        Condition: { StringEquals: { "AWS:SourceArn": "${aws_cloudfront_distribution.static_site_docs.arn}" } },
      },
      {
        Sid: "CloudFrontListBucket",
        Effect: "Allow",
        Principal: { Service: "cloudfront.amazonaws.com" },
        Action: "s3:ListBucket",
        Resource: "${aws_s3_bucket.static_site_docs_site.arn}",
        Condition: { StringEquals: { "AWS:SourceArn": "${aws_cloudfront_distribution.static_site_docs.arn}" } },
      },
    ]);
  });

  it("redirects HTTP to HTTPS, serves index.html, uses price class 100 and the managed caching policy, read-only methods", () => {
    expect(dist).toMatchObject({ enabled: true, is_ipv6_enabled: true, default_root_object: "index.html", price_class: "PriceClass_100", http_version: "http2and3", wait_for_deployment: false });
    expect((dist.default_cache_behavior as Body[])[0]).toEqual({
      target_origin_id: "site",
      viewer_protocol_policy: "redirect-to-https",
      allowed_methods: ["GET", "HEAD"],
      cached_methods: ["GET", "HEAD"],
      compress: true,
      cache_policy_id: CACHING_OPTIMIZED_POLICY_ID,
    });
    expect(dist.restrictions).toEqual([{ geo_restriction: [{ restriction_type: "none" }] }]);
    expect(dist.tags).toMatchObject({ "zenith:resource": "static_site/docs", "zenith:managed": "true" });
  });

  it("uses the certificate of an attached us-east-1 tls node as the alias and the viewer certificate", () => {
    expect(dist.aliases).toEqual(["docs.example.com"]);
    expect(dist.viewer_certificate).toEqual([{ acm_certificate_arn: `\${local.${refLocalName(TLS_ADDRESS, "arn")}}`, ssl_support_method: "sni-only", minimum_protocol_version: "TLSv1.2_2021" }]);
  });

  it("falls back to the default CloudFront certificate when no certificate is attached", () => {
    const bare = { ...node, dependsOn: ["build_pipeline/docs"] };
    const f = driver.compile!(bare, mkCompileContext(fx.byAddress));
    const d = res(f, "aws_cloudfront_distribution", "static_site_docs");
    expect(d.viewer_certificate).toEqual([{ cloudfront_default_certificate: true }]);
    expect(d).not.toHaveProperty("aliases");
  });

  it("refuses a certificate outside us-east-1 and says why", () => {
    const fx2 = buildFullFixture();
    fx2.tls.region = "eu-west-1";
    const attempt = () => driver.compile!(fx2.site, mkCompileContext(fx2.byAddress));
    expect(attempt).toThrow(DriverCompileError);
    expect(attempt).toThrow(/CloudFront only accepts ACM certificates issued in us-east-1/);
    expect(attempt).toThrow(/tls_certificate\/docs\.example\.com is in eu-west-1/);
  });

  it("refuses a certificate with no usable domain", () => {
    const fx2 = buildFullFixture();
    fx2.tls.spec = { domain: "bad domain;x", validation: "dns_automatic" };
    expect(() => driver.compile!(fx2.site, mkCompileContext(fx2.byAddress))).toThrow(/has no valid domain/);
  });

  it("publishes the attributes the build pipeline references and an output with the CloudFront domain", () => {
    expect(Object.keys(compiled.locals!).sort()).toEqual(["bucket", "bucket_arn", "distribution_arn", "distribution_domain", "distribution_id"].map((a) => refLocalName("static_site/docs", a)).sort());
    expect(compiled.output).toEqual({ static_site_docs_domain_name: { value: "${aws_cloudfront_distribution.static_site_docs.domain_name}", description: "CloudFront domain of static_site/docs" } });
  });

  it("is deterministic and compiles a non-managed site to nothing", () => {
    expect(JSON.stringify(driver.compile!(node, mkCompileContext(fx.byAddress)))).toBe(JSON.stringify(compiled));
    expect(driver.compile!({ ...node, ownership: "external" }, mkCompileContext(fx.byAddress))).toEqual({ addresses: [] });
  });

  it("declares contract evidence, no runtime and no discovery", () => {
    expect(driver.capabilities).toMatchObject({ runtime: false, discover: false, operations: [] });
    expect(Object.values(driver.capabilities.evidence).every((v) => v === "contract")).toBe(true);
  });
});

const DIST_ARN = "arn:aws:cloudfront::123456789012:distribution/E2ABCDEF12345";
const tagMap = (arn: string) => ({ ResourceARN: arn, Tags: zenithTagList("static_site/docs") });

function installFound() {
  tagging.on(GetResourcesCommand).callsFake((input: { ResourceTypeFilters?: string[] }) => ({
    ResourceTagMappingList: [input.ResourceTypeFilters?.[0] === "cloudfront:distribution" ? tagMap(DIST_ARN) : tagMap("arn:aws:s3:::zn-acme-docs-1a2b3c4d")],
  }));
  s3.on(GetPublicAccessBlockCommand).resolves({ PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } });
  s3.on(GetBucketEncryptionCommand).resolves({ ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] } });
}

describe("observe / verify", () => {
  it("finds the distribution (from us-east-1, where the tagging API serves CloudFront) and the bucket by tags, and reads the bucket's privacy", async () => {
    installFound();
    const obs = await driver.observe!(mkDriverContext(), node);
    expect(obs).toMatchObject({ presence: "present", externalId: "E2ABCDEF12345", source: "aws.s3_static_site@1" });
    expect(Object.fromEntries(Object.entries(obs.attributes).map(([k, v]) => [k, (v as { value: unknown }).value]))).toEqual({ distributionPresent: true, blockPublicAccess: true, encryption: "AES256" });
    expect(obs.native).toMatchObject({ distributionId: "E2ABCDEF12345", distributionArn: DIST_ARN, bucketName: "zn-acme-docs-1a2b3c4d" });
    expect(Object.keys(obs.attributes).sort()).toEqual(Object.keys(driver.expectedAttributes!(node)).sort());
    const types = tagging.commandCalls(GetResourcesCommand).map((c) => c.args[0].input.ResourceTypeFilters![0]);
    expect(types).toEqual(["cloudfront:distribution", "s3:bucket"]);
    expect(s3.commandCalls(GetPublicAccessBlockCommand)[0].args[0].input).toEqual({ Bucket: "zn-acme-docs-1a2b3c4d" });
  });

  it("never claims the distribution is healthy or correctly configured: verify keeps an unknown check for what it cannot read", async () => {
    installFound();
    const obs = await driver.observe!(mkDriverContext(), node);
    const v = await driver.verify!(mkDriverContext(), node, obs);
    expect(v.status).toBe("unknown");
    expect(v.checks.find((c) => c.id === "distribution_serving")).toMatchObject({ passed: "unknown", detail: expect.stringMatching(/@aws-sdk\/client-cloudfront is not installed/) });
    expect(v.checks.filter((c) => c.id !== "distribution_serving").every((c) => c.passed === true)).toBe(true);
  });

  it("verification FAILS when the bucket is not fully blocked from public access", async () => {
    installFound();
    s3.on(GetPublicAccessBlockCommand).resolves({ PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: false, RestrictPublicBuckets: true } });
    const obs = await driver.observe!(mkDriverContext(), node);
    expect(obs.attributes.blockPublicAccess).toMatchObject({ state: "known", value: false });
    expect((await driver.verify!(mkDriverContext(), node, obs)).status).toBe("failed");
    s3.on(GetPublicAccessBlockCommand).rejects(Object.assign(new Error("none"), { name: "NoSuchPublicAccessBlockConfiguration" }));
    const none = await driver.observe!(mkDriverContext(), node);
    expect(none.attributes.blockPublicAccess).toMatchObject({ state: "known", value: false });
  });

  it("degrades one attribute when a bucket read is denied", async () => {
    installFound();
    s3.on(GetBucketEncryptionCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDenied" }));
    const obs = await driver.observe!(mkDriverContext(), node);
    expect(obs.presence).toBe("present");
    expect(obs.attributes.encryption).toMatchObject({ state: "unknown", reason: "access_denied" });
    expect(obs.attributes.blockPublicAccess.state).toBe("known");
  });

  it("missing when either half is not found by tags; unknown when ambiguous; errors classified", async () => {
    tagging.on(GetResourcesCommand).callsFake((input: { ResourceTypeFilters?: string[] }) => ({ ResourceTagMappingList: input.ResourceTypeFilters?.[0] === "s3:bucket" ? [tagMap("arn:aws:s3:::b")] : [] }));
    const noDist = await driver.observe!(mkDriverContext(), node);
    expect(noDist.presence).toBe("missing");
    expect(noDist.error).toMatch(/CloudFront distribution/);
    tagging.reset();
    tagging.on(GetResourcesCommand).callsFake((input: { ResourceTypeFilters?: string[] }) => ({ ResourceTagMappingList: input.ResourceTypeFilters?.[0] === "cloudfront:distribution" ? [tagMap(DIST_ARN)] : [] }));
    const noBucket = await driver.observe!(mkDriverContext(), node);
    expect(noBucket.presence).toBe("missing");
    expect(noBucket.error).toMatch(/bucket/);
    tagging.reset();
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [tagMap(DIST_ARN), tagMap(`${DIST_ARN}2`)] });
    expect((await driver.observe!(mkDriverContext(), node)).presence).toBe("unknown");
    tagging.reset();
    tagging.on(GetResourcesCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    expect((await driver.observe!(mkDriverContext(), node)).presence).toBe("inaccessible");
  });

  it("an externalId that is not this distribution's id finds nothing", async () => {
    installFound();
    expect((await driver.observe!(mkDriverContext(), node, "EOTHER")).presence).toBe("missing");
    expect((await driver.observe!(mkDriverContext(), node, "E2ABCDEF12345")).presence).toBe("present");
  });

  it("distributionIdOf accepts only CloudFront distribution ARNs", () => {
    expect(distributionIdOf(DIST_ARN)).toBe("E2ABCDEF12345");
    expect(distributionIdOf("arn:aws:s3:::bucket")).toBeUndefined();
    expect(distributionIdOf("nonsense")).toBeUndefined();
  });

  it("re-throws an abort", async () => {
    const ac = new AbortController();
    tagging.on(GetResourcesCommand).callsFake(() => {
      ac.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    await expect(driver.observe!(mkDriverContext({ signal: ac.signal }), node)).rejects.toMatchObject({ name: "AbortError" });
  });
});
