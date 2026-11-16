/**
 * Price catalog loader, validator and lookup index (ADR-0013).
 *
 * Invariants:
 * - The catalog is a STATIC SNAPSHOT of list prices (`catalog/2026-10.json`).
 *   Nothing here fetches anything; refreshing it is a deliberate, reviewed
 *   change that bumps `version`.
 * - Every entry names how its number was obtained (`verification`) and is
 *   covered by a `sources[]` record for the same provider and verification
 *   class, which carries the official pricing URL, the retrieval date and an
 *   explicit statement that the values were transcribed, not fetched live.
 * - A missing price is an error, never a silent zero: a candidate that cannot
 *   be priced cannot be recommended.
 * - Prices are USD list prices before taxes, discounts and free tiers.
 *
 * Honest limit: entries marked `model_knowledge`, `derived` or
 * `internal_assumption` were NOT read from a price feed. `verificationSummary`
 * lets an estimate say how much of its total rests on such numbers.
 *
 * Refreshing the catalog (a reviewed change that bumps `version` and the
 * touched source retrieval dates): re-read the feeds named in `sources[].source`,
 * including the AWS Price
 * List Bulk API region files, the Azure Retail Prices API
 * (prices.azure.com/api/retail/prices, filtered by armRegionName and
 * serviceName), the OCI public price list API and the Cloud Run pricing page —
 * for the SKUs each `note` names; then re-derive the `derived` entries and
 * replace `model_knowledge` entries by feed values where a feed exists. The
 * catalog tests fail if a role loses a price in any region or an entry loses
 * its source.
 */
import { z } from "zod";
import type { PriceCatalog, PriceEntry, PriceVerification } from "@/lib/placement/types";
import rawCatalog from "@/lib/placement/catalog/2026-10.json";

const VERIFICATIONS = [
  "official_api",
  "official_page",
  "third_party_mirror",
  "derived",
  "model_knowledge",
  "internal_assumption",
] as const satisfies readonly PriceVerification[];

/** Verification classes that mean "read from a provider price feed or page". */
export const STRONG_VERIFICATIONS: readonly PriceVerification[] = ["official_api", "official_page"];

const UNITS = ["hour", "month", "gb_month", "gb", "million_requests", "iops_month", "request", "ratio"] as const;

