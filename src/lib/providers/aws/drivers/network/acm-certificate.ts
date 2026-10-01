/**
 * `aws:acm_certificate` (kind `tls_certificate`): a public ACM certificate for
 * one domain, validated by DNS.
 *
 * Compile
 *   `validation: dns_automatic` → `aws_acm_certificate` + the validation CNAME as
 *     `aws_route53_record` in the REFERENCED zone (`allow_overwrite`: the record
 *     is the same for every certificate of the domain) + `aws_acm_certificate_validation`.
 *     The published `arn` is the validation resource's `certificate_arn`, so a
 *     listener that uses it is only created once the certificate is ISSUED.
 *   `validation: dns_manual`    → `aws_acm_certificate` only, and an output
 *     (`<label>_validation_records`) listing the CNAME(s) the user must create.
 *     No Route 53 record and no `aws_acm_certificate_validation`: Zenith does not
 *     own that zone. The published `arn` is the PENDING certificate, and anything
 *     that needs an issued certificate (an HTTPS listener) fails at apply until
 *     the record exists and ACM has issued it. `verify` says so, with the record.
 * `key_algorithm` is left at ACM's default (RSA 2048, accepted by ALB everywhere),
 * the certificate is replaced create-before-destroy, and a record name outside
 * the referenced zone is refused.
 *
 * Observe: DescribeCertificate by `externalId` (the ARN), else ListCertificates
 * filtered to the exact domain, then ListTagsForCertificate on those few candidates
 * to match the Zenith tags (never by domain alone). Attributes: `domain`,
 * `validationMethod`, `status` (ISSUED | PENDING_VALIDATION | …; desired ISSUED) and
 * `notAfter` (ISO timestamp; observed-only — there is no desired expiry, so
 * `expectedAttributes` does not name it; drift ignores observed-only attributes and
 * the incident engine reads it). `native`: ARN, `notAfter`/`notBefore`, `inUseBy`
 * (count and up to 10 ARNs), renewal eligibility/status, the validation records
 * (name, type, value — DNS data, not secrets) and the tags.
 *
 * Verify: exists, domain and validation method as desired, the certificate is
 * ISSUED, and it is not expired or about to expire unrenewed (< 14 days).
 * A `dns_manual` certificate that is not issued yet is `unknown`, never failed or
 * passed: "awaiting manual DNS validation", with the exact CNAME to create.
 *
 * Evidence: `contract` only (mocked ACM client).
 */
import {
  ACMClient,
  DescribeCertificateCommand,
  ListCertificatesCommand,
  ListTagsForCertificateCommand,
  type CertificateDetail,
  type CertificateStatus,
  type KeyAlgorithm,
} from "@aws-sdk/client-acm";
import type { AwsSession } from "@/lib/credentials/types";
import type { CompileContext, DiscoveredResource, ResourceDriver, TofuFragment, VerificationCheck } from "@/lib/drivers/types";
import type { DnsZoneSpec, TlsCertificateSpec } from "@/lib/resources/specs";
import type { Observation, ResourceNode } from "@/lib/resources/types";
import {
  type AwsDriverContext,
  DriverCompileError,
  FragmentBuilder,
  REF,
  attempt,
  attributesOf,
  boundNative,
  failedObservation,
  fromAwsTagList,
  hasZenithManagedTag,
  isArnOf,
  matchesNodeTags,
  nowIso,
  paginate,
  refExpr,
  resourceTags,
  standardVerification,
  tfLabel,
  unknownAttributes,
  verificationResult,
} from "../shared";
import { normalizeZoneName } from "./route53-zone";

const SOURCE = "aws.acm_certificate@1";
/** `notAfter` is observed-only: there is no desired expiry, so `expectedAttributes` does not name it. */
const ATTRIBUTES = ["domain", "validationMethod", "status", "notAfter"] as const;
const EXPIRY_WARNING_DAYS = 14;
const DAY_MS = 86_400_000;
const STATUSES: CertificateStatus[] = ["PENDING_VALIDATION", "ISSUED", "INACTIVE", "EXPIRED", "VALIDATION_TIMED_OUT", "REVOKED", "FAILED"];
const KEY_TYPES: KeyAlgorithm[] = ["RSA_1024", "RSA_2048", "RSA_3072", "RSA_4096", "EC_prime256v1", "EC_secp384r1", "EC_secp521r1"];
const MAX_TAG_CANDIDATES = 10;

