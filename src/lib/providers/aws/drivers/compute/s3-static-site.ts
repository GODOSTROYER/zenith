/**
 * `aws:s3_static_site` — a private S3 bucket served through CloudFront.
 *
 * The legacy Terraform export made the bucket public-read. This driver does
 * not: the bucket blocks all public access and only ONE CloudFront
 * distribution may read it, through an Origin Access Control (OAC, SigV4,
 * `AWS:SourceArn` pinned to the distribution). Viewers get HTTPS only
 * (HTTP redirects), managed CachingOptimized policy, default root object
 * `index.html`, price class 100 (North America and Europe edges).
 *
 * Bucket-policy wildcards: the policy grants `s3:GetObject` on `<bucket>/*`
 * because the object keys are not known at compile time; the statement is
 * scoped to the CloudFront service principal AND one distribution ARN.
 *
 * Custom domains: a `tls_certificate` node in this node's `dependsOn` becomes
 * the distribution's alias + ACM certificate. CloudFront only accepts
 * certificates issued in us-east-1, so a certificate node in any other region
 * is a COMPILE ERROR with that explanation. The workspace assembler emits
 * only the default provider, so a us-east-1 certificate in an environment of
 * another region additionally needs a provider alias (`aws.us_east_1`) on the
 * certificate's resources — that belongs to the ACM driver and the assembler,
 * not here (see the handoff). Expansion does not derive such a dependency for
 * static sites today; the distribution then uses its default
 * `*.cloudfront.net` domain and certificate.
 *
 * `wait_for_deployment` is false: an apply returns when CloudFront accepted
 * the configuration; the distribution needs a few minutes to reach every edge.
 * Content arrives from the site's build pipeline (codebuild-project.ts syncs
 * the build output and invalidates the cache); a site whose artifact is not
 * `built` starts empty.
 *
 * Observe: the distribution is found through the Resource Groups Tagging API
 * (CloudFront is global; that API answers for it from us-east-1) and the
 * bucket through S3. HONEST LIMIT: `@aws-sdk/client-cloudfront` is not an
 * installed dependency, so the distribution's configuration (status, aliases,
 * root object, price class, origin access) and whether it is serving CANNOT be
 * read; `verify` reports those as `unknown` checks instead of passing.
 */
import { GetBucketEncryptionCommand, GetPublicAccessBlockCommand, S3Client } from "@aws-sdk/client-s3";
import type { AwsSession } from "@/lib/credentials/types";
import type { CompileContext, ResourceDriver } from "@/lib/drivers/types";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import type { TlsCertificateSpec } from "@/lib/resources/specs";
import { attempt, attributesOf, boundNative, cloudName, failedObservation, knownValue, nodeName, parseArn, standardVerification, tfLabel, unknownReasonOf, unknownValue } from "./support/aws-shared";
import { emitPrivateBucket } from "./support/bucket";
import { compileNode } from "./support/driver-util";
import { dependencies } from "./support/refs";
import { ComputeCompileError, Frag, attr, cat, policyJson, refOf, tagsFor } from "./support/tf";
import { failureOf, findByTags } from "./support/sdk";
import { DRIVER_IDS } from "./types";

const ID = DRIVER_IDS.s3StaticSite;

/** AWS managed cache policy "CachingOptimized". */
export const CACHING_OPTIMIZED_POLICY_ID = "658327ea-f89d-4fab-a63d-7e88639e58f6";
export const CLOUDFRONT_CERT_REGION = "us-east-1";

