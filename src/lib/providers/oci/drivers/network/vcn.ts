/**
 * `oci:vcn` — portable `network` on OCI.
 *
 * One node compiles to everything a VCN needs to be USABLE and SAFE:
 *   oci_core_vcn                        the network (`cidr_blocks = [spec.cidr]`)
 *   oci_core_internet_gateway           for the public subnets
 *   oci_core_nat_gateway                when `egress.natGateways` is not "none".
 *                                       OCI NAT gateways are regional and highly
 *                                       available, so "single" and "per_az" are
 *                                       the same one gateway (there is no
 *                                       per-AZ NAT to buy).
 *   data oci_core_services + oci_core_service_gateway
 *                                       private access to Object Storage / OCIR
 *                                       over the Oracle network, not the NAT
 *   oci_core_route_table ×2             public → IGW; private → NAT (+ service
 *                                       gateway)
 *   oci_core_default_security_list      ADOPTS the VCN's default security list
 *                                       and replaces it with "no ingress, all
 *                                       egress". Left alone, OCI's default list
 *                                       allows SSH (tcp/22) from 0.0.0.0/0 to
 *                                       every subnet that does not name its own
 *                                       list. All real ingress is expressed as
 *                                       Network Security Group rules per
 *                                       protected node (see security-rule.ts).
 *
 * Subnets read the route-table and security-list ids from locals this node
 * publishes (`<label>_public_route_table_id`, `<label>_private_route_table_id`,
 * `<label>_locked_security_list_id`). The locked list id points at the ADOPTED
 * resource, so a subnet can never be created before the SSH rule is gone.
 *
 * Honest limits: IPv6 and additional CIDRs are not modelled; PMTUD ICMP
 * (type 3 code 4) is NOT opened from the internet, because Zenith opens no
 * ingress from 0.0.0.0/0 except `public_http` to the load balancer.
 * Observe reads the VCN, its gateways' existence and its CIDR; it does not read
 * route rules or security-list contents.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { NetworkSpec } from "@/lib/resources/specs";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import { OciCompileError } from "../../errors";
import { compartmentOf } from "../../context";
import { ociCapabilities, ociDriverId } from "../../evidence";
import { auxName, interp, nodeCloudName, zenithTags } from "../../naming";
import {
  arrayOrItems,
  asArray,
  asRecord,
  asString,
  attributesOf,
  discoverWith,
  known,
  listAll,
  locate,
  observationOf,
  unknownValue,
  verifyWith,
  type LocateDef,
  type OciContext,
} from "../../observe-kit";
import { ociPath } from "../../services";
import type { OciSession } from "../../transport";
import { addressList, assertCidr, isManaged, readOnlyFragment, res, specOf } from "../shared";

export const VCN_NATIVE_TYPE = "oci:vcn";
const ID = ociDriverId(VCN_NATIVE_TYPE);

const locateDef: LocateDef = {
  service: "core",
  get: (id) => ({ path: ociPath("core", "vcns", id) }),
  list: (compartmentId) => ({ path: ociPath("core", "vcns"), query: { compartmentId } }),
  items: arrayOrItems,
  idOf: (i) => asString(asRecord(i)?.id),
};

/** The spec has no `cidr` only for Kubernetes networks (a namespace); OCI needs one. */
function cidrOf(node: ResourceNode, spec: NetworkSpec): string {
  if (spec.cidr === undefined) throw new OciCompileError(`${node.address}: an OCI VCN needs spec.cidr (a namespace-only network belongs to Kubernetes).`);
  return assertCidr(node, spec.cidr);
}

