/**
 * `gcp:dns_managed_zone` — a public Cloud DNS managed zone.
 *
 * A `managed` node compiles to `google_dns_managed_zone` (public visibility,
 * DNSSEC not enabled: turning it on without the matching DS record at the
 * registrar would break resolution for validating resolvers, so that is the
 * customer's step). The zone's name servers are exported as an output: the
 * customer delegates the domain to them. A `referenced`/`external` node
 * compiles to `data.google_dns_managed_zone` only; Zenith never declares a
 * zone it does not own.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import type { DnsZoneSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { cloudName, nodeLabels, tagDescription, tfLabel } from "../../naming";
import { contractCapabilities, managedOnly, nameResolver, specOf } from "../../driver-util";
import { dataFragment, expr, lastSegment } from "../../hcl";
import { makeReaders, rec, str, tail, type ReadSpec } from "../../read-kit";
import { normalizeDomain } from "./managed-ssl-certificate";

export const DRIVER_ID = "gcp.dns_managed_zone@1";
export const DNS = "https://dns.googleapis.com/dns/v1";

function desiredAttributes(node: ResourceNode): Record<string, unknown> {
  return { dnsName: `${normalizeDomain(specOf<DnsZoneSpec>(node).name, node.address)}.`, visibility: "public" };
}

/** Foreign (`referenced`/`external`) nodes carry only declared attributes; Zenith demands no configuration of them. */
const expectedAttributes = managedOnly(desiredAttributes);

function compile(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const L = tfLabel(node.address);
  if (node.ownership !== "managed") return dataFragment("google_dns_managed_zone", L, { name: lastSegment(node.externalRef, node.address) });
  const domain = normalizeDomain(specOf<DnsZoneSpec>(node).name, node.address);
  return {
    resource: {
      google_dns_managed_zone: {
        [L]: {
          name: cloudName(ctx.namePrefix, node.address, { max: 63 }),
          dns_name: `${domain}.`,
          description: tagDescription(ctx.tags, node, "public zone", 1000),
          visibility: "public",
          labels: nodeLabels(ctx.tags, node),
          force_destroy: false,
        },
      },
    },
    output: { [`${L}_name_servers`]: { value: expr(`google_dns_managed_zone.${L}.name_servers`), description: "delegate the domain to these name servers" } },
    addresses: [`google_dns_managed_zone.${L}`],
  };
}

const spec: ReadSpec = {
  driverId: DRIVER_ID,
  nativeType: "gcp:dns_managed_zone",
  kind: "dns_zone",
  attributes: ["dnsName", "visibility"],
  resolve: nameResolver((p) => `projects/${p}/managedZones/[a-z][a-z0-9-]{0,62}`, DNS, "managed zone"),
  list: {
    url: (ctx) => `${DNS}/projects/${ctx.session.projectId}/managedZones?maxResults=100`,
    itemsKey: "managedZones",
    labelsOf: (item) => rec(item.labels),
  },
  extract(o, ctx) {
    const name = str(o.name);
    if (!name) throw new Error("no name");
    return {
      externalId: `projects/${ctx.session.projectId}/managedZones/${name}`,
      name: tail(name),
      attributes: { dnsName: str(o.dnsName), visibility: str(o.visibility) ?? "public" },
      native: { nameServerCount: Array.isArray(o.nameServers) ? o.nameServers.length : 0, dnssec: str(rec(o.dnssecConfig).state) },
    };
  },
};

const readers = makeReaders(spec, expectedAttributes);

export const dnsManagedZoneDriver: ResourceDriver<GcpSession> = {
  id: DRIVER_ID,
  provider: "gcp",
  kind: "dns_zone",
  nativeType: "gcp:dns_managed_zone",
  capabilities: contractCapabilities({ discover: true }),
  compile,
  observe: readers.observe,
  verify: readers.verify,
  discover: readers.discover,
  expectedAttributes,
};
