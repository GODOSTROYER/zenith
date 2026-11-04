/**
 * Placement solver: hard filters with numbers in their reasons, deterministic
 * scoring, the cross-cloud margin rule, multi-region triggers, and the spec's
 * worked example ("users in India and Singapore, <= $500/month, managed
 * Postgres, survive a single compute failure, any provider").
 */
import { describe, expect, it } from "vitest";
import {
  CROSS_CLOUD_SAVINGS_MARGIN,
  COMPLEXITY_USD_PER_EXTRA_PROVIDER,
  PlacementInputError,
  CostInputError,
  estimateP95Ms,
  explainPlacement,
  loadDefaultCatalog,
  parseCatalog,
  solvePlacement,
  userToRegionRttMs,
} from "@/lib/placement";
import type { PlacementCandidate, PlacementComponent, PlacementConstraints, PlacementResult, PriceCatalog } from "@/lib/placement";
import { STACK_PLACEMENT_EDGES, stackComponents } from "./fixtures";

const catalog = loadDefaultCatalog();

const EXAMPLE: PlacementConstraints = {
  userRegions: ["india", "singapore"],
  budgetUsdMonthly: 500,
  tolerateSingleFailure: true,
  managedDatabaseRequired: true,
};

function solve(constraints: PlacementConstraints, over: { components?: PlacementComponent[]; catalog?: PriceCatalog; options?: Parameters<typeof solvePlacement>[0]["options"]; edges?: typeof STACK_PLACEMENT_EDGES } = {}): PlacementResult {
  return solvePlacement({ components: over.components ?? stackComponents(), edges: over.edges, constraints, catalog: over.catalog ?? catalog, options: over.options });
}

function all(r: PlacementResult): PlacementCandidate[] {
  return r.chosen ? [r.chosen, ...r.alternatives] : [...r.alternatives];
}

function providersOf(c: PlacementCandidate): string[] {
  return [...new Set(Object.values(c.assignments).map((a) => a.provider))].sort();
}

