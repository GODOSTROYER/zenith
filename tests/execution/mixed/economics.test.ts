/**
 * PROD-MIX-07: the mixed-cloud economics report. Contract level over the bundled dated catalog and the reference app's placement
 * (GCP web, AWS enricher, Azure PostgreSQL). Every figure is a list-price ESTIMATE; this proves the report includes the cross-cloud
 * transfer it implies, compares latency and residency, refuses to show an unpriced graph as free, and never calls an estimate a cap.
 */
import { describe, expect, it } from "vitest";
import { edgeLatencies, mixedEconomics, renderEconomics, residencyReport } from "@/lib/execution/mixed/economics";
import { findCapClaims } from "@/lib/cost/wording";
import { loadDefaultCatalog } from "@/lib/placement/pricebook";
import type { CostGraph } from "@/lib/placement/cost";
import { referenceCostGraph, referenceEconomics, runCostReportCli } from "../../../scripts/acceptance/mixed/cost-report";

const catalog = loadDefaultCatalog();
const priced = (over: Parameters<typeof referenceEconomics>[0] = {}) => {
  const report = referenceEconomics(over);
  if (!report.priced) throw new Error(`reference app not priced: ${report.reason}`);
  return report;
};

describe("the reference app's economics", () => {
  it("prices the whole placement and states that it is an estimate, never a cap", () => {
    const report = priced({ egressGb: 100, fraction: 0.5 });
    expect(report.kind).toBe("mixed_economics");
    expect(report.notABillingCap).toBe(true);
    expect(report.currency).toBe("USD");
    expect(report.monthlyUsd).toBeGreaterThan(0);
    expect(report.catalogVersion).toBe(catalog.version);
    expect(report.notes.join(" ")).toContain("not an invoice and not a billing cap");
    expect(findCapClaims(renderEconomics(report))).toEqual([]);
  });

  it("includes the data that crosses clouds, billed on the side that sends it, edge by edge, and says what share of the total it is", () => {
    const report = priced({ egressGb: 100, fraction: 0.5 });
    expect(report.transfers.map((t) => `${t.from}->${t.to}:${t.kind}`).sort()).toEqual(["resource/db->service/web:cross_cloud", "service/enricher->service/web:cross_cloud"]);
    expect(report.transfers.every((t) => t.gb === 50 && t.usd > 0)).toBe(true);
    expect(report.transferUsd).toBeCloseTo(report.transfers.reduce((s, t) => s + t.usd, 0), 2);
    expect(report.transferShare).toBeGreaterThan(0);
    expect(report.transferShare).toBeLessThan(1);
    expect(report.transferUsd).toBeLessThan(report.monthlyUsd);
  });

  it("transfer cost grows with the traffic assumed and is zero when nothing crosses", () => {
    const small = priced({ egressGb: 50, fraction: 0.2 });
    const large = priced({ egressGb: 1000, fraction: 0.8 });
    expect(large.transferUsd).toBeGreaterThan(small.transferUsd);
    expect(large.monthlyUsd).toBeGreaterThan(small.monthlyUsd);
    const none = priced({ egressGb: 100, fraction: 0 });
    expect(none.transferUsd).toBe(0);
  });

  it("splits the estimate by provider and the parts add up to the total", () => {
    const report = priced();
    expect(Object.keys(report.byProvider)).toEqual(expect.arrayContaining(["aws", "gcp", "azure"]));
    expect(Object.values(report.byProvider).reduce((s, v) => s + v, 0)).toBeCloseTo(report.monthlyUsd, 0);
  });

  it("compares cross-partition latency with a budget and labels the table approximate", () => {
    const tight = priced({ latencyBudgetMs: 30 });
    expect(tight.latency).toHaveLength(2);
    expect(tight.latency.every((l) => l.rttMs > 0 && l.p95Ms >= l.rttMs && l.withinBudget === false)).toBe(true);
    const loose = priced({ latencyBudgetMs: 500 });
    expect(loose.latency.every((l) => l.withinBudget === true)).toBe(true);
    expect(priced().latency.every((l) => l.withinBudget === undefined)).toBe(true);
    expect(renderEconomics(tight)).toContain("OVER budget");
    expect(renderEconomics(tight)).toContain("approximate table");
    expect(tight.notes.join(" ")).toContain("not a measurement");
  });

  it("checks residency of every partition", () => {
    expect(priced({ residency: ["us"] }).residency).toEqual({ required: ["us"], violations: [], satisfied: true });
    const eu = priced({ residency: ["eu"] }).residency;
    expect(eu.satisfied).toBe(false);
    expect(eu.violations.map((v) => `${v.address}:${v.reason}`).sort()).toEqual(["resource/db:region_outside_residency", "service/enricher:region_outside_residency", "service/web:region_outside_residency"]);
    expect(renderEconomics(priced({ residency: ["eu"] }))).toContain("VIOLATED");
    expect(priced().residency).toEqual({ required: [], violations: [], satisfied: true });
  });
});

