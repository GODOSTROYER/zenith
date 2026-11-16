/**
 * The managed tier's service catalog (PROD-MAN-03): exactly what Zenith-managed hosting promises, joined to the versioned
 * OFFERED catalog (PROD-LIFE-02) so the two cannot drift.
 *
 * Two sources, one rule. This module declares the PROMISES (which portable kinds, which substrate components each needs, the
 * plan-tier limits derived from `plans.ts`, never typed twice). The offered catalog says what the drivers actually implement.
 * `checkManagedCatalogDrift` fails when:
 *   - a promised kind is not offered (no `zenith` driver, or level `unsupported`);
 *   - a kind the drivers offer is neither promised nor named as platform-provided (an undocumented capability);
 *   - a kind is both promised and platform-provided.
 * The kinds the managed tier refuses (mysql, redis, queues, functions, VMs, ...) are not listed by hand: they are read from
 * the offered catalog's `unsupported` entries for provider `zenith`, with the catalog's own reason.
 *
 * Availability is separate from promise: a promised service is `available` only when the substrate components it needs are
 * configured. Evidence is whatever the offered catalog says (contract-level today); nothing here upgrades it.
 */
import { createHash } from "node:crypto";
import { getOfferedCatalog, type OfferedCatalog, type SupportLevel } from "@/lib/offered-catalog";
import { portabilitySupport } from "@/lib/portability/matrix";
import { PLAN_LIMITS } from "@/lib/providers/zenith/plans";
import type { ZenithSubstrate } from "@/lib/providers/zenith/substrate";
import { PLAN_TIERS, type PlanTier } from "@/lib/providers/zenith/types";
import type { PortableKind } from "@/lib/resources/types";
import { MAX_DOMAINS_PER_ENVIRONMENT } from "./domains";

export type SubstrateRequirement =
  | "cluster"
  | "gateway_api"
  | "http_issuer"
  | "registry"
  | "object_storage"
  | "object_storage_admin"
  | "managed_database";

export interface ManagedServicePromise {
  id: string;
  title: string;
  summary: string;
  /** portable kinds this service realizes; empty for a feature that rides on other kinds */
  kinds: readonly PortableKind[];
  requires: readonly SubstrateRequirement[];
  /** per-tier inclusion and limit, derived from the plan limits */
  tiers: (tier: PlanTier) => { included: boolean; limit?: string };
}

const allTiers = (limit?: string) => () => ({ included: true, ...(limit ? { limit } : {}) });

/** The promises. Every kind listed must be offered; every offered kind must be here or in PLATFORM_PROVIDED_KINDS. */
export const MANAGED_PROMISES: readonly ManagedServicePromise[] = [
  { id: "web-services", title: "Web services and static sites", summary: "Containers and static sites served over HTTPS at <service>.<environment>.<workspace>.<app domain> through the platform gateway, with a platform wildcard certificate.", kinds: ["container_service", "static_site", "load_balancer"], requires: ["cluster", "gateway_api"], tiers: allTiers() },
  { id: "scheduled-jobs", title: "Scheduled jobs", summary: "Cron jobs in the tenant namespace under the plan's compute quota.", kinds: ["scheduled_job"], requires: ["cluster"], tiers: allTiers() },
  { id: "secrets", title: "Secrets from the vault", summary: "Secret values live in the encrypted vault and reach workloads as secret references resolved at apply time; no value is in a manifest, plan or event.", kinds: ["secret"], requires: ["cluster"], tiers: (t) => ({ included: true, limit: `${PLAN_LIMITS[t].quota.secrets} secrets` }) },
  { id: "managed-postgres", title: "Managed Postgres", summary: "A managed Postgres database per declared postgres resource, reused from an established managed database service (never an in-cluster database), with logical export and restore to tenant-owned storage.", kinds: ["postgres"], requires: ["managed_database"], tiers: (t) => ({ included: true, limit: `${PLAN_LIMITS[t].maxManagedDatabases} per environment` }) },
  { id: "object-storage", title: "Tenant object storage", summary: "A key prefix of the shared bucket per object store, reachable only with a credential scoped to that prefix; removing a store revokes the credential and never deletes objects.", kinds: ["object_store"], requires: ["object_storage", "object_storage_admin"], tiers: (t) => ({ included: PLAN_LIMITS[t].maxObjectStores > 0, ...(PLAN_LIMITS[t].maxObjectStores > 0 ? { limit: `${PLAN_LIMITS[t].maxObjectStores} per environment` } : {}) }) },
  { id: "persistent-volumes", title: "Persistent volumes", summary: "PersistentVolumeClaims inside the plan's storage quota.", kinds: ["volume"], requires: ["cluster"], tiers: (t) => ({ included: Number(PLAN_LIMITS[t].quota.persistentvolumeclaims) > 0, ...(Number(PLAN_LIMITS[t].quota.persistentvolumeclaims) > 0 ? { limit: `${PLAN_LIMITS[t].quota.persistentvolumeclaims} claims, ${PLAN_LIMITS[t].quota["requests.storage"]} total` } : {}) }) },
  { id: "custom-domains", title: "Custom domains", summary: "A hostname you own, proven by a DNS TXT challenge, served with its own ACME certificate. The proof is re-checked before it expires and a lapsed proof stops being served.", kinds: [], requires: ["gateway_api", "http_issuer"], tiers: allTiers(`${MAX_DOMAINS_PER_ENVIRONMENT} per environment`) },
  { id: "autoscaling", title: "Autoscaling", summary: "CPU-based horizontal autoscaling of web services up to the plan's replica ceiling and quota.", kinds: [], requires: ["cluster"], tiers: (t) => ({ included: PLAN_LIMITS[t].maxAutoscaleReplicas > 0, ...(PLAN_LIMITS[t].maxAutoscaleReplicas > 0 ? { limit: `up to ${PLAN_LIMITS[t].maxAutoscaleReplicas} replicas` } : {}) }) },
  { id: "built-images", title: "Built-image registry", summary: "Digest-pinned images in the platform registry can be deployed; images outside it are refused.", kinds: [], requires: ["registry"], tiers: allTiers() },
];

