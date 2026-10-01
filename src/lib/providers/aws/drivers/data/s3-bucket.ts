/**
 * `aws:s3_bucket` driver (kind `object_store`).
 *
 * Compile (one bucket, six hardening resources, chained with `depends_on` so
 * S3's "conflicting conditional operation" never races them):
 *
 *   random_id                      a stable 4-byte suffix: bucket names are
 *                                  global, so `<prefix>-<name>` alone collides
 *                                  across accounts. Kept in state, not computed.
 *   aws_s3_bucket                  `force_destroy` only when `deletionPolicy` is
 *                                  `allow`; everything else false
 *   …_public_access_block          all four flags true
 *   …_ownership_controls           BucketOwnerEnforced (ACLs off)
 *   …_server_side_encryption_…     `aws:kms` with the AWS-managed key and S3
 *                                  Bucket Keys (default), or AES256 when
 *                                  `config.encryption = "AES256"`
 *   …_versioning                   Enabled / Suspended per `spec.versioning`
 *   …_lifecycle_configuration      abort incomplete multipart uploads after 7
 *                                  days; expire noncurrent versions after 30
 *                                  days (only when versioning is on)
 *   …_policy                       Deny every request not over TLS 1.2 or later
 *
 * The bucket policy is Deny-only with a `*` principal and `s3:*` action, which
 * is the standard TLS-enforcement statement; a policy checker that flags
 * wildcard actions must exempt `Effect = Deny`.
 *
 * Observe: HeadBucket + GetBucketVersioning, GetPublicAccessBlock,
 * GetBucketEncryption, GetBucketOwnershipControls, GetBucketPolicy and
 * GetBucketTagging. Each sub-read fails independently: a denied
 * GetBucketEncryption makes `encryption` `unknown (access_denied)` and leaves
 * the rest `known`. An absent sub-configuration (no PAB, no encryption rule, no
 * tag set, no policy) is a KNOWN answer, reported as such.
 *
 * Honest limits: no runtime (object counts need CloudWatch storage metrics,
 * which are a day old and belong to observability); the tag lookup used when
 * `externalId` is unknown goes through the eventually consistent tagging index;
 * `contract` evidence only.
 */
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
import type { CompileContext, DiscoveredResource, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { AwsSession } from "@/lib/credentials/types";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import {
  cloudName,
  DriverCompileError,
  FragmentBuilder,
  nodeName,
  paginate,
  partitionOfRegion,
  parseArn,
  REF,
  resourceTags,
  tfLabel,
} from "./_shared";
import {
  classifyAwsError,
  attrCheck,
  Attributes,
  call,
  candidate,
  configEnum,
  DELETION_POLICIES,
  EMPTY_FRAGMENT,
  expectedFor,
  failAttributes,
  findByTags,
  guardObserve,
  isManaged,
  matchesExpectedCheck,
  MAX_TAG_READS,
  safeTags,
  scalars,
  specBool,
  specEnum,
  tagMap,
  validId,
  verificationOf,
  type AwsDriverContext,
  type DeletionPolicy,
  type ReadResult,
} from "./support";

export const S3_SOURCE = "aws.s3_bucket@1";

export type S3Encryption = "aws:kms" | "AES256";
export const NONCURRENT_EXPIRATION_DAYS = 30;
export const ABORT_MULTIPART_DAYS = 7;

const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export interface S3SpecView {
  versioning: boolean;
  deletionPolicy: DeletionPolicy;
  encryption: S3Encryption;
}

export function readS3Spec(node: ResourceNode): S3SpecView {
  // `publicAccess` is `false` in the contract; anything else is refused rather than compiled into an open bucket.
  const raw = (node.spec as { publicAccess?: unknown }).publicAccess;
  if (raw !== undefined && raw !== false) throw new DriverCompileError("policy_refused", node.address, "spec.publicAccess must be false; Zenith never compiles a public bucket.");
  return {
    versioning: specBool(node, "versioning", false),
    deletionPolicy: specEnum(node, "deletionPolicy", DELETION_POLICIES),
    encryption: configEnum<S3Encryption>(node, "encryption", ["aws:kms", "AES256"]) ?? "aws:kms",
  };
}

export function compileS3Bucket(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (!isManaged(node)) return { ...EMPTY_FRAGMENT };
  const spec = readS3Spec(node);
  const label = tfLabel(node.address);
  // 63 - "-" - 8 hex of the random suffix
  const stem = cloudName(ctx.namePrefix, nodeName(node.address), 54);
  const tags = safeTags(resourceTags(ctx.tags, node.address));
  const bucketRef = `\${aws_s3_bucket.${label}.id}`;
  const b = new FragmentBuilder(node.address);

  b.resource("aws_s3_bucket", label, {
    bucket: `${stem}-\${random_id.${label}_suffix.hex}`,
    force_destroy: spec.deletionPolicy === "allow",
    tags,
  });
  b.resource("random_id", `${label}_suffix`, { byte_length: 4 });

  b.resource("aws_s3_bucket_public_access_block", `${label}_pab`, {
    bucket: bucketRef,
    block_public_acls: true,
    block_public_policy: true,
    ignore_public_acls: true,
    restrict_public_buckets: true,
  });
  b.resource("aws_s3_bucket_ownership_controls", `${label}_ownership`, {
    bucket: bucketRef,
    rule: { object_ownership: "BucketOwnerEnforced" },
    depends_on: [`aws_s3_bucket_public_access_block.${label}_pab`],
  });
  b.resource("aws_s3_bucket_server_side_encryption_configuration", `${label}_sse`, {
    bucket: bucketRef,
    rule: {
      apply_server_side_encryption_by_default: { sse_algorithm: spec.encryption },
      // Bucket Keys cut KMS request cost; they do not apply to SSE-S3.
      ...(spec.encryption === "aws:kms" ? { bucket_key_enabled: true } : {}),
    },
    depends_on: [`aws_s3_bucket_ownership_controls.${label}_ownership`],
  });
  b.resource("aws_s3_bucket_versioning", `${label}_versioning`, {
    bucket: bucketRef,
    versioning_configuration: { status: spec.versioning ? "Enabled" : "Suspended" },
    depends_on: [`aws_s3_bucket_server_side_encryption_configuration.${label}_sse`],
  });
  b.resource("aws_s3_bucket_lifecycle_configuration", `${label}_lifecycle`, {
    bucket: bucketRef,
    rule: [
      { id: "zenith-abort-incomplete-multipart", status: "Enabled", filter: {}, abort_incomplete_multipart_upload: { days_after_initiation: ABORT_MULTIPART_DAYS } },
      ...(spec.versioning
        ? [{ id: "zenith-expire-noncurrent-versions", status: "Enabled", filter: {}, noncurrent_version_expiration: { noncurrent_days: NONCURRENT_EXPIRATION_DAYS } }]
        : []),
    ],
    depends_on: [`aws_s3_bucket_versioning.${label}_versioning`],
  });
  b.data("aws_iam_policy_document", `${label}_tls`, {
    statement: [
      {
        sid: "DenyInsecureTransport",
        effect: "Deny",
        actions: ["s3:*"],
        resources: [`\${aws_s3_bucket.${label}.arn}`, `\${aws_s3_bucket.${label}.arn}/*`],
        principals: [{ type: "*", identifiers: ["*"] }],
        condition: [{ test: "Bool", variable: "aws:SecureTransport", values: ["false"] }],
      },
      {
        sid: "DenyOutdatedTls",
        effect: "Deny",
        actions: ["s3:*"],
        resources: [`\${aws_s3_bucket.${label}.arn}`, `\${aws_s3_bucket.${label}.arn}/*`],
        principals: [{ type: "*", identifiers: ["*"] }],
        condition: [{ test: "NumericLessThan", variable: "s3:TlsVersion", values: ["1.2"] }],
      },
    ],
  });
  b.resource("aws_s3_bucket_policy", `${label}_policy`, {
    bucket: bucketRef,
    policy: `\${data.aws_iam_policy_document.${label}_tls.json}`,
    depends_on: [`aws_s3_bucket_lifecycle_configuration.${label}_lifecycle`],
  });

  b.expose(REF.arn, `aws_s3_bucket.${label}.arn`);
  b.expose(REF.id, `aws_s3_bucket.${label}.id`);
  b.output(`${label}_arn`, `\${aws_s3_bucket.${label}.arn}`);
  b.output(`${label}_name`, `\${aws_s3_bucket.${label}.id}`);
  b.output(`${label}_regional_domain_name`, `\${aws_s3_bucket.${label}.bucket_regional_domain_name}`);
  return b.build();
}

/* --------------------------------- reading --------------------------------- */

const EXPECTED_NAMES = ["versioning", "publicAccessAllowed", "encryption", "objectOwnership", "denyInsecureTransport"] as const;
const INFORMATIONAL_NAMES = ["bucketKeyEnabled", "versioningStatus"] as const;
export const S3_ATTRIBUTE_NAMES: readonly string[] = [...EXPECTED_NAMES, ...INFORMATIONAL_NAMES];

export function expectedS3Attributes(node: ResourceNode): Record<string, unknown> {
  return expectedFor(node, () => buildExpectedS3(node));
}

function buildExpectedS3(node: ResourceNode): Record<string, unknown> {
  const spec = readS3Spec(node);
  return {
    versioning: spec.versioning,
    publicAccessAllowed: false,
    encryption: spec.encryption,
    objectOwnership: "BucketOwnerEnforced",
    denyInsecureTransport: true,
  };
}

/** ARN (`arn:aws:s3:::name`) or bare bucket name to the bucket name. An object ARN (`…/key`) is not a bucket. */
export function bucketNameOf(externalId: string | undefined): string | undefined {
  if (externalId === undefined || externalId === "") return undefined;
  if (externalId.startsWith("arn:")) {
    const a = parseArn(externalId);
    return a && a.service === "s3" && !a.resource.includes("/") ? validId(a.resource, BUCKET_NAME) : undefined;
  }
  return validId(externalId, BUCKET_NAME);
}

export const bucketArn = (region: string, name: string): string => `arn:${partitionOfRegion(region)}:s3:::${name}`;

/** Did this S3 error mean "that sub-configuration is not set" rather than a failure? */
const ABSENT = /^(NoSuchTagSet|NoSuchPublicAccessBlockConfiguration|ServerSideEncryptionConfigurationNotFoundError|OwnershipControlsNotFoundError|NoSuchBucketPolicy|NoSuchLifecycleConfiguration)$/;

function denyInsecureTransport(policyJson: string | undefined): boolean {
  if (!policyJson) return false;
  try {
    const doc = JSON.parse(policyJson) as { Statement?: unknown };
    const statements = Array.isArray(doc.Statement) ? doc.Statement : doc.Statement ? [doc.Statement] : [];
    return statements.some((s) => {
      const st = s as { Effect?: string; Condition?: { Bool?: Record<string, unknown> } };
      const v = st.Condition?.Bool?.["aws:SecureTransport"];
      return st.Effect === "Deny" && (v === "false" || v === false);
    });
  } catch {
    return false;
  }
}

async function resolveBucket(ctx: AwsDriverContext, node: ResourceNode, externalId: string | undefined): Promise<{ name: string } | "missing" | { ambiguous: string }> {
  const name = bucketNameOf(externalId);
  if (externalId !== undefined && externalId !== "" && name === undefined) return { ambiguous: "externalId is not an S3 bucket ARN or name" };
  if (name !== undefined) return { name };
  const { matches } = await findByTags(ctx, node, "s3");
  const buckets = matches.flatMap((m) => {
    const n = bucketNameOf(m.arn);
    return n ? [n] : [];
  });
  if (buckets.length === 0) return "missing";
  if (buckets.length > 1) return { ambiguous: `${buckets.length} buckets carry the Zenith tags for ${node.address}; refusing to choose one` };
  return { name: buckets[0] };
}

async function observeBucket(ctx: AwsDriverContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  return guardObserve(
    ctx,
    node,
    S3_SOURCE,
    S3_ATTRIBUTE_NAMES,
    externalId,
    async (): Promise<ReadResult> => {
      const found = await resolveBucket(ctx, node, externalId);
      if (found === "missing") return { kind: "missing" };
      if ("ambiguous" in found) return { kind: "ambiguous", detail: found.ambiguous };
      const Bucket = found.name;
      const s3 = ctx.session.client(S3Client);

      // Existence and access first: a missing or forbidden bucket makes every other read moot.
      const head = await call(ctx, (o) => s3.send(new HeadBucketCommand({ Bucket }), o));

      const a = new Attributes(ctx);
      let tags: Record<string, string> | undefined;
      /** One independent sub-read: failure marks only `names` unknown; an absent configuration is a known answer. */
      const sub = async <T>(names: readonly string[], read: () => Promise<T>, apply: (v: T) => void, whenAbsent: () => void): Promise<void> => {
        try {
          apply(await read());
        } catch (err) {
          const f = classifyAwsError(err, ctx.signal);
          if (f.kind === "aborted") throw err;
          if (ABSENT.test(f.code)) whenAbsent();
          else failAttributes(a.out, names, f);
        }
      };
      await Promise.all([
        sub(
          ["versioning", "versioningStatus"],
          () => call(ctx, (o) => s3.send(new GetBucketVersioningCommand({ Bucket }), o)),
          (v) => {
            a.set("versioning", v.Status === "Enabled");
            a.set("versioningStatus", v.Status ?? "none");
          },
          () => {
            a.set("versioning", false);
            a.set("versioningStatus", "none");
          }
        ),
        sub(
          ["publicAccessAllowed"],
          () => call(ctx, (o) => s3.send(new GetPublicAccessBlockCommand({ Bucket }), o)),
          (v) => {
            const c = v.PublicAccessBlockConfiguration;
            const allBlocked = c?.BlockPublicAcls === true && c?.BlockPublicPolicy === true && c?.IgnorePublicAcls === true && c?.RestrictPublicBuckets === true;
            a.set("publicAccessAllowed", !allBlocked);
          },
          () => a.set("publicAccessAllowed", true)
        ),
        sub(
          ["encryption", "bucketKeyEnabled"],
          () => call(ctx, (o) => s3.send(new GetBucketEncryptionCommand({ Bucket }), o)),
          (v) => {
            const rule = v.ServerSideEncryptionConfiguration?.Rules?.[0];
            a.set("encryption", rule?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? "none");
            a.set("bucketKeyEnabled", rule?.BucketKeyEnabled === true);
          },
          () => {
            a.set("encryption", "none");
            a.set("bucketKeyEnabled", false);
          }
        ),
        sub(
          ["objectOwnership"],
          () => call(ctx, (o) => s3.send(new GetBucketOwnershipControlsCommand({ Bucket }), o)),
          (v) => a.set("objectOwnership", v.OwnershipControls?.Rules?.[0]?.ObjectOwnership ?? "ObjectWriter"),
          () => a.set("objectOwnership", "ObjectWriter")
        ),
        sub(
          ["denyInsecureTransport"],
          () => call(ctx, (o) => s3.send(new GetBucketPolicyCommand({ Bucket }), o)),
          (v) => a.set("denyInsecureTransport", denyInsecureTransport(v.Policy)),
          () => a.set("denyInsecureTransport", false)
        ),
        sub(
          [],
          () => call(ctx, (o) => s3.send(new GetBucketTaggingCommand({ Bucket }), o)),
          (v) => {
            tags = tagMap(v.TagSet);
          },
          () => {
            tags = {};
          }
        ),
      ]);

      return {
        kind: "present",
        externalId: bucketArn(ctx.region, Bucket),
        attributes: a.finish(S3_ATTRIBUTE_NAMES),
        native: { bucketName: Bucket, region: head.BucketRegion ?? ctx.region, ...(tags ? { tags } : { tagsUnreadable: true }) },
      };
    },
    ["tags", "bucketName", "region"]
  );
}

async function discoverBuckets(ctx: AwsDriverContext): Promise<DiscoveredResource[]> {
  const s3 = ctx.session.client(S3Client);
  const { items } = await paginate(
    async (token) => {
      const out = await call(ctx, (o) => s3.send(new ListBucketsCommand({ BucketRegion: ctx.region, MaxBuckets: 1000, ...(token ? { ContinuationToken: token } : {}) }), o));
      return { items: out.Buckets ?? [], next: out.ContinuationToken || undefined };
    },
    { maxPages: 5, signal: ctx.signal }
  );
  const found: DiscoveredResource[] = [];
  let reads = 0;
  for (const bucket of items) {
    if (!bucket.Name) continue;
    let tags: Record<string, string> | undefined;
    if (reads < MAX_TAG_READS) {
      reads++;
      try {
        tags = tagMap((await call(ctx, (o) => s3.send(new GetBucketTaggingCommand({ Bucket: bucket.Name }), o))).TagSet);
      } catch (err) {
        const f = classifyAwsError(err, ctx.signal);
        if (f.kind === "aborted") throw err;
        if (ABSENT.test(f.code)) tags = {};
      }
    }
    found.push(
      candidate(ctx, {
        kind: "object_store",
        nativeType: "aws:s3_bucket",
        externalId: bucketArn(ctx.region, bucket.Name),
        name: bucket.Name,
        ...(tags ? { tags } : {}),
        attributes: scalars({ tagsRead: tags !== undefined, createdAt: bucket.CreationDate?.toISOString?.() }),
      })
    );
  }
  return found.sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0));
}

