/**
 * Cost engine v2 building blocks: input types, usage defaults, the price
 * ledger and the per-kind pricing rules. The public API and the graph-level
 * rules (NAT, IPv4, load balancers, egress, cross-boundary transfer) live in
 * `cost.ts`, which documents the whole model; this file is split out only to
 * keep each file focused.
 */
import type { PortableKind } from "@/lib/resources/types";
import type { CostLine, PriceCatalog, PriceEntry, PriceVerification, UsageAssumptions } from "@/lib/placement/types";
import { buildPriceBook, MissingPriceError, type PriceBook } from "@/lib/placement/pricebook";
import { skuFor, type SkuRole } from "@/lib/placement/capabilities";
import { containerShape, isPlacementSize, vmClass, type PlacementSize } from "@/lib/placement/sizes";

export const HOURS_PER_MONTH = 730;
export const DEFAULT_AZ_COUNT = 2;
export const DEFAULT_BACKUP_RETENTION_DAYS = 7;
/** daily change rate used to size incremental backups (assumption) */
export const BACKUP_CHANGE_RATE_PER_DAY = 0.05;
export const OBJECT_READ_SHARE = 0.9;
/** legacy duty cycle of a cron service: it "runs briefly" */
export const SCHEDULED_JOB_DUTY = 0.15;
/** new connections per second one ALB capacity unit covers (AWS documented dimension) */
export const LCU_NEW_CONNECTIONS_PER_SECOND = 25;

export const DEFAULT_USAGE: Required<UsageAssumptions> = {
  egressGb: 50,
  requestsMillions: 5,
  storageGb: 10,
  logGbPerService: 5,
  dbStorageGb: 20,
  interComponentFraction: 0.2,
};

/** Data-plane relations that move bytes between components. */
export const TRAFFIC_RELATIONS = new Set(["routes_to", "connects_to", "publishes_to", "consumes_from"]);

export class CostInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostInputError";
  }
}

export interface CostNode {
  address: string;
  kind: PortableKind | "provider_native";
  provider: string;
  region: string;
  spec?: Record<string, unknown>;
  ownership?: "managed" | "referenced" | "external";
}

export interface CostEdge {
  from: string;
  to: string;
  relation: string;
}

/** Structurally satisfied by `ResourceGraph`. */
export interface CostGraph {
  nodes: readonly CostNode[];
  edges?: readonly CostEdge[];
}

export interface CostOptions {
  catalog: PriceCatalog | PriceBook;
  usage?: UsageAssumptions;
  /** policy default for database backup retention when a node does not set one */
  backupRetentionDays?: number;
  /** ISO timestamp stamped into `computedAt`; defaults to the catalog snapshot time (never the wall clock) */
  now?: string;
}

/* --------------------------------- helpers -------------------------------- */

const bookCache = new WeakMap<PriceCatalog, PriceBook>();

export function toPriceBook(catalog: PriceCatalog | PriceBook): PriceBook {
  if ("find" in catalog && typeof catalog.find === "function") return catalog as PriceBook;
  const c = catalog as PriceCatalog;
  let b = bookCache.get(c);
  if (!b) {
    b = buildPriceBook(c);
    bookCache.set(c, b);
  }
  return b;
}

/** 2-decimal rounding, half away from zero, tolerant of binary float noise (0.005 -> 0.01, 31.025 -> 31.03). */
export function round2(x: number): number {
  return (Math.sign(x) * Math.round(Math.abs(x) * 100 + 1e-9)) / 100 || 0;
}

export function q6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

export function fmt(x: number): string {
  return String(q6(x));
}

export function resolveUsage(u: UsageAssumptions | undefined): Required<UsageAssumptions> {
  const out = { ...DEFAULT_USAGE };
  if (u) {
    for (const k of Object.keys(DEFAULT_USAGE) as (keyof UsageAssumptions)[]) {
      const v = u[k];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new CostInputError(`usage.${k} must be a finite number >= 0.`);
      out[k] = v;
    }
  }
  if (out.interComponentFraction > 1) throw new CostInputError("usage.interComponentFraction must be between 0 and 1.");
  return out;
}

