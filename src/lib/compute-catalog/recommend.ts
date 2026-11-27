import { z } from "zod";
import { compareUsd, computePeriodUsd, decimalFromNumber, usdForScore } from "./money";
import type { ComputeCatalog, ComputeCatalogCoverage, ComputeOffer, ComputeProvider } from "./types";

const ProviderSchema = z.enum(["aws", "gcp", "azure"]);
const IdentifierSchema = z.string().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Control characters are not allowed.");
const TimestampSchema = z.string().datetime({ offset: true });

/** Only requirements/preferences belong to public input. Evidence comes from the server. */
export const ComputeRecommendationRequestSchema = z.object({
  minimumVcpus: z.number().int().positive().max(1_048_576),
  minimumMemoryMiB: z.number().int().positive().max(10_000_000_000),
  // An explicit empty list denies every offer. Omission means unrestricted.
  allowedProviders: z.array(ProviderSchema).max(3).optional(),
  allowedRegions: z.array(z.object({ provider: ProviderSchema, region: IdentifierSchema }).strict()).max(1000).optional(),
  allowedArchitectures: z.array(z.enum(["x86_64", "arm64"])).min(1).max(2).default(["x86_64"]),
  requireSustainedCpu: z.boolean().default(true),
  hoursPerMonth: z.number().finite().min(1 / 3600).max(744).default(730),
  instanceCount: z.number().int().min(1).max(10_000).default(1),
  budgetUsdMonthly: z.number().finite().positive().max(1_000_000_000_000).optional(),
  costWeight: z.number().finite().min(0).max(1).default(1),
  latencyWeight: z.number().finite().min(0).max(1).default(0),
  // Fixed references keep scores stable when unrelated catalog entries appear.
  costReferenceUsd: z.number().finite().min(0.01).max(1_000_000_000_000).default(150),
  latencyReferenceMs: z.number().finite().min(0.001).max(3_600_000).default(80),
  maxRttP95Ms: z.number().finite().positive().max(3_600_000).optional(),
  audience: z.array(z.object({ id: IdentifierSchema, weight: z.number().finite().positive().max(1_000_000) }).strict()).max(32).default([]),
  maxPriceAgeHours: z.number().finite().positive().max(720).default(24),
  maxLatencyAgeMinutes: z.number().finite().positive().max(1440).default(60),
  limit: z.number().int().min(1).max(100).default(10),
}).strict().superRefine((value, context) => {
  if (Math.abs(value.costWeight + value.latencyWeight - 1) > 1e-9) {
    context.addIssue({ code: "custom", path: ["costWeight"], message: "Cost and latency weights must sum to 1." });
  }
  if ((value.latencyWeight > 0 || value.maxRttP95Ms !== undefined) && value.audience.length === 0) {
    context.addIssue({ code: "custom", path: ["audience"], message: "Latency weighting or a latency limit requires at least one audience group." });
  }
  if (new Set(value.audience.map((group) => group.id)).size !== value.audience.length) {
    context.addIssue({ code: "custom", path: ["audience"], message: "Audience IDs must be unique." });
  }
});

export const ComputeRequest = ComputeRecommendationRequestSchema;
export type ComputeRecommendationRequest = z.infer<typeof ComputeRecommendationRequestSchema>;

/** Measurements are supplied by an authenticated server-side collector, never request JSON. */
export interface ComputeLatencyObservation {
  provider: ComputeProvider;
  region: string;
  audienceId: string;
  metric: "rtt_p95_ms";
  valueMs: number;
  sampleCount: number;
  observedAt: string;
  source: string;
}

export interface ComputeRecommendationContext {
  /** Explicit time makes freshness checks repeatable and testable. */
  now: string;
  /** A verified connection is not proof of eligibility, quota, or available capacity. */
  connectedProviders?: readonly ComputeProvider[];
  latencyObservations?: readonly ComputeLatencyObservation[];
  /** Additional policy is enforced before scoring; callers cannot relax it through preferences. */
  policyRejections?: Readonly<Record<string, readonly string[]>>;
}

