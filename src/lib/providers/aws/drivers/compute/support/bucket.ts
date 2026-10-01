/**
 * A private, encrypted S3 bucket, hardened the same way wherever a compute
 * driver needs one (a build pipeline's source-bundle bucket, a static site's
 * origin bucket): all four public-access blocks on, bucket-owner-enforced
 * ownership (ACLs off), SSE-S3 default encryption, optional expiry of old
 * objects, `force_destroy` because both uses hold rebuildable artifacts.
 *
 * Bucket names are global, so the name carries a `random_id` suffix (the
 * `random` provider is part of the aws provider set); the name is otherwise
 * `${namePrefix}-<name>` cut to leave room for it.
 */
import type { CompileContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { cloudName } from "./aws-shared";
import { Frag, TfRef, attr, cat, tagsFor, type TfCat } from "./tf";

export interface PrivateBucket {
  bucket: TfRef;
  /** the bucket name (an expression: it contains the random suffix) */
  name: TfRef;
  arn: TfRef;
}

export function emitPrivateBucket(
  b: Frag,
  node: ResourceNode,
  ctx: CompileContext,
  opts: { label: string; nameBase: string; expireAfterDays?: number; expirePrefix?: string }
): PrivateBucket {
  const suffix = b.resource("random_id", `${opts.label}_suffix`, { byte_length: 4 });
  // 63 = S3 limit; 8 hex + hyphen leave 54 for the readable part
  const name: TfCat = cat(cloudName(ctx.namePrefix, opts.nameBase, 54), "-", attr(suffix, "hex"));
  const bucket = b.resource("aws_s3_bucket", opts.label, { bucket: name, force_destroy: true, tags: tagsFor(ctx, node) });
  b.resource("aws_s3_bucket_public_access_block", opts.label, {
    bucket: attr(bucket, "id"),
    block_public_acls: true,
    block_public_policy: true,
    ignore_public_acls: true,
    restrict_public_buckets: true,
  });
  b.resource("aws_s3_bucket_ownership_controls", opts.label, { bucket: attr(bucket, "id"), rule: [{ object_ownership: "BucketOwnerEnforced" }] });
  b.resource("aws_s3_bucket_server_side_encryption_configuration", opts.label, {
    bucket: attr(bucket, "id"),
    rule: [{ apply_server_side_encryption_by_default: [{ sse_algorithm: "AES256" }] }],
  });
  if (opts.expireAfterDays !== undefined) {
    b.resource("aws_s3_bucket_lifecycle_configuration", opts.label, {
      bucket: attr(bucket, "id"),
      rule: [
        {
          id: "expire-old-objects",
          status: "Enabled",
          filter: [{ prefix: opts.expirePrefix ?? "" }],
          expiration: [{ days: opts.expireAfterDays }],
          abort_incomplete_multipart_upload: [{ days_after_initiation: 1 }],
        },
      ],
    });
  }
  return { bucket, name: attr(bucket, "bucket"), arn: attr(bucket, "arn") };
}
