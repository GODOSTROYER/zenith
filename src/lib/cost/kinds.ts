/**
 * Estimate | Forecast | ActualSpend as three distinct types (PROD-COST-01).
 *
 * Each carries its own `kind` discriminant, so the compiler and the stores can
 * refuse to confuse them:
 * - `Estimate` is the placement engine's `CostEstimate` (`kind: "estimate"`).
 * - `ActualSpend` is what a provider billing adapter read (`kind: "actual_spend"`)
 *   with its source, retrieval time and a checksum of the response.
 * - `Forecast` is derived from an `ActualSpend` only (`kind: "forecast"`); it is
 *   never derived from an estimate, and an estimate is never relabeled as spend.
 *
 * Pure: no network, clock or store. Times are passed in.
 */
import type { CostEstimate } from "@/lib/placement/types";
import { ACTUAL_SPEND_NOTICE, FORECAST_NOTICE } from "@/lib/cost/wording";

export type Estimate = CostEstimate;

export const BILLING_PROVIDERS = ["aws", "gcp", "azure", "oci"] as const;
export type BillingProvider = (typeof BILLING_PROVIDERS)[number];

export interface ActualSpendLine {
  /** the provider's own service name, copied verbatim (treat as data) */
  service: string;
  usd: number;
}

export interface ActualSpend {
  kind: "actual_spend";
  provider: BillingProvider;
  /** opaque billing scope (account id, BigQuery export table, subscription, tenancy); never a credential */
  scope: string;
  /** inclusive, YYYY-MM-DD */
  periodStart: string;
  /** exclusive, YYYY-MM-DD */
  periodEnd: string;
  currency: "USD";
  totalUsd: number;
  lines: ActualSpendLine[];
  /** which provider cost metric `totalUsd` is (for example unblended cost, before credits) */
  costBasis: string;
  /** provisional until the period has closed at the provider */
  finalization: "provisional" | "final";
  source: {
    adapter: string;
    endpoint: string;
    /** ISO timestamp of the read */
    retrievedAt: string;
    /** lowercase hex SHA-256 of the exact response bytes */
    responseSha256: string;
  };
  notice: string;
}

export interface Forecast {
  kind: "forecast";
  method: "run_rate";
  provider: BillingProvider;
  scope: string;
  periodStart: string;
  periodEnd: string;
  currency: "USD";
  /** spend already reported for the days observed: the forecast cannot be lower */
  floorUsd: number;
  /** floor plus the observed daily average over the remaining days */
  projectedUsd: number;
  basedOn: { responseSha256: string; observedDays: number; periodDays: number; asOf: string };
  assumptions: string[];
  notice: string;
}

export type CostFigure = Estimate | Forecast | ActualSpend;

export const isEstimate = (x: { kind: string }): x is Estimate => x.kind === "estimate";
export const isForecast = (x: { kind: string }): x is Forecast => x.kind === "forecast";
export const isActualSpend = (x: { kind: string }): x is ActualSpend => x.kind === "actual_spend";

export class CostKindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostKindError";
  }
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function dayNumber(day: string): number {
  if (!ISO_DAY.test(day)) throw new CostKindError(`"${day}" is not a YYYY-MM-DD date.`);
  const t = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== day) throw new CostKindError(`"${day}" is not a real calendar date.`);
  return Math.round(t / DAY_MS);
}

export function daysBetween(startInclusive: string, endExclusive: string): number {
  return dayNumber(endExclusive) - dayNumber(startInclusive);
}

/** Structural validation for an actual-spend value read from a store or an adapter. */
export function assertActualSpend(x: unknown): asserts x is ActualSpend {
  const v = x as Partial<ActualSpend> | null;
  if (!v || typeof v !== "object" || v.kind !== "actual_spend") throw new CostKindError("Not an actual-spend record.");
  if (!BILLING_PROVIDERS.includes(v.provider as BillingProvider)) throw new CostKindError("Unknown billing provider.");
  if (v.currency !== "USD") throw new CostKindError("Only USD actual spend is supported; the amount is never converted.");
  if (typeof v.totalUsd !== "number" || !Number.isFinite(v.totalUsd)) throw new CostKindError("totalUsd must be a finite number.");
  if (typeof v.scope !== "string" || v.scope.length === 0 || v.scope.length > 300) throw new CostKindError("scope must be a non-empty string.");
  if (daysBetween(v.periodStart as string, v.periodEnd as string) < 1) throw new CostKindError("The billing period must span at least one day.");
  if (!v.source || !/^[0-9a-f]{64}$/.test(v.source.responseSha256 ?? "")) throw new CostKindError("Actual spend must carry the SHA-256 of the provider response.");
  if (v.finalization !== "provisional" && v.finalization !== "final") throw new CostKindError("finalization must be provisional or final.");
  if (!Array.isArray(v.lines)) throw new CostKindError("lines must be an array.");
}