export type ComputeValidation = "account_eligibility" | "quota" | "capacity" | "image_compatibility" | "application_performance" | "regional_offering";
export type ComputeRejectionCode =
  | "policy" | "provider_not_allowed" | "region_not_allowed" | "insufficient_vcpus" | "insufficient_memory"
  | "architecture_not_allowed" | "sustained_cpu_required" | "unsupported_offer" | "invalid_spec_evidence"
  | "missing_price" | "invalid_price" | "invalid_price_evidence" | "stale_price" | "future_price"
  | "budget_exceeded" | "latency_missing" | "latency_stale" | "latency_invalid" | "latency_target_exceeded";

export interface ComputeCandidate {
  offer: ComputeOffer;
  /** Requested instance count multiplied by the per-instance hourly rate. */
  hourlyComputeUsd: string;
  /** Exact public rate × requested hours × instance count, before excluded charges. */
  monthlyComputeUsd: string;
  /** Weighted mean of audience-level RTT p95s. This is NOT a global or application p95. */
  weightedRttP95Ms: number | null;
  latencyObservations: ComputeLatencyObservation[];
  /** Lower is preferred. This is a preference score, not a performance prediction. */
  score: number;
  scoreBreakdown: { cost: number; latency: number };
  requiresConnection: boolean;
  validationRequired: ComputeValidation[];
  discoveryOnly: true;
  costScope: "compute_only";
  warnings: string[];
}

export interface ComputeRejection {
  offerId: string;
  reasons: string[];
  reasonCodes: ComputeRejectionCode[];
}

export interface ComputeRecommendationResult {
  kind: "compute_comparison";
  discoveryOnly: true;
  costScope: "compute_only";
  asOf: string;
  catalogVersion: string;
  catalogGeneratedAt: string;
  request: ComputeRecommendationRequest;
  chosen: ComputeCandidate | null;
  alternatives: ComputeCandidate[];
  /** First 500 rejected offers in stable offer-ID order, with full reasons. */
  rejected: ComputeRejection[];
  /** Counts cover the complete catalog even when rejection details are capped. */
  rejectedCount: number;
  rejectedTruncated: boolean;
  consideredCount: number;
  eligibleCount: number;
  coverage: ComputeCatalogCoverage[];
  exclusions: string[];
  warnings: string[];
}

