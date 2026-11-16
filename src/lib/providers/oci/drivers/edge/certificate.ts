/**
 * `oci:certificate` — portable `tls_certificate` on OCI. LOOKUP ONLY.
 *
 * The honest position: OCI cannot issue a publicly trusted certificate for a
 * customer's domain. The Certificates service issues from a PRIVATE CA (which
 * no browser trusts) or IMPORTS a certificate; importing needs the private key
 * as an argument, which would put a key in OpenTofu state, so Zenith never does
 * it. There is no ACME / DNS-validated managed certificate like AWS ACM, so
 * `spec.validation` (dns_automatic / dns_manual) has no OCI meaning here.
 *
 * What this node does instead: look up an EXISTING, ACTIVE certificate named
 * exactly `spec.domain` in the Zenith compartment with a data source, and fail
 * the plan with a clear message (a `postcondition`) if there is not exactly one.
 * The customer obtains the certificate themselves (for example with an ACME
 * client) and imports it into OCI Certificates under the route's hostname. The
 * load balancer's HTTPS listener then uses its OCID; the key never leaves
 * OCI. Expiry is NOT managed: renewal is the customer's ACME tooling, and
 * `verify` fails when the certificate has fewer than 14 days left.
 *
 * Because the certificate is customer-created it carries no Zenith tags, so it
 * is found by exact name in the compartment — a deliberate exception to "never
 * by name alone" for this one node type.
 *
 * Prerequisite outside Zenith (created by deploy/oci): a policy letting the
 * load balancer service read certificates in the compartment.
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { TlsCertificateSpec } from "@/lib/resources/specs";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import { compartmentOf } from "../../context";
import { OciCompileError } from "../../errors";
import { ociCapabilities, ociDriverId } from "../../evidence";
import { auxName, interp } from "../../naming";
import {
  arrayOrItems,
  asArray,
  asRecord,
  asString,
  attributesOf,
  discoverWith,
  isGone,
  listAll,
  observationOf,
  unreadableObservation,
  verifyWith,
  type LocateDef,
  type Located,
  type OciContext,
} from "../../observe-kit";
import { isOcid, ociPath } from "../../services";
import { ociCall, type OciSession } from "../../transport";
import { addressList, res, specOf } from "../shared";

export const CERTIFICATE_NATIVE_TYPE = "oci:certificate";
const ID = ociDriverId(CERTIFICATE_NATIVE_TYPE);

const HOSTNAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
export const MIN_DAYS_TO_EXPIRY = 14;

export function compileCertificate(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const spec = specOf<TlsCertificateSpec>(node);
  if (typeof spec.domain !== "string" || !HOSTNAME.test(spec.domain)) throw new OciCompileError(`${node.address}: domain "${String(spec.domain).slice(0, 80)}" is not a plain hostname.`);
  const cert = res("oci_certificates_management_certificates", node);
  const items = `data.${cert.address}.certificate_collection[0].items`;
  return {
    data: {
      oci_certificates_management_certificates: {
        [cert.label]: {
          compartment_id: compartmentOf(ctx),
          name: spec.domain,
          state: "ACTIVE",
          lifecycle: {
            postcondition: [
              {
                condition: interp(`length(self.certificate_collection) > 0 && length(self.certificate_collection[0].items) == 1`),
                error_message: `Expected exactly one ACTIVE OCI Certificates certificate named ${spec.domain} in the Zenith compartment. OCI cannot issue public certificates: import one (obtained with your own ACME client) under that name.`,
              },
            ],
          },
        },
      },
    },
    locals: { [auxName(node.address, "id")]: interp(`${items}[0].id`) },
    addresses: addressList(`data.${cert.address}`, []),
  };
}

export const certificateExpected = (_node: ResourceNode): Record<string, unknown> => ({ active: true, covers: true });

/** Does a certificate name/SAN list cover `domain` (exact, or a single-label wildcard)? */
export function covers(names: string[], domain: string): boolean {
  const d = domain.toLowerCase();
  return names.some((n) => {
    const x = n.toLowerCase();
    if (x === d) return true;
    if (x.startsWith("*.")) {
      const rest = d.indexOf(".");
      return rest > 0 && d.slice(rest + 1) === x.slice(2);
    }
    return false;
  });
}

const locateDef: LocateDef = {
  service: "certificates",
  get: (id) => ({ path: ociPath("certificates", "certificates", id) }),
  list: (compartmentId) => ({ path: ociPath("certificates", "certificates"), query: { compartmentId } }),
  items: arrayOrItems,
  idOf: (i) => asString(asRecord(i)?.id),
};