export function specOf(n: CostNode): Record<string, unknown> {
  return n.spec ?? {};
}

export function num(n: CostNode, key: string, fallback: number, opts: { int?: boolean; min?: number } = {}): number {
  const v = specOf(n)[key];
  if (v === undefined || v === null) return fallback;
  const min = opts.min ?? 0;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || (opts.int && !Number.isInteger(v))) {
    throw new CostInputError(`${n.address}: spec.${key} must be ${opts.int ? "an integer" : "a number"} >= ${min}.`);
  }
  return v;
}

export function bool(n: CostNode, ...keys: string[]): boolean | undefined {
  for (const k of keys) {
    const v = specOf(n)[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== "boolean") throw new CostInputError(`${n.address}: spec.${k} must be a boolean.`);
    return v;
  }
  return undefined;
}

export function sizeOf(n: CostNode): PlacementSize {
  const v = specOf(n).size;
  if (v === undefined || v === null) return "small";
  if (!isPlacementSize(v)) throw new CostInputError(`${n.address}: unknown size "${String(v)}" (expected nano, small, standard or performance).`);
  return v;
}

export function azCountOf(n: CostNode): number {
  const s = specOf(n);
  if (s.azCount !== undefined) return num(n, "azCount", DEFAULT_AZ_COUNT, { int: true, min: 1 });
  // `NetworkSpec.zones` (src/lib/resources/specs.ts) is a count.
  if (typeof s.zones === "number") return num(n, "zones", DEFAULT_AZ_COUNT, { int: true, min: 1 });
  if (Array.isArray(s.zones) && s.zones.length > 0) return s.zones.length;
  return DEFAULT_AZ_COUNT;
}

const WEAK: ReadonlySet<PriceVerification> = new Set<PriceVerification>(["model_knowledge", "derived", "internal_assumption"]);

/* ---------------------------------- ledger -------------------------------- */

interface LedgerLine {
  line: CostLine;
  raw: number;
  weak: boolean;
}

export class Ledger {
  readonly lines: LedgerLine[] = [];
  readonly excluded = new Set<string>();
  readonly assumed: Record<string, number | string> = {};
  readonly unpricedProviders = new Set<string>();
  constructor(readonly book: PriceBook) {}

  /** entry for a role, or undefined (and an exclusion note) when the provider has no such role */
  entry(provider: string, region: string, role: SkuRole, who: string): PriceEntry | undefined {
    const sku = skuFor(provider, role);
    if (!sku) {
      this.excluded.add(`${who}: ${provider} has no catalog SKU for ${role.replace(/_/g, " ")}; not priced.`);
      return undefined;
    }
    const e = this.book.find(provider, region, sku);
    if (!e) throw new MissingPriceError(provider, region, sku);
    return e;
  }

  /** price a quantity of `role`; returns the entry used, or undefined when the role does not exist for the provider */
  charge(args: { address?: string; description: string; provider: string; region: string; role: SkuRole; quantity: number; basis: string; who?: string }): PriceEntry | undefined {
    const e = this.entry(args.provider, args.region, args.role, args.who ?? args.address ?? args.description);
    if (!e) return undefined;
    if (args.quantity <= 0) return e;
    const quantity = q6(args.quantity);
    const raw = quantity * e.usd;
    this.lines.push({
      line: {
        ...(args.address !== undefined ? { address: args.address } : {}),
        description: args.description,
        sku: e.sku,
        quantity,
        unit: e.unit,
        unitUsd: e.usd,
        monthlyUsd: round2(raw),
        basis: args.basis,
        ...(e.verification ? { priceVerification: e.verification } : {}),
      },
      raw,
      weak: e.verification !== undefined && WEAK.has(e.verification),
    });
    return e;
  }

  /** multiplier from a `ratio` SKU, defaulting to 1 with an exclusion note when absent */
  ratio(provider: string, region: string, role: SkuRole, who: string): number {
    const e = this.entry(provider, region, role, who);
    return e?.usd ?? 1;
  }
}

