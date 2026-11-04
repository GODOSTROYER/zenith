/**
 * `gcp:subnetwork` — a regional subnetwork.
 *
 * GCP subnetworks are regional, not zonal: `SubnetSpec.zone` (`a`/`b`/`c`) has
 * no effect except that each node keeps its own CIDR and name. `private` tier
 * subnets enable Private Google Access (workloads reach Google APIs without
 * external IPs); `public` tier subnets do not: on GCP "public" is a property
 * of an instance's external IP, not of the subnet.
 *
 * Cloud Run Direct VPC egress needs a subnet large enough for its instances
 * (Google recommends at least a /26). Sizing is decided by manifest expansion,
 * not here.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import type { SubnetSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { GcpCompileError } from "../../errors";
import { cloudName, parseTagDescription, tagDescription, tfLabel } from "../../naming";
import { COMPUTE, computeRegional, contractCapabilities, managedOnly, specOf } from "../../driver-util";
import { dataFragment, lastSegment, lit, ref, safeRegion } from "../../hcl";
import { makeReaders, str, tail, computePath, type ReadSpec } from "../../read-kit";

export const DRIVER_ID = "gcp.subnetwork@1";

const CIDR = /^(?:\d{1,3}\.){3}\d{1,3}\/(?:[89]|[12]\d|30)$/;

function desiredAttributes(node: ResourceNode): Record<string, unknown> {
  const s = specOf<SubnetSpec>(node);
  return { ipCidrRange: s.cidr, privateIpGoogleAccess: s.tier === "private" };
}

/** Foreign (`referenced`/`external`) nodes carry only declared attributes; Zenith demands no configuration of them. */
const expectedAttributes = managedOnly(desiredAttributes);

function compile(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const L = tfLabel(node.address);
  if (node.ownership !== "managed") {
    return dataFragment("google_compute_subnetwork", L, { name: lastSegment(node.externalRef, node.address), region: safeRegion(node.region) });
  }
  const s = specOf<SubnetSpec>(node);
  if (!CIDR.test(String(s.cidr))) throw new GcpCompileError("invalid_cidr", `${node.address}: "${lit(String(s.cidr))}" is not an IPv4 CIDR.`);
  if (s.tier !== "private" && s.tier !== "public") throw new GcpCompileError("invalid_spec", `${node.address}: tier must be private or public.`);
  safeRegion(ctx.region);
  return {
    resource: {
      google_compute_subnetwork: {
        [L]: {
          name: cloudName(ctx.namePrefix, node.address, { max: 63 }),
          description: tagDescription(ctx.tags, node, `${s.tier} subnet (zone ${lit(String(s.zone))}; GCP subnetworks are regional)`),
          region: ctx.region,
          network: ref(ctx, s.network, "id"),
          ip_cidr_range: s.cidr,
          private_ip_google_access: s.tier === "private",
        },
      },
    },
    addresses: [`google_compute_subnetwork.${L}`],
  };
}

const spec: ReadSpec = {
  driverId: DRIVER_ID,
  nativeType: "gcp:subnetwork",
  kind: "subnet",
  attributes: ["ipCidrRange", "privateIpGoogleAccess"],
  resolve: computeRegional("subnetworks", "subnetwork"),
  list: {
    url: (ctx) => `${COMPUTE}/projects/${ctx.session.projectId}/regions/${ctx.region}/subnetworks?maxResults=500`,
    itemsKey: "items",
    labelsOf: (item) => parseTagDescription(item.description),
  },
  extract(o) {
    const self = str(o.selfLink);
    const id = self ? computePath(self) : undefined;
    if (!id) throw new Error("no selfLink");
    return {
      externalId: id,
      name: tail(id),
      attributes: { ipCidrRange: str(o.ipCidrRange), privateIpGoogleAccess: typeof o.privateIpGoogleAccess === "boolean" ? o.privateIpGoogleAccess : false },
      native: { network: tail(str(o.network)), purpose: str(o.purpose), stackType: str(o.stackType), gatewayAddress: str(o.gatewayAddress) },
    };
  },
};

const readers = makeReaders(spec, expectedAttributes);

export const subnetworkDriver: ResourceDriver<GcpSession> = {
  id: DRIVER_ID,
  provider: "gcp",
  kind: "subnet",
  nativeType: "gcp:subnetwork",
  capabilities: contractCapabilities({ discover: true }),
  compile,
  observe: readers.observe,
  verify: readers.verify,
  discover: readers.discover,
  expectedAttributes,
};
