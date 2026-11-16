/**
 * PROD-OPS-02: the exported dashboard and alert definitions under deploy/observability stay in lockstep
 * with the metric catalog and the runbook. A renamed metric, a dropped label or an alert without a
 * runbook heading fails here instead of leaving a panel silently empty.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { METRIC_CATALOG } from "@/lib/ops/telemetry/catalog";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
const dashboard = JSON.parse(read("deploy/observability/grafana/zenith-control-plane.dashboard.json")) as {
  uid: string; title: string; __inputs: { name: string }[];
  templating: { list: { name: string }[] };
  panels: { id: number; type: string; title: string; targets?: { expr: string }[] }[];
  annotations: { list: { expr: string }[] };
};
const rules = JSON.parse(read("deploy/observability/alerts/zenith-control-plane.rules.json")) as {
  groups: { name: string; rules: { alert: string; expr: string; for: string; labels: Record<string, string>; annotations: Record<string, string> }[] }[];
};
const collector = JSON.parse(read("deploy/observability/otel/collector.json")) as { service: { pipelines: Record<string, { receivers: string[]; exporters: string[] }> } };
const runbook = read("docs/platform/operations/CONTROL-PLANE-FAIRNESS.md");

const known = new Map(METRIC_CATALOG.map((m) => [m.name, m]));

function metricsIn(expr: string): string[] {
  return (expr.match(/zenith_[a-z_]+/g) ?? []).map((name) => {
    for (const suffix of ["_bucket", "_sum", "_count"]) {
      const base = name.slice(0, -suffix.length);
      if (name.endsWith(suffix) && known.get(base)?.type === "histogram") return base;
    }
    return name;
  });
}

/** label names used in matchers and aggregations of one expression, e.g. {tenant=~"x"} and `by (tenant, le)` */
function labelsIn(expr: string): string[] {
  const out = new Set<string>();
  for (const m of expr.matchAll(/\{([^}]*)\}/g)) for (const part of m[1].split(",")) { const name = /^\s*([a-z_]+)\s*(?:=|!=|=~|!~)/.exec(part)?.[1]; if (name) out.add(name); }
  for (const m of expr.matchAll(/\bby\s*\(([^)]*)\)/g)) for (const name of m[1].split(",")) if (name.trim()) out.add(name.trim());
  out.delete("le");
  return [...out];
}

describe("dashboard", () => {
  const exprs = dashboard.panels.flatMap((p) => (p.targets ?? []).map((t) => ({ panel: p.title, expr: t.expr })));

  it("is importable: a stable uid, a datasource input, unique panel ids and a tenant variable", () => {
    expect(dashboard.uid).toBe("zenith-control-plane");
    expect(dashboard.__inputs.map((i) => i.name)).toContain("DS_PROMETHEUS");
    const ids = dashboard.panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(dashboard.templating.list.map((v) => v.name)).toContain("tenant");
    expect(exprs.length).toBeGreaterThan(15);
  });

  it("queries only cataloged metrics, and only labels the catalog declares for that metric", () => {
    for (const { panel, expr } of [...exprs, ...dashboard.annotations.list.map((a) => ({ panel: "annotation", expr: a.expr }))]) {
      const metrics = metricsIn(expr);
      expect(metrics.length, `${panel}: ${expr}`).toBeGreaterThan(0);
      for (const name of metrics) expect(known.has(name), `${panel}: unknown metric ${name}`).toBe(true);
      // Every label named in a matcher or `by` clause must exist on at least one metric the expression reads.
      const allowed = new Set(metrics.flatMap((m) => [...(known.get(m)?.labels ?? [])]));
      for (const label of labelsIn(expr)) expect(allowed.has(label), `${panel}: label "${label}" is not on ${metrics.join(", ")}`).toBe(true);
    }
  });

  it("correlates by tenant: tenant-scoped panels filter on the $tenant variable", () => {
    const filtered = exprs.filter((e) => e.expr.includes('tenant=~"$tenant"'));
    expect(filtered.length).toBeGreaterThanOrEqual(6);
  });

  it("covers every layer the requirement names: API, fairness and backpressure, queues, worker scheduling, maintenance, telemetry health", () => {
    const joined = exprs.map((e) => e.expr).join("\n");
    for (const metric of ["zenith_api_requests_total", "zenith_admission_decisions_total", "zenith_dispatch_total", "zenith_runner_queue_depth", "zenith_active_operations", "zenith_worker_fair_waiting", "zenith_worker_activity_wait_seconds", "zenith_maintenance_mode", "zenith_control_store_up", "zenith_telemetry_dropped_total"])
      expect(joined, metric).toContain(metric);
  });
});