function readCertSpec(node: ResourceNode): { domain: string; validation: "dns_automatic" | "dns_manual"; zone?: string } {
  const s = node.spec as Partial<TlsCertificateSpec>;
  const domain = normalizeZoneName(s.domain);
  if (!domain) throw new DriverCompileError("invalid_spec", node.address, `spec.domain must be a DNS name, got ${JSON.stringify(s.domain)}.`);
  if (s.validation !== "dns_automatic" && s.validation !== "dns_manual") throw new DriverCompileError("invalid_spec", node.address, `spec.validation must be dns_automatic or dns_manual, got ${JSON.stringify(s.validation)}.`);
  return { domain, validation: s.validation, ...(typeof s.zone === "string" ? { zone: s.zone } : {}) };
}

export function compileCertificate(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (node.ownership !== "managed") throw new DriverCompileError("policy_refused", node.address, `Zenith does not request a certificate for a ${node.ownership} node.`);
  const spec = readCertSpec(node);
  const L = tfLabel(node.address);
  const b = new FragmentBuilder(node.address);
  b.resource("aws_acm_certificate", L, {
    domain_name: spec.domain,
    validation_method: "DNS",
    tags: resourceTags(ctx.tags, node.address, spec.domain),
    lifecycle: { create_before_destroy: true },
  });
  b.expose("domain_name", `aws_acm_certificate.${L}.domain_name`);
  const option = `tolist(aws_acm_certificate.${L}.domain_validation_options)[0]`;

  if (spec.validation === "dns_manual") {
    b.expose(REF.arn, `aws_acm_certificate.${L}.arn`);
    b.output(`${L}_validation_records`, `\${[for o in aws_acm_certificate.${L}.domain_validation_options : { name = o.resource_record_name, type = o.resource_record_type, value = o.resource_record_value }]}`, {
      description: `DNS records to create by hand so ACM can validate ${spec.domain}`,
    });
    return b.build();
  }

  if (!spec.zone) throw new DriverCompileError("invalid_spec", node.address, "dns_automatic validation needs spec.zone, the referenced zone that holds the validation record.");
  const zone = ctx.node(spec.zone);
  if (!zone || zone.kind !== "dns_zone") throw new DriverCompileError("missing_node", node.address, `zone ${spec.zone} is not a dns_zone in the graph.`);
  const zoneName = normalizeZoneName((zone.spec as Partial<DnsZoneSpec>).name);
  if (!zoneName || (spec.domain !== zoneName && !spec.domain.endsWith(`.${zoneName}`))) {
    throw new DriverCompileError("policy_refused", node.address, `${spec.domain} is not inside the zone ${zoneName ?? spec.zone}; Zenith only writes validation records under the zone the manifest named.`);
  }
  b.resource("aws_route53_record", `${L}_validation`, {
    zone_id: refExpr(ctx.ref(spec.zone, REF.zoneId)),
    name: `\${${option}.resource_record_name}`,
    type: `\${${option}.resource_record_type}`,
    records: [`\${${option}.resource_record_value}`],
    ttl: 60,
    allow_overwrite: true,
  });
  b.resource("aws_acm_certificate_validation", `${L}_validation`, {
    certificate_arn: `\${aws_acm_certificate.${L}.arn}`,
    validation_record_fqdns: [`\${aws_route53_record.${L}_validation.fqdn}`],
    timeouts: { create: "30m" },
  });
  b.expose(REF.arn, `aws_acm_certificate_validation.${L}_validation.certificate_arn`);
  return b.build();
}

export function expectedCertificateAttributes(node: ResourceNode): Record<string, unknown> {
  const domain = normalizeZoneName((node.spec as Partial<TlsCertificateSpec>).domain);
  return domain ? { domain, validationMethod: "DNS", status: "ISSUED" } : {};
}

/* --------------------------------- reading --------------------------------- */