/* ------------------------------- node pricing ------------------------------ */

export function isPublic(n: CostNode): boolean {
  return bool(n, "publicIp", "assignPublicIp") === true;
}

export function replicasOf(n: CostNode): number {
  if (n.kind === "compute_instance") return num(n, "count", num(n, "replicas", 1, { int: true }), { int: true });
  return num(n, "replicas", 1, { int: true });
}

export function priceContainer(l: Ledger, n: CostNode) {
  const size = sizeOf(n);
  const replicas = replicasOf(n);
  const duty = n.kind === "scheduled_job" ? SCHEDULED_JOB_DUTY : 1;
  const shape = containerShape(n.provider, size);
  const hours = HOURS_PER_MONTH * replicas * duty;
  const dutyText = duty === 1 ? "" : ` × ${duty} duty cycle (scheduled job runs briefly)`;
  const shapeText = shape.note ? ` [${shape.note}]` : "";
  l.charge({
    address: n.address,
    description: `${n.kind === "scheduled_job" ? "Scheduled job" : "Container"} vCPU-hours (${size})`,
    provider: n.provider,
    region: n.region,
    role: "container_vcpu_hour",
    quantity: hours * shape.vcpu,
    basis: `${HOURS_PER_MONTH} h × ${replicas} replica(s)${dutyText} × ${fmt(shape.vcpu)} vCPU (${size})${shapeText}`,
  });
  l.charge({
    address: n.address,
    description: `${n.kind === "scheduled_job" ? "Scheduled job" : "Container"} memory GB-hours (${size})`,
    provider: n.provider,
    region: n.region,
    role: "container_gb_hour",
    quantity: hours * shape.memoryGb,
    basis: `${HOURS_PER_MONTH} h × ${replicas} replica(s)${dutyText} × ${fmt(shape.memoryGb)} GB (${size})${shapeText}`,
  });
  if (n.provider === "azure") l.assumed.azureContainerBilling = "active-rate upper bound (idle vCPU/memory is billed at roughly 1/8 of the active rate)";
}

/* These profiles match the current native drivers, not arbitrary portable
 * configurations. Unknown billing-affecting fields must not disappear into a
 * partial subtotal. Usage is assumed when omitted, never measured. */
function meteredShape(n: CostNode, keys: readonly string[]): Record<string, unknown> {
  const spec = specOf(n);
  if (Object.keys(spec).some((key) => !keys.includes(key))) throw new MissingPriceError(n.provider, n.region, `(unsupported ${n.kind} billing profile: ${n.address})`);
  return spec;
}

function meteredNumber(n: CostNode, key: string, fallback: number, int = false): number {
  if (specOf(n)[key] === null) throw new CostInputError(`${n.address}: spec.${key} must be a finite nonnegative ${int ? "integer" : "number"}.`);
  return num(n, key, fallback, { int });
}

function requireRoles(l: Ledger, n: CostNode, roles: readonly SkuRole[]): void {
  for (const role of roles) {
    if (!skuFor(n.provider, role) || !l.entry(n.provider, n.region, role, n.address)) throw new MissingPriceError(n.provider, n.region, role);
  }
}

