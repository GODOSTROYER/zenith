/**
 * Placement and cost contract (spec §29, §30, §38, ADR-0013).
 *
 * The model turns natural language into `PlacementConstraints`; the
 * deterministic solver chooses. Every number carries its price source, and
 * every estimate says it is an estimate — never an invoice.
 */

/**
 * How a catalog number was obtained (additive to the original contract).
 * Anything other than `official_api` / `official_page` is weaker evidence and
 * the estimate says so.
 */
export type PriceVerification =
  | "official_api" // read from the provider's own public price feed / API
  | "official_page" // parsed from the provider's official pricing page
  | "third_party_mirror" // read from a third-party mirror of the official API
  | "derived" // arithmetic on other catalog numbers (documented in `note`)
  | "model_knowledge" // remembered list price, NOT read from any feed; refresh before relying on it
  | "internal_assumption"; // Zenith managed tier planning price; not a published rate

export interface PriceEntry {
  provider: string;
  region: string;
  /** SKU-ish key, e.g. `aws.fargate.vcpu_hour`, `aws.nat_gateway.hour`, `aws.ipv4.hour` */
  sku: string;
  /** `ratio` is a dimensionless multiplier (HA factors); every other unit is a per-unit USD price. */
  unit: "hour" | "month" | "gb_month" | "gb" | "million_requests" | "iops_month" | "request" | "ratio";
  usd: number;
  /** additive: how this number was obtained */
  verification?: PriceVerification;
  /** additive: what exactly is priced (instance class, tier, caveats) */
  note?: string;
  /**
   * additive, `gb` unit only: marginal volume tiers per month. `tiers[0]` starts at 0 GB and
   * equals `usd`; later tiers start higher and price only the GB above their `fromGb`.
   * Free monthly allowances are never encoded here (they stay un-deducted, conservative).
   */
  tiers?: PriceTier[];
}

export interface PriceTier {
  fromGb: number;
  usd: number;
}

/** additive: one saved provider price file a catalog was refreshed from (dated provenance + checksum) */
export interface CatalogSnapshotRecord {
  provider: string;
  /** the official endpoint or file the bytes came from */
  url: string;
  retrievedAt: string;
  /** lowercase hex SHA-256 of the exact saved bytes */
  sha256: string;
  bytes: number;
  service?: string;
  region?: string;
}

export interface PriceCatalog {
  /** catalog identity: e.g. `2026-09-30.1` */
  version: string;
  /**
   * where the numbers came from (URLs, API, manual transcription) and when.
   * `url` and `verification` are additive: a catalog entry is covered by the
   * source with the same provider and `verification`.
   */
  sources: { provider: string; source: string; retrievedAt: string; url?: string; verification?: PriceVerification }[];
  /** additive: saved official price files this catalog was refreshed from, each with a checksum */
  snapshots?: CatalogSnapshotRecord[];
  entries: PriceEntry[];
}

export interface CostLine {
  address?: string;
  description: string;
  sku: string;
  quantity: number;
  unit: PriceEntry["unit"];
  unitUsd: number;
  monthlyUsd: number;
  /** why this quantity: "730 h/month × 2 tasks × 0.5 vCPU" */
  basis: string;
  /** additive: how the unit price was obtained (weaker classes are flagged in the estimate's assumptions) */
  priceVerification?: PriceVerification;
}

export interface CostEstimate {
  kind: "estimate";
  catalogVersion: string;
  currency: "USD";
  monthlyUsd: number;
  lines: CostLine[];
  /** usage assumptions the estimate depends on (egress GB, requests, …) */
  assumptions: Record<string, number | string>;
  /** commonly missed costs that were INCLUDED, so the reader can check */
  included: string[];
  /** costs not modeled, stated explicitly */
  excluded: string[];
  computedAt: string;
}

