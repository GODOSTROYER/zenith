/**
 * `oci:subnet` — portable `subnet` on OCI.
 *
 * OCI subnets are REGIONAL: no availability domain is set, so one subnet spans
 * every AD of the region. Expansion still emits one node per zone letter; on
 * OCI they are equivalent and workloads attach to the first subnet of their
 * tier (`networkOf`). `spec.zone` is therefore informational here.
 *
 *   tier "public"   route table → internet gateway; public IPs allowed
 *   tier "private"  `prohibit_public_ip_on_vnic` AND `prohibit_internet_ingress`;
 *                   route table → NAT gateway (+ service gateway)
 *
 * Every subnet names the locked-down security list published by the VCN node
 * (`…_locked_security_list_id`), never the VCN default, so no subnet can
 * inherit an open SSH rule. Access is granted by NSG rules only.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { SubnetSpec } from "@/lib/resources/specs";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import { OciCompileError } from "../../errors";
import { compartmentOf } from "../../context";
import { ociCapabilities, ociDriverId } from "../../evidence";
import { auxRef, interp, nodeCloudName, zenithTags } from "../../naming";
import { arrayOrItems, asRecord, asString, attributesOf, discoverWith, locate, observationOf, verifyWith, type LocateDef, type OciContext } from "../../observe-kit";
import { ociPath } from "../../services";
import type { OciSession } from "../../transport";
import { addressList, assertCidr, isManaged, readOnlyFragment, res, specOf } from "../shared";

export const SUBNET_NATIVE_TYPE = "oci:subnet";
const ID = ociDriverId(SUBNET_NATIVE_TYPE);

const locateDef: LocateDef = {
  service: "core",
  get: (id) => ({ path: ociPath("core", "subnets", id) }),
  list: (compartmentId) => ({ path: ociPath("core", "subnets"), query: { compartmentId } }),
  items: arrayOrItems,
  idOf: (i) => asString(asRecord(i)?.id),
};

export function compileSubnet(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (!isManaged(node)) return readOnlyFragment();
  const spec = specOf<SubnetSpec>(node);
  if (spec.tier !== "public" && spec.tier !== "private") throw new OciCompileError(`${node.address}: subnet tier must be "public" or "private".`);
  if (typeof spec.network !== "string") throw new OciCompileError(`${node.address}: subnet spec has no network.`);
  const cidr = assertCidr(node, spec.cidr);
  const subnet = res("oci_core_subnet", node);
  const isPrivate = spec.tier === "private";
  return {
    resource: {
      oci_core_subnet: {
        [subnet.label]: {
          compartment_id: compartmentOf(ctx),
          vcn_id: ctx.ref(spec.network, "id"),
          cidr_block: cidr,
          display_name: nodeCloudName(ctx, node, 80),
          prohibit_public_ip_on_vnic: isPrivate,
          prohibit_internet_ingress: isPrivate,
          route_table_id: auxRef(spec.network, isPrivate ? "private_route_table_id" : "public_route_table_id"),
          security_list_ids: [auxRef(spec.network, "locked_security_list_id")],
          freeform_tags: zenithTags(ctx, node),
        },
      },
    },
    output: { [`${subnet.label}_id`]: { value: interp(`${subnet.address}.id`), description: `OCID of ${node.address}` } },
    addresses: addressList(subnet.address, []),
  };
}

export function subnetExpected(node: ResourceNode): Record<string, unknown> {
  const spec = specOf<SubnetSpec>(node);
  return { cidr: spec.cidr, tier: spec.tier };
}

export async function observeSubnet(ctx: OciContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  const located = await locate(ctx, node, externalId, locateDef);
  if (located.presence !== "present" || !located.item) return observationOf(ctx, node, ID, located);
  const item = located.item;
  const at = ctx.now().toISOString();
  const prohibit = item.prohibitPublicIpOnVnic;
  const attributes = attributesOf(at, {
    cidr: asString(item.cidrBlock),
    tier: typeof prohibit === "boolean" ? (prohibit ? "private" : "public") : undefined,
  });
  return observationOf(ctx, node, ID, located, attributes, { lifecycleState: item.lifecycleState, prohibitPublicIpOnVnic: prohibit, vcnId: item.vcnId, availabilityDomain: item.availabilityDomain ?? null });
}

export const subnetDriver: ResourceDriver<OciSession> = {
  id: ID,
  provider: "oci",
  kind: "subnet",
  nativeType: SUBNET_NATIVE_TYPE,
  capabilities: ociCapabilities({ compile: true, observe: true, verify: true, discover: true }),
  compile: compileSubnet,
  observe: observeSubnet,
  expectedAttributes: subnetExpected,
  verify: async (ctx, node, observation) => verifyWith({ node, observation, expected: subnetExpected(node), now: ctx.now() }),
  discover: (ctx) =>
    discoverWith(ctx, {
      ...locateDef,
      kind: "subnet",
      nativeType: SUBNET_NATIVE_TYPE,
      nameOf: (i) => asString(i.displayName) ?? asString(i.id) ?? "subnet",
      attributes: (i) => ({ cidr: asString(i.cidrBlock) ?? "", state: asString(i.lifecycleState) ?? "" }),
    }),
};