async function findCertificate(ctx: AwsDriverContext, acm: ACMClient, domain: string, address: string, externalId?: string): Promise<{ detail?: CertificateDetail; tags: Record<string, string>; matches: number }> {
  const opts = { abortSignal: ctx.signal };
  if (externalId !== undefined && isArnOf(externalId, "acm", "certificate")) {
    const r = await acm.send(new DescribeCertificateCommand({ CertificateArn: externalId }), opts);
    const tags = fromAwsTagList((await acm.send(new ListTagsForCertificateCommand({ CertificateArn: externalId }), opts)).Tags);
    return { detail: r.Certificate, tags, matches: r.Certificate ? 1 : 0 };
  }
  const { items } = await paginate(
    async (t) => {
      const r = await acm.send(new ListCertificatesCommand({ NextToken: t, MaxItems: 100, CertificateStatuses: STATUSES, Includes: { keyTypes: KEY_TYPES } }), opts);
      return { items: r.CertificateSummaryList ?? [], next: r.NextToken };
    },
    { maxPages: 10, signal: ctx.signal }
  );
  const candidates = items.filter((c) => typeof c.CertificateArn === "string" && normalizeZoneName(c.DomainName) === domain).slice(0, MAX_TAG_CANDIDATES);
  const hits: { arn: string; tags: Record<string, string> }[] = [];
  for (const c of candidates) {
    const tags = fromAwsTagList((await acm.send(new ListTagsForCertificateCommand({ CertificateArn: c.CertificateArn }), opts)).Tags);
    if (matchesNodeTags(tags, ctx, address)) hits.push({ arn: c.CertificateArn as string, tags });
  }
  if (hits.length !== 1) return { tags: {}, matches: hits.length };
  const r = await acm.send(new DescribeCertificateCommand({ CertificateArn: hits[0].arn }), opts);
  return { detail: r.Certificate, tags: hits[0].tags, matches: r.Certificate ? 1 : 0 };
}

async function observeCertificate(ctx: AwsDriverContext, node: ResourceNode, externalId?: string): Promise<Observation> {
  const base = { address: node.address, observedAt: nowIso(ctx), source: SOURCE, simulated: false };
  const domain = normalizeZoneName((node.spec as Partial<TlsCertificateSpec>).domain);
  if (!domain) return { ...base, presence: "unknown", attributes: unknownAttributes(ATTRIBUTES, "not_applicable", "spec.domain is not a DNS name"), error: "invalid certificate spec" };
  const acm = ctx.session.client(ACMClient);
  const found = await attempt(() => findCertificate(ctx, acm, domain, node.address, externalId), ctx.signal);
  if (!found.ok) return failedObservation(ctx, node, SOURCE, ATTRIBUTES, found.failure, externalId);
  const { detail, tags, matches } = found.value;
  if (matches > 1) return { ...base, presence: "unknown", attributes: unknownAttributes(ATTRIBUTES, "error", "more than one certificate carries this node's Zenith tags"), error: `${matches} certificates carry the Zenith tags of ${node.address}; refusing to pick one.` };
  if (matches === 0 || !detail) return { ...base, presence: "missing", attributes: unknownAttributes(ATTRIBUTES, "not_applicable", "no certificate carries this node's Zenith tags") };

  const options = detail.DomainValidationOptions ?? [];
  return {
    ...base,
    externalId: detail.CertificateArn,
    presence: "present",
    attributes: attributesOf(ctx, ATTRIBUTES, { domain: normalizeZoneName(detail.DomainName), validationMethod: options[0]?.ValidationMethod ?? (detail.Type === "AMAZON_ISSUED" ? "DNS" : undefined), status: detail.Status, notAfter: detail.NotAfter?.toISOString() }),
    native: boundNative(
      {
        certificateArn: detail.CertificateArn,
        status: detail.Status,
        type: detail.Type,
        keyAlgorithm: detail.KeyAlgorithm,
        notAfter: detail.NotAfter?.toISOString(),
        notBefore: detail.NotBefore?.toISOString(),
        inUseByCount: detail.InUseBy?.length ?? 0,
        inUseBy: (detail.InUseBy ?? []).slice(0, 10),
        renewalEligibility: detail.RenewalEligibility,
        renewalStatus: detail.RenewalSummary?.RenewalStatus,
        validation: options.map((o) => ({ domain: o.DomainName, status: o.ValidationStatus, method: o.ValidationMethod, recordName: o.ResourceRecord?.Name, recordType: o.ResourceRecord?.Type, recordValue: o.ResourceRecord?.Value })),
        tags,
      },
      { priority: ["certificateArn", "status", "notAfter", "validation", "tags"] }
    ),
  };
}

function manualInstructions(observation: Observation, domain: string): string {
  const v = observation.native?.validation;
  const first = Array.isArray(v) ? (v[0] as { recordName?: string; recordType?: string; recordValue?: string } | undefined) : undefined;
  return first?.recordName && first.recordValue
    ? `awaiting manual DNS validation: in the DNS zone for ${domain}, create a ${first.recordType ?? "CNAME"} record named ${first.recordName} with value ${first.recordValue}; ACM issues the certificate once it resolves.`
    : `awaiting manual DNS validation: create the DNS validation record ACM shows for ${domain} (none was returned yet).`;
}

