import {
  GetBucketEncryptionCommand,
  GetBucketOwnershipControlsCommand,
  GetBucketPolicyCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { s3BucketDriver as driver } from "@/lib/providers/aws/drivers/data";
import { bucketNameOf, NONCURRENT_EXPIRATION_DAYS } from "@/lib/providers/aws/drivers/data/s3-bucket";
import { DriverCompileError } from "@/lib/providers/aws/drivers/shared";
import { driftOf } from "./_drift";
import { awsError, bucketSpec, compileCtx, driverCtx, mkNode, tagList } from "./_helpers";

const s3 = mockClient(S3Client);
const tagging = mockClient(ResourceGroupsTaggingAPIClient);
beforeEach(() => {
  s3.reset();
  tagging.reset();
});
afterAll(() => {
  s3.restore();
  tagging.restore();
});

const node = mkNode("object_store/uploads", "object_store", bucketSpec());
const build = (spec: Record<string, unknown>, over: Partial<typeof node> = {}) => mkNode("object_store/uploads", "object_store", bucketSpec(spec), over);
const compile = (n = node) => driver.compile!(n, compileCtx([n]));
type Body = Record<string, unknown>;
const res = (f: ReturnType<typeof compile>, type: string, name: string): Body => (f.resource![type] as Record<string, Body>)[name];

describe("aws:s3_bucket compile", () => {
  it("defines the bucket first and every hardening resource after it", () => {
    expect(compile().addresses).toEqual([
      "aws_s3_bucket.object_store_uploads",
      "random_id.object_store_uploads_suffix",
      "aws_s3_bucket_public_access_block.object_store_uploads_pab",
      "aws_s3_bucket_ownership_controls.object_store_uploads_ownership",
      "aws_s3_bucket_server_side_encryption_configuration.object_store_uploads_sse",
      "aws_s3_bucket_versioning.object_store_uploads_versioning",
      "aws_s3_bucket_lifecycle_configuration.object_store_uploads_lifecycle",
      "data.aws_iam_policy_document.object_store_uploads_tls",
      "aws_s3_bucket_policy.object_store_uploads_policy",
    ]);
  });

  it("blocks all public access, disables ACLs and names the bucket with a stable random suffix", () => {
    const f = compile();
    expect(res(f, "aws_s3_bucket_public_access_block", "object_store_uploads_pab")).toMatchObject({ block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true });
    expect(res(f, "aws_s3_bucket_ownership_controls", "object_store_uploads_ownership").rule).toEqual({ object_ownership: "BucketOwnerEnforced" });
    expect(res(f, "aws_s3_bucket", "object_store_uploads").bucket).toBe("zen-prod-uploads-${random_id.object_store_uploads_suffix.hex}");
    expect(res(f, "random_id", "object_store_uploads_suffix")).toEqual({ byte_length: 4 });
  });

  it("encrypts with aws:kms and bucket keys by default, AES256 on request", () => {
    expect(res(compile(), "aws_s3_bucket_server_side_encryption_configuration", "object_store_uploads_sse").rule).toEqual({
      apply_server_side_encryption_by_default: { sse_algorithm: "aws:kms" },
      bucket_key_enabled: true,
    });
    expect(res(compile(build({ config: { encryption: "AES256" } })), "aws_s3_bucket_server_side_encryption_configuration", "object_store_uploads_sse").rule).toEqual({
      apply_server_side_encryption_by_default: { sse_algorithm: "AES256" },
    });
  });

  it("follows spec.versioning, with the noncurrent-version rule only when versioning is on", () => {
    const rules = (n: typeof node) => (res(compile(n), "aws_s3_bucket_lifecycle_configuration", "object_store_uploads_lifecycle").rule as Body[]).map((r) => r.id);
    expect(res(compile(), "aws_s3_bucket_versioning", "object_store_uploads_versioning").versioning_configuration).toEqual({ status: "Enabled" });
    expect(rules(node)).toEqual(["zenith-abort-incomplete-multipart", "zenith-expire-noncurrent-versions"]);
    const off = build({ versioning: false });
    expect(res(compile(off), "aws_s3_bucket_versioning", "object_store_uploads_versioning").versioning_configuration).toEqual({ status: "Suspended" });
    expect(rules(off)).toEqual(["zenith-abort-incomplete-multipart"]);
    const lifecycle = res(compile(), "aws_s3_bucket_lifecycle_configuration", "object_store_uploads_lifecycle").rule as Body[];
    expect(lifecycle[0].abort_incomplete_multipart_upload).toEqual({ days_after_initiation: 7 });
    expect(lifecycle[1].noncurrent_version_expiration).toEqual({ noncurrent_days: NONCURRENT_EXPIRATION_DAYS });
  });

  it("denies plain HTTP and old TLS with a Deny-only bucket policy", () => {
    const f = compile();
    const doc = (f.data!.aws_iam_policy_document as Record<string, { statement: Body[] }>).object_store_uploads_tls;
    expect(doc.statement.map((s) => [s.sid, s.effect])).toEqual([
      ["DenyInsecureTransport", "Deny"],
      ["DenyOutdatedTls", "Deny"],
    ]);
    expect(doc.statement[0].condition).toEqual([{ test: "Bool", variable: "aws:SecureTransport", values: ["false"] }]);
    expect(doc.statement.every((s) => s.effect === "Deny")).toBe(true);
    expect(res(f, "aws_s3_bucket_policy", "object_store_uploads_policy").policy).toBe("${data.aws_iam_policy_document.object_store_uploads_tls.json}");
  });

  it.each([
    ["deny", false],
    ["approval", false],
    ["allow", true],
  ] as const)("deletionPolicy %s → force_destroy %s", (policy, force) => {
    expect(res(compile(build({ deletionPolicy: policy })), "aws_s3_bucket", "object_store_uploads").force_destroy).toBe(force);
  });

  it("chains the bucket sub-resources so S3 never sees conflicting concurrent changes", () => {
    const f = compile();
    const chain = ["public_access_block", "ownership_controls", "server_side_encryption_configuration", "versioning", "lifecycle_configuration", "policy"];
    const deps = chain.map((c) => res(f, `aws_s3_bucket_${c}`, `object_store_uploads_${{ public_access_block: "pab", ownership_controls: "ownership", server_side_encryption_configuration: "sse", versioning: "versioning", lifecycle_configuration: "lifecycle", policy: "policy" }[c]}`).depends_on);
    expect(deps[0]).toBeUndefined();
    for (let i = 1; i < deps.length; i++) expect((deps[i] as string[])[0]).toContain(chain[i - 1]);
  });

  it("publishes arn and id; is deterministic; non-managed nodes compile to nothing", () => {
    const f = compile();
    expect(Object.keys(f.locals!).sort()).toEqual(["ref_object_store_uploads__arn", "ref_object_store_uploads__id"]);
    expect(JSON.stringify(compile())).toBe(JSON.stringify(compile()));
    expect(compile(build({}, { ownership: "referenced", externalRef: "arn:aws:s3:::legacy" }))).toEqual({ addresses: [] });
  });

  it("refuses a public spec and unknown policies instead of compiling an open or unprotected bucket", () => {
    for (const bad of [{ publicAccess: true }, { deletionPolicy: "never" }, { config: { encryption: "none" } }]) {
      expect(() => compile(build(bad))).toThrow(DriverCompileError);
    }
  });

  it("keeps long names within 63 characters", () => {
    const n = mkNode(`object_store/${"y".repeat(40)}`, "object_store", bucketSpec());
    const f = driver.compile!(n, compileCtx([n]));
    const raw = Object.values(f.resource!.aws_s3_bucket as Record<string, Body>)[0].bucket as string;
    const stem = raw.replace(/-\$\{random_id\.[^}]+\}$/, "");
    expect(stem).not.toBe(raw);
    // the 8-hex random suffix and its hyphen are appended to the stem
    expect(stem.length + 9).toBeLessThanOrEqual(63);
    expect(stem).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
  });
});

