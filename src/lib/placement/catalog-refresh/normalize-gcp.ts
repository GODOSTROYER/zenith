/**
 * GCP Cloud Billing Catalog normalizer. Input: one page of
 * `GET https://cloudbilling.googleapis.com/v1/services/<serviceId>/skus?currencyCode=USD`
 * (the `skus` array), saved with its checksum. Region comes from each SKU's
 * `serviceRegions`. Only `OnDemand` usage types are read.
 *
 * Same rules as the other normalizers: unit-checked, never guesses, ambiguity
 * and absence become `skipped`. Tested against recorded fixtures shaped like the
 * official response, not live pages (see `normalize-aws.ts` for the honest limit).
 *
 * Google quotes volume in GiBy; the catalog's `gb` unit is treated as the same
 * quantity (a conservative ~7% difference against decimal GB on tier boundaries
 * and no difference on per-GB price).
 */
import { buildTiered, resolveCandidates, toNumber, type Dimension, type Priced } from "@/lib/placement/catalog-refresh/common";
import type { Normalizer, PriceObservation, Skipped } from "@/lib/placement/catalog-refresh/types";
import type { PriceEntry } from "@/lib/placement/types";
import { derivePrices, type DerivedPriceRule } from "./derived";

interface GcpSku {
  description?: string;
  category?: { serviceDisplayName?: string; resourceFamily?: string; resourceGroup?: string; usageType?: string };
  serviceRegions?: string[];
  pricingInfo?: {
    pricingExpression?: {
      usageUnit?: string;
      tieredRates?: { startUsageAmount?: number | string; unitPrice?: { currencyCode?: string; units?: string; nanos?: number } }[];
    };
  }[];
}

interface GcpRule {
  sku: string;
  unit: PriceEntry["unit"];
  service: RegExp;
  match: (s: GcpSku) => boolean;
  /** accepted `usageUnit` */
  usageUnit: RegExp;
  scale?: number;
  pick: "tiers" | "first_paid";
  how?: "single" | "mode";
  note: string;
}

const desc = (re: RegExp) => (s: GcpSku) => re.test(s.description ?? "");

