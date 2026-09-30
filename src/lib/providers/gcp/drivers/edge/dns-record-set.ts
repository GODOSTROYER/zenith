/**
 * `gcp:dns_record_set` — a Cloud DNS record for a `DnsRecordSpec` alias.
 *
 * `type: "alias"` toward a load balancer compiles to an `A` record (TTL 300 s)
 * pointing at the load balancer's reserved global IP address (the primary
 * forwarding rule's `ip_address`). Aliasing anything else is refused: a CNAME
 * to a `*.run.app` host would not serve a custom hostname without a Cloud Run
 * domain mapping, which this driver does not create.
 *
 * Record sets have no labels, so the identity of a record is (zone, name,
 * type) — the one place a lookup is by name. `observe` therefore reads the
 * record in the most specific managed zone whose DNS name covers the record
 * (or the zone in `externalId`, when given) and never guesses across zones;
 * there is no `discover`.
 *
 * Compile pairs with `gcp:dns_managed_zone` (`spec.zone` is that node's
 * address) and, for managed certificates, with the DNS record that lets
 * Google see the domain.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import type { DnsRecordSpec } from "@/lib/resources/specs";
import type { Observation, ObservedValue, ResourceNode } from "@/lib/resources/types";
import { GcpCompileError } from "../../errors";
import { tfLabel } from "../../naming";
import { contractCapabilities, specOf } from "../../driver-util";
import { dataFragment, lastSegment, lit, ref } from "../../hcl";
import { gcpGet, gcpList } from "../../rest";
import { arr, makeReaders, num, str, type ReadSpec } from "../../read-kit";
import { DNS } from "./dns-managed-zone";
import { normalizeDomain } from "./managed-ssl-certificate";

export const DRIVER_ID = "gcp.dns_record_set@1";
const TTL = 300;
const ATTRS = ["type", "ttl"] as const;

function expectedAttributes(_node: ResourceNode): Record<string, unknown> {
  return { type: "A", ttl: TTL };
}

function compile(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const L = tfLabel(node.address);
  if (node.ownership !== "managed") {
    return dataFragment("google_dns_record_set", L, { managed_zone: lastSegment(node.externalRef, node.address), name: `${normalizeDomain(specOf<DnsRecordSpec>(node).name, node.address)}.`, type: "A" });
  }
  const s = specOf<DnsRecordSpec>(node);
  const target = ctx.node(s.target);
  if (!target) throw new GcpCompileError("unknown_target", `${node.address}: target ${lit(String(s.target))} is not in the graph.`);
  if (target.kind !== "load_balancer") throw new GcpCompileError("unsupported_dns_target", `${node.address}: only a load balancer can be aliased on GCP (got ${target.kind}).`);
  if (!ctx.node(s.zone)) throw new GcpCompileError("unknown_zone", `${node.address}: zone ${lit(String(s.zone))} is not in the graph.`);
  return {
    resource: {
      google_dns_record_set: {
        [L]: {
          managed_zone: ref(ctx, s.zone, "name"),
          name: `${normalizeDomain(s.name, node.address)}.`,
          type: "A",
          ttl: TTL,
          rrdatas: [ref(ctx, target.address, "ip_address")],
        },
      },
    },
    addresses: [`google_dns_record_set.${L}`],
  };
}

const EXTERNAL = /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/managedZones\/([a-z][a-z0-9-]{0,62})\/rrsets\/([a-z0-9._-]{1,253}\.)\/(A)$/;

const spec: ReadSpec = {
  driverId: DRIVER_ID,
  nativeType: "gcp:dns_record_set",
  kind: "dns_record",
  attributes: ATTRS,
  resolve: () => ({ error: "unused" }),
  extract: () => {
    throw new Error("unused");
  },
};

const readers = makeReaders(spec, expectedAttributes);

async function observe(ctx: Parameters<NonNullable<ResourceDriver<GcpSession>["observe"]>>[0], node: ResourceNode, externalId?: string): Promise<Observation> {
  const at = ctx.now().toISOString();
  const base = { address: node.address, observedAt: at, source: DRIVER_ID, simulated: false as const };
  const unknownAll = (reason: "access_denied" | "error" | "not_applicable", detail?: string): Record<string, ObservedValue> =>
    Object.fromEntries(ATTRS.map((a) => [a, { state: "unknown", reason, ...(detail ? { detail } : {}) } as ObservedValue]));
  let fqdn: string;
  try {
    fqdn = `${normalizeDomain(specOf<DnsRecordSpec>(node).name, node.address)}.`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "invalid record name";
    return { ...base, presence: "unknown", attributes: unknownAll("error", msg), error: msg };
  }

  let zone: string | undefined;
  if (externalId) {
    const m = EXTERNAL.exec(externalId);
    if (!m || m[1] !== ctx.session.projectId || m[3] !== fqdn) {
      const error = `externalId is not this record in project ${ctx.session.projectId}.`;
      return { ...base, presence: "unknown", attributes: unknownAll("error", error), error };
    }
    zone = m[2];
  } else {
    const zones = await gcpList(ctx, `${DNS}/projects/${ctx.session.projectId}/managedZones?maxResults=100`, "managedZones");
    if (zones.outcome !== "ok") {
      const presence = zones.outcome === "inaccessible" ? "inaccessible" : "unknown";
      return { ...base, presence, attributes: unknownAll(zones.outcome === "inaccessible" ? "access_denied" : "error", zones.detail), error: zones.detail ?? zones.outcome };
    }
    const covering = zones.items
      .map((z) => ({ name: str(z.name), dns: str(z.dnsName) }))
      .filter((z): z is { name: string; dns: string } => !!z.name && !!z.dns && (fqdn === z.dns || fqdn.endsWith(`.${z.dns}`)))
      .sort((a, b) => b.dns.length - a.dns.length);
    if (covering.length === 0) return { ...base, presence: "missing", attributes: unknownAll("not_applicable", "no managed zone covers this name") };
    zone = covering[0].name;
  }

  const id = `projects/${ctx.session.projectId}/managedZones/${zone}/rrsets/${fqdn}/A`;
  const res = await gcpGet(ctx, `${DNS}/${id}`);
  if (res.outcome === "missing") return { ...base, presence: "missing", attributes: unknownAll("not_applicable"), externalId: id };
  if (res.outcome !== "ok") {
    return { ...base, presence: res.outcome === "inaccessible" ? "inaccessible" : "unknown", attributes: unknownAll(res.outcome === "inaccessible" ? "access_denied" : "error", res.detail), error: res.detail ?? res.outcome, externalId: id };
  }
  return {
    ...base,
    presence: "present",
    externalId: id,
    attributes: {
      type: { state: "known", value: str(res.json.type), observedAt: at },
      ttl: { state: "known", value: num(res.json.ttl), observedAt: at },
    },
    native: { recordCount: arr(res.json.rrdatas).length },
  };
}

export const dnsRecordSetDriver: ResourceDriver<GcpSession> = {
  id: DRIVER_ID,
  provider: "gcp",
  kind: "dns_record",
  nativeType: "gcp:dns_record_set",
  capabilities: contractCapabilities({}),
  compile,
  observe,
  verify: readers.verify,
  expectedAttributes,
};
