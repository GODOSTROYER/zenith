/** Synthetic scoped telemetry contracts. No real metrics/backend acceptance is claimed. */
import { describe, expect, it, vi } from "vitest";
import { createMeasurementCollector } from "@/lib/cost/optimizer/measurement-collector";
import type { MetricQuery, MetricSeries, QueryResult } from "@/lib/observability/types";
import type { ResourceGraph } from "@/lib/resources/types";
import type { ReconcileEnvironment } from "@/lib/reconcile/types";

const now = new Date("2026-10-08T00:00:00.000Z");
const env: ReconcileEnvironment = { workspaceId: "ws-test", environmentId: "env-test", projectId: "proj-test", provider: "aws", region: "us-east-1", class: "production" };
const graph: ResourceGraph = { version: 1, environmentId: env.environmentId, nodes: [{ address: "service/web", kind: "container_service", provider: "aws", region: "us-east-1", spec: { size: "standard", replicas: 3 }, ownership: "managed", nativeType: "aws:ecs_service", origin: ["web"], labels: {}, dependsOn: [], specDigest: "fixture" }], edges: [], manifestDigest: "fixture", graphDigest: "fixture", notes: [] };

export function completeMetrics(query: MetricQuery): QueryResult<MetricSeries> {
  return { simulated: false, truncated: false, unavailable: [], sources: ["fixture-metrics"], telemetry: {
    schemaVersion: 1, signal: "metric", scope: { workspaceId: query.scope.workspaceId, environmentId: query.scope.environmentId, addresses: query.scope.addresses! },
    observedAt: now.toISOString(), state: "fresh", partial: false, freshness: { budgetMs: 3600_000 }, provenance: [{ source: "fixture-metrics", provider: "aws", simulated: false, state: "fresh", observedAt: now.toISOString(), itemCount: query.metrics.length, evidence: { level: "contract", basis: "synthetic scoped collector contract" } }],
  }, items: query.metrics.map(metric => ({ metric, address: "service/web", provider: "aws", native: {},
    unit: metric.endsWith("utilization") ? "Percent" : metric === "http.requests" ? "Requests/Second" : "Bytes/Second",
    points: Array.from({ length: 169 }, (_, i) => ({ timestamp: new Date(Date.parse(query.range.from) + i * 3600_000).toISOString(), value: metric.endsWith("utilization") ? 20 : metric === "cost.inter_component.bytes" ? 0 : 1 })),
  })) };
}
function setup(change?: (result: QueryResult<MetricSeries>) => void) {
  const read = vi.fn(async (_env, _graph, query: MetricQuery) => { const result = completeMetrics(query); change?.(result); return result; });
  return { read, collector: createMeasurementCollector({ read, now: () => now, constraints: async () => ({ userRegions: ["us-east"], residency: ["US"], budgetUsdMonthly: 1000 }) }) };
}

describe("default optimizer measurement collector", () => {
  it("collects seven days in scoped queries and derives monthly-equivalent usage without defaults", async () => {
    const { collector, read } = setup();
    const result = await collector.load(env, graph);
    expect(read).toHaveBeenCalledWith(env, graph, expect.objectContaining({ scope: { workspaceId: env.workspaceId, environmentId: env.environmentId, projectId: env.projectId, addresses: ["service/web"] }, stepSec: 3600 }), undefined);
    expect(result?.measured.usage).toMatchObject({ egressGb: 0.002628, requestsMillions: 2.628, logGbPerService: 0.002628, storageGb: 0, dbStorageGb: 0, interComponentFraction: 0 });
    expect(result?.utilization["service/web"]).toEqual({ cpuP95: 0.2, memoryP95: 0.2, sampleDays: 7 });
    expect(result?.constraints).toMatchObject({ residency: ["US"], budgetUsdMonthly: 1000 });
  });
  it("keeps backend provenance distinct from the resource's cloud provider", async () => {
    const { collector } = setup(result => {
      result.sources = ["prometheus"];
      result.telemetry!.provenance[0]!.source = "prometheus";
      result.telemetry!.provenance[0]!.provider = "prometheus";
    });
    expect((await collector.load(env, graph))?.measured.source).toContain("observability:prometheus");
  });
  it.each(["missing", "overlap", "truncated", "simulated", "stale", "foreign", "gap", "unit", "nonfinite", "future", "provenance", "signal"])("refuses %s telemetry", async reason => {
    const { collector } = setup(result => {
      if (reason === "missing") result.items.pop();
      if (reason === "overlap") result.items.push(result.items[0]!);
      if (reason === "truncated") result.truncated = true;
      if (reason === "simulated") result.simulated = true;
      if (reason === "stale") result.telemetry!.state = "stale";
      if (reason === "foreign") result.telemetry!.scope.workspaceId = "another-workspace";
      if (reason === "gap") result.items[0]!.points.splice(70, 5);
      if (reason === "unit") result.items[0]!.unit = "Count";
      if (reason === "nonfinite") result.items[0]!.points[0]!.value = NaN;
      if (reason === "future") result.items[0]!.points[0]!.timestamp = "2027-01-01T00:00:00Z";
      if (reason === "provenance") result.telemetry!.provenance = [];
      if (reason === "signal") result.telemetry!.signal = "log";
    });
    expect(await collector.load(env, graph)).toBeUndefined();
  });
  it("propagates cancellation and refuses an unrepresentable transfer fraction", async () => {
    const { collector, read } = setup();
    const controller = new AbortController(); controller.abort();
    await expect(collector.load(env, graph, controller.signal)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    const transfer = setup(r => { r.items.find(s => s.metric === "cost.inter_component.bytes")!.points.forEach(p => { p.value = 2; }); });
    expect(await transfer.collector.load(env, graph)).toBeUndefined();
  });
});