export function priceSecret(l: Ledger, n: CostNode): void {
  const keys = ["namespace", "secretRef", "store", "purpose", "requestsMillions", ...(n.provider === "gcp" ? ["activeVersions", "rotationNotifications"] : [])];
  const spec = meteredShape(n, keys);
  if (!["aws", "gcp", "azure"].includes(n.provider) || spec.store !== "zenith_vault" || spec.purpose !== "environment" || typeof spec.secretRef !== "string" || !spec.secretRef.startsWith("vault:") || spec.secretRef.length <= 6 || (spec.namespace !== undefined && typeof spec.namespace !== "string")) {
    throw new MissingPriceError(n.provider, n.region, `(unsupported managed secret store/purpose: ${n.address})`);
  }
  const requests = meteredNumber(n, "requestsMillions", 0.01);
  l.assumed.secretRequestsMillionsDefault = 0.01;
  l.assumed.secretDriverProfile = "AWS aws/secretsmanager without rotation; GCP one user-managed replica; Azure Standard vault, secret operations only";
  requireRoles(l, n, ["secret_requests_million", ...(n.provider === "aws" ? ["secret_month" as const] : n.provider === "gcp" ? ["secret_active_version_month" as const, "secret_rotation_notification" as const] : [])]);
  if (n.provider === "aws") l.charge({ address: n.address, description: "Managed secret storage", provider: n.provider, region: n.region, role: "secret_month", quantity: 1, basis: "1 secret-month; versions share the secret charge; native aws/secretsmanager encryption is free, automatic rotation is not configured" });
  if (n.provider === "gcp") {
    const versions = meteredNumber(n, "activeVersions", 1, true);
    const rotations = meteredNumber(n, "rotationNotifications", 0, true);
    l.assumed.secretActiveVersionsDefault = 1;
    l.assumed.secretRotationNotificationsDefault = 0;
    l.charge({ address: n.address, description: "Managed secret active versions", provider: n.provider, region: n.region, role: "secret_active_version_month", quantity: versions, basis: `${versions} enabled or disabled version(s) × 1 native replica location × 1 month; retained version count is assumed, not read from the account` });
    l.charge({ address: n.address, description: "Managed secret rotation notifications", provider: n.provider, region: n.region, role: "secret_rotation_notification", quantity: rotations, basis: `${rotations} notification(s); native driver sets no rotation schedule (default 0); free allowance not deducted; external rotation execution is unsupported` });
  }
  l.charge({ address: n.address, description: "Managed secret API requests", provider: n.provider, region: n.region, role: "secret_requests_million", quantity: requests, basis: `${fmt(requests)} million assumed billable ${n.provider === "gcp" ? "access" : "secret"} operations/month; default 10,000, not measured; ${n.provider === "azure" ? "Standard Key Vault has operation-based secret pricing" : "free allowances not deducted"}` });
}

export function priceRegistry(l: Ledger, n: CostNode): void {
  const spec = meteredShape(n, ["scanOnPush", "immutableTags", "storageGb", "internetPullGb"]);
  if (n.provider !== "aws" || spec.scanOnPush !== true || spec.immutableTags !== false) throw new MissingPriceError(n.provider, n.region, `(unsupported managed registry profile: ${n.address})`);
  requireRoles(l, n, ["registry_storage_gb_month", "egress_internet_gb"]);
  const storage = meteredNumber(n, "storageGb", 1);
  const internet = meteredNumber(n, "internetPullGb", 1);
  l.assumed.registryStorageGbDefault = 1;
  l.assumed.registryInternetPullGbDefault = 1;
  l.assumed.registryDriverProfile = "Private ECR, AES256 encryption and basic scan on push; account-level enhanced scanning/replication/signing is unsupported";
  l.charge({ address: n.address, description: "Private registry image storage", provider: n.provider, region: n.region, role: "registry_storage_gb_month", quantity: storage, basis: `${fmt(storage)} GB-month average retained images; default 1 GB assumes all images within the native 30-image lifecycle, not one GB per image; AES256 and basic scan carry no additional charge` });
  l.charge({ address: n.address, description: "Private registry internet pulls", provider: n.provider, region: n.region, role: "egress_internet_gb", quantity: internet, basis: `${fmt(internet)} GB assumed charged internet transfer/month (default 1); same-region AWS pulls are free and may be represented by explicit 0; cross-region replication/receiving-side charges are unsupported` });
}

