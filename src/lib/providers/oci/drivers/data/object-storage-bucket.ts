/**
 * `oci:object_storage_bucket` — portable `object_store` on OCI.
 *
 *   access_type  "NoPublicAccess", always. `spec.publicAccess` is typed `false`;
 *                a spec that says otherwise is refused, not honoured.
 *   versioning   "Enabled" when `spec.versioning`, else "Disabled".
 *   encryption   OCI encrypts every bucket at rest with Oracle-managed keys;
 *                `spec.encryption` (always true) is satisfied by that default.
 *                No customer-managed key is attached (that needs a vault key
 *                and a service policy; not derived today).
 *   destroy      buckets have no deletion-protection flag, so stateful buckets
 *                carry `lifecycle.prevent_destroy` unless `deletionPolicy` is
 *                "allow". OCI also refuses to delete a non-empty bucket.
 *
 * The tenancy's Object Storage NAMESPACE comes from a data source. Bucket names
 * are unique per namespace (per tenancy), so the name is
 * `${namePrefix}-<node-name>` (truncated with a hash when long).
 *
 * Observe needs the namespace first (`GET /n`), then reads the bucket
 * (`publicAccessType`, `versioning`). Buckets are found by externalId (the bucket
 * name) or by Zenith tags via `GET /n/{ns}/b?compartmentId=…&fields=tags`.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { ObjectStoreSpec } from "@/lib/resources/specs";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import { compartmentOf } from "../../context";
import { OciCompileError } from "../../errors";
import { ociCapabilities, ociDriverId } from "../../evidence";
import { auxName, cloudName, interp, nameOf, zenithTags } from "../../naming";
import {
  arrayOrItems,
  asRecord,
  asString,
  attributesOf,
  discoverWith,
  locate,
  observationOf,
  unreadableObservation,
  verifyWith,
  type LocateDef,
  type OciContext,
} from "../../observe-kit";
import { ociPath } from "../../services";
import { ociCall, type OciSession } from "../../transport";
import { addressList, isManaged, protectFromDestroy, readOnlyFragment, res, specOf } from "../shared";

export const BUCKET_NATIVE_TYPE = "oci:object_storage_bucket";
const ID = ociDriverId(BUCKET_NATIVE_TYPE);
const BUCKET_NAME = /^[A-Za-z0-9._-]{1,256}$/;

export function compileBucket(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (!isManaged(node)) return readOnlyFragment();
  const spec = specOf<ObjectStoreSpec>(node);
  if (spec.publicAccess !== false) throw new OciCompileError(`${node.address}: object stores are never public; spec.publicAccess must be false.`);
  const compartment = compartmentOf(ctx);
  const bucket = res("oci_objectstorage_bucket", node);
  const ns = `${bucket.label}_ns`;
  return {
    data: { oci_objectstorage_namespace: { [ns]: { compartment_id: compartment } } },
    resource: {
      oci_objectstorage_bucket: {
        [bucket.label]: {
          compartment_id: compartment,
          namespace: interp(`data.oci_objectstorage_namespace.${ns}.namespace`),
          name: cloudName(ctx.namePrefix, nameOf(node.address), 256),
          access_type: "NoPublicAccess",
          versioning: spec.versioning ? "Enabled" : "Disabled",
          storage_tier: "Standard",
          freeform_tags: zenithTags(ctx, node),
          ...protectFromDestroy(spec),
        },
      },
    },
    locals: { [auxName(node.address, "namespace")]: interp(`data.oci_objectstorage_namespace.${ns}.namespace`) },
    addresses: addressList(bucket.address, [`data.oci_objectstorage_namespace.${ns}`]),
  };
}

export function bucketExpected(node: ResourceNode): Record<string, unknown> {
  const spec = specOf<ObjectStoreSpec>(node);
  return { publicAccess: false, versioning: spec.versioning };
}

async function namespaceOf(ctx: OciContext, region: string): Promise<{ ok: true; namespace: string; requestId?: string } | { ok: false; message: string; denied: boolean }> {
  const r = await ociCall(ctx, { service: "objectstorage", region, method: "GET", path: ociPath("objectstorage", "n") });
  if (!r.ok) return { ok: false, message: r.message, denied: r.outcome === "denied" };
  const ns = asString(r.body);
  return ns ? { ok: true, namespace: ns, requestId: r.requestId } : { ok: false, message: "OCI returned no Object Storage namespace.", denied: false };
}

const locateDefFor = (namespace: string): LocateDef => ({
  service: "objectstorage",
  get: (name) => ({ path: ociPath("objectstorage", "n", namespace, "b", name) }),
  list: (compartmentId) => ({ path: ociPath("objectstorage", "n", namespace, "b"), query: { compartmentId, fields: "tags" } }),
  items: arrayOrItems,
  idOf: (i) => asString(asRecord(i)?.name),
  validId: (id) => BUCKET_NAME.test(id),
});

export async function observeBucket(ctx: OciContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  const ns = await namespaceOf(ctx, node.region || ctx.region);
  if (!ns.ok) return unreadableObservation(ctx, node, ID, ns.message, ns.denied ? "inaccessible" : "unknown");
  const located = await locate(ctx, node, externalId, locateDefFor(ns.namespace));
  if (located.presence !== "present" || !located.item || !located.externalId) return observationOf(ctx, node, ID, located);

  // summaries omit access type and versioning; read the bucket itself
  const r = await ociCall(ctx, { service: "objectstorage", region: node.region || ctx.region, method: "GET", path: ociPath("objectstorage", "n", ns.namespace, "b", located.externalId) });
  if (r.requestId) located.requestIds.push(r.requestId);
  const full = r.ok ? asRecord(r.body) : undefined;
  const at = ctx.now().toISOString();
  const access = asString(full?.publicAccessType);
  const versioning = asString(full?.versioning);
  const attributes = attributesOf(at, { publicAccess: access === undefined ? undefined : access !== "NoPublicAccess", versioning: versioning === undefined ? undefined : versioning === "Enabled" });
  return observationOf(ctx, node, ID, located, attributes, { name: located.externalId, publicAccessType: access ?? null, versioning: versioning ?? null, storageTier: full?.storageTier ?? null });
}

export const bucketDriver: ResourceDriver<OciSession> = {
  id: ID,
  provider: "oci",
  kind: "object_store",
  nativeType: BUCKET_NATIVE_TYPE,
  capabilities: ociCapabilities({ compile: true, observe: true, verify: true, discover: true }),
  compile: compileBucket,
  observe: observeBucket,
  expectedAttributes: bucketExpected,
  verify: async (ctx, node, observation) => verifyWith({ node, observation, expected: bucketExpected(node), now: ctx.now() }),
  discover: async (ctx) => {
    const ns = await namespaceOf(ctx, ctx.region);
    if (!ns.ok) return [];
    return discoverWith(ctx, {
      ...locateDefFor(ns.namespace),
      kind: "object_store",
      nativeType: BUCKET_NATIVE_TYPE,
      nameOf: (i) => asString(i.name) ?? "bucket",
      attributes: () => ({}),
    });
  },
};
