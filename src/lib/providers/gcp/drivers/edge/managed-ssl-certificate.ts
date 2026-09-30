/**
 * `gcp:managed_ssl_certificate` — a Google-managed SSL certificate
 * (`google_compute_managed_ssl_certificate`) for one domain, attached to the
 * global external Application Load Balancer by `gcp:global_http_lb`.
 *
 * Provisioning is asynchronous and not something tofu waits for: Google
 * issues the certificate only after the domain resolves to the load
 * balancer's IP address (the `dns_record_set` node, or a record the customer
 * creates when `validation` is `dns_manual`). `runtime` therefore reports the
 * certificate status honestly: PROVISIONING is `degraded`, a failed state is
 * `unhealthy`, ACTIVE is `healthy`.
 *
 * The name carries a hash of the domain so a domain change creates a NEW
 * certificate before the old one is destroyed (`create_before_destroy`),
 * avoiding a window with no certificate on the load balancer. Wildcard
 * domains are refused: classic Google-managed certificates do not support
 * them (that needs Certificate Manager with DNS authorization).
 */
import type { CompileContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import type { TlsCertificateSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { GcpCompileError } from "../../errors";
import { cloudName, fnv6, parseTagDescription, tagDescription, tfLabel } from "../../naming";
import { COMPUTE, computeGlobal, contractCapabilities, specOf } from "../../driver-util";
import { dataFragment, lastSegment, lit } from "../../hcl";
import { arr, computePath, makeReaders, rec, str, tail, type ReadSpec } from "../../read-kit";

export const DRIVER_ID = "gcp.managed_ssl_certificate@1";

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}[a-z0-9]$/;

export function normalizeDomain(d: string, where: string): string {
  const v = String(d).trim().toLowerCase().replace(/\.$/, "");
  if (!DOMAIN.test(v)) throw new GcpCompileError("invalid_domain", `${where}: "${lit(String(d)).slice(0, 60)}" is not a valid fully qualified, non-wildcard domain.`);
  return v;
}

function expectedAttributes(node: ResourceNode): Record<string, unknown> {
  return { domains: [normalizeDomain(specOf<TlsCertificateSpec>(node).domain, node.address)], type: "MANAGED" };
}

function compile(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const L = tfLabel(node.address);
  if (node.ownership !== "managed") return dataFragment("google_compute_ssl_certificate", L, { name: lastSegment(node.externalRef, node.address) });
  const domain = normalizeDomain(specOf<TlsCertificateSpec>(node).domain, node.address);
  return {
    resource: {
      google_compute_managed_ssl_certificate: {
        [L]: {
          name: cloudName(ctx.namePrefix, node.address, { max: 63, suffix: fnv6(domain) }),
          description: tagDescription(ctx.tags, node, "google-managed certificate"),
          managed: [{ domains: [domain] }],
          lifecycle: { create_before_destroy: true },
        },
      },
    },
    addresses: [`google_compute_managed_ssl_certificate.${L}`],
  };
}

const spec: ReadSpec = {
  driverId: DRIVER_ID,
  nativeType: "gcp:managed_ssl_certificate",
  kind: "tls_certificate",
  attributes: ["domains", "type"],
  resolve: computeGlobal("sslCertificates", "SSL certificate"),
  list: {
    url: (ctx) => `${COMPUTE}/projects/${ctx.session.projectId}/global/sslCertificates?maxResults=500`,
    itemsKey: "items",
    labelsOf: (item) => parseTagDescription(item.description),
  },
  extract(o) {
    const self = str(o.selfLink);
    const id = self ? computePath(self) : undefined;
    if (!id) throw new Error("no selfLink");
    const managed = rec(o.managed);
    const domains = arr(managed.domains).map(String).sort();
    return {
      externalId: id,
      name: tail(id),
      attributes: { domains, type: str(o.type) },
      native: {
        status: str(managed.status),
        domainStates: Object.values(rec(managed.domainStatus)).slice(0, 10).map((v) => String(v).slice(0, 40)),
        expireTime: str(o.expireTime),
      },
    };
  },
  runtime(o) {
    const managed = rec(o.managed);
    const status = str(managed.status);
    const safe = (v: unknown) => String(v ?? "").replace(/[^A-Z_]/g, "").slice(0, 48);
    const signals = Object.values(rec(managed.domainStatus)).map((v) => `domain_status:${safe(v)}`);
    let health: "healthy" | "degraded" | "unhealthy" | "unknown" = "unknown";
    if (status === "ACTIVE") health = "healthy";
    else if (status === "PROVISIONING" || status === "MANAGED_CERTIFICATE_STATUS_UNSPECIFIED") health = status === "PROVISIONING" ? "degraded" : "unknown";
    else if (status) health = "unhealthy";
    if (status) signals.unshift(`certificate:${safe(status)}`);
    return { health, counts: {}, signals };
  },
};

const readers = makeReaders(spec, expectedAttributes, { serving: true });

export const managedSslCertificateDriver: ResourceDriver<GcpSession> = {
  id: DRIVER_ID,
  provider: "gcp",
  kind: "tls_certificate",
  nativeType: "gcp:managed_ssl_certificate",
  capabilities: contractCapabilities({ runtime: true, discover: true }),
  compile,
  observe: readers.observe,
  runtime: readers.runtime,
  verify: readers.verify,
  discover: readers.discover,
  expectedAttributes,
};