export function priceBuild(l: Ledger, n: CostNode): void {
  const spec = meteredShape(n, ["source", "output", "location", "buildsPerMonth", "minutesPerBuild", "sourceStorageGb", "sourceGetRequests", "sourcePutRequests", "logIngestGb", "logStorageGb", "internetEgressGb"]);
  const source = spec.source;
  const output = spec.output;
  if (n.provider !== "aws" || spec.location !== "customer_account" || !source || typeof source !== "object" || Array.isArray(source) || !output || typeof output !== "object" || Array.isArray(output)) throw new MissingPriceError(n.provider, n.region, `(unsupported managed build profile: ${n.address})`);
  const src = source as Record<string, unknown>;
  const out = output as Record<string, unknown>;
  if (Object.keys(src).some((key) => !["repo", "ref", "dockerfile"].includes(key)) || typeof src.repo !== "string" || !src.repo || typeof src.ref !== "string" || !src.ref || (src.dockerfile !== undefined && (typeof src.dockerfile !== "string" || !src.dockerfile)) || Object.keys(out).length !== 1 || typeof out.registry !== "string" || !out.registry.startsWith("container_registry/")) throw new MissingPriceError(n.provider, n.region, `(unsupported managed build source/output: ${n.address})`);
  requireRoles(l, n, ["build_medium_hour", "object_storage_gb_month", "object_get_million", "object_put_million", "logs_ingest_gb", "logs_storage_gb_month", "egress_internet_gb"]);
  const builds = meteredNumber(n, "buildsPerMonth", 4, true);
  const minutes = meteredNumber(n, "minutesPerBuild", 10);
  const storage = meteredNumber(n, "sourceStorageGb", 1);
  const gets = meteredNumber(n, "sourceGetRequests", builds, true);
  const puts = meteredNumber(n, "sourcePutRequests", builds, true);
  const logs = meteredNumber(n, "logIngestGb", 0.1);
  const retainedLogs = meteredNumber(n, "logStorageGb", 0.1);
  const internet = meteredNumber(n, "internetEgressGb", 1);
  l.assumed.buildsPerMonthDefault = 4;
  l.assumed.buildMinutesPerBuildDefault = 10;
  l.assumed.buildSourceStorageGbDefault = 1;
  l.assumed.buildSourceRequestsDefault = "one GET and one PUT per build; multipart/API retries need explicit quantities";
  l.assumed.buildLogIngestGbDefault = 0.1;
  l.assumed.buildLogStorageGbDefault = 0.1;
  l.assumed.buildInternetEgressGbDefault = 1;
  l.assumed.buildDriverProfile = "CodeBuild on-demand Linux BUILD_GENERAL1_MEDIUM, no VPC/cache/CodePipeline/customer KMS; S3 source expiry 14 days and CloudWatch retention 30 days";
  const rows: { role: SkuRole; description: string; quantity: number; basis: string }[] = [
    { role: "build_medium_hour", description: "Build compute hours", quantity: builds * Math.ceil(minutes) / 60, basis: `${builds} build(s)/month × ceil(${fmt(minutes)} minutes/build) ÷ 60; native BUILD_GENERAL1_MEDIUM on-demand Linux; free allowance not deducted` },
    { role: "object_storage_gb_month", description: "Build source bucket storage", quantity: storage, basis: `${fmt(storage)} GB-month average source bundles retained under native 14-day expiry; default 1, not measured` },
    { role: "object_get_million", description: "Build source GET requests", quantity: gets / 1e6, basis: `${gets} assumed GET request(s)/month ÷ 1,000,000` },
    { role: "object_put_million", description: "Build source PUT requests", quantity: puts / 1e6, basis: `${puts} assumed PUT request(s)/month ÷ 1,000,000; include multipart requests and retries when sizing` },
    { role: "logs_ingest_gb", description: "Build log ingestion", quantity: logs, basis: `${fmt(logs)} GB assumed log ingestion/month` },
    { role: "logs_storage_gb_month", description: "Build log storage", quantity: retainedLogs, basis: `${fmt(retainedLogs)} GB-month average compressed logs retained under native 30-day retention` },
    { role: "egress_internet_gb", description: "Build internet egress", quantity: internet, basis: `${fmt(internet)} GB assumed charged internet transfer/month; native build has no VPC/NAT; external build-service consumption is unsupported` },
  ];
  for (const row of rows) l.charge({ address: n.address, provider: n.provider, region: n.region, ...row });
}

