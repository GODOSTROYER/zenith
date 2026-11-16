/**
 * PROD-COST-02: infeasible budget, residency and availability constraints are
 * refused with a typed report, and a budget is described as a planning limit on
 * an estimate, never a billing cap.
 */
import { describe, expect, it, vi } from "vitest";
import {
  assessFeasibility,
  budgetReason,
  explainPlacement,
  loadDefaultCatalog,
  parseBudgetReason,
  reasonCategory,
  solvePlacement,
  unsatisfiableResidency,
} from "@/lib/placement";
import type { PlacementConstraints, PlacementResult } from "@/lib/placement";
import { recommendPlacement, type RecommendReads, type PlacementConnection } from "@/lib/placement/recommend";
import { ManifestV2 } from "@/lib/resources/manifest-v2";
import { BUDGET_NOTICE, findCapClaims } from "@/lib/cost/wording";
import { STACK_PLACEMENT_EDGES, stackComponents } from "./fixtures";

const catalog = loadDefaultCatalog();

function solve(constraints: PlacementConstraints, options: Parameters<typeof solvePlacement>[0]["options"] = {}): PlacementResult {
  return solvePlacement({ components: stackComponents(), edges: STACK_PLACEMENT_EDGES, catalog, constraints, options });
}

describe("reason vocabulary", () => {
  it("round-trips the budget reason the solver writes", () => {
    const reason = budgetReason(137.456, 50);
    expect(reason).toBe("budget: estimated $137.46/month exceeds the $50.00 budget by $87.46");
    expect(parseBudgetReason(reason)).toEqual({ estimatedUsd: 137.46, budgetUsd: 50, overUsd: 87.46 });
    expect(reasonCategory(reason)).toBe("budget");
    expect(parseBudgetReason("budget: something else")).toBeUndefined();
    expect(reasonCategory("residency: x")).toBe("residency");
    expect(reasonCategory("cross-cloud margin: x")).toBe("cross-cloud margin");
    expect(reasonCategory("whatever: x")).toBe("other");
  });

  it("the solver writes exactly this budget reason", () => {
    const r = solve({ userRegions: ["india"], budgetUsdMonthly: 50 });
    const reason = r.rejected.flatMap((x) => x.reasons).find((x) => x.startsWith("budget:"))!;
    expect(parseBudgetReason(reason)).toBeDefined();
  });
});

describe("infeasible budget", () => {
  const open = solve({ userRegions: ["india"] }, { maxAlternatives: 200 });
  const cheapest = Math.min(...[open.chosen!, ...open.alternatives].map((c) => c.cost.monthlyUsd));
  const r = solve({ userRegions: ["india"], budgetUsdMonthly: 50 });
  const report = assessFeasibility(r, { budgetUsdMonthly: 50 });

  it("is refused with a budget blocker and the cheapest otherwise-feasible estimate", () => {
    expect(r.chosen).toBeUndefined();
    expect(report.feasible).toBe(false);
    expect(report.kind).toBe("feasibility");
    expect(report.blockers.some((b) => b.kind === "budget" && b.candidatesAffected > 10)).toBe(true);
    expect(report.budget?.cheapestOtherwiseFeasibleUsdMonthly).toBeCloseTo(cheapest, 2);
    expect(report.budget?.shortfallUsdMonthly).toBeCloseTo(cheapest - 50, 2);
    expect(report.remedies.join(" ")).toMatch(/Raise the budget/);
  });

  it("says the budget is a limit on an estimate, never a billing cap", () => {
    expect(report.budget).toMatchObject({ limitUsdMonthly: 50, isEstimate: true, notABillingCap: true, notice: BUDGET_NOTICE });
    expect(explainPlacement(r)).toContain(BUDGET_NOTICE);
    expect(findCapClaims(explainPlacement(r))).toEqual([]);
  });

  it("a budget equal to the cheapest estimate is feasible and reports no blockers", () => {
    const ok = solve({ userRegions: ["india"], budgetUsdMonthly: cheapest });
    const feasible = assessFeasibility(ok, { budgetUsdMonthly: cheapest });
    expect(feasible).toMatchObject({ feasible: true, blockers: [], remedies: [] });
    expect(feasible.budget).toMatchObject({ limitUsdMonthly: cheapest, notABillingCap: true });
    expect(feasible.budget?.shortfallUsdMonthly).toBeUndefined();
  });

  it("without a budget there is no budget section", () => {
    expect(assessFeasibility(open, {}).budget).toBeUndefined();
  });
});