export const GCP_RULES: readonly GcpRule[] = [
  { sku: "component.gcp.e2.cpu", unit: "hour", service: /^Compute Engine$/, match: desc(/^E2 Instance Core running in /i), usageUnit: /^h$/, pick: "first_paid", note: "E2 core-hour" },
  { sku: "component.gcp.e2.memory", unit: "hour", service: /^Compute Engine$/, match: desc(/^E2 Instance Ram running in /i), usageUnit: /^GiBy\.h$/, pick: "first_paid", note: "E2 GiB-hour" },
  { sku: "component.gcp.sql.cpu", unit: "hour", service: /^Cloud SQL$/, match: s => /^Cloud SQL for PostgreSQL:/i.test(s.description ?? "") && /\b(vCPU|CPU)\b/i.test(s.description ?? "") && !/Regional|HA|Enterprise Plus|N2|C4A|memory.optimized/i.test(s.description ?? ""), usageUnit: /^h$/, pick: "first_paid", note: "Cloud SQL PostgreSQL Enterprise zonal CPU-hour" },
  { sku: "component.gcp.sql.memory", unit: "hour", service: /^Cloud SQL$/, match: s => /^Cloud SQL for PostgreSQL:/i.test(s.description ?? "") && /\b(RAM|Memory)\b/i.test(s.description ?? "") && !/Regional|HA|Enterprise Plus|N2|C4A|memory.optimized/i.test(s.description ?? ""), usageUnit: /^GiBy\.h$/, pick: "first_paid", note: "Cloud SQL PostgreSQL Enterprise zonal GiB-hour" },
  { sku: "gcp.cloud_sql_postgres.nano_hour", unit: "hour", service: /^Cloud SQL$/, match: s => /^Cloud SQL for PostgreSQL:/i.test(s.description ?? "") && /\bg1.small\b/i.test(s.description ?? "") && !/Regional|HA/i.test(s.description ?? ""), usageUnit: /^h$/, pick: "first_paid", note: "db-g1-small shared core, no HA" },
  { sku: "gcp.cloud_sql_postgres.storage_gb_month", unit: "gb_month", service: /^Cloud SQL$/, match: s => /^Cloud SQL for PostgreSQL:/i.test(s.description ?? "") && /SSD Storage/i.test(s.description ?? "") && !/Regional|HA/i.test(s.description ?? ""), usageUnit: /^GiBy\.mo$/, pick: "first_paid", note: "Cloud SQL zonal SSD storage" },
  { sku: "gcp.cloud_sql_postgres.backup_gb_month", unit: "gb_month", service: /^Cloud SQL$/, match: desc(/^Cloud SQL.*Backup/i), usageUnit: /^GiBy\.mo$/, pick: "first_paid", note: "Cloud SQL backup storage" },
  {
    sku: "gcp.cloud_run.vcpu_hour",
    unit: "hour",
    service: /^Cloud Run$/,
    match: (s) => /Services CPU .*Allocation Time/i.test(s.description ?? "") && !/idle/i.test(s.description ?? ""),
    usageUnit: /^s$/,
    scale: 3600,
    pick: "first_paid",
    note: "Cloud Run services CPU allocation time, per vCPU-second converted to hours",
  },
  {
    sku: "gcp.cloud_run.gb_hour",
    unit: "hour",
    service: /^Cloud Run$/,
    match: (s) => /Services Memory .*Allocation Time/i.test(s.description ?? "") && !/idle/i.test(s.description ?? ""),
    usageUnit: /GiBy\.s/,
    scale: 3600,
    pick: "first_paid",
    note: "Cloud Run services memory allocation time, per GiB-second converted to hours",
  },
  {
    sku: "gcp.network.internet_gb",
    unit: "gb",
    service: /Networking|Compute Engine/,
    match: (s) => /Network Internet Egress from .* to Worldwide Destinations/i.test(s.description ?? "") && !/to (china|australia) destinations/i.test(s.description ?? ""),
    usageUnit: /^GiBy$/,
    pick: "tiers",
    note: "Premium-tier internet egress to worldwide destinations; first paid tier from 0 GB (free allowance not deducted), provider volume tiers from their cumulative boundaries",
  },
  {
    sku: "gcp.network.inter_region_gb",
    unit: "gb",
    service: /Networking|Compute Engine/,
    match: desc(/Network Inter Region Egress from .* to .*/i),
    usageUnit: /^GiBy$/,
    pick: "first_paid",
    how: "mode",
    note: "Inter-region egress; most common destination rate, higher rate on a tie",
  },
  {
    sku: "gcp.network.inter_az_gb",
    unit: "gb",
    service: /Networking|Compute Engine/,
    match: desc(/Network Inter Zone Egress/i),
    usageUnit: /^GiBy$/,
    pick: "first_paid",
    note: "Inter-zone egress inside a region, per GiB",
  },
  { sku: "gcp.cloud_nat.hour", unit: "hour", service: /Networking/, match: desc(/Cloud NAT Gateway uptime/i), usageUnit: /^h$/, pick: "first_paid", note: "Cloud NAT gateway uptime per hour" },
  { sku: "gcp.cloud_nat.gb", unit: "gb", service: /Networking/, match: desc(/Cloud NAT Data Processing/i), usageUnit: /^GiBy$/, pick: "first_paid", note: "Cloud NAT data processed per GiB" },
  { sku: "gcp.ipv4.hour", unit: "hour", service: /Networking|Compute Engine/, match: desc(/(Static|Ephemeral) IP Charge|IP address .*in use|In-use .*IP/i), usageUnit: /^h$/, pick: "first_paid", note: "In-use external IPv4 address per hour" },
  { sku: "gcp.gcs.storage_gb_month", unit: "gb_month", service: /Cloud Storage/, match: desc(/^Standard Storage .*/i), usageUnit: /GiBy\.mo/, pick: "first_paid", note: "Cloud Storage Standard storage" },
  { sku: "gcp.pd_balanced.gb_month", unit: "gb_month", service: /Compute Engine/, match: desc(/^Balanced PD Capacity/i), usageUnit: /GiBy\.mo/, pick: "first_paid", note: "Balanced persistent disk capacity" },
  { sku: "gcp.pd_balanced.snapshot_gb_month", unit: "gb_month", service: /Compute Engine/, match: desc(/^Storage PD Snapshot/i), usageUnit: /GiBy\.mo/, pick: "first_paid", note: "Persistent disk standard snapshot storage" },
];

