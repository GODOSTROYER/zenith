/**
 * `gcp:vpc_network` — a custom-mode VPC plus the pieces every Zenith
 * environment network on GCP needs.
 *
 * Compiles to (primary first):
 *   google_compute_network            custom subnet mode, regional routing
 *   google_compute_global_address     Private Service Access (PSA) range, /20
 *   google_service_networking_connection   peering to Google-managed services
 *   google_compute_firewall           egress DENY to the PSA range (priority 2000)
 *   google_compute_router + _nat      only when `egress.natGateways !== "none"`
 *
 * Design notes (honest):
 *   - PSA is always created. Cloud SQL private IP and Memorystore for Redis
 *     both need it and a network can carry one service-networking connection,
 *     so it cannot be owned by the database drivers (two databases would
 *     collide on the one connection). The Service Networking API must be
 *     enabled (`deploy/gcp` does this). `NetworkSpec` has no "needs private
 *     services" flag; a future additive field could omit this for networks
 *     without stateful services.
 *   - The egress deny to the PSA range is what makes the per-source allow
 *     rules compiled by `gcp:firewall_rule` meaningful: VPC firewalls do not
 *     filter traffic into Google-managed producer networks, but they do filter
 *     egress from a workload's network interface (Cloud Run Direct VPC egress
 *     carries network tags). Allow rules are priority 1000, this deny 2000.
 *   - `egress.natGateways` `single` and `per_az` both create ONE regional Cloud
 *     NAT; Cloud NAT is regional, not per zone. Cloud Run with private-ranges
 *     egress does not need NAT for internet access; NAT serves VMs/GKE.
 *   - `NetworkSpec.cidr` is informational: a custom-mode VPC has no VPC-wide
 *     CIDR; ranges live on the subnetworks.
 *   - The VPC has no `labels` field; Zenith tags are carried in `description`.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import type { NetworkSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { cloudName, parseTagDescription, tagDescription, tfLabel, tfSub } from "../../naming";
import { COMPUTE, computeGlobal, contractCapabilities, managedOnly, specOf } from "../../driver-util";
import { dataFragment, expr, lastSegment, safeRegion } from "../../hcl";
import { makeReaders, rec, str, tail, computePath, type ReadSpec } from "../../read-kit";

export const DRIVER_ID = "gcp.vpc_network@1";

/** tofu address of this network's Private Service Access connection (for `depends_on`). */
export const psaConnectionAddress = (networkAddress: string): string => `google_service_networking_connection.${tfSub(networkAddress, "psa")}`;

function desiredAttributes(_node: ResourceNode): Record<string, unknown> {
  return { autoCreateSubnetworks: false, routingMode: "REGIONAL" };
}

/** Foreign (`referenced`/`external`) nodes carry only declared attributes; Zenith demands no configuration of them. */
const expectedAttributes = managedOnly(desiredAttributes);

