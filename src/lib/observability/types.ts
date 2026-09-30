/**
 * Observability fabric contract (spec §20, ADR-0011).
 *
 * Federated querying: Zenith asks each provider's native backend (CloudWatch,
 * Cloud Logging, Azure Monitor, Kubernetes, Prometheus, Loki, journald via
 * zenithd) at query time and normalizes the answer. It does not ingest.
 *
 * Normalization never pretends signals are equivalent: every record keeps a
 * bounded `native` bag with the provider's own fields, and `source` says
 * exactly which backend answered. Log and event text is untrusted data — it is
 * returned as data, redacted for secret patterns as defense in depth, and
 * never interpreted as instructions.
 */

export type SignalType = "log" | "metric" | "trace" | "event" | "health";
export type Severity = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "unknown";

export interface SignalScope {
  workspaceId: string;
  projectId?: string;
  environmentId: string;
  /** resource addresses to restrict to; empty = whole environment */
  addresses?: string[];
}

export interface TimeRange {
  /** ISO timestamps; `to` defaults to now */
  from: string;
  to?: string;
}

export interface NormalizedLog {
  timestamp: string;
  address?: string;
  provider: string;
  environmentId: string;
  severity: Severity;
  message: string;
  traceId?: string;
  spanId?: string;
  attributes: Record<string, string | number | boolean>;
  /** bounded provider-native fields (log stream, task id, pod, …) */
  native: Record<string, unknown>;
}

export interface LogQuery {
  scope: SignalScope;
  range: TimeRange;
  /** plain substring or provider-neutral filter; never passed raw into a query language */
  text?: string;
  minSeverity?: Severity;
  /** hard-capped by the fabric (default 200, max 1000) */
  limit?: number;
}

export interface MetricPoint {
  timestamp: string;
  value: number;
}

export interface MetricSeries {
  /** portable metric name, e.g. `cpu.utilization`, `http.5xx.rate`, `db.connections` */
  metric: string;
  unit: string;
  address?: string;
  provider: string;
  /** provider-native metric identity (namespace/name/dimensions) */
  native: Record<string, unknown>;
  points: MetricPoint[];
}

export interface MetricQuery {
  scope: SignalScope;
  range: TimeRange;
  metrics: string[];
  /** seconds */
  stepSec?: number;
}

export interface NormalizedEvent {
  timestamp: string;
  address?: string;
  provider: string;
  environmentId: string;
  severity: Severity;
  /** e.g. `ecs.service.steady_state`, `k8s.pod.backoff`, `deployment.rollout` */
  type: string;
  message: string;
  native: Record<string, unknown>;
}

export interface EventQuery {
  scope: SignalScope;
  range: TimeRange;
  limit?: number;
}

export interface TraceSpanSummary {
  traceId: string;
  rootName: string;
  durationMs: number;
  status: "ok" | "error" | "unknown";
  startedAt: string;
  native: Record<string, unknown>;
}

export interface QueryResult<T> {
  items: T[];
  /** which backend(s) answered, e.g. `aws.cloudwatch-logs` */
  sources: string[];
  truncated: boolean;
  simulated: boolean;
  /** backends that could not be queried and why — partial answers are labeled */
  unavailable: { source: string; reason: string }[];
  /**
   * Additive (WS-OBS): coverage caveats that do not make a backend unavailable,
   * e.g. "searched back to 2026-09-30T10:00:00Z only (page budget reached)".
   * Absent when there is nothing to say.
   */
  notes?: string[];
}

export interface ObservabilitySource {
  id: string;
  provider: string;
  supports: SignalType[];
  /**
   * Additive (WS-OBS): can this source answer anything for this scope? The
   * fabric only calls sources that return true. Absent = covers every scope.
   * Must be a cheap, synchronous, side-effect-free check (it inspects the
   * source's own view of the resource graph, never the network).
   */
  covers?(scope: SignalScope): boolean;
  searchLogs?(q: LogQuery, signal: AbortSignal): Promise<QueryResult<NormalizedLog>>;
  queryMetrics?(q: MetricQuery, signal: AbortSignal): Promise<QueryResult<MetricSeries>>;
  searchEvents?(q: EventQuery, signal: AbortSignal): Promise<QueryResult<NormalizedEvent>>;
  searchTraces?(q: { scope: SignalScope; range: TimeRange; limit?: number }, signal: AbortSignal): Promise<QueryResult<TraceSpanSummary>>;
}

/**
 * Additive (WS-OBS): the federated query surface. Every method validates its
 * input (throws `ObservabilityInputError` for a malformed query), fans out to
 * the sources that support the signal and cover the scope, and returns a
 * merged, bounded, redacted answer in which a slow or failing source is an
 * `unavailable` entry — never an exception. Only a caller-initiated abort
 * rejects (with the signal's reason), because then nobody wants the answer.
 */
export interface ObservabilityFabric {
  searchLogs(q: LogQuery, signal?: AbortSignal): Promise<QueryResult<NormalizedLog>>;
  queryMetrics(q: MetricQuery, signal?: AbortSignal): Promise<QueryResult<MetricSeries>>;
  searchEvents(q: EventQuery, signal?: AbortSignal): Promise<QueryResult<NormalizedEvent>>;
  searchTraces(q: { scope: SignalScope; range: TimeRange; limit?: number }, signal?: AbortSignal): Promise<QueryResult<TraceSpanSummary>>;
}
