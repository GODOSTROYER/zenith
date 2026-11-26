import { describe, expect, it } from "vitest";
import { ComputeRecommendationRequestSchema, recommendCompute, type ComputeLatencyObservation, type ComputeRecommendationContext } from "@/lib/compute-catalog/recommend";
import type { ComputeCatalog, ComputeOffer, ComputeProvider, SourceEvidence } from "@/lib/compute-catalog/types";

const NOW = "2026-11-26T12:00:00Z";
const RECENT = "2026-11-26T11:30:00Z";
const requirement = { minimumVcpus: 4, minimumMemoryMiB: 16_384 };
const context = { now: NOW };

function source(provider: ComputeProvider = "aws", retrievedAt = RECENT): SourceEvidence {
  return {
    kind: provider === "aws" ? "aws_ec2_prices" : provider === "gcp" ? "gcp_skus" : "azure_retail_prices",
    url: `https://example.test/${provider}/synthetic-test-prices`, retrievedAt,
  };
}

function offer(id: string, overrides: Partial<ComputeOffer> = {}): ComputeOffer {
  const provider = overrides.provider ?? "aws";
  return {
    id, provider, region: `${provider}-test-region`, instanceType: `${provider}-test-vm`,
    vcpus: 4, memoryMiB: 16_384, architecture: "x86_64", cpuMode: "sustained",
    operatingSystem: "linux", tenancy: "shared", purchaseModel: "on_demand",
    price: { hourlyUsd: "0.2", source: source(provider) }, specSource: source(provider),
    offeringState: "offered", warnings: [], ...overrides,
  };
}

function priced(id: string, hourlyUsd: string, overrides: Partial<ComputeOffer> = {}): ComputeOffer {
  return offer(id, { price: { hourlyUsd, source: source(overrides.provider) }, ...overrides });
}

function catalog(offers: ComputeOffer[]): ComputeCatalog {
  const providers = [...new Set(offers.map((item) => item.provider))].sort();
  return {
    schemaVersion: 1, version: "synthetic-ranking-test", generatedAt: NOW, warnings: [],
    sources: providers.map((provider) => source(provider)), offers,
    coverage: providers.map((provider) => {
      const group = offers.filter((item) => item.provider === provider);
      return { provider, regions: [...new Set(group.map((item) => item.region))].sort(), offerCount: group.length,
        pricedOfferCount: group.filter((item) => item.price !== null).length, scope: "imported_snapshots", warnings: [] };
    }),
  };
}

