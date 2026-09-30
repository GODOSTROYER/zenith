/**
 * Placement and cost contract (spec §29, §30, §38, ADR-0013).
 *
 * The model turns natural language into `PlacementConstraints`; the
 * deterministic solver chooses. Every number carries its price source, and
 * every estimate says it is an estimate — never an invoice.
 */

export interface PriceEntry {
  provider: string;
  region: string;
  /** SKU-ish key, e.g. `aws.fargate.vcpu_hour`, `aws.nat_gateway.hour`, `aws.ipv4.hour` */
  sku: string;
  unit: "hour" | "month" | "gb_month" | "gb" | "million_requests" | "iops_month" | "request";
  usd: number;
}

export interface PriceCatalog {
  /** catalog identity: e.g. `2026-09-30.1` */
  version: string;
  /** where the numbers came from (URLs, API, manual transcription) and when */
  sources: { provider: string; source: string; retrievedAt: string }[];
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
  usage?: { egressGb?: number; requestsMillions?: number; storageGb?: number };
}

export interface PlacementCandidate {
  id: string;
  /** component → { provider, region, nativeType } */
  assignments: Record<string, { provider: string; region: string; nativeType: string }>;
  cost: CostEstimate;
  /** estimated p95 latency per user region, from the latency table */
  latencyMs: Record<string, number>;
  /** cross-cloud / cross-region implications, costed */
  crossBoundary: { from: string; to: string; kind: "cross_region" | "cross_cloud"; egressUsdMonthly: number; addedLatencyMs: number }[];
  score: number;
  /** score components, for explanation */
  scoreBreakdown: Record<string, number>;
  warnings: string[];
}

export interface PlacementResult {
  chosen?: PlacementCandidate;
  alternatives: PlacementCandidate[];
  rejected: { id: string; reasons: string[] }[];
  assumptions: string[];
  catalogVersion: string;
  deterministicSeed: string;
}
