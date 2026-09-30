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
  const ha = bool(n, "ha", "multiAz") === true;
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
  const backupOff = bool(n, "backup") === false;
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
  const nodes = num(n, "replicas", bool(n, "ha") === true ? 2 : 1, { int: true, min: 1 });
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
