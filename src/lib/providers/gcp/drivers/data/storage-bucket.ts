/**
 * `gcp:storage_bucket` — a Cloud Storage bucket for `object_store`.
 *
 * Compile (google_storage_bucket), always:
 *   - `uniform_bucket_level_access = true` (no object ACLs);
 *   - `public_access_prevention = "enforced"` — the bucket can never be made
 *     public, which is what `ObjectStoreSpec.publicAccess: false` means here;
 *   - Google-managed encryption (the default; `encryption: true`);
 *   - versioning per `spec.versioning`; with versioning on, noncurrent
 *     versions are deleted 30 days after they stop being current (cost bound,
 *     documented; adjust by editing the spec once a retention field exists);
 *   - soft delete at Cloud Storage's default 7 days, stated explicitly so a
 *     provider default change cannot silently alter retention;
 *   - `force_destroy = false` and `deletion_policy = PREVENT` unless
 *     `deletionPolicy` is `allow` (objects are data; destroying a non-empty
 *     bucket must be an explicit, approved act).
 * The name is `<prefix>-<name>-<hash>`: bucket names are global, so a
 * deterministic environment-scoped hash keeps two environments (and two
 * customers) from colliding.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import type { ObjectStoreSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { cloudName, nodeLabels, tfLabel } from "../../naming";
import { contractCapabilities, deletionGuard, specOf } from "../../driver-util";
import { dataFragment, expr, lastSegment, safeRegion } from "../../hcl";
import { makeReaders, num, rec, str, type ReadSpec } from "../../read-kit";

export const DRIVER_ID = "gcp.storage_bucket@1";
const STORAGE = "https://storage.googleapis.com/storage/v1";
const SOFT_DELETE_SEC = 604800;

function expectedAttributes(node: ResourceNode): Record<string, unknown> {
  const s = specOf<ObjectStoreSpec>(node);
  return {
    uniformBucketLevelAccess: true,
    publicAccessPrevention: "enforced",
    versioning: s.versioning === true,
    location: node.region.toUpperCase(),
    softDeleteSeconds: SOFT_DELETE_SEC,
  };
}

function bucketName(ctx: CompileContext, node: ResourceNode): string {
  return cloudName(ctx.namePrefix, node.address, { max: 63, min: 3, unique: ctx.environmentId }).replace(/goog/g, "gog");
}

function compile(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const L = tfLabel(node.address);
  if (node.ownership !== "managed") return dataFragment("google_storage_bucket", L, { name: lastSegment(node.externalRef, node.address) });
  safeRegion(ctx.region);
  const s = specOf<ObjectStoreSpec>(node);
  const guard = deletionGuard(s);
  const versioning = s.versioning === true;
  const body: Record<string, unknown> = {
    name: bucketName(ctx, node),
    location: ctx.region.toUpperCase(),
    storage_class: "STANDARD",
    uniform_bucket_level_access: true,
    public_access_prevention: "enforced",
    versioning: [{ enabled: versioning }],
    soft_delete_policy: [{ retention_duration_seconds: SOFT_DELETE_SEC }],
    force_destroy: false,
    deletion_policy: guard.policy,
    labels: nodeLabels(ctx.tags, node),
  };
  if (versioning) body.lifecycle_rule = [{ action: [{ type: "Delete" }], condition: [{ days_since_noncurrent_time: 30, with_state: "ARCHIVED" }] }];
  return {
    resource: { google_storage_bucket: { [L]: body } },
    output: { [`${L}_name`]: { value: expr(`google_storage_bucket.${L}.name`), description: "bucket name" } },
    addresses: [`google_storage_bucket.${L}`],
  };
}

const NAME = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;

export const bucketReadSpec: ReadSpec = {
  driverId: DRIVER_ID,
  nativeType: "gcp:storage_bucket",
  kind: "object_store",
  attributes: ["uniformBucketLevelAccess", "publicAccessPrevention", "versioning", "location", "softDeleteSeconds"],
  resolve(_ctx, externalId) {
    const name = String(externalId).replace(/^projects\/_\/buckets\//, "");
    if (!NAME.test(name)) return { error: "externalId is not a bucket name." };
    return { url: `${STORAGE}/b/${name}`, externalId: name };
  },
  list: {
    url: (ctx) => `${STORAGE}/b?project=${ctx.session.projectId}&maxResults=500`,
    itemsKey: "items",
    labelsOf: (item) => rec(item.labels),
  },
  extract(o) {
    const name = str(o.name);
    if (!name) throw new Error("no name");
    const iam = rec(o.iamConfiguration);
    return {
      externalId: name,
      name,
      attributes: {
        uniformBucketLevelAccess: rec(iam.uniformBucketLevelAccess).enabled === true,
        publicAccessPrevention: str(iam.publicAccessPrevention) ?? "inherited",
        versioning: rec(o.versioning).enabled === true,
        location: str(o.location),
        softDeleteSeconds: num(rec(o.softDeletePolicy).retentionDurationSeconds),
      },
      native: { storageClass: str(o.storageClass), locationType: str(o.locationType), projectNumber: str(o.projectNumber), lifecycleRules: Array.isArray(rec(o.lifecycle).rule) ? (rec(o.lifecycle).rule as unknown[]).length : 0 },
    };
  },
};

const readers = makeReaders(bucketReadSpec, expectedAttributes);

export const storageBucketDriver: ResourceDriver<GcpSession> = {
  id: DRIVER_ID,
  provider: "gcp",
  kind: "object_store",
  nativeType: "gcp:storage_bucket",
  capabilities: contractCapabilities({ discover: true }),
  compile,
  observe: readers.observe,
  verify: readers.verify,
  discover: readers.discover,
  expectedAttributes,
};