/** Monthly usage the estimate is modeled on (additive superset of the original `usage`). */
export interface UsageAssumptions {
  /** internet egress GB per month (default 50) */
  egressGb?: number;
  /** requests to the app per month, in millions (default 5); drives load-balancer capacity units */
  requestsMillions?: number;
  /** object storage GB per object store (default 10) */
  storageGb?: number;
  /** log GB ingested per compute service per month (default 5) */
  logGbPerService?: number;
  /** database storage GB per database (default 20) */
  dbStorageGb?: number;
  /** fraction of egress that flows between components across a region/provider boundary (default 0.2) */
  interComponentFraction?: number;
}

/**
 * Additive usage dimensions that are priced only when supplied (never defaulted), so an
 * estimate never invents traffic. Supplying one for a provider whose catalog lacks the
 * price refuses the estimate rather than pricing it at zero.
 */
export interface ExtendedUsageAssumptions {
  /** GB per month moving between availability zones of one region (priced per site that hosts compute) */
  interAzGb?: number;
  /** million billable storage I/O requests per month, per managed database, volume and VM */
  storageIoMillions?: number;
  /** GB per month of backup copied to another region, per managed database */
  crossRegionBackupCopyGb?: number;
}

export type CostUsage = UsageAssumptions & ExtendedUsageAssumptions;

export interface PlacementConstraints {
  budgetUsdMonthly?: number;
  /** user-facing regions (e.g. "india", "singapore") resolved to provider regions */
  userRegions: string[];
  /** data residency: allowed jurisdictions/countries */
  residency?: string[];
  /** target p95 user latency in ms, per user region */
  latencyTargetMs?: number;
  /** e.g. 99.9, 99.95 — drives multi-AZ / replica requirements */
  availabilityTarget?: number;
  providerPreference?: string[];
  providerDenylist?: string[];
  /** per-component pins, e.g. { database: "azure" } */
  componentProviders?: Record<string, string>;
  /** survive loss of one compute instance/zone */
  tolerateSingleFailure?: boolean;
  managedDatabaseRequired?: boolean;
  /** assumed monthly usage for cost modeling */
  usage?: CostUsage;
}

export interface PlacementCandidate {
  id: string;
  /** component → { provider, region, nativeType } */
  assignments: Record<string, { provider: string; region: string; nativeType: string }>;
  cost: CostEstimate;
  /** estimated p95 latency per user region, from the latency table */
  latencyMs: Record<string, number>;
  /**
   * cross-cloud / cross-region implications, costed. `from` and `to` are the
   * component addresses at the two ends of a data-plane edge; `egressUsdMonthly`
   * is the transfer cost on the sending side and `addedLatencyMs` the extra
   * round trip the boundary adds to a request.
   */
  crossBoundary: { from: string; to: string; kind: "cross_region" | "cross_cloud"; egressUsdMonthly: number; addedLatencyMs: number }[];
  /** weighted penalty; LOWER IS BETTER (the chosen candidate has the lowest score) */
  score: number;
  /** score components, for explanation */
  scoreBreakdown: Record<string, number>;
  warnings: string[];
  /** additive: shape of the candidate */
  topology?: "single_region" | "multi_region" | "cross_cloud";
  /** additive: availability zones the priced topology uses per region */
  availabilityZones?: number;
  /**
   * additive: spec keys the solver changed to satisfy availability
   * constraints (replicas, azCount, ha), per component address. Apply these
   * to the graph to get exactly what was priced.
   */
  specOverrides?: Record<string, Record<string, unknown>>;
}

export interface PlacementResult {
  chosen?: PlacementCandidate;
  alternatives: PlacementCandidate[];
  rejected: { id: string; reasons: string[] }[];
  assumptions: string[];
  catalogVersion: string;
  deterministicSeed: string;
}

/** Result of `diffCost(before, after)` (additive). */
export interface CostDiff {
  beforeMonthlyUsd: number;
  afterMonthlyUsd: number;
  deltaMonthlyUsd: number;
  /** one entry per changed / added / removed line, keyed by address + sku + description */
  lines: {
    address?: string;
    sku: string;
    description: string;
    beforeUsd: number;
    afterUsd: number;
    deltaUsd: number;
    change: "added" | "removed" | "changed";
  }[];
  /** true when the two estimates used different catalog versions (the delta then mixes price changes with usage changes) */
  catalogChanged: boolean;
}
