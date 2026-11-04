/**
 * `oci:dns_zone` (referenced → data source) and `oci:dns_rrset`.
 *
 * ZONE. Zenith never creates a customer's zone. The zone node compiles to a
 * `data "oci_dns_zones"` lookup (GLOBAL scope, PRIMARY, ACTIVE, exact `name`)
 * in the Zenith compartment, guarded by a `postcondition` that fails the plan
 * if it is not found exactly once. Honest limit: the zone must live in the
 * compartment Zenith is connected to (or be made visible there); zones in
 * other compartments are not searched. The zone's id is published as
 * `local.<zone>_id`.
 *
 * RRSET. A `dns_record` (type "alias") becomes an `oci_dns_rrset` of type A
 * pointing at the load balancer's RESERVED public IP (published by the load
 * balancer node as `local.<lb>_public_ip`), TTL 300. OCI DNS has no account-
 * level "alias to a load balancer" record for this case, and an A record to a
 * reserved IP survives load-balancer replacement. Only a load-balancer target
 * is supported; an alias to anything else (a static site, a worker) has no OCI
 * meaning here and is refused.
 *
 * `oci_dns_rrset` owns the WHOLE record set: applying it REPLACES any records
 * already at that name and type. Zenith only derives DNS for hosts the user
 * asked it to manage (`managedDns`), so the replacement is intended, but it
 * is exactly why `dns.modify` is a high-risk capability.
 *
 * Observe reads the zone by name and the rrset by (zone, domain, type). Record
 * sets carry no tags; a record set is `present` when it has items, and
 * `missing` only if the zone itself is readable (so a 404 cannot be
 * "not authorized").
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { DnsRecordSpec, DnsZoneSpec } from "@/lib/resources/specs";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import { compartmentOf } from "../../context";
import { OciCompileError, OciUnsupportedError } from "../../errors";
import { ociCapabilities, ociDriverId } from "../../evidence";
import { auxName, auxRef, interp, nameOf } from "../../naming";
import { asRecord, asString, attributesOf, discoverWith, observationOf, unreadableObservation, verifyWith, arrayOrItems, type LocateDef, type OciContext } from "../../observe-kit";
import { ociPath } from "../../services";
import { ociCall, type OciSession } from "../../transport";
import { addressList, res, specOf } from "../shared";

export const DNS_ZONE_NATIVE_TYPE = "oci:dns_zone";
export const DNS_RRSET_NATIVE_TYPE = "oci:dns_rrset";
const ZONE_ID = ociDriverId(DNS_ZONE_NATIVE_TYPE);
const RRSET_ID = ociDriverId(DNS_RRSET_NATIVE_TYPE);

const HOSTNAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
export const RRSET_TTL = 300;

/* ---------------------------------- zone ----------------------------------- */

export function compileDnsZone(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const spec = specOf<DnsZoneSpec>(node);
  if (typeof spec.name !== "string" || !HOSTNAME.test(spec.name)) throw new OciCompileError(`${node.address}: zone name "${String(spec.name).slice(0, 80)}" is not a plain domain name.`);
  const zone = res("oci_dns_zones", node);
  return {
    data: {
      oci_dns_zones: {
        [zone.label]: {
          compartment_id: compartmentOf(ctx),
          name: spec.name,
          scope: "GLOBAL",
          zone_type: "PRIMARY",
          state: "ACTIVE",
          lifecycle: { postcondition: [{ condition: interp("length(self.zones) == 1"), error_message: `Expected exactly one ACTIVE public zone named ${spec.name} in the Zenith compartment; Zenith never creates a customer zone.` }] },
        },
      },
    },
    locals: { [auxName(node.address, "id")]: interp(`data.${zone.address}.zones[0].id`) },
    addresses: addressList(`data.${zone.address}`, []),
  };
}

export const dnsZoneExpected = (node: ResourceNode): Record<string, unknown> => ({ name: specOf<DnsZoneSpec>(node).name, active: true });

const zoneLocate: LocateDef = {
  service: "dns",
  get: (idOrName) => ({ path: ociPath("dns", "zones", idOrName), query: {} }),
  list: (compartmentId) => ({ path: ociPath("dns", "zones"), query: { compartmentId, scope: "GLOBAL" } }),
  items: arrayOrItems,
  idOf: (i) => asString(asRecord(i)?.id),
};

export async function observeDnsZone(ctx: OciContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  const spec = specOf<DnsZoneSpec>(node);
  const zoneRef = externalId ?? spec.name;
  const r = await ociCall(ctx, { service: "dns", region: node.region || ctx.region, method: "GET", path: zoneLocate.get!(zoneRef).path, query: { compartmentId: ctx.session.compartmentOcid, scope: "GLOBAL" } });
  const requestIds = r.requestId ? [r.requestId] : [];
  if (!r.ok) {
    if (r.outcome === "not_found") return unreadableObservation(ctx, node, ZONE_ID, `${r.message} (DNS answers 404 for unauthorized reads too; absence of the zone cannot be concluded)`, "inaccessible");
    return unreadableObservation(ctx, node, ZONE_ID, r.message, r.outcome === "denied" ? "inaccessible" : "unknown");
  }
  const zone = asRecord(r.body);
  if (!zone) return unreadableObservation(ctx, node, ZONE_ID, "Unexpected zone response.");
  const at = ctx.now().toISOString();
  return observationOf(ctx, node, ZONE_ID, { presence: "present", item: zone, externalId: asString(zone.id), requestIds }, attributesOf(at, { name: asString(zone.name), active: asString(zone.lifecycleState) === undefined ? undefined : zone.lifecycleState === "ACTIVE" }), {
    name: zone.name,
    zoneType: zone.zoneType ?? null,
    lifecycleState: zone.lifecycleState,
  });
}