export function priceVm(l: Ledger, n: CostNode) {
  const size = sizeOf(n);
  const count = replicasOf(n);
  const cls = vmClass(size);
  const role = `vm_${cls}_hour` as SkuRole;
  l.charge({
    address: n.address,
    description: `Virtual machine hours (${cls} class for size ${size})`,
    provider: n.provider,
    region: n.region,
    role,
    quantity: HOURS_PER_MONTH * count,
    basis: `${HOURS_PER_MONTH} h × ${count} instance(s), ${cls} class for size ${size}`,
  });
  const volumeGb = num(n, "volumeGb", 20);
  l.charge({
    address: n.address,
    description: "Block storage",
    provider: n.provider,
    region: n.region,
    role: "block_gb_month",
    quantity: volumeGb * count,
    basis: `${fmt(volumeGb)} GB × ${count} instance(s)`,
  });
  const iops = num(n, "iops", 0);
  if (iops > 0) {
    l.charge({
      address: n.address,
      description: "Provisioned block storage IOPS",
      provider: n.provider,
      region: n.region,
      role: "block_iops_month",
      quantity: iops * count,
      basis: `${fmt(iops)} provisioned IOPS × ${count} instance(s)`,
    });
  }
  const retention = specOf(n).backupRetentionDays;
  if (retention !== undefined) {
    const days = num(n, "backupRetentionDays", 0, { int: true });
    if (days > 0) {
      l.charge({
        address: n.address,
        description: "Volume snapshots",
        provider: n.provider,
        region: n.region,
        role: "block_snapshot_gb_month",
        quantity: volumeGb * count * (1 + BACKUP_CHANGE_RATE_PER_DAY * days),
        basis: `${fmt(volumeGb * count)} GB × (1 + ${BACKUP_CHANGE_RATE_PER_DAY} daily change × ${days} days retained)`,
      });
    }
  }
}

export function priceDatabase(l: Ledger, n: CostNode, usage: Required<UsageAssumptions>, policyRetention: number) {
  const size = sizeOf(n);
  const ha = bool(n, "highAvailability", "ha", "multiAz") === true;
  const role = `pg_${size}_hour` as SkuRole;
  const who = n.address;
  const mult = ha ? l.ratio(n.provider, n.region, "pg_ha_multiplier", who) : 1;
  const storageMult = ha ? l.ratio(n.provider, n.region, "pg_ha_storage_multiplier", who) : 1;
  const haText = ha ? ` × ${fmt(mult)} HA multiplier` : "";
  const label = n.kind === "mysql" ? "MySQL (priced as the provider's PostgreSQL equivalent)" : "PostgreSQL";
  l.charge({
    address: n.address,
    description: `Managed ${label} instance hours (${size}${ha ? ", high availability" : ""})`,
    provider: n.provider,
    region: n.region,
    role,
    quantity: HOURS_PER_MONTH * mult,
    basis: `${HOURS_PER_MONTH} h${haText}, ${size} instance class`,
  });
  const storageGb = num(n, "storageGb", usage.dbStorageGb);
  l.charge({
    address: n.address,
    description: "Database storage",
    provider: n.provider,
    region: n.region,
    role: "pg_storage_gb_month",
    quantity: storageGb * storageMult,
    basis: `${fmt(storageGb)} GB${ha ? ` × ${fmt(storageMult)} HA storage multiplier` : ""}`,
  });
  const iops = num(n, "iops", 0);
  if (iops > 0) {
    l.charge({
      address: n.address,
      description: "Provisioned database IOPS",
      provider: n.provider,
      region: n.region,
      role: "pg_iops_month",
      quantity: iops,
      basis: `${fmt(iops)} provisioned IOPS above baseline`,
    });
  }
  // `backup` is either the legacy boolean or the resource model's
  // "none" | "daily" | "hourly" (src/lib/resources/specs.ts PostgresSpec).
  const backupSpec = specOf(n).backup;
  if (backupSpec !== undefined && typeof backupSpec !== "boolean" && backupSpec !== "none" && backupSpec !== "daily" && backupSpec !== "hourly") {
    throw new CostInputError(`${n.address}: spec.backup must be a boolean or "none" | "daily" | "hourly".`);
  }
  const backupOff = backupSpec === false || backupSpec === "none";
  const retention = specOf(n).backupRetentionDays === undefined ? policyRetention : num(n, "backupRetentionDays", policyRetention, { int: true });
  if (!backupOff && retention > 0) {
    l.charge({
      address: n.address,
      description: "Database backup storage",
      provider: n.provider,
      region: n.region,
      role: "pg_backup_gb_month",
      quantity: storageGb * (1 + BACKUP_CHANGE_RATE_PER_DAY * retention),
      basis: `${fmt(storageGb)} GB × (1 + ${BACKUP_CHANGE_RATE_PER_DAY} daily change × ${retention} days retained); provider free backup allowance not deducted`,
    });
  }
}