describe("infeasible residency", () => {
  it("names a jurisdiction no known region satisfies", () => {
    expect(unsatisfiableResidency(["Atlantis"])).toEqual(["Atlantis"]);
    expect(unsatisfiableResidency(["India"])).toEqual([]);
    expect(unsatisfiableResidency(["Atlantis", "India"])).toEqual([]); // any token matching is enough
    expect(unsatisfiableResidency(undefined)).toEqual([]);
    const r = solve({ userRegions: ["india"], residency: ["Atlantis"] });
    const report = assessFeasibility(r, { residency: ["Atlantis"] });
    expect(report.feasible).toBe(false);
    expect(report.blockers[0]).toMatchObject({ kind: "residency", bindingOnAll: true });
    expect(report.blockers[0]!.message).toContain("Atlantis");
    expect(report.remedies.join(" ")).toMatch(/jurisdiction/);
  });

  it("a satisfiable residency that still leaves nothing (EU residency, India-only providers) reports the residency blocker on the candidates", () => {
    const constraints = { userRegions: ["india"], residency: ["EU"], providerDenylist: ["aws", "gcp", "azure"] };
    const r = solve(constraints);
    const report = assessFeasibility(r, constraints);
    expect(r.chosen).toBeUndefined();
    expect(report.blockers.some((b) => b.kind === "residency")).toBe(true);
  });
});

describe("infeasible availability", () => {
  it("reports the availability blocker with the zone numbers", () => {
    const constraints = { userRegions: ["india"], residency: ["India"], tolerateSingleFailure: true, providerDenylist: ["aws", "gcp", "azure"] };
    const r = solve(constraints);
    const report = assessFeasibility(r, constraints);
    expect(r.chosen).toBeUndefined();
    expect(report.feasible).toBe(false);
    const availability = report.blockers.find((b) => b.kind === "availability");
    expect(availability).toBeDefined();
    expect(availability!.example).toMatch(/availability: oci\/ap-mumbai-1 offers 1 availability zone\(s\) but 2 are required/);
    expect(report.remedies.join(" ")).toMatch(/availability target/);
  });

  it("provider removals are not counted as tried candidates", () => {
    const r = solve({ userRegions: ["india"], providerDenylist: ["aws", "gcp", "azure"] }, { maxAlternatives: 50 });
    const report = assessFeasibility(r, {});
    expect(report.feasible).toBe(r.chosen !== undefined);
  });
});

describe("through the product recommendation", () => {
  const input = { workspaceId: "ws-a", projectId: "proj-a", environmentId: "env-a" };
  const connection = (provider: string): PlacementConnection => ({ workspaceId: "ws-a", provider, verified: true });
  const manifest = ManifestV2.parse({
    version: 2,
    placement: { provider: "auto" },
    constraints: { userRegions: ["india"] },
    services: [{ id: "svc-a", name: "web-app", kind: "web", source: { type: "image", image: "example.test/app:1" }, port: 8080 }],
    resources: [{ id: "db-a", name: "main-db", kind: "postgres" }],
  });
  const reads: RecommendReads = {
    project: vi.fn(async () => ({ id: "proj-a", workspaceId: "ws-a", workingManifest: manifest })),
    environment: vi.fn<RecommendReads["environment"]>(async () => ({ id: "env-a", projectId: "proj-a", provider: "aws", name: "Staging", class: "staging", region: "ap-south-1", connectionId: "c", baseDomain: "example.test", createdAt: "2026-09-30T00:00:00Z", policies: { approvalRequired: false, allowStatefulDeletion: false } })),
    connections: vi.fn(async () => [connection("aws")]),
  };

  it("carries a typed feasibility report and the estimate disclosure", async () => {
    const r = await recommendPlacement({ ...input, constraints: { budgetUsdMonthly: 1 } }, reads);
    expect(r.result.chosen).toBeUndefined();
    expect(r.feasibility.feasible).toBe(false);
    expect(r.feasibility.blockers.some((b) => b.kind === "budget")).toBe(true);
    expect(r.feasibility.budget?.cheapestOtherwiseFeasibleUsdMonthly).toBeGreaterThan(1);
    expect(r.disclosure).toMatchObject({ kind: "estimate", isBillingCap: false });
    expect(r.explanation).toContain(BUDGET_NOTICE);
  });

  it("is feasible when a placement exists", async () => {
    const r = await recommendPlacement(input, reads);
    expect(r.feasibility).toMatchObject({ feasible: true, blockers: [] });
    expect(r.disclosure.isBillingCap).toBe(false);
  });

  it("reports the connection blocker when no provider is connected", async () => {
    const none: RecommendReads = { ...reads, connections: vi.fn(async () => []) };
    const r = await recommendPlacement(input, none);
    expect(r.feasibility.feasible).toBe(false);
    expect(r.feasibility.blockers.some((b) => b.kind === "connection")).toBe(true);
  });
});
