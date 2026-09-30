/**
 * `gcp:artifact_registry_repository` — a Docker repository for
 * `container_registry`.
 *
 * Compile (google_artifact_registry_repository): `format = DOCKER`, tags
 * mutable (`ContainerRegistrySpec.immutableTags: false`), vulnerability
 * scanning `INHERITED` (on when the project has the Container Scanning API
 * enabled, which `deploy/gcp` does; this driver does not and cannot turn the
 * API on), Zenith labels. Images are rebuildable artifacts, so the repository
 * is not deletion-protected (`deletion_policy` stays DELETE); deleting it
 * deletes its images.
 *
 * Output `<label>_url`: `<region>-docker.pkg.dev/<project>/<repository>`.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import type { ContainerRegistrySpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { cloudName, nodeLabels, tfLabel } from "../../naming";
import { contractCapabilities, nameResolver, specOf } from "../../driver-util";
import { dataFragment, lastSegment, safeRegion } from "../../hcl";
import { makeReaders, rec, str, tail, type ReadSpec } from "../../read-kit";

export const DRIVER_ID = "gcp.artifact_registry_repository@1";
const AR = "https://artifactregistry.googleapis.com/v1";

function expectedAttributes(node: ResourceNode): Record<string, unknown> {
  const s = specOf<ContainerRegistrySpec>(node);
  return { format: "DOCKER", immutableTags: Boolean(s?.immutableTags), vulnerabilityScanning: "INHERITED" };
}

function compile(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const L = tfLabel(node.address);
  if (node.ownership !== "managed") {
    return dataFragment("google_artifact_registry_repository", L, { repository_id: lastSegment(node.externalRef, node.address), location: safeRegion(node.region) });
  }
  safeRegion(ctx.region);
  const s = specOf<ContainerRegistrySpec>(node);
  const addr = `google_artifact_registry_repository.${L}`;
  return {
    resource: {
      google_artifact_registry_repository: {
        [L]: {
          repository_id: cloudName(ctx.namePrefix, node.address, { max: 63 }),
          location: ctx.region,
          format: "DOCKER",
          description: "Zenith container registry",
          labels: nodeLabels(ctx.tags, node),
          docker_config: [{ immutable_tags: Boolean(s?.immutableTags) }],
          vulnerability_scanning_config: [{ enablement_config: "INHERITED" }],
        },
      },
    },
    output: {
      [`${L}_url`]: { value: `\${${addr}.location}-docker.pkg.dev/\${${addr}.project}/\${${addr}.repository_id}`, description: "registry host and path for image references" },
    },
    addresses: [addr],
  };
}

const spec: ReadSpec = {
  driverId: DRIVER_ID,
  nativeType: "gcp:artifact_registry_repository",
  kind: "container_registry",
  attributes: ["format", "immutableTags", "vulnerabilityScanning"],
  resolve: nameResolver((p) => `projects/${p}/locations/[a-z0-9-]{2,40}/repositories/[a-z][a-z0-9-]{0,62}`, AR, "Artifact Registry repository"),
  list: {
    url: (ctx) => `${AR}/projects/${ctx.session.projectId}/locations/${ctx.region}/repositories?pageSize=100`,
    itemsKey: "repositories",
    labelsOf: (item) => rec(item.labels),
  },
  extract(o) {
    const name = str(o.name);
    if (!name) throw new Error("no name");
    const scanning = rec(o.vulnerabilityScanningConfig);
    return {
      externalId: name,
      name: tail(name),
      attributes: {
        format: str(o.format),
        immutableTags: rec(o.dockerConfig).immutableTags === true,
        vulnerabilityScanning: str(scanning.enablementConfig),
      },
      native: { mode: str(o.mode), sizeBytes: str(o.sizeBytes), scanningState: str(scanning.enablementState) },
    };
  },
};

const readers = makeReaders(spec, expectedAttributes);

export const artifactRegistryRepositoryDriver: ResourceDriver<GcpSession> = {
  id: DRIVER_ID,
  provider: "gcp",
  kind: "container_registry",
  nativeType: "gcp:artifact_registry_repository",
  capabilities: contractCapabilities({ discover: true }),
  compile,
  observe: readers.observe,
  verify: readers.verify,
  discover: readers.discover,
  expectedAttributes,
};