function compile(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const L = tfLabel(node.address);
  if (node.ownership !== "managed") {
    return dataFragment("google_compute_network", L, { name: lastSegment(node.externalRef, node.address) });
  }
  safeRegion(ctx.region);
  const spec = specOf<NetworkSpec>(node);
  const name = cloudName(ctx.namePrefix, node.address, { max: 63 });
  const description = tagDescription(ctx.tags, node, "environment network");
  const psa = tfSub(node.address, "psa");
  const egress = tfSub(node.address, "psa_egress_deny");
  const net = `google_compute_network.${L}`;
  const PSA_PREFIX = 20;

  const resource: NonNullable<TofuFragment["resource"]> = {
    google_compute_network: {
      [L]: {
        name,
        description,
        auto_create_subnetworks: false,
        routing_mode: "REGIONAL",
        delete_default_routes_on_create: false,
      },
    },
    google_compute_global_address: {
      [psa]: {
        name: cloudName(ctx.namePrefix, node.address, { max: 63, suffix: "psa" }),
        description: tagDescription(ctx.tags, node, "private services access range"),
        purpose: "VPC_PEERING",
        address_type: "INTERNAL",
        prefix_length: PSA_PREFIX,
        network: expr(`${net}.id`),
      },
    },
    google_service_networking_connection: {
      [psa]: {
        network: expr(`${net}.id`),
        service: "servicenetworking.googleapis.com",
        reserved_peering_ranges: [expr(`google_compute_global_address.${psa}.name`)],
        // destroying the connection fails while producer instances exist; abandoning it
        // on destroy lets the network be deleted after the databases are gone.
        deletion_policy: "ABANDON",
      },
    },
    google_compute_firewall: {
      [egress]: {
        name: cloudName(ctx.namePrefix, node.address, { max: 63, suffix: "deny-psa" }),
        description: tagDescription(ctx.tags, node, "default deny to Google-managed services; allow rules are per workload"),
        network: expr(`${net}.id`),
        direction: "EGRESS",
        priority: 2000,
        destination_ranges: [`\${google_compute_global_address.${psa}.address}/\${google_compute_global_address.${psa}.prefix_length}`],
        deny: [{ protocol: "all" }],
      },
    },
  };
  const addresses = [`google_compute_network.${L}`, `google_compute_global_address.${psa}`, `google_service_networking_connection.${psa}`, `google_compute_firewall.${egress}`];

  if (spec?.egress && spec.egress.natGateways !== "none") {
    const router = tfSub(node.address, "router");
    const nat = tfSub(node.address, "nat");
    resource.google_compute_router = {
      [router]: { name: cloudName(ctx.namePrefix, node.address, { max: 63, suffix: "rtr" }), region: ctx.region, network: expr(`${net}.id`), description: tagDescription(ctx.tags, node, "cloud nat router") },
    };
    resource.google_compute_router_nat = {
      [nat]: {
        name: cloudName(ctx.namePrefix, node.address, { max: 63, suffix: "nat" }),
        region: ctx.region,
        router: expr(`google_compute_router.${router}.name`),
        nat_ip_allocate_option: "AUTO_ONLY",
        source_subnetwork_ip_ranges_to_nat: "ALL_SUBNETWORKS_ALL_IP_RANGES",
        log_config: [{ enable: true, filter: "ERRORS_ONLY" }],
      },
    };
    addresses.push(`google_compute_router.${router}`, `google_compute_router_nat.${nat}`);
  }
  return {
    resource,
    output: { [`${L}_name`]: { value: expr(`${net}.name`), description: "VPC network name" } },
    addresses,
  };
}

const spec: ReadSpec = {
  driverId: DRIVER_ID,
  nativeType: "gcp:vpc_network",
  kind: "network",
  attributes: ["autoCreateSubnetworks", "routingMode"],
  resolve: computeGlobal("networks", "VPC network"),
  list: {
    url: (ctx) => `${COMPUTE}/projects/${ctx.session.projectId}/global/networks?maxResults=500`,
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
      attributes: {
        autoCreateSubnetworks: typeof o.autoCreateSubnetworks === "boolean" ? o.autoCreateSubnetworks : false,
        routingMode: str(rec(o.routingConfig).routingMode) ?? "REGIONAL",
      },
      native: { name: str(o.name), subnetworks: Array.isArray(o.subnetworks) ? o.subnetworks.length : 0, peerings: Array.isArray(o.peerings) ? o.peerings.length : 0, mtu: o.mtu },
    };
  },
};

const readers = makeReaders(spec, expectedAttributes);

export const vpcNetworkDriver: ResourceDriver<GcpSession> = {
  id: DRIVER_ID,
  provider: "gcp",
  kind: "network",
  nativeType: "gcp:vpc_network",
  capabilities: contractCapabilities({ discover: true }),
  compile,
  observe: readers.observe,
  verify: readers.verify,
  discover: readers.discover,
  expectedAttributes,
};