function regionsOf(c: PlacementCandidate): string[] {
  return [...new Set(Object.values(c.assignments).map((a) => `${a.provider}/${a.region}`))].sort();
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

/** A copy of the catalog with some prices rewritten (still validated). */
function withPrices(fn: (e: PriceCatalog["entries"][number]) => number | undefined): PriceCatalog {
  const copy = JSON.parse(JSON.stringify(catalog)) as PriceCatalog;
  for (const e of copy.entries) {
    const v = fn(e);
    if (v !== undefined) e.usd = v;
  }
  return parseCatalog(copy);
}

describe("the spec example", () => {
  const r = solve(EXAMPLE);

  it("chooses a candidate within budget with at least 2 AZ and 2 replicas", () => {
    const c = r.chosen!;
    expect(c).toBeDefined();
    expect(c.cost.monthlyUsd).toBeLessThanOrEqual(500);
    expect(c.availabilityZones).toBeGreaterThanOrEqual(2);
    expect(c.specOverrides?.["service/web"]).toEqual({ replicas: 2 });
    expect(c.specOverrides?.["network/main"]).toEqual({ azCount: 2 });
    const vcpu = c.cost.lines.find((l) => l.address === "service/web" && l.description.startsWith("Container vCPU-hours"))!;
    expect(vcpu.basis).toMatch(/× 2 replica\(s\)/);
    expect(c.topology).toBe("single_region");
    for (const a of all(r)) {
      expect(a.cost.monthlyUsd).toBeLessThanOrEqual(500);
      expect(a.specOverrides?.["service/web"]).toEqual({ replicas: 2 });
      expect(a.availabilityZones).toBeGreaterThanOrEqual(2);
    }
  });

  it("places every component, with native types, and estimates latency for both user regions", () => {
    const c = r.chosen!;
    expect(Object.keys(c.assignments).sort()).toEqual(["load_balancer/edge", "network/main", "resource/assets", "resource/db", "service/web"]);
    expect(c.assignments["service/web"]!.nativeType).toMatch(/^(aws:ecs_service|gcp:cloud_run_service|azure:container_app|oci:container_instance)$/);
    expect(c.assignments["resource/db"]!.nativeType).toMatch(/postgres/);
    expect(Object.keys(c.latencyMs).sort()).toEqual(["india", "singapore"]);
    for (const ms of Object.values(c.latencyMs)) expect(ms).toBeGreaterThan(0);
    expect(c.cost.kind).toBe("estimate");
  });

  it("considers more than one provider and ranks by score, lowest first, with the score broken down", () => {
    expect(new Set(all(r).flatMap(providersOf)).size).toBeGreaterThan(1);
    const scores = all(r).map((c) => c.score);
    expect([...scores].sort((a, b) => a - b)).toEqual(scores);
    const b = r.chosen!.scoreBreakdown;
    expect(b.monthlyUsd).toBe(r.chosen!.cost.monthlyUsd);
    expect(r.chosen!.score).toBeCloseTo((b.costPenalty ?? 0) + (b.latencyPenalty ?? 0) + (b.overshootPenalty ?? 0) + (b.complexityPenalty ?? 0) + (b.preferenceBonus ?? 0), 5);
    expect(r.chosen!.scoreBreakdown.costPenalty).toBeGreaterThanOrEqual(0);
  });

  it("rejects OCI regions that have a single availability domain, with the numbers", () => {
    const mumbai = r.rejected.find((x) => x.id === "single:oci:ap-mumbai-1")!;
    expect(mumbai.reasons[0]).toMatch(/availability: oci\/ap-mumbai-1 offers 1 availability zone\(s\) but 2 are required/);
  });

  it("explains itself in plain text from the result alone", () => {
    const text = explainPlacement(r);
    expect(text).toContain(r.chosen!.id);
    expect(text).toContain(`$${r.chosen!.cost.monthlyUsd.toFixed(2)}`);
    expect(text).toMatch(/p95/);
    expect(text).toMatch(/not an invoice/);
    expect(text).toMatch(/replicas=2/);
    expect(text).toMatch(/Compared with the alternatives/);
    expect(text).toContain(r.deterministicSeed.slice(0, 12));
  });

  it("records the catalog version, a 64-hex seed and the assumptions it used", () => {
    expect(r.catalogVersion).toBe("2026-10-05.2");
    expect(r.deterministicSeed).toMatch(/^[0-9a-f]{64}$/);
    expect(r.assumptions.join("\n")).toMatch(/catalog 2026-10-05\.2/);
    expect(r.assumptions.join("\n")).toMatch(/Approximate/);
    expect(r.assumptions.join("\n")).toMatch(/lower is better/);
  });
});

describe("availability rules", () => {
  it("adds no replicas and one AZ (two for AWS load balancers) when nothing requires more", () => {
    const r = solve({ userRegions: ["us-east"] }, { options: { maxAlternatives: 50 } });
    const gcp = all(r).find((c) => c.id === "single:gcp:us-central1")!;
    expect(gcp.availabilityZones).toBe(1);
    expect(gcp.specOverrides?.["service/web"]).toBeUndefined();
    const aws = all(r).find((c) => c.id === "single:aws:us-east-1")!;
    expect(aws.availabilityZones).toBe(2); // ALB needs two AZs
  });

  it("makes databases and caches highly available and needs 2 AZ at 99.9%", () => {
    const r = solve({ userRegions: ["us-east"], availabilityTarget: 99.9 }, { options: { maxAlternatives: 50 } });
    const c = r.chosen!;
    expect(c.specOverrides?.["resource/db"]).toEqual({ ha: true });
    expect(c.cost.lines.some((l) => l.description.includes("high availability"))).toBe(true);
    expect(c.availabilityZones).toBeGreaterThanOrEqual(2);
    expect(r.rejected.some((x) => x.id.startsWith("single:oci:ap-") && x.reasons[0]!.startsWith("availability:"))).toBe(true);
  });

  it("at 99.99% rejects single-region candidates and considers multi-region ones", () => {
    const r = solve({ userRegions: ["india", "singapore"], availabilityTarget: 99.99, budgetUsdMonthly: 1000 }, { options: { maxAlternatives: 100 } });
    const c = r.chosen!;
    expect(c.topology).toBe("multi_region");
    expect(c.id).toMatch(/^multi:[a-z]+:[^+]+\+[^+]+$/);
    expect(regionsOf(c).length).toBe(2);
    expect(providersOf(c).length).toBe(1);
    expect(c.availabilityZones).toBe(3);
    const single = r.rejected.find((x) => x.id === "single:aws:ap-south-1")!;
    expect(single.reasons.join(" ")).toMatch(/availability: target 99.99% needs at least two regions/);
    expect(all(r).every((x) => x.id.startsWith("multi:"))).toBe(true);
    expect(r.assumptions.join(" ")).toMatch(/Multi-region candidates were considered because availability target 99.99%/);
  });

  it("prices the second region: duplicated compute, a database replica and the replication transfer", () => {
    const r = solve({ userRegions: ["india", "singapore"], availabilityTarget: 99.99 });
    const c = r.chosen!;
    const clones = Object.keys(c.assignments).filter((a) => a.includes("@"));
    expect(clones.some((a) => a.startsWith("load_balancer/edge@"))).toBe(true);
    expect(clones.some((a) => a.startsWith("network/main@"))).toBe(true);
    expect(clones.some((a) => a.startsWith("resource/db@"))).toBe(true);
    expect(clones.some((a) => a.startsWith("service/web@"))).toBe(true);
    const replication = c.crossBoundary.find((x) => x.to.startsWith("resource/db@") && x.from === "resource/db");
    expect(replication).toBeDefined();
    expect(replication!.kind).toBe("cross_region");
    expect(replication!.egressUsdMonthly).toBeGreaterThan(0);
    expect(c.cost.lines.some((l) => l.description.startsWith("Cross-region transfer"))).toBe(true);
    expect(c.warnings.join(" ")).toMatch(/global traffic steering/);
    // each user region is served by its nearest region
    expect(c.latencyMs.india).toBeLessThan(60);
    expect(c.latencyMs.singapore).toBeLessThan(60);
  });

  it("does not consider multi-region when the users are close and every target is met", () => {
    const r = solve(EXAMPLE);
    expect(r.assumptions.join(" ")).toMatch(/Multi-region candidates were not considered/);
    expect([...all(r), ...r.rejected.map((x) => ({ id: x.id }))].some((c) => c.id.startsWith("multi:"))).toBe(false);
  });

  it("considers multi-region when the user regions are far apart", () => {
    const r = solve({ userRegions: ["india", "us-east"] }, { options: { maxAlternatives: 100 } });
    expect(r.assumptions.join(" ")).toMatch(/far apart \(200 ms/);
    expect(all(r).some((c) => c.topology === "multi_region")).toBe(true);
  });

  it("considers multi-region when no single region meets the latency target, and picks it", () => {
    const r = solve({ userRegions: ["india", "singapore"], latencyTargetMs: 40 });
    expect(r.assumptions.join(" ")).toMatch(/no single region keeps estimated p95 at or under 40 ms/);
    expect(r.chosen!.topology).toBe("multi_region");
    expect(Math.max(...Object.values(r.chosen!.latencyMs))).toBeLessThanOrEqual(40);
    const relaxed = solve({ userRegions: ["india", "singapore"], latencyTargetMs: 200 });
    expect(relaxed.chosen!.topology).toBe("single_region");
    expect(relaxed.assumptions.join(" ")).toMatch(/not considered/);
  });

  it("penalizes a candidate that overshoots the latency target and warns", () => {
    const r = solve({ userRegions: ["india", "singapore"], latencyTargetMs: 60 }, { options: { maxAlternatives: 100 } });
    // no single region can meet 60 ms for both, so multi-region wins; check a single candidate carries the overshoot
    const mumbai = all(r).find((c) => c.id === "single:aws:ap-south-1")!;
    expect(mumbai.scoreBreakdown.overshootPenalty).toBeGreaterThan(0);
    expect(mumbai.warnings.join(" ")).toMatch(/latency: estimated p95 for singapore users is 90 ms, above the 60 ms target/);
  });
});

describe("residency", () => {
  it("keeps every candidate inside the allowed jurisdictions and explains each rejection", () => {
    const r = solve({ userRegions: ["europe"], residency: ["EU"] }, { options: { maxAlternatives: 50 } });
    expect(r.chosen).toBeDefined();
    for (const c of all(r)) {
      for (const a of Object.values(c.assignments)) expect(["eu-west-1", "europe-west1", "westeurope"]).toContain(a.region);
    }
    const mumbai = r.rejected.find((x) => x.id === "single:aws:ap-south-1")!;
    expect(mumbai.reasons.join(" ")).toMatch(/residency: aws\/ap-south-1 \(Mumbai, IN\) is outside the allowed jurisdictions \[eu\]/);
    expect(r.rejected.some((x) => x.id === "single:oci:us-ashburn-1" && x.reasons.some((y) => y.startsWith("residency:")))).toBe(true);
  });

  it("selects India regions for an India residency constraint", () => {
    const r = solve({ userRegions: ["india"], residency: ["India"] }, { options: { maxAlternatives: 50 } });
    for (const c of all(r)) for (const a of Object.values(c.assignments)) expect(["ap-south-1", "asia-south1", "centralindia", "ap-mumbai-1"]).toContain(a.region);
    expect(["ap-south-1", "asia-south1", "centralindia", "ap-mumbai-1"]).toContain(r.chosen!.assignments["resource/db"]!.region);
  });

  it("returns no placement when nothing satisfies residency, with a reason per candidate", () => {
    const r = solve({ userRegions: ["india"], residency: ["Atlantis"] });
    expect(r.chosen).toBeUndefined();
    expect(r.rejected.length).toBeGreaterThan(10);
    expect(r.rejected.every((x) => x.reasons.some((y) => y.startsWith("residency:")))).toBe(true);
    expect(explainPlacement(r)).toMatch(/No placement satisfies the constraints/);
    expect(explainPlacement(r)).toMatch(/residency/);
  });

  it("only pairs regions that pass residency for multi-region candidates", () => {
    const r = solve({ userRegions: ["india", "us-east"], residency: ["India"] }, { options: { maxAlternatives: 100 } });
    expect(all(r).some((c) => c.topology === "multi_region")).toBe(false);
    expect(r.chosen!.assignments["service/web"]!.region).toMatch(/ap-south-1|asia-south1|centralindia|ap-mumbai-1/);
  });
});

describe("budget", () => {
  it("rejects over-budget candidates with the estimate, the budget and the overrun", () => {
    const r = solve({ userRegions: ["india"], budgetUsdMonthly: 50 });
    expect(r.chosen).toBeUndefined();
    const budgetRejections = r.rejected.filter((x) => x.reasons.some((y) => y.startsWith("budget:")));
    expect(budgetRejections.length).toBeGreaterThan(10);
    for (const x of budgetRejections) {
      const reason = x.reasons.find((y) => y.startsWith("budget:"))!;
      const m = reason.match(/^budget: estimated \$(\d+\.\d{2})\/month exceeds the \$50\.00 budget by \$(\d+\.\d{2})$/);
      expect(m, reason).not.toBeNull();
      expect(Number(m![1]) - 50).toBeCloseTo(Number(m![2]), 2);
    }
    expect(explainPlacement(r)).toMatch(/budget/);
  });

  it("treats the budget as inclusive: a budget equal to the cheapest estimate still places", () => {
    const open = solve({ userRegions: ["india"] }, { options: { maxAlternatives: 100 } });
    const cheapest = Math.min(...all(open).map((c) => c.cost.monthlyUsd));
    const exact = solve({ userRegions: ["india"], budgetUsdMonthly: cheapest });
    expect(exact.chosen).toBeDefined();
    expect(exact.chosen!.cost.monthlyUsd).toBeLessThanOrEqual(cheapest);
    const under = solve({ userRegions: ["india"], budgetUsdMonthly: cheapest - 0.01 });
    expect(under.chosen).toBeUndefined();
  });

  it("shows a budget rejection example in the explanation of a successful placement", () => {
    const open = solve({ userRegions: ["india"] }, { options: { maxAlternatives: 100 } });
    const costs = all(open).map((c) => c.cost.monthlyUsd).sort((a, b) => a - b);
    const mid = (costs[0]! + costs[costs.length - 1]!) / 2;
    const r = solve({ userRegions: ["india"], budgetUsdMonthly: mid });
    expect(r.chosen).toBeDefined();
    expect(explainPlacement(r)).toMatch(/Example: .*budget: estimated \$\d+\.\d{2}\/month exceeds the/);
  });
});

describe("denylist, preference and zenith", () => {
  it("never places on a denied provider and reports the denial", () => {
    const r = solve({ userRegions: ["india"], providerDenylist: ["AWS"] }, { options: { maxAlternatives: 100 } });
    for (const c of all(r)) expect(providersOf(c)).not.toContain("aws");
    expect(r.rejected.find((x) => x.id === "provider:aws")!.reasons[0]).toMatch(/denylist/);
  });

  it("returns no placement when every provider is denied", () => {
    const r = solve({ userRegions: ["india"], providerDenylist: ["aws", "gcp", "azure", "oci"] });
    expect(r.chosen).toBeUndefined();
    expect(r.rejected.filter((x) => x.id.startsWith("provider:")).map((x) => x.id)).toEqual(["provider:aws", "provider:azure", "provider:gcp", "provider:oci"]);
    expect(explainPlacement(r)).toMatch(/denylist/);
  });

  it("applies a preference bonus of exactly the documented weight to a preferred provider", () => {
    const none = solve({ userRegions: ["india"] }, { options: { maxAlternatives: 100 } });
    const pref = solve({ userRegions: ["india"], providerPreference: ["gcp"] }, { options: { maxAlternatives: 100 } });
    const a = all(none).find((c) => c.id === "single:gcp:asia-south1")!;
    const b = all(pref).find((c) => c.id === "single:gcp:asia-south1")!;
    expect(b.scoreBreakdown.preferenceBonus).toBe(-0.1);
    expect(a.scoreBreakdown.preferenceBonus).toBe(0);
    expect(b.score).toBeCloseTo(a.score - 0.1, 6);
    const aws = all(pref).find((c) => c.id === "single:aws:ap-south-1")!;
    expect(aws.scoreBreakdown.preferenceBonus).toBe(0);
  });

  it("leaves the zenith managed tier out unless asked, pinned or preferred", () => {
    const off = solve({ userRegions: ["india"] }, { options: { maxAlternatives: 100 } });
    expect(all(off).some((c) => providersOf(c).includes("zenith"))).toBe(false);
    expect(off.assumptions.join(" ")).toMatch(/zenith managed tier was not considered/);
    const on = solve({ userRegions: ["india"] }, { options: { includeZenithManagedTier: true, maxAlternatives: 100 } });
    const z = all(on).find((c) => providersOf(c).includes("zenith"))!;
    expect(z).toBeDefined();
    expect(z.warnings.join(" ")).toMatch(/internal assumptions/);
    expect(z.warnings.join(" ")).toMatch(/rests on remembered, derived or internal prices/);
    const preferred = solve({ userRegions: ["india"], providerPreference: ["zenith"] }, { options: { maxAlternatives: 100 } });
    expect(all(preferred).some((c) => providersOf(c).includes("zenith"))).toBe(true);
  });

  it("rejects a provider that cannot host a kind natively, naming the kind", () => {
    const components: PlacementComponent[] = [...stackComponents(), { address: "cluster/main", kind: "kubernetes_cluster", spec: {} }];
    const r = solve({ userRegions: ["india"] }, { components, options: { includeZenithManagedTier: true, maxAlternatives: 100 } });
    const z = r.rejected.find((x) => x.id === "single:zenith:ap-south")!;
    expect(z.reasons.join(" ")).toMatch(/capability: zenith has no native type for "kubernetes_cluster"/);
    expect(all(r)).toEqual([]);
    for (const provider of ["aws", "gcp"]) expect(r.rejected.some((entry) => entry.id.startsWith(`single:${provider}:`) && entry.reasons.some((reason) => reason.includes("managed kubernetes_cluster")))).toBe(true);
    const site = solve({ userRegions: ["india"] }, { components: [...stackComponents(), { address: "site/docs", kind: "static_site", spec: {} }], options: { maxAlternatives: 100 } });
    expect(site.rejected.find((x) => x.id === "single:oci:ap-mumbai-1")!.reasons.join(" ")).toMatch(/capability: oci has no native type for "static_site"/);
  });
});

describe("unpriced managed placement", () => {
  it.each(["function", "static_site", "kubernetes_cluster"] as const)("never ranks managed %s as a zero or partial budget fit", (kind) => {
    const result = solve({ userRegions: ["us-east"], budgetUsdMonthly: 100000 }, { components: [...stackComponents(), { address: "unknown/main", kind, spec: {} }], options: { maxAlternatives: 100 } });
    expect(result.chosen).toBeUndefined();
    expect(result.alternatives).toEqual([]);
    expect(result.rejected.length).toBeGreaterThan(0);
    expect(result.rejected.some((entry) => entry.reasons.some((reason) => reason.startsWith("price:") && reason.includes(`managed ${kind}`)))).toBe(true);
  });
});

describe("cross-cloud", () => {
  it("is not considered without pins on different providers or a multi-provider preference", () => {
    const r = solve({ userRegions: ["india"] });
    expect(r.assumptions.join(" ")).toMatch(/Cross-cloud candidates were not considered/);
    expect(r.rejected.some((x) => x.id.startsWith("mixed:"))).toBe(false);
  });

  it("rejects a preference-driven cross-cloud candidate that does not beat the margin, with numbers", () => {
    const r = solve({ userRegions: ["india"], providerPreference: ["aws", "gcp", "oci"] }, { options: { maxAlternatives: 200 } });
    expect(r.assumptions.join(" ")).toMatch(/Cross-cloud candidates were considered because the provider preference lists aws, gcp, oci/);
    expect(r.chosen!.topology).toBe("single_region");
    const mixed = r.rejected.filter((x) => x.id.startsWith("mixed:"));
    expect(mixed.length).toBeGreaterThan(5);
    const singles = all(r).filter((c) => c.topology !== "cross_cloud");
    const best = Math.min(...singles.map((c) => c.cost.monthlyUsd));
    for (const x of mixed) {
      const reason = x.reasons.find((y) => y.startsWith("cross-cloud margin:"))!;
      expect(reason, x.id).toBeDefined();
      const m = reason.match(/costs \$(\d+\.\d{2})\/month including \$(\d+\.\d{2}) cross-cloud transfer, against \$(\d+\.\d{2}) for (\S+);/)!;
      expect(m, reason).not.toBeNull();
      expect(Number(m[3])).toBeCloseTo(best, 2);
      const net = Number(m[3]) - Number(m[1]) - COMPLEXITY_USD_PER_EXTRA_PROVIDER;
      expect(net).toBeLessThan(CROSS_CLOUD_SAVINGS_MARGIN * Number(m[3]));
      expect(reason).toMatch(/below the required 15% margin/);
    }
  });

  it("chooses a cross-cloud candidate only when savings clear the margin after egress and complexity (property over price scenarios)", () => {
    let accepted = 0;
    let rejectedByMargin = 0;
    for (const factor of [1, 1.3, 2, 5, 30]) {
      const cat = withPrices((e) => {
        if (e.provider === "aws" && e.sku.startsWith("aws.rds_postgres.") && e.unit !== "ratio") return e.usd * factor;
        if (e.provider === "gcp" && (e.sku.startsWith("gcp.cloud_run.") || e.sku.startsWith("gcp.load_balancing."))) return e.usd * factor;
        return undefined;
      });
      const r = solve({ userRegions: ["us-east"], providerPreference: ["aws", "gcp"], providerDenylist: ["oci", "azure"] }, { catalog: cat, options: { maxAlternatives: 300 } });
      const feasible = all(r);
      const singles = feasible.filter((c) => c.topology !== "cross_cloud");
      const baseline = Math.min(...singles.map((c) => c.cost.monthlyUsd));
      for (const c of feasible.filter((x) => x.topology === "cross_cloud")) {
        const extra = providersOf(c).length - 1;
        expect(baseline - c.cost.monthlyUsd - COMPLEXITY_USD_PER_EXTRA_PROVIDER * extra, `${c.id} at ${factor}`).toBeGreaterThanOrEqual(CROSS_CLOUD_SAVINGS_MARGIN * baseline - 1e-9);
        accepted += 1;
      }
      for (const x of r.rejected.filter((y) => y.id.startsWith("mixed:"))) {
        const reason = x.reasons.find((y) => y.startsWith("cross-cloud margin:"));
        expect(reason, `${x.id} at ${factor}`).toBeDefined();
        rejectedByMargin += 1;
      }
      if (factor === 30) {
        expect(r.chosen!.topology).toBe("cross_cloud");
        expect(r.chosen!.crossBoundary.length).toBeGreaterThan(0);
        expect(r.chosen!.scoreBreakdown.complexityPenalty).toBeGreaterThan(0);
        expect(r.chosen!.cost.lines.some((l) => l.description.startsWith("Cross-cloud transfer"))).toBe(true);
      }
      if (factor === 1) expect(r.chosen!.topology).toBe("single_region");
    }
    expect(accepted).toBeGreaterThan(0);
    expect(rejectedByMargin).toBeGreaterThan(0);
  });

  it("chooses cross-cloud when pins force it, and costs the egress and the latency", () => {
    const r = solve({ userRegions: ["india"], componentProviders: { web: "aws", database: "azure" } }, { options: { maxAlternatives: 100 } });
    const c = r.chosen!;
    expect(c.topology).toBe("cross_cloud");
    expect(c.id).toMatch(/^mixed:/);
    expect(providersOf(c)).toEqual(["aws", "azure"]);
    expect(c.assignments["service/web"]!.provider).toBe("aws");
    expect(c.assignments["resource/db"]!.provider).toBe("azure");
    expect(r.assumptions.join(" ")).toMatch(/Cross-cloud candidates are forced: component pins name aws and azure/);
    // egress: the database (callee) sends 20% of 50 GB at Azure's internet price
    const hop = c.crossBoundary.find((x) => x.from === "service/web" && x.to === "resource/db")!;
    expect(hop.kind).toBe("cross_cloud");
    expect(hop.egressUsdMonthly).toBeGreaterThan(0);
    expect(hop.addedLatencyMs).toBeGreaterThanOrEqual(10);
    expect(c.cost.lines.find((l) => l.description.startsWith("Cross-cloud transfer"))!.monthlyUsd).toBeCloseTo(hop.egressUsdMonthly, 2);
    // latency: nearest serving region plus the cross-cloud hop, then p95
    const app = c.assignments["service/web"]!;
    expect(c.latencyMs.india).toBe(estimateP95Ms(userToRegionRttMs("india", app.provider, app.region) + hop.addedLatencyMs));
    expect(c.scoreBreakdown.complexityPenalty).toBeGreaterThan(0);
    expect(c.warnings.join(" ")).toMatch(/identity federation/);
    // every single-provider candidate is rejected by the pin, and no margin applies to a forced mix
    expect(r.rejected.filter((x) => x.id.startsWith("single:")).every((x) => x.reasons.join(" ").includes("pin:"))).toBe(true);
    expect(r.rejected.some((x) => x.reasons.join(" ").includes("cross-cloud margin"))).toBe(false);
  });

  it("keeps all groups in one geography when the providers have a region there", () => {
    const r = solve({ userRegions: ["india"], componentProviders: { web: "aws", database: "azure" } });
    const c = r.chosen!;
    expect(c.assignments["service/web"]!.region).toBe("ap-south-1");
    expect(c.assignments["resource/db"]!.region).toBe("centralindia");
    expect(c.crossBoundary[0]!.addedLatencyMs).toBe(10);
  });

  it("falls back to the nearest geography when a pinned provider has no region where the app is", () => {
    const r = solve({ userRegions: ["europe"], componentProviders: { web: "aws", database: "oci" } }, { options: { maxAlternatives: 100 } });
    const eu = all(r).find((c) => c.assignments["service/web"]!.region === "eu-west-1");
    expect(eu).toBeDefined();
    expect(eu!.assignments["resource/db"]!.provider).toBe("oci");
    expect(eu!.assignments["resource/db"]!.region).toBe("us-ashburn-1"); // nearest OCI region to Ireland
    expect(eu!.crossBoundary[0]!.addedLatencyMs).toBeGreaterThan(50);
  });

  it("pinning everything to one provider is just a single-provider placement", () => {
    const r = solve({ userRegions: ["india"], componentProviders: { database: "azure" } }, { options: { maxAlternatives: 100 } });
    expect(r.chosen!.topology).toBe("single_region");
    expect(providersOf(r.chosen!)).toEqual(["azure"]);
    expect(r.rejected.find((x) => x.id === "single:aws:ap-south-1")!.reasons.join(" ")).toMatch(/pin: component resource\/db is pinned to azure but this candidate places it on aws/);
    expect(r.assumptions.join(" ")).toMatch(/Cross-cloud candidates were not considered/);
  });

  it("holds existing (referenced) components where they are and costs the traffic to them", () => {
    const components = stackComponents().map((c): PlacementComponent =>
      c.address === "resource/db" ? { ...c, ownership: "referenced", pin: { provider: "gcp", region: "asia-south1" } } : c,
    );
    const r = solve({ userRegions: ["india"] }, { components, options: { maxAlternatives: 100 } });
    for (const c of all(r)) expect(c.assignments["resource/db"]).toMatchObject({ provider: "gcp", region: "asia-south1" });
    const onGcp = all(r).find((c) => c.id === "single:gcp:asia-south1")!;
    expect(onGcp.crossBoundary).toEqual([]);
    const onAws = all(r).find((c) => c.id === "single:aws:ap-south-1")!;
    expect(onAws.crossBoundary.some((x) => x.to === "resource/db" && x.kind === "cross_cloud")).toBe(true);
    expect(onAws.cost.lines.some((l) => l.sku.includes("rds_postgres"))).toBe(false); // not our bill
  });
});

describe("input problems", () => {
  const failed = (r: PlacementResult) => {
    expect(r.chosen).toBeUndefined();
    expect(r.alternatives).toEqual([]);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.id).toBe("input");
    return r.rejected[0]!.reasons.join(" | ");
  };

  it("reports unknown user regions, empty user regions and unknown preferred providers as a result", () => {
    expect(failed(solve({ userRegions: ["atlantis"] }))).toMatch(/unknown user region "atlantis"/);
    expect(failed(solve({ userRegions: [] }))).toMatch(/userRegions is empty/);
    expect(failed(solve({ userRegions: ["india"], providerPreference: ["digitalocean"] }))).toMatch(/preferred provider "digitalocean" has no price catalog/);
  });

  it("reports pins that match nothing, conflict, name an unknown provider, or name a denied provider", () => {
    expect(failed(solve({ userRegions: ["india"], componentProviders: { databse: "aws" } }))).toMatch(/componentProviders key "databse" matches no component/);
    expect(failed(solve({ userRegions: ["india"], componentProviders: { database: "aws", db: "gcp" } }))).toMatch(/pinned to both/);
    expect(failed(solve({ userRegions: ["india"], componentProviders: { database: "digitalocean" } }))).toMatch(/no price catalog/);
    expect(failed(solve({ userRegions: ["india"], componentProviders: { database: "aws" }, providerDenylist: ["aws"] }))).toMatch(/denylist/);
  });

  it("requires a managed database component when managedDatabaseRequired is set", () => {
    const components = stackComponents().filter((c) => c.kind !== "postgres");
    expect(failed(solve({ userRegions: ["india"], managedDatabaseRequired: true }, { components }))).toMatch(/no managed database component/);
  });

  it("throws on structurally invalid numbers and duplicate components", () => {
    expect(() => solve({ userRegions: ["india"], budgetUsdMonthly: -1 })).toThrow(PlacementInputError);
    expect(() => solve({ userRegions: ["india"], budgetUsdMonthly: Number.NaN })).toThrow(PlacementInputError);
    expect(() => solve({ userRegions: ["india"], availabilityTarget: 150 })).toThrow(PlacementInputError);
    expect(() => solve({ userRegions: ["india"], availabilityTarget: 0 })).toThrow(PlacementInputError);
    expect(() => solve({ userRegions: ["india"], latencyTargetMs: 0 })).toThrow(PlacementInputError);
    expect(() => solve({ userRegions: "india" as unknown as string[] })).toThrow(PlacementInputError);
    expect(() => solve({ userRegions: ["india"] }, { components: [...stackComponents(), { address: "service/web", kind: "container_service" }] })).toThrow(/Duplicate component address/);
    expect(() => solve({ userRegions: ["india"], usage: { egressGb: -5 } })).toThrow(CostInputError);
  });
});

describe("determinism", () => {
  it("returns identical results, including the seed, for identical inputs", () => {
    const a = solve(EXAMPLE);
    const b = solve(EXAMPLE);
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("is independent of component and edge order", () => {
    const a = solve(EXAMPLE);
    const shuffled = [...stackComponents()].reverse();
    const b = solvePlacement({ components: shuffled, edges: [...STACK_PLACEMENT_EDGES].reverse(), constraints: EXAMPLE, catalog });
    const c = solvePlacement({ components: shuffled, edges: STACK_PLACEMENT_EDGES, constraints: EXAMPLE, catalog });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
    expect(b.deterministicSeed).toBe(a.deterministicSeed);
    // and of the order of userRegions / residency / denylist entries
    const x = solve({ userRegions: ["singapore", "india"], residency: ["IN", "sg"], providerDenylist: ["oci", "azure"] });
    const y = solve({ userRegions: ["india", "singapore"], residency: ["SG", "in"], providerDenylist: ["azure", "oci"] });
    expect(JSON.stringify(y)).toBe(JSON.stringify(x));
  });

  it("changes the seed when any input that matters changes", () => {
    const base = solve(EXAMPLE).deterministicSeed;
    expect(solve({ ...EXAMPLE, budgetUsdMonthly: 501 }).deterministicSeed).not.toBe(base);
    expect(solve({ ...EXAMPLE, userRegions: ["india"] }).deterministicSeed).not.toBe(base);
    expect(solve(EXAMPLE, { options: { includeZenithManagedTier: true } }).deterministicSeed).not.toBe(base);
    expect(solve(EXAMPLE, { components: stackComponents({ web: { size: "standard" } }) }).deterministicSeed).not.toBe(base);
    const bumped = { ...catalog, version: "2026-10-01.1" };
    expect(solve(EXAMPLE, { catalog: bumped }).deterministicSeed).not.toBe(base);
    expect(solve(EXAMPLE, { options: { now: "2027-01-01T00:00:00.000Z" } }).deterministicSeed).not.toBe(base);
  });

  it("does not mutate its inputs", () => {
    const components = deepFreeze(stackComponents());
    const edges = deepFreeze([...STACK_PLACEMENT_EDGES]);
    const constraints = deepFreeze({ ...EXAMPLE, userRegions: [...EXAMPLE.userRegions], componentProviders: { web: "aws" } });
    expect(() => solvePlacement({ components, edges, constraints, catalog })).not.toThrow();
  });

  it("breaks exact ties on the candidate id, lexicographically", () => {
    const cat = withPrices((e) => {
      if (e.provider !== "aws" || e.region !== "us-east-1") return undefined;
      return catalog.entries.find((x) => x.provider === "aws" && x.region === "eu-west-1" && x.sku === e.sku)!.usd;
    });
    const constraints: PlacementConstraints = { userRegions: ["europe", "us-east"], providerDenylist: ["gcp", "azure", "oci"] };
    const r = solve(constraints, { catalog: cat });
    expect(r.chosen!.id).toBe("single:aws:eu-west-1");
    expect(r.alternatives[0]!.id).toBe("single:aws:us-east-1");
    expect(r.alternatives[0]!.score).toBe(r.chosen!.score);
    expect(r.alternatives[0]!.cost.monthlyUsd).toBe(r.chosen!.cost.monthlyUsd);
  });

  it("stays fast with pins, preferences and far-apart users all enabled", () => {
    const t0 = performance.now();
    const r = solve({ userRegions: ["india", "us-east", "europe"], providerPreference: ["aws", "gcp", "azure", "oci"], componentProviders: { web: "aws", database: "azure", cache: "gcp" }, availabilityTarget: 99.9 }, {
      components: [...stackComponents(), { address: "resource/cache", kind: "redis", spec: { size: "small" } }, { address: "queue/jobs", kind: "queue", spec: {} }],
      options: { maxAlternatives: 10 },
    });
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(r.chosen ?? r.rejected.length).toBeTruthy();
  });
});

describe("explanation", () => {
  it("is deterministic and only quotes numbers that are in, or derived from, the result", () => {
    const r = solve(EXAMPLE);
    const text = explainPlacement(r);
    expect(explainPlacement(r)).toBe(text);
    const allowed = new Set<string>();
    const add = (x: number) => allowed.add(Math.abs(x).toFixed(2));
    for (const c of all(r)) {
      add(c.cost.monthlyUsd);
      for (const l of c.cost.lines) add(l.monthlyUsd);
      for (const x of c.crossBoundary) add(x.egressUsdMonthly);
      for (const other of all(r)) add(c.cost.monthlyUsd - other.cost.monthlyUsd);
    }
    for (const x of r.rejected) for (const reason of x.reasons) for (const m of reason.matchAll(/\$(\d+\.\d{2})/g)) allowed.add(m[1]!);
    for (const m of text.matchAll(/\$(\d+\.\d{2})/g)) {
      // amounts inside the basis strings of cost lines (e.g. weak-evidence warnings) are quoted from the result too
      if (allowed.has(m[1]!)) continue;
      const inWarnings = r.chosen!.warnings.join(" ").includes(m[1]!);
      const inBasis = r.chosen!.cost.lines.some((l) => l.basis.includes(m[1]!));
      expect(inWarnings || inBasis, `unexplained amount $${m[1]}`).toBe(true);
    }
  });

  it("compares the recommendation with alternatives using result numbers", () => {
    const r = solve(EXAMPLE);
    const text = explainPlacement(r, { alternatives: 2 });
    const alt = r.alternatives[0]!;
    expect(text).toContain(alt.id);
    expect(text).toContain(`$${alt.cost.monthlyUsd.toFixed(2)}/month`);
    expect(text).toMatch(/Not chosen because/);
  });

  it("names the input problem when there is no placement", () => {
    const text = explainPlacement(solve({ userRegions: ["atlantis"] }));
    expect(text).toMatch(/No placement satisfies the constraints/);
    expect(text).toMatch(/unknown user region "atlantis"/);
    expect(text).toMatch(/Seed [0-9a-f]{12}/);
  });
});

describe("purity", () => {
  it("does not touch the clock, the environment, the network, the filesystem or randomness", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(process.cwd(), "src", "lib", "placement");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(8);
    const forbidden = /Date\.now|new Date\(|process\.env|\bfetch\(|Math\.random|node:fs|node:http|node:net|XMLHttpRequest|@\/app\/|setTimeout/;
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join("\n");
      expect(forbidden.test(src), f).toBe(false);
    }
  });
});

// A budget must include auxiliaries, not turn unknown components into zero.
describe("native auxiliary placement completeness", () => {
  const secret: PlacementComponent = { address: "secret/env", kind: "secret", spec: { store: "zenith_vault", purpose: "environment", secretRef: "vault:environment" }, pin: { provider: "aws" } };
  it("includes native secret storage and assumed operations in numeric budget refusal", () => {
    const result = solve({ userRegions: ["india"], budgetUsdMonthly: 0.44 }, { components: [secret] });
    expect(result.chosen).toBeUndefined();
    expect(result.rejected.length).toBeGreaterThan(0);
    expect(result.rejected.some((candidate) => candidate.reasons.some((reason) => /^budget:/.test(reason) && reason.includes("0.45")))).toBe(true);
    const allowed = solve({ userRegions: ["india"], budgetUsdMonthly: 0.45 }, { components: [secret] });
    expect(allowed.chosen?.cost.monthlyUsd).toBe(0.45);
    expect(allowed.chosen?.cost.lines.some((line) => line.sku === "aws.secretsmanager.requests_million")).toBe(true);
  });
  it("rejects every candidate when an auxiliary meter is absent even at zero declared usage", () => {
    const incomplete = { ...catalog, entries: catalog.entries.filter((entry) => entry.sku !== "aws.secretsmanager.requests_million") };
    const result = solve({ userRegions: ["india"] }, { components: [{ ...secret, spec: { ...secret.spec, requestsMillions: 0 } }], catalog: incomplete });
    expect(result.chosen).toBeUndefined(); expect(result.alternatives).toEqual([]);
    expect(result.rejected.length).toBeGreaterThan(0);
    const aws = result.rejected.filter((candidate) => candidate.id.startsWith("single:aws:"));
    expect(aws).toHaveLength(4);
    expect(aws.every((candidate) => candidate.reasons.some((reason) => reason.includes("aws.secretsmanager.requests_million")))).toBe(true);
  });
});