export function newActualSpend(input: Omit<ActualSpend, "kind" | "notice" | "currency">): ActualSpend {
  const value: ActualSpend = { kind: "actual_spend", currency: "USD", notice: ACTUAL_SPEND_NOTICE, ...input };
  assertActualSpend(value);
  return value;
}

function round2(x: number): number {
  return (Math.sign(x) * Math.round(Math.abs(x) * 100 + 1e-9)) / 100 || 0;
}

/**
 * Run-rate forecast from observed spend. It needs at least one fully observed
 * day and refuses a period that has already ended (that is actual spend, not a
 * forecast). Nothing here reads the clock: `asOf` is the caller's.
 */
export function forecastFromActual(actual: ActualSpend, asOf: string): Forecast {
  assertActualSpend(actual);
  const periodDays = daysBetween(actual.periodStart, actual.periodEnd);
  const asOfDay = asOf.slice(0, 10);
  const elapsed = Math.min(periodDays, daysBetween(actual.periodStart, asOfDay));
  if (daysBetween(asOfDay, actual.periodEnd) <= 0) throw new CostKindError("The period has ended; use the actual spend, not a forecast.");
  if (elapsed < 1) throw new CostKindError("At least one full day of spend is needed before a run-rate forecast.");
  const daily = actual.totalUsd / elapsed;
  const projected = actual.totalUsd + daily * (periodDays - elapsed);
  return {
    kind: "forecast",
    method: "run_rate",
    provider: actual.provider,
    scope: actual.scope,
    periodStart: actual.periodStart,
    periodEnd: actual.periodEnd,
    currency: "USD",
    floorUsd: round2(actual.totalUsd),
    projectedUsd: round2(projected),
    basedOn: { responseSha256: actual.source.responseSha256, observedDays: elapsed, periodDays, asOf },
    assumptions: [
      `The ${elapsed} observed day(s) average ${round2(daily)} USD per day and the remaining ${periodDays - elapsed} day(s) repeat that average.`,
      "Usage spikes, one-off charges, credits, refunds and provider billing lag are not modeled.",
    ],
    notice: FORECAST_NOTICE,
  };
}

export interface SpendComparison {
  kind: "estimate_vs_actual";
  estimateMonthlyUsd: number;
  estimateCatalogVersion: string;
  actualUsd: number;
  actualFinalization: ActualSpend["finalization"];
  deltaUsd: number;
  /** actual divided by estimate; absent when the estimate is zero */
  ratio?: number;
  /** false when the periods cannot be compared like for like; read `caveats` */
  comparable: boolean;
  caveats: string[];
}

/** Side-by-side of an estimate and actual spend. Neither is converted into the other. */
export function compareEstimateToActual(estimate: Estimate, actual: ActualSpend): SpendComparison {
  assertActualSpend(actual);
  const days = daysBetween(actual.periodStart, actual.periodEnd);
  const caveats: string[] = [];
  let comparable = true;
  if (days < 28 || days > 31) {
    comparable = false;
    caveats.push(`The actual period is ${days} day(s); an estimate covers a 730-hour month, so the two are not like for like.`);
  }
  if (actual.finalization === "provisional") caveats.push("Actual spend is provisional and may still change.");
  caveats.push("The estimate models list prices; actual spend includes discounts, credits, free tiers and resources outside Zenith's model.");
  return {
    kind: "estimate_vs_actual",
    estimateMonthlyUsd: estimate.monthlyUsd,
    estimateCatalogVersion: estimate.catalogVersion,
    actualUsd: round2(actual.totalUsd),
    actualFinalization: actual.finalization,
    deltaUsd: round2(actual.totalUsd - estimate.monthlyUsd),
    ...(estimate.monthlyUsd > 0 ? { ratio: Math.round((actual.totalUsd / estimate.monthlyUsd) * 1000) / 1000 } : {}),
    comparable,
    caveats,
  };
}