export const s3BucketDriver: ResourceDriver<AwsSession> = {
  id: S3_SOURCE,
  provider: "aws",
  kind: "object_store",
  nativeType: "aws:s3_bucket",
  capabilities: {
    compile: true,
    observe: true,
    // No runtime: object counts live in daily CloudWatch storage metrics, which observability owns.
    runtime: false,
    verify: true,
    discover: true,
    operations: [],
    evidence: { compile: "contract", observe: "contract", verify: "contract", discover: "contract" },
  },
  compile: compileS3Bucket,
  observe: observeBucket,
  expectedAttributes: expectedS3Attributes,
  async verify(ctx, node, observation) {
    const checks = [
      attrCheck(observation, "public_access_blocked", "all public access is blocked", "publicAccessAllowed", (v) => v === false),
      attrCheck(observation, "encrypted", "default encryption is on", "encryption", (v) => v === "aws:kms" || v === "AES256" || v === "aws:kms:dsse"),
      attrCheck(observation, "acls_disabled", "ACLs are disabled (BucketOwnerEnforced)", "objectOwnership", (v) => v === "BucketOwnerEnforced"),
      attrCheck(observation, "tls_only", "requests over plain HTTP are denied", "denyInsecureTransport", (v) => v === true),
      matchesExpectedCheck(expectedS3Attributes(node), observation),
    ];
    return verificationOf(ctx, node, observation, checks);
  },
  discover: discoverBuckets,
};