async function verifyCertificate(ctx: AwsDriverContext, node: ResourceNode, observation: Observation) {
  const expected = expectedCertificateAttributes(node);
  const manual = (node.spec as Partial<TlsCertificateSpec>).validation === "dns_manual";
  const domain = String(expected.domain ?? (node.spec as Partial<TlsCertificateSpec>).domain ?? "the domain");
  const { status: _status, ...rest } = expected;
  const base = standardVerification(ctx, node, observation, rest, "the certificate");
  if (observation.presence !== "present") return base;
  const checks: VerificationCheck[] = [...base.checks];
  const status = observation.native?.status;
  if (typeof status !== "string") {
    checks.push({ id: "certificate_issued", description: "the certificate is issued", passed: "unknown", detail: "the status was not read" });
  } else if (status === "ISSUED") {
    checks.push({ id: "certificate_issued", description: "the certificate is issued", passed: true });
  } else if (status === "PENDING_VALIDATION" && manual) {
    checks.push({ id: "certificate_issued", description: "the certificate is issued", passed: "unknown", detail: manualInstructions(observation, domain) });
  } else {
    checks.push({
      id: "certificate_issued",
      description: "the certificate is issued",
      passed: false,
      detail: status === "PENDING_VALIDATION" ? "status is PENDING_VALIDATION although Zenith manages the validation record; check the hosted zone and the validation record." : `status is ${status}`,
    });
  }
  const read = observation.attributes.notAfter;
  const notAfter = read?.state === "known" ? read.value : undefined;
  if (status === "ISSUED") {
    const ms = typeof notAfter === "string" ? Date.parse(notAfter) - ctx.now().getTime() : Number.NaN;
    const expired = ms < 0;
    const days = Math.floor(Math.abs(ms) / DAY_MS);
    const ok = !expired && days >= EXPIRY_WARNING_DAYS;
    checks.push({
      id: "not_expiring",
      description: `the certificate is valid for at least ${EXPIRY_WARNING_DAYS} more days`,
      passed: Number.isNaN(ms) ? "unknown" : ok,
      ...(Number.isNaN(ms) || ok ? {} : { detail: expired ? `expired ${days} day(s) ago` : `expires in ${days} day(s) and has not renewed` }),
    });
  }
  return verificationResult(ctx, node, checks);
}

async function discoverCertificates(ctx: AwsDriverContext): Promise<DiscoveredResource[]> {
  const acm = ctx.session.client(ACMClient);
  const { items } = await paginate(
    async (t) => {
      const r = await acm.send(new ListCertificatesCommand({ NextToken: t, MaxItems: 100, CertificateStatuses: STATUSES, Includes: { keyTypes: KEY_TYPES } }), { abortSignal: ctx.signal });
      return { items: r.CertificateSummaryList ?? [], next: r.NextToken };
    },
    { maxPages: 5, signal: ctx.signal }
  );
  const out: DiscoveredResource[] = [];
  for (const c of items.filter((x) => typeof x.CertificateArn === "string").slice(0, 100)) {
    let tagged = false;
    try {
      tagged = hasZenithManagedTag(fromAwsTagList((await acm.send(new ListTagsForCertificateCommand({ CertificateArn: c.CertificateArn }), { abortSignal: ctx.signal })).Tags));
    } catch (error) {
      if (ctx.signal.aborted) throw error;
    }
    out.push({
      provider: "aws",
      kind: "tls_certificate",
      nativeType: "aws:acm_certificate",
      externalId: c.CertificateArn as string,
      name: c.DomainName ?? (c.CertificateArn as string),
      region: ctx.region,
      zenithTagged: tagged,
      attributes: { domain: c.DomainName ?? "", status: c.Status ?? "unknown", type: c.Type ?? "unknown" },
    });
  }
  return out;
}

export const acmCertificateDriver: ResourceDriver<AwsSession> = {
  id: SOURCE,
  provider: "aws",
  kind: "tls_certificate",
  nativeType: "aws:acm_certificate",
  capabilities: {
    compile: true,
    observe: true,
    runtime: false,
    verify: true,
    discover: true,
    operations: [],
    evidence: { compile: "contract", observe: "contract", verify: "contract", discover: "contract" },
  },
  compile: compileCertificate,
  observe: observeCertificate,
  expectedAttributes: expectedCertificateAttributes,
  verify: verifyCertificate,
  discover: discoverCertificates,
};
