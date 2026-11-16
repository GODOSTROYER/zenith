/**
 * Prometheus metrics source (`prometheus`): HTTP API `/api/v1/query_range`.
 *
 * Evidence level: `contract` — exercised only against a local fake HTTP
 * server implementing the response shape. Never run against a real
 * Prometheus.
 *
 * Injection safety: every PromQL expression is a fixed template from
 * `DEFAULT_PROMETHEUS_METRICS` (or operator configuration) with exactly one
 * substitution — the label matchers — and each matcher is `name="value"` where
 * the name is sanitized to the PromQL identifier grammar and the value is
 * escaped as a string literal (`escape.ts`). Query text from callers never
 * reaches PromQL (metric queries carry no free text at all); metric names not
 * in the table are `unavailable`, not passed through.
 *
 * The default templates encode common conventions (cAdvisor / kube-state-
 * metrics / `http_requests_total`) and assume the selected labels exist on
 * those series. Real clusters differ, which is why `metrics` and `labelMap`
 * are configuration. Units differ from CloudWatch for the same portable name
 * (`http.requests` is requests/second here, a per-period Count there) and each
 * series states its own unit — the fabric does not pretend they are equal.
 *
 * Templates use `{{matchers}}` (comma-joined equality matchers) and `{{window}}`
 * (a range-vector duration derived from the step, at least 5 minutes).
 */
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";
import { throwIfAborted } from "../abort";
import { joinMatchers, matchersFrom } from "../escape";
import { errorMessage, isRecord } from "../normalize";
import { SERIES_PER_QUERY_MAX } from "../query";
import { sanitizeNative, sanitizeReason } from "../redact";
import type { MetricPoint, MetricQuery, MetricSeries, ObservabilitySource, QueryResult } from "../types";
import { getJson, normalizeBaseUrl, type HttpEndpointConfig } from "./http";
import { DEFAULT_LABEL_MAP, selectorLabelsFor, type LabelMap } from "./labels";
import { bindingOf, coversScope, nodesInScope, sameEnvironment, type EnvironmentBinding } from "./scope";
import { mapPool } from "./util";
import { COST_PROMETHEUS_METRICS } from "@/lib/cost/optimizer/measurement-collector";

export const PROMETHEUS_SOURCE_ID = "prometheus";

export interface PromMetricDef {
  /** PromQL template; `{{matchers}}` and `{{window}}` are the only substitutions */
  expr: string;
  unit: string;
}

export const DEFAULT_PROMETHEUS_METRICS: Readonly<Record<string, PromMetricDef>> = {
  "cpu.utilization": {
    expr: 'sum(rate(container_cpu_usage_seconds_total{{{matchers}}}[{{window}}])) / sum(kube_pod_container_resource_limits{resource="cpu",{{matchers}}}) * 100',
    unit: "Percent",
  },
  "memory.utilization": {
    expr: 'sum(container_memory_working_set_bytes{{{matchers}}}) / sum(kube_pod_container_resource_limits{resource="memory",{{matchers}}}) * 100',
    unit: "Percent",
  },
  "http.requests": { expr: "sum(rate(http_requests_total{{{matchers}}}[{{window}}]))", unit: "Requests/Second" },
  "http.5xx.count": { expr: 'sum(increase(http_requests_total{code=~"5..",{{matchers}}}[{{window}}]))', unit: "Count" },
  "http.target_response_time": {
    expr: "histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{{{matchers}}}[{{window}}])))",
    unit: "Seconds",
  },
};

export interface PrometheusConfig extends HttpEndpointConfig {
  /** Fixed tenant/resource boundary meters; requires workspace binding and fresh producer reports. */
  costUsage?: boolean;
  graph: ResourceGraph;
  workspaceId?: string;
  /** graph label key → Prometheus label name; default `DEFAULT_LABEL_MAP` */
  labelMap?: LabelMap;
  /** overrides/additions to `DEFAULT_PROMETHEUS_METRICS`, keyed by portable metric name */
  metrics?: Record<string, PromMetricDef>;
}