function gcpPrice(s: GcpSku, rule: GcpRule): Priced | { error: string } | undefined {
  const expr = s.pricingInfo?.[0]?.pricingExpression;
  if (!expr?.tieredRates?.length) return undefined;
  if (expr.usageUnit === undefined || !rule.usageUnit.test(expr.usageUnit)) return { error: `unexpected usage unit "${String(expr.usageUnit).slice(0, 40)}"` };
  const dims: Dimension[] = [];
  for (const r of expr.tieredRates) {
    if (r.unitPrice?.currencyCode !== "USD") return { error: "price is not in USD" };
    const units = toNumber(r.unitPrice.units ?? "0");
    const nanos = toNumber(r.unitPrice.nanos ?? 0);
    const from = toNumber(r.startUsageAmount ?? 0);
    if (units === undefined || nanos === undefined || from === undefined) continue;
    dims.push({ from, usd: (units + nanos / 1e9) * (rule.scale ?? 1) });
  }
  if (rule.pick === "tiers") return buildTiered(dims);
  const first = dims.sort((a, b) => a.from - b.from).find((d) => d.usd > 0);
  return first ? { usd: first.usd } : undefined;
}

export const normalizeGcp: Normalizer = (text, snapshot) => {
  const region = snapshot.region;
  const skipped: Skipped[] = [];
  const observations: PriceObservation[] = [];
  let json: { skus?: GcpSku[] };
  try {
    json = JSON.parse(text) as { skus?: GcpSku[] };
  } catch {
    return { observations, skipped: [{ sku: "(file)", region: region ?? "", reason: "not valid JSON" }] };
  }
  if (!region || !Array.isArray(json.skus)) return { observations, skipped: [{ sku: "(file)", region: region ?? "", reason: "not a Cloud Billing Catalog skus page" }] };

  for (const rule of GCP_RULES) {
    if (!rule.service.test(snapshot.service)) continue;
    const candidates: Priced[] = [];
    let problem: string | undefined;
    for (const s of json.skus) {
      if (s.category?.usageType !== "OnDemand") continue;
      if (!s.serviceRegions?.includes(region)) continue;
      if (!rule.match(s)) continue;
      const priced = gcpPrice(s, rule);
      if (!priced) continue;
      if ("error" in priced) problem = priced.error;
      else candidates.push(priced);
    }
    if (candidates.length === 0 && problem) {
      skipped.push({ sku: rule.sku, region, reason: problem });
      continue;
    }
    const resolved = resolveCandidates(candidates, rule.how ?? "single");
    if (!resolved.ok) {
      skipped.push({ sku: rule.sku, region, reason: resolved.reason });
      continue;
    }
    observations.push({
      provider: "gcp",
      region,
      sku: rule.sku,
      unit: rule.unit,
      usd: resolved.priced.usd,
      ...(resolved.priced.tiers ? { tiers: resolved.priced.tiers } : {}),
      note: `${rule.note} (Cloud Billing Catalog, ${snapshot.service})`,
      snapshotSha256: snapshot.sha256,
    });
  }
  return derivePrices({ observations, skipped }, gcpDerivedRules(snapshot.service), [region]);
};

function gcpDerivedRules(service: string): DerivedPriceRule[] {
  if (service === "Compute Engine") return [["small", 0.5, 2], ["medium", 1, 4], ["large", 2, 8]].map(([size, cpu, memory]) => ({
    sku: `gcp.compute_engine.${size}_hour`, components: [{ sku: "component.gcp.e2.cpu", quantity: Number(cpu) }, { sku: "component.gcp.e2.memory", quantity: Number(memory) }], note: `E2 ${size} Linux on-demand shape`,
  }));
  if (service === "Cloud SQL") return [["small", 1, 3.75], ["standard", 2, 7.5], ["performance", 4, 15]].map(([size, cpu, memory]) => ({
    sku: `gcp.cloud_sql_postgres.${size}_hour`, components: [{ sku: "component.gcp.sql.cpu", quantity: Number(cpu) }, { sku: "component.gcp.sql.memory", quantity: Number(memory) }], note: `Cloud SQL Enterprise zonal PostgreSQL ${size}, no HA`,
  }));
  return [];
}

export function gcpRefreshableSkus(): string[] {
  return [...GCP_RULES.map(r => r.sku).filter(s => !s.startsWith("component.")), ...gcpDerivedRules("Compute Engine").map(r => r.sku), ...gcpDerivedRules("Cloud SQL").map(r => r.sku)];
}