const EXCLUSIONS = [
  "Boot and data disks, storage operations, snapshots, and backups.",
  "Network egress and cross-zone, cross-region, and cross-cloud transfer.",
  "Public IPv4, NAT gateways, load balancers, and other supporting services.",
  "Usage-dependent VM surcharges (including burst CPU credits), billing minimums, and per-start billing rounding.",
  "Operating-system/software licenses and support plans beyond the listed Linux base VM.",
  "Taxes, negotiated account rates, credits, commitments, and Spot/preemptible pricing.",
];
const BASE_VALIDATIONS: ComputeValidation[] = ["account_eligibility", "quota", "capacity", "image_compatibility", "application_performance"];
const MIN_LATENCY_SAMPLES = 100;
const MAX_REJECTION_DETAILS = 500;
const lexicalCompare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function timestamp(value: string): number | null {
  if (!TimestampSchema.safeParse(value).success) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function latencyKey(provider: ComputeProvider, region: string, audienceId: string): string {
  return JSON.stringify([provider, region, audienceId]);
}

type LatencyIndex = Map<string, ComputeLatencyObservation[]>;
function indexLatency(observations: readonly ComputeLatencyObservation[]): LatencyIndex {
  const index: LatencyIndex = new Map();
  for (const observation of observations) {
    const key = latencyKey(observation.provider, observation.region, observation.audienceId);
    const values = index.get(key) ?? [];
    values.push(observation);
    index.set(key, values);
  }
  return index;
}

interface LatencyResult {
  valueMs: number | null;
  observations: ComputeLatencyObservation[];
  failures: { code: ComputeRejectionCode; reason: string }[];
}

function evaluateLatency(offer: ComputeOffer, request: ComputeRecommendationRequest, now: number, index: LatencyIndex): LatencyResult {
  const observations: ComputeLatencyObservation[] = [];
  const failures: LatencyResult["failures"] = [];
  let totalWeight = 0;
  let weightedValue = 0;
  const largestWeight = Math.max(0, ...request.audience.map((group) => group.weight));
  // Canonical order avoids input-order changes in floating-point accumulation.
  for (const group of [...request.audience].sort((a, b) => lexicalCompare(a.id, b.id))) {
    const available = index.get(latencyKey(offer.provider, offer.region, group.id)) ?? [];
    const wellFormed = available.filter((measurement) => {
      const at = timestamp(measurement.observedAt);
      return measurement.metric === "rtt_p95_ms" && Number.isFinite(measurement.valueMs) && measurement.valueMs >= 0 && measurement.valueMs <= 3_600_000 &&
        Number.isSafeInteger(measurement.sampleCount) && measurement.sampleCount >= MIN_LATENCY_SAMPLES &&
        typeof measurement.source === "string" && measurement.source.trim().length > 0 && at !== null && at <= now;
    });
    const fresh = wellFormed.filter((measurement) => now - Date.parse(measurement.observedAt) <= request.maxLatencyAgeMinutes * 60_000);
    if (fresh.length === 0) {
      const code = available.length === 0 ? "latency_missing" : wellFormed.length === 0 ? "latency_invalid" : "latency_stale";
      failures.push({ code, reason: `${code}: audience ${group.id} has no fresh measured RTT p95 with at least ${MIN_LATENCY_SAMPLES} samples in ${offer.provider}/${offer.region}.` });
      continue;
    }
    // Prefer newest evidence. Equal-time measurements use the conservative RTT,
    // then source/sample count, making conflicts deterministic without optimism.
    fresh.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || b.valueMs - a.valueMs || lexicalCompare(a.source, b.source) || b.sampleCount - a.sampleCount);
    const selected = fresh[0]!;
    observations.push({
      provider: selected.provider, region: selected.region, audienceId: selected.audienceId,
      metric: selected.metric, valueMs: selected.valueMs, sampleCount: selected.sampleCount,
      observedAt: new Date(selected.observedAt).toISOString(), source: selected.source,
    });
    // Rescale before accumulation so tiny but valid weights do not underflow
    // an otherwise well-defined weighted mean.
    const weight = group.weight / largestWeight;
    totalWeight += weight;
    weightedValue += selected.valueMs * weight;
    if (request.maxRttP95Ms !== undefined && selected.valueMs > request.maxRttP95Ms) {
      failures.push({ code: "latency_target_exceeded", reason: `latency_target_exceeded: audience ${group.id} RTT p95 ${selected.valueMs} ms exceeds ${request.maxRttP95Ms} ms.` });
    }
  }
  return {
    valueMs: observations.length > 0 && observations.length === request.audience.length ? weightedValue / totalWeight : null,
    observations,
    failures,
  };
}

/**
 * Filter hardware, policy, valid/fresh prices, budgets, and measured latency
 * before deterministic scoring. This compares catalog offers for discovery;
 * it never claims that an account can deploy one or that a provider has stock.
 */
