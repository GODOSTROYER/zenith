/**
 * `oci:container_repository` — portable `container_registry` on OCI (OCIR).
 *
 * `is_public = false` always; `is_immutable` follows `spec.immutableTags`.
 * A repository's pull path is published as the output `<label>_image_path`
 * (`<region>.ocir.io/<namespace>/<name>`), using the tenancy's Object Storage
 * namespace, which is also the OCIR namespace.
 *
 * Not realized: `spec.scanOnPush`. OCIR itself has no scan-on-push switch;
 * scanning is a separate Vulnerability Scanning recipe/target that this driver
 * does not create. The node therefore does NOT claim scanning: it is absent
 * from `expectedAttributes` and from what observe reports.
 *
 * Pull access for container instances is an IAM concern: the identity node
 * grants `read repos where target.repo.name = '<name>'` for an `image_pull`
 * grant (see identity.ts).
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { ContainerRegistrySpec } from "@/lib/resources/specs";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import { compartmentOf } from "../../context";
import { ociCapabilities, ociDriverId } from "../../evidence";
import { cloudName, interp, nameOf, zenithTags } from "../../naming";
import { arrayOrItems, asRecord, asString, attributesOf, discoverWith, locate, observationOf, verifyWith, type LocateDef, type OciContext } from "../../observe-kit";
import { ociPath } from "../../services";
import type { OciSession } from "../../transport";
import { addressList, isManaged, readOnlyFragment, res, specOf } from "../shared";

export const REPOSITORY_NATIVE_TYPE = "oci:container_repository";
const ID = ociDriverId(REPOSITORY_NATIVE_TYPE);

export function compileRepository(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (!isManaged(node)) return readOnlyFragment();
  const spec = specOf<ContainerRegistrySpec>(node);
  const compartment = compartmentOf(ctx);
  const repo = res("oci_artifacts_container_repository", node);
  const ns = `${repo.label}_ns`;
  return {
    data: { oci_objectstorage_namespace: { [ns]: { compartment_id: compartment } } },
    resource: {
      oci_artifacts_container_repository: {
        [repo.label]: {
          compartment_id: compartment,
          display_name: cloudName(ctx.namePrefix, nameOf(node.address), 200),
          is_public: false,
          is_immutable: Boolean(spec.immutableTags),
          freeform_tags: zenithTags(ctx, node),
        },
      },
    },
    output: {
      [`${repo.label}_image_path`]: {
        value: `${ctx.region}.ocir.io/${interp(`data.oci_objectstorage_namespace.${ns}.namespace`)}/${interp(`${repo.address}.display_name`)}`,
        description: `Pull/push path of ${node.address}`,
      },
    },
    addresses: addressList(repo.address, [`data.oci_objectstorage_namespace.${ns}`]),
  };
}

export const repositoryExpected = (node: ResourceNode): Record<string, unknown> => ({ publicAccess: false, immutableTags: Boolean(specOf<ContainerRegistrySpec>(node).immutableTags) });

const locateDef: LocateDef = {
  service: "artifacts",
  get: (id) => ({ path: ociPath("artifacts", "container", "repositories", id) }),
  list: (compartmentId) => ({ path: ociPath("artifacts", "container", "repositories"), query: { compartmentId } }),
  items: arrayOrItems,
  idOf: (i) => asString(asRecord(i)?.id),
};

export async function observeRepository(ctx: OciContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  const located = await locate(ctx, node, externalId, locateDef);
  if (located.presence !== "present" || !located.item) return observationOf(ctx, node, ID, located);
  const item = located.item;
  const at = ctx.now().toISOString();
  const isPublic = item.isPublic;
  const immutable = item.isImmutable;
  const attributes = attributesOf(at, {
    publicAccess: typeof isPublic === "boolean" ? isPublic : undefined,
    immutableTags: typeof immutable === "boolean" ? immutable : undefined,
  });
  return observationOf(ctx, node, ID, located, attributes, { displayName: item.displayName, lifecycleState: item.lifecycleState, imageCount: item.imageCount ?? null });
}

export const repositoryDriver: ResourceDriver<OciSession> = {
  id: ID,
  provider: "oci",
  kind: "container_registry",
  nativeType: REPOSITORY_NATIVE_TYPE,
  capabilities: ociCapabilities({ compile: true, observe: true, verify: true, discover: true }),
  compile: compileRepository,
  observe: observeRepository,
  expectedAttributes: repositoryExpected,
  verify: async (ctx, node, observation) => verifyWith({ node, observation, expected: repositoryExpected(node), now: ctx.now() }),
  discover: (ctx) =>
    discoverWith(ctx, {
      ...locateDef,
      kind: "container_registry",
      nativeType: REPOSITORY_NATIVE_TYPE,
      nameOf: (i) => asString(i.displayName) ?? asString(i.id) ?? "repository",
      attributes: (i) => ({ public: i.isPublic === true }),
    }),
};