describe("what it refuses to do", () => {
  const graph = (region: string, provider = "aws"): CostGraph => ({ nodes: [{ address: "service/x", kind: "container_service", provider, region, spec: { size: "small", replicas: 1, publicIp: true }, ownership: "managed" }], edges: [] });

  it("never shows an unpriced graph as free", () => {
    const report = mixedEconomics({ graph: graph("us-nowhere-9"), catalog });
    expect(report.priced).toBe(false);
    expect(report).not.toHaveProperty("monthlyUsd");
    if (report.priced) return;
    expect(report.reason.length).toBeGreaterThan(5);
    expect(report.notes.join(" ")).toContain("never presented as free");
    expect(renderEconomics(report)).toContain("Not priced");
  });

  it("flags an unknown region under a residency constraint instead of assuming it is fine", () => {
    const r = residencyReport(graph("xx-fake-1"), ["eu"]);
    expect(r.violations).toEqual([{ address: "service/x", provider: "aws", region: "xx-fake-1", reason: "region_unknown" }]);
  });

  it("ignores nodes Zenith does not own when judging residency and prices only what it manages", () => {
    const g: CostGraph = { nodes: [{ address: "resource/ext", kind: "postgres", provider: "azure", region: "westeurope", ownership: "external" }, ...graph("us-east-1").nodes], edges: [] };
    expect(residencyReport(g, ["us"]).satisfied).toBe(true);
  });

  it("only measures edges that really cross a partition", () => {
    const g: CostGraph = { nodes: [{ address: "a", kind: "container_service", provider: "aws", region: "us-east-1" }, { address: "b", kind: "container_service", provider: "aws", region: "us-east-1" }, { address: "c", kind: "container_service", provider: "gcp", region: "us-central1" }], edges: [{ from: "a", to: "b", relation: "connects_to" }, { from: "a", to: "c", relation: "connects_to" }, { from: "a", to: "ghost", relation: "connects_to" }] };
    expect(edgeLatencies(g).map((l) => `${l.from}->${l.to}`)).toEqual(["a->c"]);
  });
});

describe("the cost report command", () => {
  const run = (argv: string[]) => { const out: string[] = []; const err: string[] = []; const code = runCostReportCli(argv, { out: (s) => { out.push(s); }, err: (s) => { err.push(s); } }); return { code, out: out.join(""), err: err.join("") }; };

  it("prints the estimate with its disclaimers and exits 0 when priced and inside the residency constraint", () => {
    const r = run(["--egress-gb", "100", "--fraction", "0.5", "--residency", "us", "--latency-ms", "100"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("ESTIMATE, not an invoice and not a billing cap");
    expect(r.out).toContain("transfer resource/db -> service/web (cross_cloud)");
  });

  it("exits non-zero on a residency violation and prints machine-readable JSON on request", () => {
    expect(run(["--residency", "eu"]).code).toBe(1);
    const json = run(["--json"]);
    expect((JSON.parse(json.out) as { kind: string; notABillingCap: boolean }).notABillingCap).toBe(true);
  });

  it("rejects unknown options and bad numbers", () => {
    expect(run(["--bogus"]).code).toBe(2);
    expect(run(["--egress-gb", "-1"]).code).toBe(2);
    expect(run(["--fraction", "abc"]).code).toBe(2);
  });

  it("derives the graph from the manifest it reports on", () => {
    expect(referenceCostGraph().nodes).toHaveLength(3);
    expect(() => referenceCostGraph({ services: [{ id: "x", name: "x", kind: "web" }], resources: [], bindings: [], nodePlacement: {} })).toThrow("does not place");
  });
});
