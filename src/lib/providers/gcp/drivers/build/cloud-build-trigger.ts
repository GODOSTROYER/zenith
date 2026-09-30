/**
 * `gcp:cloud_build_trigger` — the `build_pipeline` build ENVIRONMENT (ADR-0016).
 *
 * The native-type table pins the name `cloud_build_trigger`, but no
 * `google_cloudbuild_trigger` is created: a trigger needs a connected source
 * repository or a webhook secret, and ADR-0016 has Zenith upload a source
 * bundle instead and never hold repository credentials. Cloud Build has no
 * persistent "project" object, so the pipeline node owns the things a build
 * needs, and builds are started per run through `build-api.ts`
 * (`builds.create` with a Cloud Storage source).
 *
 * Compiles (bucket first):
 *   google_storage_bucket                  private source-bundle bucket: uniform
 *                                          access, public access prevention
 *                                          enforced, no soft delete, bundles
 *                                          expire after 7 days, `force_destroy`
 *                                          (bundles are disposable)
 *   google_service_account                 dedicated build identity
 *   google_storage_bucket_iam_member       objectViewer on THAT bucket only
 *   google_artifact_registry_repository_iam_member   artifactregistry.writer on the
 *                                          output registry repository only
 *   google_project_iam_member              logging.logWriter (builds log to Cloud Logging)
 * and outputs `<label>_source_bucket` / `<label>_build_service_account`, which
 * the workflow passes to `startBuild`.
 *
 * `output.staticSite` is refused: there is no GCP static-site driver here.
 * `source.repo`/`ref` are not read at compile time: Zenith fetches the source
 * and uploads the bundle; they describe provenance, not configuration.
 *
 * Observation reads the source bucket (hardening attributes), which is the
 * node's external id.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import type { BuildPipelineSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { GcpCompileError } from "../../errors";
import { cloudName, nodeLabels, tagDescription, tfLabel, tfSub } from "../../naming";
import { contractCapabilities, specOf } from "../../driver-util";
import { dataFragment, expr, lastSegment, lit, ref, safeRegion } from "../../hcl";
import { makeReaders, type ReadSpec } from "../../read-kit";
import { bucketReadSpec } from "../data/storage-bucket";

export const DRIVER_ID = "gcp.cloud_build_trigger@1";

function expectedAttributes(node: ResourceNode): Record<string, unknown> {
  return { uniformBucketLevelAccess: true, publicAccessPrevention: "enforced", location: node.region.toUpperCase() };
}

function compile(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const L = tfLabel(node.address);
  if (node.ownership !== "managed") return dataFragment("google_storage_bucket", L, { name: lastSegment(node.externalRef, node.address) });
  safeRegion(ctx.region);
  const s = specOf<BuildPipelineSpec>(node);
  if (!s.output || !("registry" in s.output)) {
    throw new GcpCompileError("unsupported_output", `${node.address}: only builds that push to a container registry are supported on GCP (no static-site output).`);
  }
  if (!ctx.node(s.output.registry)) throw new GcpCompileError("unknown_registry", `${node.address}: output registry ${lit(String(s.output.registry))} is not in the graph.`);

  const bucket = `google_storage_bucket.${L}`;
  const sa = tfSub(node.address, "build");
  const member = `serviceAccount:\${google_service_account.${sa}.email}`;
  const viewer = tfSub(node.address, "src_viewer");
  const push = tfSub(node.address, "registry_writer");
  const logs = tfSub(node.address, "log_writer");
  return {
    resource: {
      google_storage_bucket: {
        [L]: {
          name: cloudName(ctx.namePrefix, node.address, { max: 63, min: 3, suffix: "src", unique: ctx.environmentId }).replace(/goog/g, "gog"),
          location: ctx.region.toUpperCase(),
          storage_class: "STANDARD",
          uniform_bucket_level_access: true,
          public_access_prevention: "enforced",
          versioning: [{ enabled: false }],
          soft_delete_policy: [{ retention_duration_seconds: 0 }],
          lifecycle_rule: [{ action: [{ type: "Delete" }], condition: [{ age: 7 }] }],
          force_destroy: true,
          labels: nodeLabels(ctx.tags, node),
        },
      },
      google_service_account: {
        [sa]: {
          account_id: cloudName(ctx.namePrefix, node.address, { max: 30, min: 6, suffix: "bld" }),
          display_name: "Zenith source build",
          description: tagDescription(ctx.tags, node, "build identity", 256),
        },
      },
      google_storage_bucket_iam_member: { [viewer]: { bucket: expr(`${bucket}.name`), role: "roles/storage.objectViewer", member } },
      google_artifact_registry_repository_iam_member: {
        [push]: { repository: ref(ctx, s.output.registry, "name"), location: ctx.region, role: "roles/artifactregistry.writer", member },
      },
      google_project_iam_member: { [logs]: { project: expr(`google_service_account.${sa}.project`), role: "roles/logging.logWriter", member } },
    },
    output: {
      [`${L}_source_bucket`]: { value: expr(`${bucket}.name`), description: "bucket that receives source bundles" },
      [`${L}_build_service_account`]: { value: expr(`google_service_account.${sa}.email`), description: "service account builds run as" },
    },
    addresses: [
      bucket,
      `google_service_account.${sa}`,
      `google_storage_bucket_iam_member.${viewer}`,
      `google_artifact_registry_repository_iam_member.${push}`,
      `google_project_iam_member.${logs}`,
    ],
  };
}

const spec: ReadSpec = {
  ...bucketReadSpec,
  driverId: DRIVER_ID,
  nativeType: "gcp:cloud_build_trigger",
  kind: "build_pipeline",
  attributes: ["uniformBucketLevelAccess", "publicAccessPrevention", "location"],
};

const readers = makeReaders(spec, expectedAttributes);

export const cloudBuildTriggerDriver: ResourceDriver<GcpSession> = {
  id: DRIVER_ID,
  provider: "gcp",
  kind: "build_pipeline",
  nativeType: "gcp:cloud_build_trigger",
  // no discover: the source bucket is found by its Zenith labels; listing buckets would misreport every bucket as a pipeline
  capabilities: contractCapabilities({}),
  compile,
  observe: readers.observe,
  verify: readers.verify,
  expectedAttributes,
};
