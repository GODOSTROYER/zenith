/**
 * Private OCI VM: own NSG, encrypted boot volume (Oracle-managed at rest and
 * encrypted in transit), IMDSv2, Oracle Cloud Agent and OS Management Hub plugin.
 * Instance principals are available through IMDS; a separate identity node
 * grants scoped permissions. Plugin enablement is not registration or health.
 * All evidence is contract-only; RUNNING says nothing about guest processes.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { compartmentOf } from "../../context";
import { ociCapabilities, ociDriverId } from "../../evidence";
import { auxName, interp, nodeCloudName, zenithTags } from "../../naming";
import { strictArrayOrItems, asRecord, asString, attributesOf, discoverWith, locate, observationOf, runtimeOf, verifyWith, type LocateDef } from "../../observe-kit";
import { ociPath } from "../../services";
import { ociCall, type OciSession } from "../../transport";
import { addressList, isManaged, protectFromDestroy, readOnlyFragment, res, specOf } from "../shared";
import type { ComputeInstanceSpec } from "./specs";
import { boundedNumber, cloudInitMetadata, flexibleShape, imageId, privatePlacement } from "./support";

const NATIVE = "oci:compute_instance";
const ID = ociDriverId(NATIVE);
export function compileComputeInstance(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (!isManaged(node)) return readOnlyFragment();
  const spec = specOf<ComputeInstanceSpec>(node);
  const image = imageId(node, spec.imageOcid);
  const shape = flexibleShape(node, spec.shape);
  const ocpus = boundedNumber(node, "ocpus", spec.ocpus, 1, 1, 64);
  const memory = boundedNumber(node, "memoryGb", spec.memoryGb, ocpus * 16, ocpus, Math.min(1024, ocpus * 64));
  const boot = boundedNumber(node, "bootVolumeGb", spec.bootVolumeGb, 50, 50, 32768);
  const metadata = cloudInitMetadata(node, spec.cloudInit);
  const placement = privatePlacement(ctx, node);
  const compartment = compartmentOf(ctx);
  const tags = zenithTags(ctx, node);
  const instance = res("oci_core_instance", node);
  const nsg = res("oci_core_network_security_group", node, "_nsg");
  const ad = res("oci_identity_availability_domain", node, "_ad");
  return {
    data: { oci_identity_availability_domain: { [ad.label]: { compartment_id: compartment, ad_number: 1 } } },
    resource: {
      oci_core_network_security_group: { [nsg.label]: { compartment_id: compartment, vcn_id: ctx.ref(placement.network, "id"), display_name: `${nodeCloudName(ctx, node)}-nsg`, freeform_tags: tags } },
      oci_core_instance: { [instance.label]: {
        compartment_id: compartment, availability_domain: interp(`data.${ad.address}.name`), display_name: nodeCloudName(ctx, node),
        shape, shape_config: { ocpus, memory_in_gbs: memory },
        source_details: { source_type: "image", source_id: image, boot_volume_size_in_gbs: boot },
        is_pv_encryption_in_transit_enabled: true,
        create_vnic_details: { subnet_id: ctx.ref(placement.subnets[0], "id"), assign_public_ip: false, nsg_ids: [interp(`${nsg.address}.id`)], freeform_tags: tags },
        instance_options: { are_legacy_imds_endpoints_disabled: true },
        agent_config: { is_management_disabled: false, is_monitoring_disabled: false, are_all_plugins_disabled: false, plugins_config: [{ name: "OS Management Hub Agent", desired_state: "ENABLED" }] },
        metadata, freeform_tags: tags, ...protectFromDestroy(spec),
      } },
    },
    locals: { [auxName(node.address, "nsg_id")]: interp(`${nsg.address}.id`), [auxName(node.address, "private_ip")]: interp(`${instance.address}.private_ip`) },
    addresses: addressList(instance.address, [nsg.address, `data.${ad.address}`]),
  };
}

const def: LocateDef = {
  service: "core", get: (id) => ({ path: ociPath("core", "instances", id) }),
  list: (compartmentId) => ({ path: ociPath("core", "instances"), query: { compartmentId } }),
  items: strictArrayOrItems, idOf: (i) => asString(asRecord(i)?.id),
};

const expected = (node: ResourceNode) => ({ shape: flexibleShape(node, node.spec.shape), imageOcid: node.spec.imageOcid, encryptionInTransit: true });
export const computeInstanceDriver: ResourceDriver<OciSession> = {
  id: ID, provider: "oci", kind: "compute_instance", nativeType: NATIVE,
  capabilities: ociCapabilities({ compile: true, observe: true, runtime: true, verify: true, discover: true }),
  compile: compileComputeInstance, expectedAttributes: expected,
  observe: async (ctx, node, externalId) => {
    const found = await locate(ctx, node, externalId, def);
    if (found.presence !== "present" || !found.externalId) return observationOf(ctx, node, ID, found);
    const r = await ociCall(ctx, { service: "core", region: node.region || ctx.region, method: "GET", ...def.get!(found.externalId) });
    if (r.requestId) found.requestIds.push(r.requestId);
    const full = r.ok ? asRecord(r.body) : undefined;
    return observationOf(ctx, node, ID, found, attributesOf(ctx.now().toISOString(), {
      shape: asString(full?.shape), imageOcid: asString(asRecord(full?.sourceDetails)?.imageId),
      encryptionInTransit: typeof full?.isPvEncryptionInTransitEnabled === "boolean" ? full.isPvEncryptionInTransitEnabled : undefined,
    }), { lifecycleState: full?.lifecycleState, shape: full?.shape });
  },
  runtime: async (ctx, node, externalId) => {
    const found = await locate(ctx, node, externalId, def);
    const state = found.presence === "present" ? asString(found.item?.lifecycleState) : undefined;
    const health = state === "RUNNING" ? "healthy" : ["STOPPED", "TERMINATED"].includes(state ?? "") ? "unhealthy" : ["PROVISIONING", "STARTING", "STOPPING", "TERMINATING", "MOVING"].includes(state ?? "") ? "degraded" : "unknown";
    return runtimeOf(ctx, node, ID, health, state ? { running: state === "RUNNING" ? 1 : 0 } : {}, state ? [`state:${state}`] : [`presence:${found.presence}`]);
  },
  verify: async (ctx, node, observation, runtime) => verifyWith({ node, observation, expected: expected(node), runtime, now: ctx.now() }),
  discover: (ctx) => discoverWith(ctx, { ...def, kind: "compute_instance", nativeType: NATIVE, nameOf: (i) => asString(i.displayName) ?? "instance", attributes: (i) => ({ state: asString(i.lifecycleState) ?? "", shape: asString(i.shape) ?? "" }) }),
};