export const dnsZoneDriver: ResourceDriver<OciSession> = {
  id: ZONE_ID,
  provider: "oci",
  kind: "dns_zone",
  nativeType: DNS_ZONE_NATIVE_TYPE,
  capabilities: ociCapabilities({ compile: true, observe: true, verify: true, discover: true }),
  compile: compileDnsZone,
  observe: observeDnsZone,
  expectedAttributes: dnsZoneExpected,
  verify: async (ctx, node, observation) => verifyWith({ node, observation, expected: dnsZoneExpected(node), now: ctx.now() }),
  discover: (ctx) =>
    discoverWith(ctx, {
      ...zoneLocate,
      kind: "dns_zone",
      nativeType: DNS_ZONE_NATIVE_TYPE,
      nameOf: (i) => asString(i.name) ?? asString(i.id) ?? "zone",
      attributes: (i) => ({ state: asString(i.lifecycleState) ?? "", zoneType: asString(i.zoneType) ?? "" }),
    }),
};

/* --------------------------------- rrset ----------------------------------- */

export function compileDnsRrset(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const spec = specOf<DnsRecordSpec>(node);
  if (spec.type !== "alias") throw new OciUnsupportedError(`${node.address}: only "alias" records are derived (got "${String(spec.type)}").`);
  if (typeof spec.name !== "string" || !HOSTNAME.test(spec.name)) throw new OciCompileError(`${node.address}: record name "${String(spec.name).slice(0, 80)}" is not a plain hostname.`);
  const target = ctx.node(spec.target);
  if (!target || target.nativeType !== "oci:load_balancer" || target.ownership !== "managed") {
    throw new OciUnsupportedError(`${node.address}: an alias to ${spec.target} cannot be realized on OCI; only a Zenith-managed load balancer is a valid target (it supplies the reserved public IP for an A record).`);
  }
  const zone = ctx.node(spec.zone);
  if (!zone || zone.nativeType !== "oci:dns_zone") throw new OciCompileError(`${node.address}: zone ${spec.zone} is not an oci:dns_zone node in the graph.`);
  const rrset = res("oci_dns_rrset", node);
  return {
    resource: {
      oci_dns_rrset: {
        [rrset.label]: {
          zone_name_or_id: auxRef(spec.zone, "id"),
          domain: spec.name,
          rtype: "A",
          items: [{ domain: spec.name, rtype: "A", rdata: auxRef(spec.target, "public_ip"), ttl: RRSET_TTL }],
        },
      },
    },
    addresses: addressList(rrset.address, []),
  };
}

export const dnsRrsetExpected = (node: ResourceNode): Record<string, unknown> => ({ rtype: "A", ttl: RRSET_TTL, recordCount: 1, name: specOf<DnsRecordSpec>(node).name });

/** The zone name of a record node: the apex in its `zone` address (`dns_zone/<apex>`). */
const zoneNameOf = (spec: DnsRecordSpec): string => nameOf(spec.zone);

export async function observeDnsRrset(ctx: OciContext, node: ResourceNode, _externalId?: string): Promise<Observation> {
  const spec = specOf<DnsRecordSpec>(node);
  const region = node.region || ctx.region;
  const zoneName = zoneNameOf(spec);
  const r = await ociCall(ctx, { service: "dns", region, method: "GET", path: ociPath("dns", "zones", zoneName, "records", spec.name, "A"), query: { compartmentId: ctx.session.compartmentOcid, scope: "GLOBAL" } });
  const requestIds = r.requestId ? [r.requestId] : [];
  if (!r.ok && r.outcome === "not_found") {
    // a 404 is "missing" only if we can read the zone (so it is not an authorization failure)
    const z = await ociCall(ctx, { service: "dns", region, method: "GET", path: ociPath("dns", "zones", zoneName), query: { compartmentId: ctx.session.compartmentOcid, scope: "GLOBAL" } });
    if (z.requestId) requestIds.push(z.requestId);
    if (z.ok) return observationOf(ctx, node, RRSET_ID, { presence: "missing", requestIds });
    return unreadableObservation(ctx, node, RRSET_ID, `${r.message} (zone ${zoneName} is not readable either)`, "inaccessible");
  }
  if (!r.ok) return unreadableObservation(ctx, node, RRSET_ID, r.message, r.outcome === "denied" ? "inaccessible" : "unknown");
  const items = arrayOrItems(r.body).map((i) => asRecord(i)).filter((i): i is Record<string, unknown> => i !== undefined);
  if (items.length === 0) return observationOf(ctx, node, RRSET_ID, { presence: "missing", requestIds });
  const at = ctx.now().toISOString();
  const ttls = [...new Set(items.map((i) => i.ttl).filter((t): t is number => typeof t === "number"))];
  const values = items.map((i) => asString(i.rdata)).filter((v): v is string => v !== undefined).sort();
  return observationOf(ctx, node, RRSET_ID, { presence: "present", item: { id: `${zoneName}/${spec.name}/A` }, externalId: `${zoneName}/${spec.name}/A`, requestIds }, attributesOf(at, { rtype: "A", ttl: ttls.length === 1 ? ttls[0] : undefined, recordCount: items.length, name: spec.name }), { values: values.slice(0, 8) });
}

export const dnsRrsetDriver: ResourceDriver<OciSession> = {
  id: RRSET_ID,
  provider: "oci",
  kind: "dns_record",
  nativeType: DNS_RRSET_NATIVE_TYPE,
  capabilities: ociCapabilities({ compile: true, observe: true, verify: true }),
  compile: compileDnsRrset,
  observe: observeDnsRrset,
  expectedAttributes: dnsRrsetExpected,
  verify: async (ctx, node, observation) => verifyWith({ node, observation, expected: dnsRrsetExpected(node), now: ctx.now() }),
};