describe("alerts", () => {
  const all = rules.groups.flatMap((g) => g.rules);

  it("has the alerts the requirement implies, each with severity, a duration and a runbook", () => {
    const names = all.map((r) => r.alert);
    expect(new Set(names).size).toBe(names.length);
    for (const required of ["ZenithControlStoreDown", "ZenithMaintenanceLeftOn", "ZenithApiOverloaded", "ZenithTenantThrottled", "ZenithRunnerQueueNearCap", "ZenithWorkerFairLaneSaturated", "ZenithTelemetryExportFailing"])
      expect(names, required).toContain(required);
    for (const r of all) {
      expect(["critical", "warning", "info"], r.alert).toContain(r.labels.severity);
      expect(r.for, r.alert).toMatch(/^\d+[smh]$/);
      expect(r.annotations.summary.length, r.alert).toBeGreaterThan(10);
      expect(r.annotations.description.length, r.alert).toBeGreaterThan(20);
    }
  });

  it("references only cataloged metrics and declared labels", () => {
    for (const r of all) {
      const metrics = metricsIn(r.expr);
      expect(metrics.length, r.alert).toBeGreaterThan(0);
      for (const name of metrics) expect(known.has(name), `${r.alert}: unknown metric ${name}`).toBe(true);
      const allowed = new Set(metrics.flatMap((m) => [...(known.get(m)?.labels ?? [])]));
      for (const label of labelsIn(r.expr)) expect(allowed.has(label), `${r.alert}: label ${label}`).toBe(true);
    }
  });

  it("points every alert at a runbook heading that exists", () => {
    const headings = new Set([...runbook.matchAll(/^#{2,4}\s+(.+?)\s*$/gm)].map((m) => m[1].toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-")));
    for (const r of all) {
      const url = r.annotations.runbook_url;
      expect(url, r.alert).toMatch(/^docs\/platform\/operations\/CONTROL-PLANE-FAIRNESS\.md#[a-z0-9-]+$/);
      expect(headings.has(url.split("#")[1]), `${r.alert} -> ${url}`).toBe(true);
    }
  });

  it("is plain JSON Prometheus rule-group format (promtool accepts JSON as YAML)", () => {
    expect(rules.groups.every((g) => typeof g.name === "string" && g.rules.length > 0)).toBe(true);
  });
});

describe("collector", () => {
  it("receives OTLP and exports metrics and traces", () => {
    const p = collector.service.pipelines;
    expect(p.metrics.receivers).toContain("otlp");
    expect(p.traces.receivers).toContain("otlp");
    expect(p.metrics.exporters.length).toBeGreaterThan(0);
    expect(p.traces.exporters.length).toBeGreaterThan(0);
  });
});

describe("runbook", () => {
  it("documents the data-plane guarantee, maintenance semantics, backpressure answers and the knobs", () => {
    for (const heading of ["Data-plane guarantee", "Maintenance mode", "Backpressure", "Weighted-fair scheduling", "Configuration"])
      expect(runbook, heading).toContain(heading);
    for (const knob of ["ZENITH_OPS_API_RATE_PER_SEC", "ZENITH_OPS_MAX_ACTIVE_OPERATIONS", "ZENITH_OPS_RUNNER_QUEUE_MAX_PER_TENANT", "ZENITH_MAINTENANCE_MODE", "ZENITH_WORKER_FAIR_CAPACITY", "ZENITH_OPS_ADMIN_IDS", "ZENITH_OTEL_EXPORTER_OTLP_ENDPOINT"])
      expect(runbook, knob).toContain(knob);
  });
});