export function compileVcn(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (!isManaged(node)) return readOnlyFragment();
  const spec = specOf<NetworkSpec>(node);
  const cidr = cidrOf(node, spec);
  const compartment = compartmentOf(ctx);
  const tags = zenithTags(ctx, node);
  const name = nodeCloudName(ctx, node, 80);
  const nat = (spec.egress?.natGateways ?? "single") !== "none";

  const vcn = res("oci_core_vcn", node);
  const igw = res("oci_core_internet_gateway", node, "_igw");
  const natGw = res("oci_core_nat_gateway", node, "_nat");
  const sgw = res("oci_core_service_gateway", node, "_sgw");
  const services = res("oci_core_services", node, "_services");
  const rtPublic = res("oci_core_route_table", node, "_rt_public");
  const rtPrivate = res("oci_core_route_table", node, "_rt_private");
  const defaultSl = res("oci_core_default_security_list", node, "_default_sl");
  const vcnId = interp(`${vcn.address}.id`);

  const privateRules: Record<string, unknown>[] = [];
  if (nat) privateRules.push({ description: "internet egress through the NAT gateway", destination: "0.0.0.0/0", destination_type: "CIDR_BLOCK", network_entity_id: interp(`${natGw.address}.id`) });
  privateRules.push({
    description: "Oracle services over the service gateway",
    destination: interp(`data.${services.address}.services[0].cidr_block`),
    destination_type: "SERVICE_CIDR_BLOCK",
    network_entity_id: interp(`${sgw.address}.id`),
  });

  const resource: NonNullable<TofuFragment["resource"]> = {
    oci_core_vcn: { [vcn.label]: { compartment_id: compartment, cidr_blocks: [cidr], display_name: name, freeform_tags: tags } },
    oci_core_internet_gateway: { [igw.label]: { compartment_id: compartment, vcn_id: vcnId, enabled: true, display_name: `${name}-igw`, freeform_tags: tags } },
    oci_core_service_gateway: {
      [sgw.label]: { compartment_id: compartment, vcn_id: vcnId, display_name: `${name}-sgw`, services: [{ service_id: interp(`data.${services.address}.services[0].id`) }], freeform_tags: tags },
    },
    oci_core_route_table: {
      [rtPublic.label]: {
        compartment_id: compartment,
        vcn_id: vcnId,
        display_name: `${name}-public`,
        route_rules: [{ description: "internet through the internet gateway", destination: "0.0.0.0/0", destination_type: "CIDR_BLOCK", network_entity_id: interp(`${igw.address}.id`) }],
        freeform_tags: tags,
      },
      [rtPrivate.label]: { compartment_id: compartment, vcn_id: vcnId, display_name: `${name}-private`, route_rules: privateRules, freeform_tags: tags },
    },
    oci_core_default_security_list: {
      [defaultSl.label]: {
        manage_default_resource_id: interp(`${vcn.address}.default_security_list_id`),
        display_name: `${name}-locked`,
        // No ingress block at all: OCI's default list would otherwise allow SSH from the internet.
        egress_security_rules: [{ description: "all egress", destination: "0.0.0.0/0", destination_type: "CIDR_BLOCK", protocol: "all", stateless: false }],
        freeform_tags: tags,
      },
    },
  };
  if (nat) {
    resource.oci_core_nat_gateway = { [natGw.label]: { compartment_id: compartment, vcn_id: vcnId, display_name: `${name}-nat`, freeform_tags: tags } };
  }

  return {
    data: {
      oci_core_services: {
        [services.label]: {
          filter: [{ name: "name", values: ["All .* Services In Oracle Services Network"], regex: true }],
          lifecycle: { postcondition: [{ condition: interp("length(self.services) > 0"), error_message: "No 'All <region> Services In Oracle Services Network' entry was found for the service gateway." }] },
        },
      },
    },
    resource,
    locals: {
      [auxName(node.address, "public_route_table_id")]: interp(`${rtPublic.address}.id`),
      [auxName(node.address, "private_route_table_id")]: interp(`${rtPrivate.address}.id`),
      [auxName(node.address, "locked_security_list_id")]: interp(`${defaultSl.address}.id`),
    },
    addresses: addressList(vcn.address, [igw.address, sgw.address, rtPublic.address, rtPrivate.address, defaultSl.address, `data.${services.address}`, ...(nat ? [natGw.address] : [])]),
  };
}

export function vcnExpected(node: ResourceNode): Record<string, unknown> {
  const spec = specOf<NetworkSpec>(node);
  return { cidr: spec.cidr, internetGateway: true, natGateway: (spec.egress?.natGateways ?? "single") !== "none" };
}

async function gatewayPresent(ctx: OciContext, node: ResourceNode, segment: string, vcnId: string): Promise<boolean | undefined> {
  const listed = await listAll(ctx, { service: "core", region: node.region || ctx.region, method: "GET", path: ociPath("core", segment), query: { compartmentId: ctx.session.compartmentOcid, vcnId } }, arrayOrItems);
  if (!listed.ok) return undefined;
  if (listed.truncated) return listed.items.some((g) => asString(asRecord(g)?.lifecycleState) === "AVAILABLE") ? true : undefined;
  return listed.items.some((g) => asString(asRecord(g)?.lifecycleState) === "AVAILABLE");
}

export async function observeVcn(ctx: OciContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  const located = await locate(ctx, node, externalId, locateDef);
  if (located.presence !== "present" || !located.item) return observationOf(ctx, node, ID, located);
  const item = located.item;
  const at = ctx.now().toISOString();
  const vcnId = asString(item.id);
  const cidr = asString(item.cidrBlock) ?? asString(asArray(item.cidrBlocks)[0]);
  const attributes = attributesOf(at, { cidr });
  if (vcnId) {
    attributes.internetGateway = gwValue(await gatewayPresent(ctx, node, "internetGateways", vcnId), at);
    attributes.natGateway = gwValue(await gatewayPresent(ctx, node, "natGateways", vcnId), at);
  } else {
    attributes.internetGateway = unknownValue("not_inspected");
    attributes.natGateway = unknownValue("not_inspected");
  }
  return observationOf(ctx, node, ID, located, attributes, { lifecycleState: item.lifecycleState, cidrBlocks: item.cidrBlocks, displayName: item.displayName });
}

const gwValue = (present: boolean | undefined, at: string) => (present === undefined ? unknownValue("error", "gateway listing failed") : known(present, at));

export const vcnDriver: ResourceDriver<OciSession> = {
  id: ID,
  provider: "oci",
  kind: "network",
  nativeType: VCN_NATIVE_TYPE,
  capabilities: ociCapabilities({ compile: true, observe: true, verify: true, discover: true }),
  compile: compileVcn,
  observe: observeVcn,
  expectedAttributes: vcnExpected,
  verify: async (ctx, node, observation) => verifyWith({ node, observation, expected: vcnExpected(node), now: ctx.now() }),
  discover: (ctx) =>
    discoverWith(ctx, {
      ...locateDef,
      kind: "network",
      nativeType: VCN_NATIVE_TYPE,
      nameOf: (i) => asString(i.displayName) ?? asString(i.id) ?? "vcn",
      attributes: (i) => ({ cidr: asString(i.cidrBlock) ?? "", state: asString(i.lifecycleState) ?? "" }),
    }),
};

