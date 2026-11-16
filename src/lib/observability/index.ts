/**
 * Observability fabric barrel (spec §20, ADR-0011).
 *
 * Typical use, inside a credential-broker session:
 *
 *   await broker.withSession(req, async (session) => {
 *     const sources = sourcesForEnvironment({ provider, graph, sessions: { aws: session as AwsSession } });
 *     const fabric = createObservabilityFabric(sources);
 *     return fabric.searchLogs({ scope, range, text: "timeout" }, signal);
 *   });
 */
export * from "./types";
export { createObservabilityFabric, DEFAULT_SOURCE_TIMEOUT_MS, type FabricOptions } from "./fabric";
export {
  ObservabilityInputError,
  normalizeRange,
  validateLogQuery,
  validateMetricQuery,
  validateEventQuery,
  validateTraceQuery,
  LOG_LIMIT_DEFAULT,
  LOG_LIMIT_MAX,
  EVENT_LIMIT_DEFAULT,
  EVENT_LIMIT_MAX,
  TRACE_LIMIT_DEFAULT,
  TRACE_LIMIT_MAX,
  METRICS_PER_QUERY_MAX,
  SERIES_PER_QUERY_MAX,
  MAX_RANGE_MS,
} from "./query";
export { redactText, sanitizeLog, sanitizeEvent, sanitizeMessage, sanitizeReason, REDACTED, MAX_MESSAGE_BYTES } from "./redact";
export { SOURCE_EVIDENCE, type SourceEvidence } from "./evidence";
export { resourceHealth, resourceHealthWithTelemetry, describeHealthTelemetry, HEALTH_KINDS, type HealthDeps, type HealthTelemetry } from "./health";
export * from "./telemetry";
export { sourcesForEnvironment, sandboxSourceOf, cloudWatchLogsSourceOf, KNOWN_SOURCE_IDS, type SourcesForEnvironmentInput, type SourceEndpoints, type SourceSessions } from "./sources/factory";
export { createSandboxSource, type SandboxSource, type SandboxDeps } from "./sources/sandbox";
export { createCloudWatchLogsSource, type CloudWatchLogsSource, type CloudWatchLogsConfig } from "./sources/aws-cloudwatch-logs";
export { createCloudWatchMetricsSource, AWS_METRIC_TABLE, type AwsMetricDef } from "./sources/aws-cloudwatch-metrics";
export { createAwsEventsSource } from "./sources/aws-events";
export { createPrometheusSource, DEFAULT_PROMETHEUS_METRICS, type PrometheusConfig, type PromMetricDef } from "./sources/prometheus";
export { createLokiSource, type LokiConfig } from "./sources/loki";
export { createKubernetesSource, type KubernetesSourceConfig, type KubernetesCoreApi } from "./sources/kubernetes";
export { createUnavailableSource } from "./sources/unavailable";
export { createOciLoggingSource, OCI_LOGGING_SOURCE_ID } from "./sources/oci-logging";
export { createOciMonitoringSource, OCI_MONITORING_SOURCE_ID } from "./sources/oci-monitoring";
export type { FetchLike, TokenProvider } from "./sources/http";