function measurement(provider: ComputeProvider, audienceId: string, valueMs: number, overrides: Partial<ComputeLatencyObservation> = {}): ComputeLatencyObservation {
  return { provider, region: `${provider}-test-region`, audienceId, metric: "rtt_p95_ms", valueMs, sampleCount: 200,
    observedAt: RECENT, source: "synthetic-test-observation", ...overrides };
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

describe("native compute request validation", () => {
  it("uses explicit units and conservative hardware defaults", () => {
    expect(ComputeRecommendationRequestSchema.parse(requirement)).toMatchObject({
      minimumVcpus: 4, minimumMemoryMiB: 16_384, allowedArchitectures: ["x86_64"], requireSustainedCpu: true,
      hoursPerMonth: 730, instanceCount: 1, costWeight: 1, latencyWeight: 0, audience: [],
    });
  });

  it.each([
    { minimumVcpus: 0 }, { minimumVcpus: 4.1 }, { minimumMemoryMiB: 0 }, { hoursPerMonth: 745 },
    { instanceCount: 0 }, { costWeight: 0.8, latencyWeight: 0.8 }, { budgetUsdMonthly: NaN },
    { maxPriceAgeHours: 721 }, { costReferenceUsd: 0 }, { allowedArchitectures: ["unknown"] },
    { costWeight: 0.5, latencyWeight: 0.5 }, { maxRttP95Ms: 80 },
    { audience: [{ id: "a", weight: 1 }, { id: "a", weight: 2 }] },
    { latencyObservations: [] }, { catalog: {} }, { connectedProviders: ["aws"] },
  ])("rejects invalid requirements or client-supplied evidence %j", (overrides) => {
    expect(ComputeRecommendationRequestSchema.safeParse({ ...requirement, ...overrides }).success).toBe(false);
  });
});

describe("compute hard constraints and evidence", () => {
  it("requires genuine 4 vCPU/16 GiB, architecture, and sustained CPU compatibility before considering price", () => {
    const data = catalog([
      priced("fits", "0.2"), priced("too-few-cpus", "0.01", { vcpus: 2 }),
      priced("decimal-gigabytes", "0.01", { memoryMiB: 16_000 }),
      priced("arm", "0.01", { architecture: "arm64" }), priced("unknown-arch", "0.01", { architecture: "unknown" }),
      priced("burst", "0.01", { cpuMode: "burstable" }), priced("shared", "0.01", { cpuMode: "shared" }),
      priced("unknown-cpu", "0.01", { cpuMode: "unknown" }),
    ]);
    const result = recommendCompute(data, requirement, context);
    expect(result.chosen?.offer.id).toBe("fits");
    expect(result.eligibleCount).toBe(1);
    expect(result.rejected.find((item) => item.offerId === "decimal-gigabytes")?.reasonCodes).toContain("insufficient_memory");
    expect(result.rejected.find((item) => item.offerId === "unknown-cpu")?.reasonCodes).toContain("sustained_cpu_required");
    expect(result.rejected.find((item) => item.offerId === "unknown-arch")?.reasonCodes).toContain("architecture_not_allowed");
  });

  it("accepts a cheaper larger machine without rewarding additional CPU or RAM by itself", () => {
    const result = recommendCompute(catalog([
      priced("exact", "0.2"), priced("cheaper-large", "0.19", { vcpus: 8, memoryMiB: 32_768 }),
      priced("expensive-large", "0.21", { vcpus: 32, memoryMiB: 131_072 }),
    ]), requirement, context);
    expect([result.chosen!, ...result.alternatives].map((item) => item.offer.id)).toEqual(["cheaper-large", "exact", "expensive-large"]);
  });

  it("allows deliberate architecture/CPU relaxations while keeping the CPU caveat visible", () => {
    const result = recommendCompute(catalog([offer("arm-burst", { architecture: "arm64", cpuMode: "burstable" })]),
      { ...requirement, allowedArchitectures: ["arm64"], requireSustainedCpu: false }, context);
    expect(result.chosen?.offer.id).toBe("arm-burst");
    expect(result.chosen?.warnings.join(" ")).toMatch(/not sustained/);
  });

  it.each([{ allowedProviders: [] }, { allowedRegions: [] }])("treats an explicit empty allowlist as deny-all: %j", (overrides) => {
    const result = recommendCompute(catalog([offer("a")]), { ...requirement, ...overrides }, context);
    expect(result.chosen).toBeNull();
    expect(result.eligibleCount).toBe(0);
    expect(result.rejected).toHaveLength(1);
  });

  it("pairs region and provider instead of matching region text across clouds", () => {
    const result = recommendCompute(catalog([offer("aws", { region: "same-name" }), offer("gcp", { provider: "gcp", region: "same-name" })]),
      { ...requirement, allowedRegions: [{ provider: "gcp", region: "same-name" }] }, context);
    expect(result.chosen?.offer.id).toBe("gcp");
    expect(result.rejected[0]?.reasonCodes).toContain("region_not_allowed");
  });

  it("enforces server policy before ranking even when the rejected candidate is cheapest", () => {
    const result = recommendCompute(catalog([priced("blocked", "0.01"), priced("allowed", "0.2")]), requirement,
      { ...context, policyRejections: { blocked: ["Manifest residency does not permit this region."] } });
    expect(result.chosen?.offer.id).toBe("allowed");
    expect(result.rejected).toContainEqual({ offerId: "blocked", reasonCodes: ["policy"], reasons: ["policy: Manifest residency does not permit this region."] });
  });

  it("never turns missing prices into free offers, while preserving an explicit zero public price", () => {
    const result = recommendCompute(catalog([offer("unpriced", { price: null }), priced("explicit-zero", "0")]), requirement, context);
    expect(result.chosen?.offer.id).toBe("explicit-zero");
    expect(result.chosen?.monthlyComputeUsd).toBe("0");
    expect(result.rejected[0]?.reasonCodes).toContain("missing_price");
  });

  it("rejects stale, future-effective, and invalid prices independently of their low price", () => {
    const result = recommendCompute(catalog([
      priced("good", "0.2"),
      offer("stale", { price: { hourlyUsd: "0.01", source: source("aws", "2026-11-25T11:59:59Z") } }),
      offer("future", { price: { hourlyUsd: "0.01", source: source(), effectiveAt: "2026-11-26T12:00:01Z" } }),
      offer("future-retrieval", { price: { hourlyUsd: "0.01", source: source("aws", "2026-11-26T12:00:01Z") } }),
      offer("bad-effective-time", { price: { hourlyUsd: "0.01", source: source(), effectiveAt: "yesterday" } }),
      priced("bad-rate", "-0.01"),
    ]), requirement, context);
    expect(result.chosen?.offer.id).toBe("good");
    expect(Object.fromEntries(result.rejected.map((item) => [item.offerId, item.reasonCodes]))).toEqual({
      "bad-effective-time": ["invalid_price_evidence"], "bad-rate": ["invalid_price"],
      "future": ["future_price"], "future-retrieval": ["invalid_price_evidence"], "stale": ["stale_price"],
    });
  });

  it("uses retrieval freshness without treating a long-standing effective rate as stale", () => {
    const result = recommendCompute(catalog([offer("current", {
      price: { hourlyUsd: "0.2", source: source("aws", "2026-11-25T12:00:00Z"), effectiveAt: "2024-01-01T00:00:00Z" },
    })]), requirement, context);
    expect(result.chosen?.offer.id).toBe("current");
  });

  it("enforces the budget using exact rate × hours × count at the boundary", () => {
    const data = catalog([priced("exact", "0.1")]);
    const request = { ...requirement, hoursPerMonth: 0.2, instanceCount: 3, budgetUsdMonthly: 0.06 };
    const result = recommendCompute(data, request, context);
    expect(result.chosen?.monthlyComputeUsd).toBe("0.06");
    expect(result.chosen?.hourlyComputeUsd).toBe("0.3");
    const below = recommendCompute(data, { ...request, budgetUsdMonthly: 0.05999999999999999 }, context);
    expect(below.chosen).toBeNull();
    expect(below.rejected[0]?.reasonCodes).toContain("budget_exceeded");
    const tiny = recommendCompute(data, { ...request, budgetUsdMonthly: Number.MIN_VALUE }, context);
    expect(tiny.rejected[0]?.reasonCodes).toEqual(["budget_exceeded"]);
  });

  it("labels both offered and price-only records as discovery with unverified account prerequisites", () => {
    const result = recommendCompute(catalog([priced("unconnected", "0.1", { provider: "gcp", offeringState: "catalog_only" }), priced("connected", "0.2")]),
      requirement, { ...context, connectedProviders: ["aws"] });
    expect(result.chosen).toMatchObject({ discoveryOnly: true, costScope: "compute_only", requiresConnection: true });
    expect(result.chosen?.validationRequired).toEqual(expect.arrayContaining(["account_eligibility", "quota", "capacity", "regional_offering"]));
    expect(result.alternatives[0]).toMatchObject({ discoveryOnly: true, requiresConnection: false });
    expect(result.alternatives[0]?.validationRequired).toContain("capacity");
    expect(result.exclusions.join(" ")).toMatch(/Network egress.*Public IPv4.*Taxes/);
    expect(result.warnings.join(" ")).toMatch(/not live account quotes/);
  });

  it("requires a reproducible comparison time", () => {
    expect(() => recommendCompute(catalog([offer("a")]), requirement, { now: "today" })).toThrow(/comparison time/);
  });
});

describe("measured latency and deterministic ranking", () => {
  const latencyRequest = { ...requirement, costWeight: 0.65, latencyWeight: 0.35, audience: [{ id: "users", weight: 1 }] };

  it("leaves unknown latency null in cost-only comparisons and refuses to score it when weighted", () => {
    const data = catalog([offer("a")]);
    const costOnly = recommendCompute(data, requirement, context);
    expect(costOnly.chosen?.weightedRttP95Ms).toBeNull();
    expect(costOnly.chosen?.latencyObservations).toEqual([]);
    const weighted = recommendCompute(data, latencyRequest, context);
    expect(weighted.chosen).toBeNull();
    expect(weighted.rejected[0]?.reasonCodes).toEqual(["latency_missing"]);
  });

  it("requires evidence for every audience and never substitutes another provider's measurements", () => {
    const result = recommendCompute(catalog([offer("a")]), { ...latencyRequest, audience: [{ id: "users", weight: 9 }, { id: "other", weight: 1 }] },
      { ...context, latencyObservations: [measurement("aws", "users", 20), measurement("gcp", "other", 10)] });
    expect(result.chosen).toBeNull();
    expect(result.rejected[0]?.reasons.join(" ")).toMatch(/audience other/);
  });

  it.each([
    { observedAt: "2026-11-26T10:59:59Z", expected: "latency_stale" },
    { observedAt: "2026-11-26T12:00:01Z", expected: "latency_invalid" },
    { sampleCount: 99, expected: "latency_invalid" },
    { valueMs: Number.POSITIVE_INFINITY, expected: "latency_invalid" },
    { source: "", expected: "latency_invalid" },
    { metric: "application_p95_ms", expected: "latency_invalid" },
  ])("rejects unusable latency evidence: %j", ({ expected, ...overrides }) => {
    const result = recommendCompute(catalog([offer("a")]), latencyRequest,
      { ...context, latencyObservations: [measurement("aws", "users", 20, overrides as Partial<ComputeLatencyObservation>)] });
    expect(result.chosen).toBeNull();
    expect(result.rejected[0]?.reasonCodes).toContain(expected);
  });

  it("applies the RTT limit to every audience rather than hiding slow users in a weighted average", () => {
    const result = recommendCompute(catalog([offer("a")]), {
      ...requirement, maxRttP95Ms: 50, audience: [{ id: "fast", weight: 98 }, { id: "slow", weight: 2 }],
    }, { ...context, latencyObservations: [measurement("aws", "fast", 10), measurement("aws", "slow", 100)] });
    expect(result.chosen).toBeNull();
    expect(result.rejected[0]?.reasonCodes).toContain("latency_target_exceeded");
  });

  it("uses a transparent weighted mean of audience p95s only for scoring", () => {
    const result = recommendCompute(catalog([offer("a")]), {
      ...latencyRequest, audience: [{ id: "fast", weight: 3 }, { id: "slow", weight: 1 }],
    }, { ...context, latencyObservations: [measurement("aws", "fast", 20), measurement("aws", "slow", 100)] });
    expect(result.chosen?.weightedRttP95Ms).toBe(40);
    expect(result.chosen?.warnings.join(" ")).toMatch(/not a global percentile or application response time/);
    const tinyWeights = recommendCompute(catalog([offer("a")]), {
      ...latencyRequest, audience: [{ id: "fast", weight: 3e-310 }, { id: "slow", weight: 1e-310 }],
    }, { ...context, latencyObservations: [measurement("aws", "fast", 20), measurement("aws", "slow", 100)] });
    expect(tinyWeights.chosen?.weightedRttP95Ms).toBeCloseTo(40, 10);
  });

  it("selects fresh newest observations and resolves equal-time conflicts conservatively", () => {
    const observations = [
      measurement("aws", "users", 5, { observedAt: "2026-11-26T11:00:00Z" }),
      measurement("aws", "users", 20), measurement("aws", "users", 60, { source: "another-probe" }),
    ];
    const data = catalog([offer("a")]);
    const a = recommendCompute(data, latencyRequest, { ...context, latencyObservations: observations });
    const b = recommendCompute(data, latencyRequest, { ...context, latencyObservations: [...observations].reverse() });
    expect(a).toEqual(b);
    expect(a.chosen?.weightedRttP95Ms).toBe(60);
  });

  it("lets a stated cost/latency preference change the winner using fixed references", () => {
    const data = catalog([priced("low-latency", "108"), priced("low-cost", "90", { provider: "gcp" })]);
    const measured: ComputeRecommendationContext = { ...context, latencyObservations: [measurement("aws", "users", 30), measurement("gcp", "users", 55)] };
    const request = { ...latencyRequest, hoursPerMonth: 1 };
    const balanced = recommendCompute(data, request, measured);
    expect(balanced.chosen?.offer.id).toBe("low-latency");
    expect(balanced.chosen?.score).toBeCloseTo(0.59925, 10);
    const costFocused = recommendCompute(data, { ...request, costWeight: 0.85, latencyWeight: 0.15 }, measured);
    expect(costFocused.chosen?.offer.id).toBe("low-cost");
    const additional = recommendCompute(catalog([...data.offers, priced("dominated", "1000", { provider: "azure" })]), request,
      { ...measured, latencyObservations: [...measured.latencyObservations!, measurement("azure", "users", 150)] });
    expect(additional.chosen).toEqual(balanced.chosen);
    expect(additional.alternatives[0]).toEqual(balanced.alternatives[0]);
  });

  it("breaks ties by cost then stable offer ID, independent of input order, without mutating inputs", () => {
    const data = freeze(catalog([priced("z", "0.2"), priced("a", "0.2"), priced("b", "0.2"), offer("missing", { price: null })]));
    const request = freeze({ ...requirement, limit: 2 });
    const current = freeze({ ...context, connectedProviders: ["aws" as const] });
    const before = JSON.stringify({ data, request, current });
    const a = recommendCompute(data, request, current);
    const b = recommendCompute({ ...data, offers: [...data.offers].reverse() }, request, current);
    expect(a).toEqual(b);
    expect(a.chosen?.offer.id).toBe("a");
    expect(a.alternatives.map((item) => item.offer.id)).toEqual(["b"]);
    expect(a.eligibleCount).toBe(3);
    expect(a.consideredCount).toBe(4);
    expect(a.rejected).toHaveLength(1);
    expect(a.rejectedCount).toBe(1);
    expect(a.rejectedTruncated).toBe(false);
    expect(JSON.stringify({ data, request, current })).toBe(before);
  });

  it("bounds rejection details for a large catalog without dropping late eligible offers or full counts", () => {
    const data = catalog(Array.from({ length: 10_000 }, (_, index) => {
      const id = `offer-${index.toString().padStart(5, "0")}`;
      return priced(id, index === 9_999 ? "0.1" : "0.2", {
        instanceType: `vm-${index}`,
        vcpus: index === 0 || index === 5_001 || index === 9_999 ? 4 : 2,
      });
    }));
    const a = recommendCompute(data, requirement, context);
    const b = recommendCompute({ ...data, offers: [...data.offers].reverse() }, requirement, context);
    expect(a).toEqual(b);
    expect(a.consideredCount).toBe(10_000);
    expect(a.eligibleCount).toBe(3);
    expect(a.rejectedCount).toBe(9_997);
    expect(a.rejectedTruncated).toBe(true);
    expect(a.rejected).toHaveLength(500);
    expect(a.rejected[0]?.offerId).toBe("offer-00001");
    expect(a.rejected[499]?.offerId).toBe("offer-00500");
    expect(a.rejected.every((item) => item.reasonCodes.includes("insufficient_vcpus"))).toBe(true);
    expect(a.chosen?.offer.id).toBe("offer-09999");
    expect(a.alternatives.map((item) => item.offer.id)).toEqual(["offer-00000", "offer-05001"]);
    expect(a.coverage).toEqual(data.coverage);
  });
});