const PROM_KINDS = new Set<string>(["container_service", "kubernetes_namespace"]);
const COST_KINDS = new Set<string>([...PROM_KINDS, "postgres", "mysql", "object_store"]);
/** Prometheus itself caps a range query at 11,000 points; the fabric re-bounds and flags anything above its own limit. */
const MAX_POINTS = 11_000;

export function createPrometheusSource(config: PrometheusConfig): ObservabilitySource {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const http = { ...config, baseUrl };
  const binding: EnvironmentBinding = bindingOf(config.graph, config.workspaceId);
  const labelMap = config.labelMap ?? DEFAULT_LABEL_MAP;
  const costUtilization = {
    "cpu.utilization": { expr: "max(zenith_cost_cpu_percent{{{matchers}}})", unit: "Percent" },
    "memory.utilization": { expr: "max(zenith_cost_memory_percent{{{matchers}}})", unit: "Percent" },
    "http.requests": { expr: "sum(rate(zenith_cost_requests_total{{{matchers}}}[{{window}}]))", unit: "Requests/Second" },
  };
  const table: Record<string, PromMetricDef> = { ...DEFAULT_PROMETHEUS_METRICS, ...COST_PROMETHEUS_METRICS, ...(config.costUsage ? costUtilization : {}), ...config.metrics };
  const isPromNode = (n: ResourceNode) => (config.costUsage ? COST_KINDS : PROM_KINDS).has(n.kind);

  return {
    id: PROMETHEUS_SOURCE_ID,
    provider: "prometheus",
    supports: ["metric"],
    covers: (scope) => coversScope(binding, config.graph, scope, isPromNode),

    async queryMetrics(q: MetricQuery, signal: AbortSignal): Promise<QueryResult<MetricSeries>> {
      const result: QueryResult<MetricSeries> = { items: [], sources: [], truncated: false, simulated: false, unavailable: [] };
      if (!sameEnvironment(binding, q.scope)) return result;
      const fail = (reason: string) => result.unavailable.push({ source: PROMETHEUS_SOURCE_ID, reason: sanitizeReason(reason) });
      if (config.costUsage && !config.workspaceId) { fail("Cost usage requires a workspace binding."); return result; }
      const from = Date.parse(q.range.from);
      const to = q.range.to === undefined ? Date.now() : Date.parse(q.range.to);
      const step = Math.max(1, Math.floor(q.stepSec ?? Math.max(60, Math.ceil((to - from) / 1000 / 120))));
      const window = `${Math.max(300, step)}s`;

      interface Planned {
        metric: string;
        def: PromMetricDef;
        node: ResourceNode;
        expr: string;
      }
      const planned: Planned[] = [];
      const nodes = nodesInScope(config.graph, q.scope, isPromNode);
      for (const metric of q.metrics) {
        const def = table[metric];
        if (!Object.hasOwn(table, metric) || !def) {
          fail(`metric "${metric}" is not mapped for Prometheus (known: ${Object.keys(table).join(", ")})`);
          continue;
        }
        for (const node of nodes) {
          const scopedUsage = config.costUsage || metric.startsWith("cost.");
          if (scopedUsage && !config.workspaceId) { fail("Cost usage requires a workspace binding."); continue; }
          const labels = scopedUsage ? { zenith_workspace_id: config.workspaceId!, zenith_environment_id: config.graph.environmentId, zenith_resource_address: node.address } : selectorLabelsFor(node, labelMap);
          const selector = joinMatchersBare(matchersFrom(labels));
          if (selector === undefined) {
            fail(`metric "${metric}": ${node.address} has no labels usable as a Prometheus selector`);
            continue;
          }
          const expr = def.expr.replaceAll("{{matchers}}", () => selector).replaceAll("{{window}}", () => window);
          // Query-time heartbeat makes gaps visible even while the HTTP scrape remains healthy.
          const freshness = ` and on() ((time() - max(zenith_cost_usage_observed_at_seconds{${selector}})) < 90) and on() (count(zenith_cost_usage_observed_at_seconds{${selector}}) == 1)`;
          planned.push({ metric, def, node, expr: scopedUsage ? `(${expr})${freshness}` : expr });
        }
      }
      if (planned.length > SERIES_PER_QUERY_MAX) {
        result.truncated = true;
        planned.length = SERIES_PER_QUERY_MAX;
      }

      const outcomes = await mapPool(planned, 4, signal, async (p) => {
        try {
          const params = new URLSearchParams({ query: p.expr, start: String(from / 1000), end: String(to / 1000), step: String(step) });
          return { p, data: await getJson(http, "/api/v1/query_range", params, signal) };
        } catch (err) {
          throwIfAborted(signal);
          return { p, error: errorMessage(err) };
        }
      });

      for (const o of outcomes) {
        if ("error" in o) {
          fail(`metric "${o.p.metric}" for ${o.p.node.address}: ${o.error}`);
          continue;
        }
        const parsed = parseMatrix(o.data);
        if (!parsed.ok) {
          fail(`metric "${o.p.metric}" for ${o.p.node.address}: ${parsed.reason}`);
          continue;
        }
        if (!result.sources.includes(PROMETHEUS_SOURCE_ID)) result.sources.push(PROMETHEUS_SOURCE_ID);
        for (const s of parsed.series) {
          result.items.push({
            metric: o.p.metric,
            unit: o.p.def.unit,
            address: o.p.node.address,
            provider: o.p.node.provider,
            native: sanitizeNative({ backend: "prometheus", expr: o.p.expr, step, labels: s.labels, datapoints: s.points.length }).value,
            points: s.points,
          });
        }
      }
      if (result.items.length > SERIES_PER_QUERY_MAX) {
        result.items.length = SERIES_PER_QUERY_MAX;
        result.truncated = true;
      }
      return result;
    },
  };
}