export function recommendCompute(catalog: ComputeCatalog, input: unknown, context: ComputeRecommendationContext): ComputeRecommendationResult {
  const request = ComputeRecommendationRequestSchema.parse(input);
  const now = timestamp(context.now);
  if (now === null) throw new Error("A valid explicit comparison time is required.");
  const connected = new Set(context.connectedProviders ?? []);
  const latencyIndex = indexLatency(context.latencyObservations ?? []);
  const latencyCache = new Map<string, LatencyResult>();
  const needsLatency = request.latencyWeight > 0 || request.maxRttP95Ms !== undefined;
  const eligible: ComputeCandidate[] = [];
  const rejected: ComputeRejection[] = [];
  let rejectedCount = 0;

  for (const offer of [...catalog.offers].sort((a, b) => lexicalCompare(a.id, b.id))) {
    const reasons: string[] = [];
    const reasonCodes: ComputeRejectionCode[] = [];
    const keepRejectionDetails = rejected.length < MAX_REJECTION_DETAILS;
    let hasRejection = false;
    const reject = (code: ComputeRejectionCode, reason: string) => {
      hasRejection = true;
      if (!keepRejectionDetails) return;
      reasons.push(reason);
      if (!reasonCodes.includes(code)) reasonCodes.push(code);
    };

    const policyReasons = context.policyRejections && Object.hasOwn(context.policyRejections, offer.id) ? context.policyRejections[offer.id] : [];
    for (const reason of policyReasons) reject("policy", `policy: ${reason}`);
    if (request.allowedProviders !== undefined && !request.allowedProviders.includes(offer.provider)) {
      reject("provider_not_allowed", `provider_not_allowed: ${offer.provider} is outside the allowed providers.`);
    }
    if (request.allowedRegions !== undefined && !request.allowedRegions.some((region) => region.provider === offer.provider && region.region === offer.region)) {
      reject("region_not_allowed", `region_not_allowed: ${offer.provider}/${offer.region} is outside the allowed regions.`);
    }
    if (!Number.isFinite(offer.vcpus) || offer.vcpus < request.minimumVcpus) {
      reject("insufficient_vcpus", `insufficient_vcpus: needs at least ${request.minimumVcpus} vCPUs; offer has ${offer.vcpus}.`);
    }
    if (!Number.isFinite(offer.memoryMiB) || offer.memoryMiB < request.minimumMemoryMiB) {
      reject("insufficient_memory", `insufficient_memory: needs at least ${request.minimumMemoryMiB} MiB; offer has ${offer.memoryMiB}.`);
    }
    if (offer.architecture === "unknown" || !request.allowedArchitectures.includes(offer.architecture)) {
      reject("architecture_not_allowed", `architecture_not_allowed: ${offer.architecture} does not satisfy the required CPU architecture.`);
    }
    if (request.requireSustainedCpu && offer.cpuMode !== "sustained") {
      reject("sustained_cpu_required", `sustained_cpu_required: ${offer.cpuMode} CPU capacity is not verified sustained capacity.`);
    }
    if (offer.operatingSystem !== "linux" || offer.tenancy !== "shared" || offer.purchaseModel !== "on_demand") {
      reject("unsupported_offer", "unsupported_offer: this comparison supports Linux, shared-tenancy, on-demand VM offers only.");
    }
    const specAt = timestamp(offer.specSource.retrievedAt);
    if (specAt === null || specAt > now) reject("invalid_spec_evidence", "invalid_spec_evidence: hardware evidence has an invalid or future retrieval time.");
    // Beyond the diagnostic limit, an already-ineligible offer only needs to
    // be counted. Continue evaluating every offer that could still qualify.
    if (hasRejection && !keepRejectionDetails) {
      rejectedCount++;
      continue;
    }

    let monthlyComputeUsd: string | null = null;
    let hourlyComputeUsd: string | null = null;
    if (offer.price === null) {
      reject("missing_price", "missing_price: no matching public hourly USD price is available; unknown prices are not zero.");
    } else {
      const retrievedAt = timestamp(offer.price.source.retrievedAt);
      const effectiveAt = offer.price.effectiveAt === undefined ? undefined : timestamp(offer.price.effectiveAt);
      if (retrievedAt === null || retrievedAt > now || effectiveAt === null) {
        reject("invalid_price_evidence", "invalid_price_evidence: price evidence has an invalid or future retrieval time, or an invalid effective time.");
      } else if (now - retrievedAt > request.maxPriceAgeHours * 3_600_000) {
        reject("stale_price", `stale_price: price evidence is older than the ${request.maxPriceAgeHours}-hour freshness limit.`);
      }
      if (effectiveAt !== undefined && effectiveAt !== null && effectiveAt > now) {
        reject("future_price", "future_price: this rate is not yet effective at the comparison time.");
      }
      try {
        hourlyComputeUsd = computePeriodUsd(offer.price.hourlyUsd, 1, request.instanceCount);
        monthlyComputeUsd = computePeriodUsd(offer.price.hourlyUsd, request.hoursPerMonth, request.instanceCount);
        usdForScore(monthlyComputeUsd);
        if (request.budgetUsdMonthly !== undefined && compareUsd(monthlyComputeUsd, decimalFromNumber(request.budgetUsdMonthly)) > 0) {
          reject("budget_exceeded", `budget_exceeded: compute alone costs $${monthlyComputeUsd} for the requested month, above the $${decimalFromNumber(request.budgetUsdMonthly)} limit.`);
        }
      } catch {
        reject("invalid_price", "invalid_price: the hourly USD rate cannot produce a valid exact compute estimate.");
      }
    }
    if (hasRejection && !keepRejectionDetails) {
      rejectedCount++;
      continue;
    }

    const regionKey = JSON.stringify([offer.provider, offer.region]);
    let latency = latencyCache.get(regionKey);
    if (!latency) {
      latency = evaluateLatency(offer, request, now, latencyIndex);
      latencyCache.set(regionKey, latency);
    }
    if (needsLatency) for (const failure of latency.failures) reject(failure.code, failure.reason);

    if (hasRejection || monthlyComputeUsd === null || hourlyComputeUsd === null) {
      rejectedCount++;
      if (keepRejectionDetails) rejected.push({ offerId: offer.id, reasons, reasonCodes });
      continue;
    }

    const costScore = request.costWeight * usdForScore(monthlyComputeUsd) / request.costReferenceUsd;
    const latencyScore = request.latencyWeight * (latency.valueMs ?? 0) / request.latencyReferenceMs;
    const requiresConnection = !connected.has(offer.provider);
    const validationRequired = [...BASE_VALIDATIONS];
    const warnings = [
      ...offer.warnings,
      "Discovery estimate: account eligibility, quota, capacity, image compatibility, and application performance remain unverified.",
      "Only base VM compute is priced; excluded infrastructure charges can exceed this estimate.",
    ];
    if (requiresConnection) warnings.push("No verified workspace connection is available for this provider.");
    if (latency.valueMs === null) warnings.push("Measured audience RTT p95 is unavailable; no latency benefit or application SLO is claimed.");
    else warnings.push("The latency score uses a weighted mean of measured audience RTT p95s, not a global percentile or application response time.");
    if (offer.cpuMode !== "sustained") warnings.push("CPU mode is not sustained capacity; burst/shared limits or unknown behavior can affect performance.");
    if (offer.offeringState === "catalog_only") {
      validationRequired.push("regional_offering");
      warnings.push("Pricing catalog evidence alone does not verify a regional hardware offering.");
    }
    eligible.push({
      offer,
      hourlyComputeUsd,
      monthlyComputeUsd,
      weightedRttP95Ms: latency.valueMs,
      latencyObservations: latency.observations,
      score: costScore + latencyScore,
      scoreBreakdown: { cost: costScore, latency: latencyScore },
      requiresConnection,
      validationRequired,
      discoveryOnly: true,
      costScope: "compute_only",
      warnings: [...new Set(warnings)].sort(lexicalCompare),
    });
  }

  eligible.sort((a, b) => a.score - b.score || compareUsd(a.monthlyComputeUsd, b.monthlyComputeUsd) || lexicalCompare(a.offer.id, b.offer.id));
  return {
    kind: "compute_comparison",
    discoveryOnly: true,
    costScope: "compute_only",
    asOf: context.now,
    catalogVersion: catalog.version,
    catalogGeneratedAt: catalog.generatedAt,
    request,
    chosen: eligible[0] ?? null,
    alternatives: eligible.slice(1, request.limit),
    rejected,
    rejectedCount,
    rejectedTruncated: rejectedCount > rejected.length,
    consideredCount: catalog.offers.length,
    eligibleCount: eligible.length,
    coverage: catalog.coverage,
    exclusions: [...EXCLUSIONS],
    warnings: [...new Set([
      ...catalog.warnings,
      "Coverage is limited to the imported provider snapshots; no claim of all-region or all-service completeness is made.",
      "Prices are timestamped public catalog rates, not live account quotes or invoices.",
      "A compute estimate below a budget does not establish that the complete deployment fits that budget.",
      "Equal vCPU and memory specifications do not establish equivalent application performance.",
    ])].sort(lexicalCompare),
  };
}