const compile = (node: ResourceNode, ctx: CompileContext) =>
  compileNode(node, () => {
    const label = tfLabel(node.address);
    const name = nodeName(node.address);
    const b = new Frag(node.address);

    // custom domain, when a certificate node is attached
    const certs = dependencies(ctx, node, "tls_certificate");
    const aliases: string[] = [];
    let certificateArn;
    for (const cert of certs) {
      if (cert.region !== CLOUDFRONT_CERT_REGION) {
        throw new ComputeCompileError(
          "unsupported",
          `certificate ${cert.address} is in ${cert.region}, but CloudFront only accepts ACM certificates issued in ${CLOUDFRONT_CERT_REGION}. Place the certificate in ${CLOUDFRONT_CERT_REGION} (its resources need a provider alias for that region).`
        );
      }
      const domain = (cert.spec as Partial<TlsCertificateSpec>).domain;
      if (typeof domain !== "string" || !/^[A-Za-z0-9*.-]{1,253}$/.test(domain)) throw new ComputeCompileError("invalid_spec", `certificate ${cert.address} has no valid domain.`);
      aliases.push(domain);
      certificateArn ??= refOf(ctx, cert.address, "arn");
    }

    const site = emitPrivateBucket(b, node, ctx, { label: `${label}_site`, nameBase: name });
    const oacName = cloudName(ctx.namePrefix, name, 64);
    const oac = b.resource("aws_cloudfront_origin_access_control", label, {
      name: oacName,
      description: `Lets the ${node.address} distribution read its private bucket`,
      origin_access_control_origin_type: "s3",
      signing_behavior: "always",
      signing_protocol: "sigv4",
    });
    const distribution = b.resource("aws_cloudfront_distribution", label, {
      enabled: true,
      is_ipv6_enabled: true,
      comment: `Zenith static site ${node.address}`,
      default_root_object: "index.html",
      price_class: "PriceClass_100",
      http_version: "http2and3",
      wait_for_deployment: false,
      ...(aliases.length ? { aliases: [...aliases].sort() } : {}),
      origin: [{ domain_name: attr(site.bucket, "bucket_regional_domain_name"), origin_id: "site", origin_access_control_id: attr(oac, "id") }],
      default_cache_behavior: [
        {
          target_origin_id: "site",
          viewer_protocol_policy: "redirect-to-https",
          allowed_methods: ["GET", "HEAD"],
          cached_methods: ["GET", "HEAD"],
          compress: true,
          cache_policy_id: CACHING_OPTIMIZED_POLICY_ID,
        },
      ],
      restrictions: [{ geo_restriction: [{ restriction_type: "none" }] }],
      viewer_certificate: [certificateArn ? { acm_certificate_arn: certificateArn, ssl_support_method: "sni-only", minimum_protocol_version: "TLSv1.2_2021" } : { cloudfront_default_certificate: true }],
      tags: tagsFor(ctx, node, cloudName(ctx.namePrefix, name, 128)),
    });
    b.resource("aws_s3_bucket_policy", label, {
      bucket: attr(site.bucket, "id"),
      policy: policyJson(
        [
          {
            Sid: "CloudFrontReadObjects",
            Effect: "Allow",
            Principal: { Service: "cloudfront.amazonaws.com" },
            Action: ["s3:GetObject"],
            Resource: [cat(site.arn, "/*")],
            Condition: { StringEquals: { "AWS:SourceArn": attr(distribution, "arn") } },
            wildcard: "object_keys",
          },
          {
            // with ListBucket a missing key is a 404 instead of a 403
            Sid: "CloudFrontListBucket",
            Effect: "Allow",
            Principal: { Service: "cloudfront.amazonaws.com" },
            Action: ["s3:ListBucket"],
            Resource: [site.arn],
            Condition: { StringEquals: { "AWS:SourceArn": attr(distribution, "arn") } },
          },
        ],
        `${node.address} bucket policy`
      ),
    });
    b.output(`${label}_domain_name`, attr(distribution, "domain_name"), { description: `CloudFront domain of ${node.address}` });
    b.expose("bucket", site.name);
    b.expose("bucket_arn", site.arn);
    b.expose("distribution_id", attr(distribution, "id"));
    b.expose("distribution_arn", attr(distribution, "arn"));
    b.expose("distribution_domain", attr(distribution, "domain_name"));
    return b.build(distribution);
  });

/* --------------------------------- expected ------------------------------- */

function expected(_node: ResourceNode): Record<string, unknown> {
  return { distributionPresent: true, blockPublicAccess: true, encryption: "AES256" };
}

/* --------------------------------- observe -------------------------------- */

export const distributionIdOf = (arn: string): string | undefined => {
  const a = parseArn(arn);
  return a && a.service === "cloudfront" && a.resource.startsWith("distribution/") ? a.resource.slice("distribution/".length) : undefined;
};