const SKU_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(value: string): boolean {
  if (value.length !== 10 || !ISO_DATE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = month === 2 ? (leapYear ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day <= daysInMonth;
}

const TierSchema = z.object({ fromGb: z.number().finite().nonnegative(), usd: z.number().finite().nonnegative() }).strict();

const EntrySchema = z
  .object({
    provider: z.string().min(1),
    region: z.string().min(1),
    sku: z.string().regex(SKU_PATTERN, "sku must be dotted lowercase, e.g. aws.nat_gateway.hour"),
    unit: z.enum(UNITS),
    usd: z.number().finite().nonnegative(),
    verification: z.enum(VERIFICATIONS),
    note: z.string().min(1).optional(),
    tiers: z.array(TierSchema).min(2).optional(),
  })
  .strict();

const SnapshotSchema = z
  .object({
    provider: z.string().min(1),
    url: z.string().url().startsWith("https://"),
    retrievedAt: z.string().refine(isCalendarDate, "retrievedAt must be a real YYYY-MM-DD calendar date"),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex characters"),
    bytes: z.number().int().positive(),
    service: z.string().min(1).optional(),
    region: z.string().min(1).optional(),
  })
  .strict();

const SourceSchema = z
  .object({
    provider: z.string().min(1),
    source: z.string().min(40, "source must describe where the numbers came from"),
    retrievedAt: z.string().refine(isCalendarDate, "retrievedAt must be a real YYYY-MM-DD calendar date"),
    url: z.string().url().startsWith("https://"),
    verification: z.enum(VERIFICATIONS),
  })
  .strict();

const CatalogSchema = z
  .object({
    version: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d+$/, "version must look like 2026-10-05.2").refine((value) => isCalendarDate(value.split(".")[0]!), "version must contain a real calendar date"),
    sources: z.array(SourceSchema).min(1),
    snapshots: z.array(SnapshotSchema).optional(),
    entries: z.array(EntrySchema).min(1),
  })
  .strict();

export class PlacementCatalogError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid price catalog: ${issues.slice(0, 5).join("; ")}${issues.length > 5 ? ` (+${issues.length - 5} more)` : ""}`);
    this.name = "PlacementCatalogError";
    this.issues = issues;
  }
}

export class MissingPriceError extends Error {
  constructor(
    readonly provider: string,
    readonly region: string,
    readonly sku: string,
  ) {
    super(`No price for ${sku} in ${provider}/${region}.`);
    this.name = "MissingPriceError";
  }
}

/** Validate an untrusted catalog object. Throws `PlacementCatalogError` listing every problem found. */
export function parseCatalog(input: unknown): PriceCatalog {
  const parsed = CatalogSchema.safeParse(input);
  if (!parsed.success) {
    throw new PlacementCatalogError(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  const catalog = parsed.data as PriceCatalog;
  const issues: string[] = [];
  const versionDate = catalog.version.split(".")[0]!;
  for (const source of catalog.sources) {
    if (source.retrievedAt > versionDate) issues.push(`source for ${source.provider}/${source.verification} was retrieved after the catalog version date`);
  }

  const covered = new Set(catalog.sources.map((s) => `${s.provider}|${s.verification}`));
  const seen = new Set<string>();
  for (const e of catalog.entries) {
    const id = `${e.provider}|${e.region}|${e.sku}`;
    if (seen.has(id)) issues.push(`duplicate entry ${e.provider}/${e.region}/${e.sku}`);
    seen.add(id);
    if (!e.sku.startsWith(`${e.provider}.`)) issues.push(`sku ${e.sku} must start with its provider "${e.provider}."`);
    if (!covered.has(`${e.provider}|${e.verification}`)) {
      issues.push(`entry ${e.provider}/${e.region}/${e.sku} has verification "${e.verification}" but no matching source`);
    }
    if (e.unit === "ratio" && (!e.sku.endsWith("_multiplier") || e.usd < 1)) {
      issues.push(`ratio entry ${e.sku} must be a *_multiplier of at least 1`);
    }
    if (e.unit !== "ratio" && e.sku.endsWith("_multiplier")) issues.push(`multiplier ${e.sku} must use unit "ratio"`);
    if (e.tiers) {
      const id2 = `${e.provider}/${e.region}/${e.sku}`;
      if (e.unit !== "gb") issues.push(`tiers on ${id2} require unit "gb"`);
      else if (e.tiers[0]!.fromGb !== 0 || e.tiers[0]!.usd !== e.usd) issues.push(`tiers on ${id2} must start at 0 GB with the entry price`);
      for (let i = 1; i < e.tiers.length; i++) {
        if (e.tiers[i]!.fromGb <= e.tiers[i - 1]!.fromGb) issues.push(`tiers on ${id2} must have strictly increasing fromGb`);
        if (e.tiers[i]!.usd > e.tiers[i - 1]!.usd) issues.push(`tiers on ${id2} must not increase in price with volume`);
      }
    }
  }
  const sourceProviders = new Set(catalog.sources.map((s) => s.provider));
  for (const snap of catalog.snapshots ?? []) {
    if (!sourceProviders.has(snap.provider)) issues.push(`snapshot for ${snap.provider} has no matching source`);
    if (snap.retrievedAt > versionDate) issues.push(`snapshot for ${snap.provider} was retrieved after the catalog version date`);
  }
  for (const s of catalog.sources) {
    if (s.verification !== "internal_assumption" && !/transcribed/i.test(s.source)) {
      issues.push(`source for ${s.provider}/${s.verification} must state the values were transcribed`);
    }
    if (
      (s.verification === "model_knowledge" || s.verification === "derived" || s.verification === "internal_assumption") &&
      !/refreshed|replaced|derived|assumption/i.test(s.source)
    ) {
      issues.push(`source for ${s.provider}/${s.verification} must say the numbers need refreshing or are assumptions`);
    }
  }
  if (issues.length > 0) throw new PlacementCatalogError(issues);
  return catalog;
}

let defaultCatalog: PriceCatalog | undefined;

/** The bundled catalog, validated once. */
export function loadDefaultCatalog(): PriceCatalog {
  defaultCatalog ??= parseCatalog(rawCatalog);
  return defaultCatalog;
}

/** Latest source retrieval at midnight UTC; a partial refresh does not refresh every entry. */
export function catalogSnapshotAt(catalog: PriceCatalog): string {
  const latest = catalog.sources.map((s) => s.retrievedAt).sort().at(-1) ?? "1970-01-01";
  return `${latest}T00:00:00.000Z`;
}

export interface PriceBook {
  readonly catalog: PriceCatalog;
  /** the entry, or undefined */
  find(provider: string, region: string, sku: string): PriceEntry | undefined;
  /** the entry's usd, or throws `MissingPriceError` */
  price(provider: string, region: string, sku: string): number;
  has(provider: string, region: string, sku: string): boolean;
  providers(): string[];
  /** regions with at least one entry, sorted */
  regions(provider: string): string[];
  /** skus present for a provider/region, sorted */
  skus(provider: string, region: string): string[];
}

export function buildPriceBook(catalog: PriceCatalog): PriceBook {
  const byKey = new Map<string, PriceEntry>();
  const regionsByProvider = new Map<string, Set<string>>();
  const skusByRegion = new Map<string, Set<string>>();
  for (const e of catalog.entries) {
    byKey.set(`${e.provider}|${e.region}|${e.sku}`, e);
    const rs = regionsByProvider.get(e.provider) ?? new Set<string>();
    rs.add(e.region);
    regionsByProvider.set(e.provider, rs);
    const sk = skusByRegion.get(`${e.provider}|${e.region}`) ?? new Set<string>();
    sk.add(e.sku);
    skusByRegion.set(`${e.provider}|${e.region}`, sk);
  }
  return {
    catalog,
    find: (p, r, s) => byKey.get(`${p}|${r}|${s}`),
    price(p, r, s) {
      const e = byKey.get(`${p}|${r}|${s}`);
      if (!e) throw new MissingPriceError(p, r, s);
      return e.usd;
    },
    has: (p, r, s) => byKey.has(`${p}|${r}|${s}`),
    providers: () => [...regionsByProvider.keys()].sort(),
    regions: (p) => [...(regionsByProvider.get(p) ?? [])].sort(),
    skus: (p, r) => [...(skusByRegion.get(`${p}|${r}`) ?? [])].sort(),
  };
}

/** Counts of catalog entries by verification class for one provider (or all). */
export function verificationSummary(catalog: PriceCatalog, provider?: string): Record<PriceVerification, number> {
  const out: Record<PriceVerification, number> = {
    official_api: 0,
    official_page: 0,
    third_party_mirror: 0,
    derived: 0,
    model_knowledge: 0,
    internal_assumption: 0,
  };
  for (const e of catalog.entries) {
    if (provider && e.provider !== provider) continue;
    if (e.verification) out[e.verification] += 1;
  }
  return out;
}