/** Kinds the managed tier provides implicitly (tenancy baseline, platform DNS and TLS), so they are offered without being a service of their own. */
export const PLATFORM_PROVIDED_KINDS: readonly PortableKind[] = ["network", "kubernetes_namespace", "firewall", "dns_record", "tls_certificate", "identity"];

const zenithEntries = (offered: OfferedCatalog) => offered.entries.filter((e) => e.provider === "zenith");
const isOffered = (level: SupportLevel): boolean => level !== "unsupported";

export interface DriftProblem {
  code: "promised_not_offered" | "offered_not_promised" | "promised_and_platform_provided" | "unknown_kind";
  kind?: string;
  service?: string;
  detail: string;
}

/** Pure; takes the offered catalog so a test can feed a tampered one. */
export function checkManagedCatalogDrift(offered: OfferedCatalog = getOfferedCatalog(), promises: readonly ManagedServicePromise[] = MANAGED_PROMISES, platformProvided: readonly PortableKind[] = PLATFORM_PROVIDED_KINDS): DriftProblem[] {
  const problems: DriftProblem[] = [];
  const entries = new Map(zenithEntries(offered).map((e) => [e.kind as string, e]));
  const promised = new Map<string, string>();
  for (const service of promises) {
    for (const kind of service.kinds) {
      promised.set(kind, service.id);
      const entry = entries.get(kind);
      if (!entry) problems.push({ code: "unknown_kind", kind, service: service.id, detail: `${service.id} promises ${kind}, which the offered catalog has no zenith entry for.` });
      else if (!isOffered(entry.level)) problems.push({ code: "promised_not_offered", kind, service: service.id, detail: `${service.id} promises ${kind}, but the offered catalog marks it ${entry.level}${entry.reason ? ` (${entry.reason})` : ""}.` });
    }
  }
  for (const kind of platformProvided) {
    if (promised.has(kind)) problems.push({ code: "promised_and_platform_provided", kind, service: promised.get(kind), detail: `${kind} is both a promised service and a platform-provided kind.` });
    const entry = entries.get(kind);
    if (!entry) problems.push({ code: "unknown_kind", kind, detail: `${kind} is named platform-provided but has no zenith entry in the offered catalog.` });
    else if (!isOffered(entry.level)) problems.push({ code: "promised_not_offered", kind, detail: `${kind} is named platform-provided, but the offered catalog marks it ${entry.level}.` });
  }
  for (const [kind, entry] of entries) {
    if (isOffered(entry.level) && !promised.has(kind) && !platformProvided.includes(kind as PortableKind)) {
      problems.push({ code: "offered_not_promised", kind, detail: `The offered catalog offers ${kind} on zenith (${entry.level}) but no managed service promises it.` });
    }
  }
  return problems.sort((a, b) => (a.code + (a.kind ?? "")).localeCompare(b.code + (b.kind ?? "")));
}

export type ServiceAvailability = { available: true } | { available: false; missing: SubstrateRequirement[]; reason: string };

const REQUIREMENT_HINT: Record<SubstrateRequirement, string> = {
  cluster: "the managed cluster (ZENITH_MANAGED_CLUSTER_SERVER, ZENITH_MANAGED_KUBECONFIG_REF, ZENITH_MANAGED_APP_DOMAIN)",
  gateway_api: "Gateway API mode (ZENITH_MANAGED_GATEWAY_MODE=gateway_api)",
  http_issuer: "an ACME HTTP-01 ClusterIssuer (ZENITH_MANAGED_HTTP_CLUSTER_ISSUER)",
  registry: "a platform registry (ZENITH_MANAGED_REGISTRY)",
  object_storage: "the shared bucket (ZENITH_MANAGED_OBJECT_STORAGE_ENDPOINT, ZENITH_MANAGED_OBJECT_STORAGE_BUCKET)",
  object_storage_admin: "the IAM-admin credential reference (ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF)",
  managed_database: "a managed database provider (ZENITH_MANAGED_DB_PROVIDER, ZENITH_MANAGED_DB_API_KEY_REF, ZENITH_MANAGED_DB_REGION)",
};