export async function observeCertificate(ctx: OciContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  const spec = specOf<TlsCertificateSpec>(node);
  const region = node.region || ctx.region;
  const requestIds: string[] = [];
  let id = externalId && isOcid(externalId) ? externalId : undefined;
  if (!id) {
    const listed = await listAll(ctx, { service: "certificates", region, method: "GET", path: ociPath("certificates", "certificates"), query: { compartmentId: ctx.session.compartmentOcid, name: spec.domain } }, arrayOrItems);
    requestIds.push(...listed.requestIds);
    if (!listed.ok) return unreadableObservation(ctx, node, ID, listed.failure.message, listed.failure.outcome === "denied" || listed.failure.outcome === "not_found" ? "inaccessible" : "unknown");
    // exact name match only; the list filter may be loose
    const live = listed.items.filter((i) => !isGone(i) && asString(asRecord(i)?.name) === spec.domain);
    if (live.length === 0) return observationOf(ctx, node, ID, listed.truncated ? { presence: "unknown", requestIds, error: "Not found in a truncated listing." } : { presence: "missing", requestIds });
    if (live.length > 1) return observationOf(ctx, node, ID, { presence: "unknown", requestIds, error: `${live.length} certificates are named ${spec.domain}.` });
    id = asString(asRecord(live[0])?.id);
  }
  if (!id) return unreadableObservation(ctx, node, ID, "The certificate has no id in the listing.");
  const r = await ociCall(ctx, { service: "certificates", region, method: "GET", path: ociPath("certificates", "certificates", id) });
  if (r.requestId) requestIds.push(r.requestId);
  if (!r.ok) return unreadableObservation(ctx, node, ID, r.message, r.outcome === "denied" ? "inaccessible" : "unknown");
  const cert = asRecord(r.body);
  if (!cert) return unreadableObservation(ctx, node, ID, "Unexpected certificate response.");
  const located: Located = { presence: "present", item: cert, externalId: id, requestIds };

  const at = ctx.now().toISOString();
  const current = asRecord(cert.currentVersion);
  const sans = asArray(current?.subjectAlternativeNames).map((s) => asString(asRecord(s)?.value)).filter((v): v is string => v !== undefined);
  const cn = asString(asRecord(cert.subject)?.commonName);
  const names = [...sans, ...(cn ? [cn] : [])];
  const notAfter = asString(asRecord(current?.validity)?.timeOfValidityNotAfter);
  const days = notAfter && !Number.isNaN(Date.parse(notAfter)) ? Math.floor((Date.parse(notAfter) - ctx.now().getTime()) / 86_400_000) : undefined;
  const attributes = attributesOf(at, {
    active: asString(cert.lifecycleState) === undefined ? undefined : cert.lifecycleState === "ACTIVE",
    covers: names.length === 0 ? undefined : covers(names, spec.domain),
    daysToExpiry: days,
  });
  return observationOf(ctx, node, ID, located, attributes, { name: cert.name, lifecycleState: cert.lifecycleState, configType: cert.configType, timeOfValidityNotAfter: notAfter ?? null });
}

export const certificateDriver: ResourceDriver<OciSession> = {
  id: ID,
  provider: "oci",
  kind: "tls_certificate",
  nativeType: CERTIFICATE_NATIVE_TYPE,
  capabilities: ociCapabilities({ compile: true, observe: true, verify: true, discover: true }),
  compile: compileCertificate,
  observe: observeCertificate,
  expectedAttributes: certificateExpected,
  verify: async (ctx, node, observation) => {
    const days = observation.attributes.daysToExpiry;
    return verifyWith({
      node,
      observation,
      expected: certificateExpected(node),
      now: ctx.now(),
      extra: [
        {
          id: "not_expiring",
          description: `the certificate has at least ${MIN_DAYS_TO_EXPIRY} days of validity left`,
          passed: !days || days.state !== "known" ? "unknown" : typeof days.value === "number" ? days.value >= MIN_DAYS_TO_EXPIRY : "unknown",
          ...(days && days.state === "known" && typeof days.value === "number" && days.value < MIN_DAYS_TO_EXPIRY ? { detail: `${days.value} days left; OCI does not renew imported certificates` } : {}),
        },
      ],
    });
  },
  discover: (ctx) =>
    discoverWith(ctx, {
      ...locateDef,
      kind: "tls_certificate",
      nativeType: CERTIFICATE_NATIVE_TYPE,
      nameOf: (i) => asString(i.name) ?? asString(i.id) ?? "certificate",
      attributes: (i) => ({ state: asString(i.lifecycleState) ?? "", configType: asString(i.configType) ?? "" }),
    }),
};