/** The matchers without braces, for splicing into a template that supplies its own `{}`. */
function joinMatchersBare(matchers: string[]): string | undefined {
  const braced = joinMatchers(matchers);
  return braced === undefined ? undefined : braced.slice(1, -1);
}

interface Matrix {
  labels: Record<string, string>;
  points: MetricPoint[];
}

/** Parse a `/api/v1/query_range` response; non-finite samples (`NaN`, `+Inf`) are dropped, not coerced. */
export function parseMatrix(body: unknown): { ok: true; series: Matrix[] } | { ok: false; reason: string } {
  if (!isRecord(body)) return { ok: false, reason: "response was not an object" };
  if (body.status !== "success") {
    const kind = typeof body.errorType === "string" ? `${body.errorType}: ` : "";
    return { ok: false, reason: `${kind}${typeof body.error === "string" ? body.error : "query failed"}` };
  }
  const data = body.data;
  if (!isRecord(data) || data.resultType !== "matrix" || !Array.isArray(data.result)) return { ok: false, reason: "unexpected result shape (expected a matrix)" };
  const series: Matrix[] = [];
  for (const r of data.result) {
    if (!isRecord(r) || !Array.isArray(r.values)) continue;
    const labels: Record<string, string> = {};
    if (isRecord(r.metric)) for (const [k, v] of Object.entries(r.metric).slice(0, 30)) if (typeof v === "string") labels[k] = v;
    const points: MetricPoint[] = [];
    for (const pair of r.values.slice(0, MAX_POINTS)) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const t = Number(pair[0]);
      const v = Number(pair[1]);
      if (Number.isFinite(t) && Number.isFinite(v)) points.push({ timestamp: new Date(t * 1000).toISOString(), value: v });
    }
    series.push({ labels, points });
  }
  return { ok: true, series };
}