export function priceCache(l: Ledger, n: CostNode) {
  const size = sizeOf(n);
  const nodes = num(n, "replicas", bool(n, "highAvailability", "ha") === true ? 2 : 1, { int: true, min: 1 });
  const m = nodes <= 1 ? 1 : (l.ratio(n.provider, n.region, "cache_ha_multiplier", n.address) * nodes) / 2;
  l.charge({
    address: n.address,
    description: `Managed Redis node hours (${size}${nodes > 1 ? `, ${nodes} nodes` : ""})`,
    provider: n.provider,
    region: n.region,
    role: `cache_${size}_hour` as SkuRole,
    quantity: HOURS_PER_MONTH * m,
    basis: `${HOURS_PER_MONTH} h${nodes > 1 ? ` × ${fmt(m)} replicated-node multiplier (${nodes} nodes)` : ""}, ${size} node class`,
  });
}

export function priceObjectStore(l: Ledger, n: CostNode, usage: Required<UsageAssumptions>) {
  const gb = num(n, "storageGb", usage.storageGb);
  const millions = num(n, "requestsMillions", 1);
  l.charge({
    address: n.address,
    description: "Object storage",
    provider: n.provider,
    region: n.region,
    role: "object_storage_gb_month",
    quantity: gb,
    basis: `${fmt(gb)} GB stored`,
  });
  l.charge({
    address: n.address,
    description: "Object storage read requests",
    provider: n.provider,
    region: n.region,
    role: "object_get_million",
    quantity: millions * OBJECT_READ_SHARE,
    basis: `${fmt(millions)} M requests × ${OBJECT_READ_SHARE} read share`,
  });
  l.charge({
    address: n.address,
    description: "Object storage write requests",
    provider: n.provider,
    region: n.region,
    role: "object_put_million",
    quantity: millions * (1 - OBJECT_READ_SHARE),
    basis: `${fmt(millions)} M requests × ${q6(1 - OBJECT_READ_SHARE)} write share`,
  });
}

export function priceQueue(l: Ledger, n: CostNode) {
  const millions = num(n, "requestsMillions", 1);
  l.charge({
    address: n.address,
    description: "Queue / topic requests",
    provider: n.provider,
    region: n.region,
    role: "queue_requests_million",
    quantity: millions,
    basis: `${fmt(millions)} M requests per month`,
  });
}

export function priceVolume(l: Ledger, n: CostNode) {
  const gb = num(n, "sizeGb", num(n, "storageGb", 20));
  l.charge({ address: n.address, description: "Block volume", provider: n.provider, region: n.region, role: "block_gb_month", quantity: gb, basis: `${fmt(gb)} GB` });
  const iops = num(n, "iops", 0);
  if (iops > 0) {
    l.charge({ address: n.address, description: "Provisioned block storage IOPS", provider: n.provider, region: n.region, role: "block_iops_month", quantity: iops, basis: `${fmt(iops)} provisioned IOPS` });
  }
}

export function priceDnsZone(l: Ledger, n: CostNode) {
  const millions = num(n, "queriesMillions", 1);
  l.charge({ address: n.address, description: "DNS hosted zone", provider: n.provider, region: n.region, role: "dns_zone_month", quantity: 1, basis: "1 hosted zone" });
  l.charge({ address: n.address, description: "DNS queries", provider: n.provider, region: n.region, role: "dns_queries_million", quantity: millions, basis: `${fmt(millions)} M queries per month` });
}
