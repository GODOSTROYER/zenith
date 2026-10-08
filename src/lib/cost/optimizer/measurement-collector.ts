import type { MetricQuery, MetricSeries, QueryResult } from "@/lib/observability/types";
import type { PromMetricDef } from "@/lib/observability/sources/prometheus";
import type { OptimizerMeasurementPort } from "@/lib/platform/optimizer-pass";
import type { ReconcileEnvironment } from "@/lib/reconcile/types";
import type { ResourceGraph } from "@/lib/resources/types";
import type { PlacementConstraints } from "@/lib/placement/types";

const DAY = 86_400_000;
const STEP_SEC = 3600;
const WINDOW_DAYS = 7;
const MONTH_SEC = 730 * 3600;

/** Explicit usage meters. Exporters must meter these boundaries, never total pod traffic. */
export const COST_PROMETHEUS_METRICS: Readonly<Record<string, PromMetricDef>> = {
  "cost.internet_egress.bytes": { expr: "sum(rate(zenith_cost_internet_egress_bytes_total{{{matchers}}}[{{window}}]))", unit: "Bytes/Second" },
  "cost.inter_component.bytes": { expr: "sum(rate(zenith_cost_inter_component_bytes_total{{{matchers}}}[{{window}}]))", unit: "Bytes/Second" },
  "cost.log_ingest.bytes": { expr: "sum(rate(zenith_cost_log_ingest_bytes_total{{{matchers}}}[{{window}}]))", unit: "Bytes/Second" },
  "cost.object_storage.bytes": { expr: "sum(zenith_cost_object_storage_bytes{{{matchers}}})", unit: "Bytes" },
  "cost.db_storage.bytes": { expr: "sum(zenith_cost_db_storage_bytes{{{matchers}}})", unit: "Bytes" },
};

export interface MeasurementCollectorDeps {
  /** Must use the existing scoped observe grant and credential-broker session. */
  read(environment: ReconcileEnvironment, graph: ResourceGraph, query: MetricQuery, signal?: AbortSignal): Promise<QueryResult<MetricSeries>>;
  /** Constraints from the applied revision, never a model's suggestion. */
  constraints(environment: ReconcileEnvironment): Promise<PlacementConstraints>;
  now(): Date;
}

