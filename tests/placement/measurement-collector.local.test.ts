/** Actual local Prometheus reads, deliberately gated. Never backdate synthetic samples. */
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import { createPrometheusSource } from "@/lib/observability/sources/prometheus";
import { createObservabilityFabric } from "@/lib/observability/fabric";
import { COST_PROMETHEUS_METRICS, createMeasurementCollector } from "@/lib/cost/optimizer/measurement-collector";
import { optimizeEconomics } from "@/lib/placement/optimizer";
import { createOptimizerOwnership } from "@/lib/cost/optimizer/optimizer-ownership";
import { loadDefaultCatalog } from "@/lib/placement/pricebook";
import { openPlatformDb } from "@/lib/controlplane/db";
import type { ResourceGraph } from "@/lib/resources/types";
import type { ReconcileEnvironment } from "@/lib/reconcile/types";
import { RecommendConstraints } from "@/lib/placement/recommend";

const enabled = process.env.ZENITH_TEST_COST_COLLECTOR === "1";
describe.skipIf(!enabled)("actual local measured optimization (needs local Prometheus, PostgreSQL and seven days of real samples)", () => {
  it("reads real scoped measurements and produces a bounded proposal with current approved field ownership", async () => {
    const endpoint = new URL(process.env.ZENITH_TEST_COST_PROMETHEUS_URL ?? "");
    expect(["localhost", "127.0.0.1", "[::1]"]).toContain(endpoint.hostname);
    const file = process.env.ZENITH_TEST_COST_GRAPH_FILE ?? "";
    const constraintsFile = process.env.ZENITH_TEST_COST_CONSTRAINTS_FILE ?? "";
    expect(isAbsolute(file) && isAbsolute(constraintsFile)).toBe(true);
    const graph = JSON.parse(readFileSync(file, "utf8")) as ResourceGraph;
    const workspaceId = process.env.ZENITH_TEST_COST_WORKSPACE_ID ?? "";
    const projectId = process.env.ZENITH_TEST_COST_PROJECT_ID ?? "";
    expect(workspaceId.length > 0 && projectId.length > 0 && graph.environmentId.length > 0).toBe(true);
    const first = graph.nodes.find(n => n.kind === "container_service" && n.ownership === "managed")!;
    expect(first).toBeDefined();
    const environment: ReconcileEnvironment = { workspaceId, projectId, environmentId: graph.environmentId, class: "production", provider: first.provider, region: first.region };
    const fabric = createObservabilityFabric([createPrometheusSource({ baseUrl: endpoint.href, graph, workspaceId, metrics: { ...COST_PROMETHEUS_METRICS } })]);
    const collector = createMeasurementCollector({ now: () => new Date(), read: (_env, _graph, query, signal) => fabric.queryMetrics(query, signal), constraints: async () => {
      const parsed = RecommendConstraints.parse(JSON.parse(readFileSync(constraintsFile, "utf8")));
      return { ...parsed, userRegions: parsed.userRegions ?? [] };
    } });
    const measurements = await collector.load(environment, graph);
    expect(measurements, "needs seven days of actual complete meters, including explicit zero series").toBeDefined();
    const url = process.env.ZENITH_TEST_PLATFORM_PG_URL ?? "";
    expect(url).not.toBe("");
    const db = await openPlatformDb({ kind: "postgres", url, migrate: false, max: 1 });
    try {
      const run = await optimizeEconomics({ graph, catalog: loadDefaultCatalog(), ...measurements!,
        ownership: createOptimizerOwnership(db, environment, () => new Date()), routableOnly: true, now: new Date().toISOString() });
      expect(run.proposals.length, "use an actually underutilized owned service with its exact approved native-op transfer").toBeGreaterThan(0);
      expect(run.proposals.length).toBeLessThanOrEqual(run.policy.maxChangesPerWindow);
      expect(run.proposals.every(p => p.savings.label === "estimate" && p.savings.monthlyUsd >= run.policy.minMonthlySavingsUsd)).toBe(true);
      // No proposal submission, approval, execution or provider mutation occurs in this harness.
    } finally { await db.close(); }
  }, 60_000);
});