const BUCKET = "zen-prod-uploads-1a2b3c4d";
const ARN = `arn:aws:s3:::${BUCKET}`;

function healthyBucket() {
  s3.on(HeadBucketCommand).resolves({ BucketRegion: "ap-south-1" });
  s3.on(GetBucketVersioningCommand).resolves({ Status: "Enabled" });
  s3.on(GetPublicAccessBlockCommand).resolves({ PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true } });
  s3.on(GetBucketEncryptionCommand).resolves({ ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms" }, BucketKeyEnabled: true }] } });
  s3.on(GetBucketOwnershipControlsCommand).resolves({ OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] } });
  s3.on(GetBucketPolicyCommand).resolves({ Policy: JSON.stringify({ Statement: [{ Effect: "Deny", Principal: "*", Action: "s3:*", Resource: [ARN], Condition: { Bool: { "aws:SecureTransport": "false" } } }] }) });
  s3.on(GetBucketTaggingCommand).resolves({ TagSet: tagList("object_store/uploads") });
}

describe("aws:s3_bucket observe", () => {
  it("reads versioning, public access, encryption, ownership, policy and tags; matches the spec", async () => {
    healthyBucket();
    const obs = await driver.observe!(driverCtx(), node, ARN);
    expect(obs).toMatchObject({ presence: "present", externalId: ARN, source: "aws.s3_bucket@1" });
    const v = (n: string) => (obs.attributes[n] as { value: unknown }).value;
    expect([v("versioning"), v("publicAccessAllowed"), v("encryption"), v("objectOwnership"), v("denyInsecureTransport"), v("bucketKeyEnabled")]).toEqual([true, false, "aws:kms", "BucketOwnerEnforced", true, true]);
    expect(obs.native).toMatchObject({ bucketName: BUCKET, region: "ap-south-1" });
    expect((obs.native as { tags: Record<string, string> }).tags["zenith:resource"]).toBe("object_store/uploads");
    expect(driftOf(node, obs, driver.expectedAttributes!)).toEqual([]);
  });

  it("treats an ABSENT sub-configuration as a known answer (no PAB → public access allowed), not as unknown", async () => {
    healthyBucket();
    s3.on(GetPublicAccessBlockCommand).rejects(awsError("NoSuchPublicAccessBlockConfiguration", "none", 404));
    s3.on(GetBucketEncryptionCommand).rejects(awsError("ServerSideEncryptionConfigurationNotFoundError", "none", 404));
    s3.on(GetBucketPolicyCommand).rejects(awsError("NoSuchBucketPolicy", "none", 404));
    s3.on(GetBucketTaggingCommand).rejects(awsError("NoSuchTagSet", "none", 404));
    s3.on(GetBucketOwnershipControlsCommand).rejects(awsError("OwnershipControlsNotFoundError", "none", 404));
    const obs = await driver.observe!(driverCtx(), node, BUCKET);
    const v = (n: string) => (obs.attributes[n] as { state: string; value: unknown });
    expect(v("publicAccessAllowed")).toMatchObject({ state: "known", value: true });
    expect(v("encryption")).toMatchObject({ state: "known", value: "none" });
    expect(v("denyInsecureTransport")).toMatchObject({ state: "known", value: false });
    expect(v("objectOwnership")).toMatchObject({ state: "known", value: "ObjectWriter" });
    expect((obs.native as { tags: unknown }).tags).toEqual({});
    const f = driftOf(node, obs, driver.expectedAttributes!);
    expect(f[0]).toMatchObject({ class: "changed", severity: "high" });
    expect(f[0].fields!.map((x) => x.attribute).sort()).toEqual(["denyInsecureTransport", "encryption", "objectOwnership", "publicAccessAllowed"]);
  });

  it("fails sub-reads independently: one denied call makes one attribute unknown and the rest stay known", async () => {
    healthyBucket();
    s3.on(GetBucketEncryptionCommand).rejects(awsError("AccessDenied", "no", 403));
    const obs = await driver.observe!(driverCtx(), node, ARN);
    expect(obs.presence).toBe("present");
    expect(obs.attributes.encryption).toMatchObject({ state: "unknown", reason: "access_denied" });
    expect(obs.attributes.bucketKeyEnabled).toMatchObject({ state: "unknown", reason: "access_denied" });
    expect(obs.attributes.versioning).toMatchObject({ state: "known", value: true });
  });

  it("marks tags unreadable (not empty) when GetBucketTagging is denied", async () => {
    healthyBucket();
    s3.on(GetBucketTaggingCommand).rejects(awsError("AccessDenied", "no", 403));
    const obs = await driver.observe!(driverCtx(), node, ARN);
    expect(obs.native).toMatchObject({ tagsUnreadable: true });
    expect(obs.native).not.toHaveProperty("tags");
  });

  it("classifies a missing bucket, a forbidden bucket and throttling at HeadBucket", async () => {
    s3.on(HeadBucketCommand).rejects(awsError("NotFound", "Not Found", 404));
    expect((await driver.observe!(driverCtx(), node, ARN)).presence).toBe("missing");
    s3.on(HeadBucketCommand).rejects(awsError("Forbidden", "Forbidden", 403));
    expect((await driver.observe!(driverCtx(), node, ARN)).presence).toBe("inaccessible");
    s3.on(HeadBucketCommand).rejects(awsError("SlowDown", "Please reduce your request rate", 503));
    expect((await driver.observe!(driverCtx(), node, ARN)).presence).toBe("unknown");
  });

  it("finds the bucket by Zenith tags when no id is known, and never guesses between two", async () => {
    healthyBucket();
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: ARN }] });
    const obs = await driver.observe!(driverCtx(), node);
    expect(obs.presence).toBe("present");
    expect(tagging.commandCalls(GetResourcesCommand)[0].args[0].input.ResourceTypeFilters).toEqual(["s3"]);
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: ARN }, { ResourceARN: `${ARN}-2` }] });
    expect((await driver.observe!(driverCtx(), node)).presence).toBe("unknown");
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [] });
    expect((await driver.observe!(driverCtx(), node)).presence).toBe("missing");
  });

  it("accepts only bucket names and bucket ARNs, never an object ARN or another service", async () => {
    expect(bucketNameOf(ARN)).toBe(BUCKET);
    expect(bucketNameOf(BUCKET)).toBe(BUCKET);
    expect(bucketNameOf(`${ARN}/key`)).toBeUndefined();
    expect(bucketNameOf("arn:aws:sqs:ap-south-1:123456789012:q")).toBeUndefined();
    expect(bucketNameOf("Not_A_Bucket")).toBeUndefined();
    const obs = await driver.observe!(driverCtx(), node, `${ARN}/key`);
    expect(obs.presence).toBe("unknown");
    expect(s3.calls()).toHaveLength(0);
  });

  it("declares no runtime, and verify checks the security posture", async () => {
    expect(driver.runtime).toBeUndefined();
    expect(driver.capabilities.runtime).toBe(false);
    healthyBucket();
    const ctx = driverCtx();
    const good = await driver.verify!(ctx, node, await driver.observe!(ctx, node, ARN));
    expect(good.status).toBe("passed");
    s3.on(GetPublicAccessBlockCommand).resolves({ PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: false, IgnorePublicAcls: true, RestrictPublicBuckets: true } });
    const bad = await driver.verify!(ctx, node, await driver.observe!(ctx, node, ARN));
    expect(bad.status).toBe("failed");
    expect(bad.checks.find((c) => c.id === "public_access_blocked")!.passed).toBe(false);
  });
});

describe("aws:s3_bucket discover", () => {
  it("lists buckets in the region, reads tags within a bound, marks Zenith-tagged ones", async () => {
    s3.on(ListBucketsCommand).resolves({ Buckets: [{ Name: BUCKET, CreationDate: new Date("2026-01-01T00:00:00Z") }, { Name: "other-bucket" }] });
    s3.on(GetBucketTaggingCommand, { Bucket: BUCKET }).resolves({ TagSet: tagList("object_store/uploads") });
    s3.on(GetBucketTaggingCommand, { Bucket: "other-bucket" }).rejects(awsError("NoSuchTagSet", "none", 404));
    const found = await driver.discover!(driverCtx());
    expect(found.map((f) => [f.name, f.zenithTagged])).toEqual([
      ["other-bucket", false],
      [BUCKET, true],
    ]);
    expect(s3.commandCalls(ListBucketsCommand)[0].args[0].input).toMatchObject({ BucketRegion: "ap-south-1" });
    expect(found[1]).toMatchObject({ provider: "aws", kind: "object_store", nativeType: "aws:s3_bucket", externalId: ARN });
  });
});
