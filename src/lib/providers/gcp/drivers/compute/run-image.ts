/**
 * Built Cloud Run workloads bootstrap without a compile-time build result.
 * Release owns their image and records its digest on the revision template;
 * OpenTofu refresh + ignore_changes retains that image on subsequent applies.
 * Literal image artifacts remain declarative. No credentials or remote reads.
 *
 * Bootstrap digests are Google's published Cloud Deploy quickstart images:
 * https://docs.cloud.google.com/deploy/docs/deploy-app-run
 * Image availability and Cloud Run execution have not been live-verified.
 */
import type { CompileContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { GcpCompileError } from "@/lib/providers/gcp/errors";
import { lit } from "@/lib/providers/gcp/hcl";

export const BOOTSTRAP_SERVICE_IMAGE = "us-docker.pkg.dev/cloudrun/container/hello@sha256:95ade4b17adcd07623b0a0c68359e344fe54e65d0cb01b989e24c39f2fcd296a";
export const BOOTSTRAP_JOB_IMAGE = "us-docker.pkg.dev/cloudrun/container/job@sha256:8eb3f5e72586de6375abe95aa67511c57c61d35fb37d5670e4d68624a68ef916";
export const IMAGE_DIGEST_ANNOTATION = "zenith.dev/image-digest";

export function imageOf(node: ResourceNode, ctx: CompileContext): string {
  const artifact = node.spec.artifact as { type?: string; ref?: string; pipeline?: string; registry?: string } | undefined;
  if (artifact?.type === "image" && typeof artifact.ref === "string" && artifact.ref !== "") return lit(artifact.ref);
  if (artifact?.type === "built") {
    const pipeline = typeof artifact.pipeline === "string" ? ctx.node(artifact.pipeline) : undefined;
    const registry = typeof artifact.registry === "string" ? ctx.node(artifact.registry) : undefined;
    if (!pipeline || pipeline.kind !== "build_pipeline" || pipeline.provider !== "gcp" || pipeline.region !== ctx.region || pipeline.ownership !== "managed" || pipeline.spec.location !== "customer_account" || !registry || registry.kind !== "container_registry" || registry.provider !== "gcp" || registry.region !== ctx.region || registry.ownership !== "managed" || (pipeline.spec.output as { registry?: string } | undefined)?.registry !== registry.address) {
      throw new GcpCompileError("unresolved_artifact", "A built Cloud Run workload needs a matching managed customer-account pipeline and registry in this GCP region.");
    }
    return node.kind === "scheduled_job" ? BOOTSTRAP_JOB_IMAGE : BOOTSTRAP_SERVICE_IMAGE;
  }
  throw new GcpCompileError("unresolved_artifact", "Cloud Run needs an image reference or a built artifact with a customer-account pipeline and registry; blueprint artifacts are unsupported.");
}

/** Only the image and its release record are delegated, never the whole template. */
export function ignoredImageChanges(node: ResourceNode): string[] {
  if ((node.spec.artifact as { type?: string } | undefined)?.type !== "built") return [];
  const template = "template[0]";
  const container = node.kind === "scheduled_job" ? `${template}.template[0]` : template;
  return [`${container}.containers[0].image`, `${template}.annotations["${IMAGE_DIGEST_ANNOTATION}"]`];
}