const observe: NonNullable<ResourceDriver<AwsSession>["observe"]> = async (ctx, node, externalId): Promise<Observation> => {
  const names = Object.keys(expected(node));
  let distributionArn: string | undefined;
  let bucketName: string | undefined;
  let tags: Record<string, string> = {};
  try {
    const dists = await findByTags(ctx, node, "cloudfront:distribution", { region: CLOUDFRONT_CERT_REGION });
    if (dists.length > 1) return failedObservation(ctx, node, ID, names, { kind: "error", code: "Ambiguous", summary: `${dists.length} distributions carry the tags of ${node.address}.` });
    const d = externalId ? dists.find((x) => distributionIdOf(x.arn) === externalId) : dists[0];
    if (d) {
      distributionArn = d.arn;
      tags = d.tags;
    }
    const buckets = await findByTags(ctx, node, "s3:bucket");
    if (buckets.length > 1) return failedObservation(ctx, node, ID, names, { kind: "error", code: "Ambiguous", summary: `${buckets.length} buckets carry the tags of ${node.address}.` });
    bucketName = buckets[0] ? parseArn(buckets[0].arn)?.resource : undefined;
  } catch (e) {
    return failedObservation(ctx, node, ID, names, failureOf(ctx, e), externalId);
  }
  const id = distributionArn ? distributionIdOf(distributionArn) : undefined;
  if (!id || !bucketName) {
    return failedObservation(ctx, node, ID, names, { kind: "missing", code: "NotFoundByTags", summary: `${!id ? "The CloudFront distribution" : "The bucket"} of ${node.address} was not found by its Zenith tags (the tag index is eventually consistent).` }, id);
  }

  const s3 = ctx.session.client(S3Client);
  const pab = await attempt(() => s3.send(new GetPublicAccessBlockCommand({ Bucket: bucketName }), { abortSignal: ctx.signal }), ctx.signal);
  const enc = await attempt(() => s3.send(new GetBucketEncryptionCommand({ Bucket: bucketName }), { abortSignal: ctx.signal }), ctx.signal);
  const values: Record<string, unknown> = { distributionPresent: true };
  const attributes = attributesOf(ctx, names, values);
  if (pab.ok) {
    const c = pab.value.PublicAccessBlockConfiguration;
    attributes.blockPublicAccess = knownValue(ctx, Boolean(c?.BlockPublicAcls && c.IgnorePublicAcls && c.BlockPublicPolicy && c.RestrictPublicBuckets));
  } else if (pab.failure.code === "NoSuchPublicAccessBlockConfiguration") {
    attributes.blockPublicAccess = knownValue(ctx, false); // the API said: no public-access block configured
  } else attributes.blockPublicAccess = unknownValue(unknownReasonOf(pab.failure), pab.failure.summary);
  if (enc.ok) {
    const algo = enc.value.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm;
    attributes.encryption = algo ? knownValue(ctx, algo) : unknownValue("not_inspected");
  } else attributes.encryption = unknownValue(unknownReasonOf(enc.failure), enc.failure.summary);

  return {
    address: node.address,
    externalId: id,
    presence: "present",
    attributes,
    native: boundNative({ distributionId: id, distributionArn, bucketName, tags }, { priority: ["distributionId", "distributionArn", "bucketName", "tags"] }),
    observedAt: ctx.now().toISOString(),
    source: ID,
    simulated: false,
  };
};

export const s3StaticSiteDriver: ResourceDriver<AwsSession> = {
  id: ID,
  provider: "aws",
  kind: "static_site",
  nativeType: "aws:s3_static_site",
  capabilities: {
    compile: true,
    observe: true,
    runtime: false,
    verify: true,
    discover: false,
    operations: [],
    evidence: { compile: "contract", observe: "contract", verify: "contract" },
  },
  compile,
  observe,
  expectedAttributes: expected,
  verify: async (ctx, node, observation) => {
    const result = standardVerification(ctx, node, observation, expected(node), "The static site");
    if (observation.presence !== "present") return result;
    const checks = [
      ...result.checks,
      {
        id: "distribution_serving",
        description: "The CloudFront distribution is deployed and serving with the desired configuration",
        passed: "unknown" as const,
        detail: "The distribution's status and configuration cannot be read: @aws-sdk/client-cloudfront is not installed. Only its existence (by tags) and the bucket's privacy are verified.",
      },
    ];
    return { ...result, checks, status: checks.some((c) => c.passed === false) ? "failed" : "unknown" };
  },
};
