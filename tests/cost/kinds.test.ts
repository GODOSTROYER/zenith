/**
 * PROD-COST-01: Estimate, Forecast and ActualSpend are separate types, and no
 * wording presents an estimate, forecast or budget as a billing cap.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertActualSpend, compareEstimateToActual, CostKindError, daysBetween, forecastFromActual, isActualSpend, isEstimate, isForecast, newActualSpend, type ActualSpend } from "@/lib/cost/kinds";
import { BUDGET_NOTICE, costDisclosure, ESTIMATE_NOTICE, findCapClaims, FORECAST_NOTICE } from "@/lib/cost/wording";
import { estimateGraphCost, loadDefaultCatalog } from "@/lib/placement";
import { node } from "../placement/fixtures";

const SHA = "a".repeat(64);

function actual(over: Partial<Omit<ActualSpend, "kind" | "notice" | "currency">> = {}): ActualSpend {
  return newActualSpend({
    provider: "aws",
    scope: "123456789012",
    periodStart: "2026-10-01",
    periodEnd: "2026-11-01",
    totalUsd: 100,
    lines: [{ service: "Amazon Elastic Compute Cloud - Compute", usd: 100 }],
    costBasis: "test",
    finalization: "provisional",
    source: { adapter: "test", endpoint: "https://example.invalid/", retrievedAt: "2026-10-11T00:00:00.000Z", responseSha256: SHA },
    ...over,
  });
}

describe("three kinds, never confused", () => {
  const estimate = estimateGraphCost({ nodes: [node("service/web", "container_service", "aws", "us-east-1", { size: "small" })] }, { catalog: loadDefaultCatalog() });

  it("discriminates by kind", () => {
    const a = actual();
    const f = forecastFromActual(a, "2026-10-11T00:00:00.000Z");
    expect(isEstimate(estimate)).toBe(true);
    expect(isActualSpend(a) && !isEstimate(a) && !isForecast(a)).toBe(true);
    expect(isForecast(f) && !isActualSpend(f) && !isEstimate(f)).toBe(true);
    expect([estimate.kind, a.kind, f.kind]).toEqual(["estimate", "actual_spend", "forecast"]);
  });

  it("refuses an estimate presented as actual spend, and non-USD or checksum-less records", () => {
    expect(() => assertActualSpend(estimate)).toThrow(CostKindError);
    expect(() => assertActualSpend({ ...actual(), currency: "EUR" })).toThrow(/USD/);
    expect(() => assertActualSpend({ ...actual(), source: { ...actual().source, responseSha256: "x" } })).toThrow(/SHA-256/);
    expect(() => actual({ periodStart: "2026-11-01", periodEnd: "2026-10-01" })).toThrow(CostKindError);
    expect(() => actual({ periodStart: "2026-02-30" })).toThrow(/real calendar date/);
  });

  it("a forecast is derived from actual spend only, as a floor plus a run rate", () => {
    const f = forecastFromActual(actual({ totalUsd: 100 }), "2026-10-11T08:00:00.000Z"); // 10 full days observed
    expect(f.basedOn).toMatchObject({ observedDays: 10, periodDays: 31, responseSha256: SHA });
    expect(f.floorUsd).toBe(100);
    expect(f.projectedUsd).toBe(310); // 100 + 10/day x 21 remaining days
    expect(f.notice).toBe(FORECAST_NOTICE);
    expect(f.assumptions.join(" ")).toMatch(/credits, refunds and provider billing lag are not modeled/);
  });

  it("refuses a forecast for an ended period or with no full day observed", () => {
    expect(() => forecastFromActual(actual(), "2026-11-02T00:00:00.000Z")).toThrow(/period has ended/);
    expect(() => forecastFromActual(actual(), "2026-10-01T12:00:00.000Z")).toThrow(/one full day/);
  });

  it("compares an estimate with actual spend without converting either", () => {
    const c = compareEstimateToActual(estimate, actual({ totalUsd: estimate.monthlyUsd * 2 }));
    expect(c.kind).toBe("estimate_vs_actual");
    expect(c.estimateMonthlyUsd).toBe(estimate.monthlyUsd);
    expect(c.ratio).toBe(2);
    expect(c.comparable).toBe(true);
    expect(c.caveats.join(" ")).toMatch(/provisional/);
    const short = compareEstimateToActual(estimate, actual({ periodEnd: "2026-10-08" }));
    expect(short.comparable).toBe(false);
  });

  it("counts days exactly", () => {
    expect(daysBetween("2026-10-01", "2026-11-01")).toBe(31);
    expect(daysBetween("2028-02-01", "2028-03-01")).toBe(29);
  });
});

describe("wording: an estimate is never a cap", () => {
  it("the standard notices deny being a cap or an invoice", () => {
    expect(ESTIMATE_NOTICE).toMatch(/not an invoice, a quote or a limit/);
    expect(BUDGET_NOTICE).toMatch(/planning limit on estimated/);
    expect(BUDGET_NOTICE).toMatch(/does not stop or cap/);
    expect(costDisclosure()).toMatchObject({ kind: "estimate", isBillingCap: false });
    for (const text of [ESTIMATE_NOTICE, BUDGET_NOTICE, FORECAST_NOTICE]) expect(findCapClaims(text)).toEqual([]);
  });

  it("detects phrases that claim a hard limit and lets denials through", () => {
    for (const bad of [
      "Your spending cap is $50.",
      "This is a hard cap on what you pay.",
      "Spend is capped at $100 per month.",
      "We guarantee the cost will stay under budget.",
      "Your bill cannot exceed the budget.",
      "Zenith will not spend more than your budget.",
    ]) {
      expect(findCapClaims(bad), bad).not.toEqual([]);
    }
    for (const ok of ["A budget is not a spending cap.", "Estimates are never a billing cap.", "This does not cap what your provider bills.", "Budgets warn before a deploy."]) {
      expect(findCapClaims(ok), ok).toEqual([]);
    }
  });

  it("no user-facing cost copy in the product claims a cap", () => {
    const files = [
      "src/lib/placement/explain.ts",
      "src/lib/placement/feasibility.ts",
      "src/lib/placement/recommend.ts",
      "src/lib/actions/defs/env.ts",
      "src/lib/actions/defs/deploy.ts",
      "src/lib/actions/defs/placement.ts",
      "src/components/platform/placement-comparison.tsx",
      "src/components/platform/cost-estimate-card.tsx",
      "src/lib/cost/wording.ts",
      "src/lib/cost/kinds.ts",
      "src/lib/cost/spend-service.ts",
      "src/lib/agent-access/v3/tools/placement.ts",
      "src/app/api/platform/v1/environments/[id]/spend/route.ts",
    ];
    for (const file of files) {
      const text = readFileSync(join(process.cwd(), file), "utf8");
      // Only string literals and comments that read as sentences matter; scan the whole file line by line.
      const offenders = text.split("\n").flatMap((line) => findCapClaims(line.replace(/^\s*(\/\/|\*|\/\*\*)\s?/, "")));
      expect(offenders, file).toEqual([]);
    }
  });
});
