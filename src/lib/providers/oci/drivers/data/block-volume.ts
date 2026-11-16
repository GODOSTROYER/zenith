/**
 * `oci:block_volume` — portable `volume` on OCI. MINIMAL.
 *
 * Expansion never produces a `volume` node today, so there is no spec contract
 * in `src/lib/resources/specs.ts` for it. This driver reads the two fields it
 * needs from `spec` defensively and PROPOSES them as an additive contract
 * (handoff note): `{ sizeGb: number; deletionPolicy; encryption: true }`.
 *
 *   sizeGb     integer 50 … 32768 (OCI's block volume bounds); default 50
 *   encryption OCI encrypts every block volume at rest (Oracle-managed keys)
 *   destroy    `prevent_destroy` unless `deletionPolicy` is "allow"
 *
 * A volume lives in ONE availability domain; this driver uses AD 1. It is not
 * attached to anything: attachment belongs to a compute instance driver, which
 * is not wired by this driver (VM boot volumes are managed by the VM driver).
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import { compartmentOf } from "../../context";
import { OciCompileError } from "../../errors";
import { ociCapabilities, ociDriverId } from "../../evidence";
import { auxName, interp, nodeCloudName, zenithTags } from "../../naming";
import { arrayOrItems, asNumber, asRecord, asString, attributesOf, discoverWith, locate, observationOf, verifyWith, type LocateDef, type OciContext } from "../../observe-kit";
import { ociPath } from "../../services";
import type { OciSession } from "../../transport";
import { addressList, isManaged, protectFromDestroy, readOnlyFragment, res } from "../shared";

export const VOLUME_NATIVE_TYPE = "oci:block_volume";
const ID = ociDriverId(VOLUME_NATIVE_TYPE);

/** Proposed spec shape (not yet in `specs.ts`). */
export interface OciVolumeSpec {
  sizeGb?: number;
  deletionPolicy?: "deny" | "approval" | "allow";
  encryption?: true;
}

export function volumeSize(node: ResourceNode): number {
  const raw = (node.spec as OciVolumeSpec).sizeGb ?? 50;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 50 || raw > 32768) throw new OciCompileError(`${node.address}: sizeGb must be an integer in 50..32768.`);
  return raw;
}

export function compileVolume(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (!isManaged(node)) return readOnlyFragment();
  const spec = node.spec as OciVolumeSpec;
  const compartment = compartmentOf(ctx);
  const volume = res("oci_core_volume", node);
  const ad = res("oci_identity_availability_domain", node, "_ad");
  return {
    data: { oci_identity_availability_domain: { [ad.label]: { compartment_id: compartment, ad_number: 1 } } },
    resource: {
      oci_core_volume: {
        [volume.label]: {
          compartment_id: compartment,
          availability_domain: interp(`data.${ad.address}.name`),
          display_name: nodeCloudName(ctx, node, 100),
          size_in_gbs: String(volumeSize(node)),
          vpus_per_gb: "10",
          freeform_tags: zenithTags(ctx, node),
          ...protectFromDestroy(spec),
        },
      },
    },
    locals: { [auxName(node.address, "id")]: interp(`${volume.address}.id`) },
    addresses: addressList(volume.address, [`data.${ad.address}`]),
  };
}

export const volumeExpected = (node: ResourceNode): Record<string, unknown> => ({ sizeGb: volumeSize(node) });

const locateDef: LocateDef = {
  service: "core",
  get: (id) => ({ path: ociPath("core", "volumes", id) }),
  list: (compartmentId) => ({ path: ociPath("core", "volumes"), query: { compartmentId } }),
  items: arrayOrItems,
  idOf: (i) => asString(asRecord(i)?.id),
};

export async function observeVolume(ctx: OciContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  const located = await locate(ctx, node, externalId, locateDef);
  if (located.presence !== "present" || !located.item) return observationOf(ctx, node, ID, located);
  const item = located.item;
  const at = ctx.now().toISOString();
  return observationOf(ctx, node, ID, located, attributesOf(at, { sizeGb: asNumber(item.sizeInGBs) }), { lifecycleState: item.lifecycleState, availabilityDomain: item.availabilityDomain, vpusPerGB: item.vpusPerGB ?? null });
}

export const volumeDriver: ResourceDriver<OciSession> = {
  id: ID,
  provider: "oci",
  kind: "volume",
  nativeType: VOLUME_NATIVE_TYPE,
  capabilities: ociCapabilities({ compile: true, observe: true, verify: true, discover: true }),
  compile: compileVolume,
  observe: observeVolume,
  expectedAttributes: volumeExpected,
  verify: async (ctx, node, observation) => verifyWith({ node, observation, expected: volumeExpected(node), now: ctx.now() }),
  discover: (ctx) =>
    discoverWith(ctx, {
      ...locateDef,
      kind: "volume",
      nativeType: VOLUME_NATIVE_TYPE,
      nameOf: (i) => asString(i.displayName) ?? asString(i.id) ?? "volume",
      attributes: (i) => ({ sizeGb: asNumber(i.sizeInGBs) ?? 0, state: asString(i.lifecycleState) ?? "" }),
    }),
};