/** `undefined` substrate = the platform is not configured at all: every requirement is missing. */
export function serviceAvailability(service: ManagedServicePromise, substrate: ZenithSubstrate | undefined): ServiceAvailability {
  const has = (r: SubstrateRequirement): boolean => {
    if (!substrate) return false;
    switch (r) {
      case "cluster": return true;
      case "gateway_api": return substrate.gateway.mode === "gateway_api";
      case "http_issuer": return substrate.gateway.mode === "gateway_api" && substrate.certManager.httpClusterIssuer !== undefined;
      case "registry": return substrate.registry !== undefined;
      case "object_storage": return substrate.objectStorage !== undefined;
      case "object_storage_admin": return substrate.objectStorage?.adminCredentialRef !== undefined;
      case "managed_database": return substrate.database !== undefined;
    }
  };
  const missing = service.requires.filter((r) => !has(r));
  return missing.length === 0 ? { available: true } : { available: false, missing, reason: `Needs ${missing.map((m) => REQUIREMENT_HINT[m]).join("; ")}.` };
}

export interface ManagedServiceView {
  id: string;
  title: string;
  summary: string;
  kinds: readonly PortableKind[];
  /** offered-catalog level per kind (what the drivers implement), never upgraded here */
  levels: Record<string, SupportLevel>;
  tiers: Record<PlanTier, { included: boolean; limit?: string }>;
  requires: readonly SubstrateRequirement[];
  availability: ServiceAvailability;
  /** postgres only: whether export and import are supported for the managed database, from the portability matrix */
  dataPortability?: { export: { supported: boolean; reason?: string }; import: { supported: boolean; reason?: string } };
}

export interface ManagedServiceCatalog {
  schemaVersion: 1;
  offeredCatalogVersion: string;
  offeredCatalogDigest: string;
  provider: "zenith";
  services: ManagedServiceView[];
  platformProvided: readonly PortableKind[];
  /** the kinds the managed tier refuses, with the offered catalog's own reasons */
  notOffered: { kind: string; reason: string }[];
  drift: { ok: boolean; problems: DriftProblem[] };
  /** digest of everything above that a client could cache against */
  digest: string;
}

export function buildManagedServiceCatalog(opts: { substrate?: ZenithSubstrate; offered?: OfferedCatalog } = {}): ManagedServiceCatalog {
  const offered = opts.offered ?? getOfferedCatalog();
  const entries = new Map(zenithEntries(offered).map((e) => [e.kind as string, e]));
  const problems = checkManagedCatalogDrift(offered);
  const services: ManagedServiceView[] = MANAGED_PROMISES.map((s) => {
    const portability = s.id === "managed-postgres" ? portabilitySupport : undefined;
    return {
      id: s.id, title: s.title, summary: s.summary, kinds: s.kinds,
      levels: Object.fromEntries(s.kinds.map((k) => [k, entries.get(k)?.level ?? "unsupported"])) as Record<string, SupportLevel>,
      tiers: Object.fromEntries(PLAN_TIERS.map((t) => [t, s.tiers(t)])) as ManagedServiceView["tiers"],
      requires: s.requires,
      availability: serviceAvailability(s, opts.substrate),
      ...(portability ? { dataPortability: {
        export: (({ supported, reason }) => ({ supported, ...(reason ? { reason } : {}) }))(portability("export", "zenith", "postgres") as { supported: boolean; reason?: string }),
        import: (({ supported, reason }) => ({ supported, ...(reason ? { reason } : {}) }))(portability("import", "zenith", "postgres") as { supported: boolean; reason?: string }),
      } } : {}),
    };
  });
  const notOffered = zenithEntries(offered).filter((e) => !isOffered(e.level)).map((e) => ({ kind: e.kind as string, reason: e.reason ?? "not offered" })).sort((a, b) => a.kind.localeCompare(b.kind));
  const body = { services, platformProvided: PLATFORM_PROVIDED_KINDS, notOffered, drift: { ok: problems.length === 0, problems } };
  return {
    schemaVersion: 1, offeredCatalogVersion: offered.catalogVersion, offeredCatalogDigest: offered.contentDigest, provider: "zenith", ...body,
    digest: createHash("sha256").update(JSON.stringify([offered.contentDigest, body.services.map((s) => [s.id, s.kinds, s.levels, s.tiers, s.requires]), body.platformProvided, body.notOffered])).digest("hex"),
  };
}