function samples(series: MetricSeries, from: number, to: number, stepMs: number): number[] | undefined {
  if (series.points.length < WINDOW_DAYS * 24) return undefined;
  const points = [...series.points].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  let previous = from - stepMs;
  for (const point of points) {
    const at = Date.parse(point.timestamp);
    if (!Number.isFinite(at) || at < from || at > to || at <= previous || at - previous > stepMs * 1.5 || !Number.isFinite(point.value) || point.value < 0) return undefined;
    previous = at;
  }
  if (to - previous > stepMs) return undefined;
  return points.map(p => p.value);
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;

/** Seven days of complete, fresh, scoped samples; any missing meter refuses the baseline. */
export function createMeasurementCollector(deps: MeasurementCollectorDeps): OptimizerMeasurementPort {
  return { async load(environment, graph, signal) {
    signal?.throwIfAborted();
    const to = Math.floor(deps.now().getTime() / 1000) * 1000;
    const from = to - WINDOW_DAYS * DAY;
    if (!Number.isFinite(to) || graph.environmentId !== environment.environmentId) return undefined;
    const compute = graph.nodes.filter(n => n.ownership === "managed" && n.kind === "container_service");
    if (!compute.length) return undefined;
    // Other managed compute cannot be sized by service.scale; their usage must not be silently omitted.
    if (graph.nodes.some(n => n.ownership === "managed" && ["compute_instance", "scheduled_job"].includes(n.kind))) return undefined;
    const usage = { egressGb: 0, requestsMillions: 0, storageGb: 0, dbStorageGb: 0, logGbPerService: 0, interComponentFraction: 0 };
    let interBytes = 0;
    const utilization: Record<string, { cpuP95: number; memoryP95: number; sampleDays: number }> = {};
    const sources = new Set<string>();
    for (const node of graph.nodes.filter(n => n.ownership === "managed")) {
      const metrics = node.kind === "container_service" ? ["cpu.utilization", "memory.utilization", "http.requests", "cost.internet_egress.bytes", "cost.inter_component.bytes", "cost.log_ingest.bytes"]
        : node.kind === "object_store" ? ["cost.object_storage.bytes"] : ["postgres", "mysql"].includes(node.kind) ? ["cost.db_storage.bytes"] : [];
      if (!metrics.length) continue;
      const query: MetricQuery = { scope: { workspaceId: environment.workspaceId, environmentId: environment.environmentId, ...(environment.projectId ? { projectId: environment.projectId } : {}), addresses: [node.address] },
        range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() }, metrics, stepSec: STEP_SEC };
      const result = await deps.read(environment, graph, query, signal);
      signal?.throwIfAborted();
      const readAt = deps.now().getTime();
      const envelope = result.telemetry;
      if (result.simulated || result.truncated || result.unavailable.length || !result.sources.length || !envelope || envelope.partial || envelope.state !== "fresh" || envelope.schemaVersion !== 1 || envelope.signal !== "metric"
        || envelope.scope.workspaceId !== environment.workspaceId || envelope.scope.environmentId !== environment.environmentId
        || envelope.scope.addresses?.length !== 1 || envelope.scope.addresses?.[0] !== node.address
        || !Number.isFinite(Date.parse(envelope.observedAt)) || readAt - Date.parse(envelope.observedAt) > STEP_SEC * 1000 || Date.parse(envelope.observedAt) > readAt
        || !envelope.provenance.length || result.sources.some(source => !envelope.provenance.some(p => p.source === source && !p.simulated && p.state === "fresh"))) return undefined;
      const values = new Map<string, number[]>();
      for (const metric of metrics) {
        const matches = result.items.filter(s => s.metric === metric && s.address === node.address && s.provider === node.provider);
        if (matches.length !== 1) return undefined; // overlapping backends or replica series need explicit aggregation at the source
        const series = matches[0]!;
        const numbers = samples(series, from, to, STEP_SEC * 1000);
        const expectedUnit = metric.endsWith("utilization") ? "Percent" : metric === "http.requests" ? "Requests/Second" : metric.endsWith("storage.bytes") ? "Bytes" : "Bytes/Second";
        if (!numbers || series.unit !== expectedUnit) return undefined;
        values.set(metric, numbers);
      }
      for (const source of result.sources) sources.add(source);
      const average = (metric: string) => mean(values.get(metric)!);
      if (node.kind === "container_service") {
        const cpuP95 = p95(values.get("cpu.utilization")!) / 100;
        const memoryP95 = p95(values.get("memory.utilization")!) / 100;
        if (cpuP95 > 1 || memoryP95 > 1) return undefined;
        utilization[node.address] = { cpuP95, memoryP95, sampleDays: WINDOW_DAYS };
        usage.egressGb += average("cost.internet_egress.bytes") * MONTH_SEC / 1e9;
        interBytes += average("cost.inter_component.bytes") * MONTH_SEC;
        usage.requestsMillions += average("http.requests") * MONTH_SEC / 1e6;
        usage.logGbPerService += average("cost.log_ingest.bytes") * MONTH_SEC / 1e9 / compute.length;
      } else if (node.kind === "object_store") usage.storageGb = Math.max(usage.storageGb, average("cost.object_storage.bytes") / 1e9);
      else usage.dbStorageGb = Math.max(usage.dbStorageGb, average("cost.db_storage.bytes") / 1e9);
    }
    if (interBytes > usage.egressGb * 1e9) return undefined; // the existing fraction model cannot represent this measurement
    usage.interComponentFraction = usage.egressGb > 0 ? interBytes / (usage.egressGb * 1e9) : 0;
    const constraints = await deps.constraints(environment);
    return { measured: { usage, windowDays: WINDOW_DAYS, observedAt: new Date(to).toISOString(), source: `observability:${[...sources].sort().join(",")};7d monthly-equivalent rates` }, utilization, constraints };
  } };
}
