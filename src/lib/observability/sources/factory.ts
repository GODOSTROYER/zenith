/**
 * `sourcesForEnvironment`: choose the observability sources for one
 * environment.
 *
 * Selection is by the environment's provider, plus optional Prometheus/Loki
 * endpoints (which can federate any provider's cluster):
 *
 *   sandbox            → `sandbox.logsim` (simulated)
 *   aws | localstack   → `aws.cloudwatch-logs`, `aws.cloudwatch-metrics`, `aws.events`
 *   kubernetes         → `kubernetes` (pod logs and events)
 *   gcp / azure        → Cloud Logging/Monitoring / Log Analytics/Monitor
 *   zenith             → tenant namespace pod logs and events (Kubernetes session)
 *   oci                → explicit gaps: runner lacks Logging Search/Monitoring
 *   endpoints.prometheus → `prometheus`;  endpoints.loki → `loki`
 *
 * A provider whose prerequisite is missing (no AWS session, no kube session)
 * gets an explicit `unavailable` source per would-be source, so a query
 * answers "cannot read AWS logs: no credential-broker session" rather than an
 * unexplained empty list.
 *
 * Sessions are injected and short-lived: build the sources, run the queries
 * and let go of them inside the credential broker's `withSession` callback.
 *
 * Prometheus/Loki endpoints are platform configuration, never a query or tool
 * argument. They are validated (http(s), no embedded credentials, not a cloud
 * metadata host) but private addresses are legitimately allowed, so if tenants
 * ever supply endpoints the caller must apply its own SSRF policy first.
 */
import type { AwsSession, AzureSession, GcpSession, KubernetesSession } from "@/lib/credentials/types";
import type { Observation, ProviderKey, ResourceGraph } from "@/lib/resources/types";
import { createGcpObservabilitySource, SOURCE_ID as GCP_SOURCE_ID } from "@/lib/providers/gcp/observability";
import { createAzureLogsSource, createAzureMetricsSource, AZURE_LOGS_SOURCE_ID, AZURE_METRICS_SOURCE_ID } from "@/lib/providers/azure/observability";
import type { OciSession } from "@/lib/providers/oci/transport";
import { sessionNamespaces } from "@/lib/providers/kubernetes/session";
import { tenantNamespace } from "@/lib/providers/zenith/tenancy";
import type { ObservabilitySource } from "../types";
import { createAwsEventsSource } from "./aws-events";
import { createCloudWatchLogsSource, CLOUDWATCH_LOGS_SOURCE_ID, type CloudWatchLogsLimits, type CloudWatchLogsSource } from "./aws-cloudwatch-logs";
import { createCloudWatchMetricsSource, CLOUDWATCH_METRICS_SOURCE_ID } from "./aws-cloudwatch-metrics";
import { AWS_EVENTS_SOURCE_ID } from "./aws-events";
import { createKubernetesSource, KUBERNETES_SOURCE_ID, type KubernetesCoreApi } from "./kubernetes";
import { createLokiSource, LOKI_SOURCE_ID, type LokiConfig } from "./loki";
import { createPrometheusSource, PROMETHEUS_SOURCE_ID, type PrometheusConfig } from "./prometheus";
import { createSandboxSource, SANDBOX_SOURCE_ID, type SandboxDeps, type SandboxSource } from "./sandbox";
import { createUnavailableSource } from "./unavailable";
import { createOciLoggingSource, OCI_LOGGING_SOURCE_ID } from "./oci-logging";
import { createOciMonitoringSource, OCI_MONITORING_SOURCE_ID } from "./oci-monitoring";
import { bindSource, kubernetesSignalGraph, scopedKubernetesApi } from "./provider-scope";

export type PrometheusEndpoint = Omit<PrometheusConfig, "graph" | "workspaceId">;
export type LokiEndpoint = Omit<LokiConfig, "graph" | "workspaceId">;

export interface SourceEndpoints {
  prometheus?: PrometheusEndpoint;
  loki?: LokiEndpoint;
}

export interface SourceSessions {
  aws?: AwsSession;
  kubernetes?: KubernetesSession;
  gcp?: GcpSession;
  azure?: AzureSession;
  oci?: OciSession;
}

export interface SourcesForEnvironmentInput {
  provider: ProviderKey;
  graph: ResourceGraph;
  /** when given, scopes for any other workspace are refused by every source */
  workspaceId?: string;
  sessions: SourceSessions;
  endpoints?: SourceEndpoints;
  /** latest driver observations — the preferred source of native identifiers */
  observations?: readonly Observation[];
  /** connection's allowed namespaces (Kubernetes) */
  kubernetes?: { allowedNamespaces?: readonly string[]; api?: (kubeConfig: unknown) => KubernetesCoreApi | Promise<KubernetesCoreApi> };
  cloudwatchLogs?: { limits?: Partial<CloudWatchLogsLimits> };
  /** dependency injection for the sandbox source (tests); default: lazily loaded logsim */
  sandbox?: SandboxDeps;
}

/** The sandbox source, typed so callers can also use its `health()`. */
export function sandboxSourceOf(sources: readonly ObservabilitySource[]): SandboxSource | undefined {
  return sources.find((s): s is SandboxSource => s.id === SANDBOX_SOURCE_ID && typeof (s as Partial<SandboxSource>).health === "function");
}

/** The CloudWatch Logs source, typed so callers can also use its Logs Insights `aggregate()`. */
export function cloudWatchLogsSourceOf(sources: readonly ObservabilitySource[]): CloudWatchLogsSource | undefined {
  return sources.find((s): s is CloudWatchLogsSource => s.id === CLOUDWATCH_LOGS_SOURCE_ID && typeof (s as Partial<CloudWatchLogsSource>).aggregate === "function");
}

export function sourcesForEnvironment(input: SourcesForEnvironmentInput): ObservabilitySource[] {
  const { provider, graph, sessions, workspaceId } = input;
  const base = workspaceId === undefined ? { graph } : { graph, workspaceId };
  const sources: ObservabilitySource[] = [];

  switch (provider) {
    case "sandbox":
      sources.push(createSandboxSource({ ...base, ...(input.sandbox ? { deps: input.sandbox } : {}) }));
      break;

    case "aws":
    case "localstack": {
      const session = sessions.aws;
      if (!session) {
        const reason = `no AWS session: reading ${provider} signals needs a credential-broker session`;
        sources.push(
          createUnavailableSource({ id: CLOUDWATCH_LOGS_SOURCE_ID, provider, supports: ["log"], reason }),
          createUnavailableSource({ id: CLOUDWATCH_METRICS_SOURCE_ID, provider, supports: ["metric"], reason }),
          createUnavailableSource({ id: AWS_EVENTS_SOURCE_ID, provider, supports: ["event"], reason })
        );
        break;
      }
      const cfg = { ...base, session, provider, ...(input.observations ? { observations: input.observations } : {}) };
      sources.push(
        createCloudWatchLogsSource({ ...cfg, ...(input.cloudwatchLogs?.limits ? { limits: input.cloudwatchLogs.limits } : {}) }),
        createCloudWatchMetricsSource(cfg),
        createAwsEventsSource(cfg)
      );
      break;
    }

    case "gcp": {
      const session = sessions.gcp;
      if (!session) {
        sources.push(createUnavailableSource({ id: GCP_SOURCE_ID, provider, supports: ["log", "metric"], reason: "no GCP session: signals need a credential-broker session" }));
        break;
      }
      const observed = new Map((input.observations ?? []).filter((o) => o.presence === "present").map((o) => [o.address, o.externalId]));
      sources.push(createGcpObservabilitySource({
        withSession: (fn) => fn(session),
        resources: async (scope) => graph.nodes.filter((n) => n.provider === "gcp" && n.ownership !== "external" && (!scope.addresses?.length || scope.addresses.includes(n.address)))
          .flatMap((n) => { const externalId = observed.get(n.address) ?? n.externalRef; return externalId ? [{ address: n.address, nativeType: n.nativeType, externalId }] : []; }),
      }));
      break;
    }

    case "azure": {
      const session = sessions.azure;
      if (!session) {
        const reason = "no Azure session: signals need a credential-broker session";
        sources.push(createUnavailableSource({ id: AZURE_LOGS_SOURCE_ID, provider, supports: ["log"], reason }), createUnavailableSource({ id: AZURE_METRICS_SOURCE_ID, provider, supports: ["metric"], reason }));
        break;
      }
      const cfg = { ...base, session, observations: input.observations };
      sources.push(createAzureLogsSource(cfg), createAzureMetricsSource(cfg));
      break;
    }

    case "oci":
      sources.push(createOciLoggingSource(sessions.oci), createOciMonitoringSource(sessions.oci));
      break;

    case "zenith":
    case "kubernetes": {
      const session = sessions.kubernetes;
      const managed = provider === "zenith";
      const sourceId = managed ? "zenith.kubernetes" : KUBERNETES_SOURCE_ID;
      if (!session || (managed && !workspaceId)) {
        sources.push(
          createUnavailableSource({
            id: sourceId,
            provider,
            supports: ["log", "event"],
            reason: managed ? "Zenith-managed signals need a workspace and a credential-broker Kubernetes session for the tenant namespace" : "no Kubernetes session: reading cluster signals needs a credential-broker session",
          })
        );
        break;
      }
      const namespaces = input.kubernetes?.allowedNamespaces ?? sessionNamespaces(session);
      if (managed && (!sessionNamespaces(session).includes(tenantNamespace(workspaceId!, graph.environmentId)) || !namespaces.includes(tenantNamespace(workspaceId!, graph.environmentId)))) {
        sources.push(createUnavailableSource({ id: sourceId, provider, supports: ["log", "event"], reason: "The broker session does not allow this tenant's managed namespace." }));
        break;
      }
      const source = createKubernetesSource({
          ...base,
          graph: kubernetesSignalGraph(graph, workspaceId, managed),
          session,
          allowedNamespaces: managed ? [tenantNamespace(workspaceId!, graph.environmentId)] : namespaces,
          api: input.kubernetes?.api ?? (() => scopedKubernetesApi(session, graph)),
        });
      sources.push(managed ? {
        ...source, id: sourceId, provider,
        searchLogs: async (q, signal) => { const r = await source.searchLogs!(q, signal); return { ...r, items: r.items.map((l) => ({ ...l, provider })), sources: r.sources.map(() => sourceId), unavailable: r.unavailable.map((u) => ({ ...u, source: sourceId })) }; },
        searchEvents: async (q, signal) => { const r = await source.searchEvents!(q, signal); return { ...r, items: r.items.map((e) => ({ ...e, provider })), sources: r.sources.map(() => sourceId), unavailable: r.unavailable.map((u) => ({ ...u, source: sourceId })) }; },
      } : source);
      break;
    }

    default:
      // An unsupported provider never turns into a successful empty read.
      sources.push(
        createUnavailableSource({
          id: `observability.${provider}`,
          provider,
          supports: ["log", "metric", "event"],
          reason: `no native observability source is implemented for provider "${provider}"`,
        })
      );
  }

  if (input.endpoints?.prometheus) sources.push(createPrometheusSource({ ...input.endpoints.prometheus, ...base }));
  if (input.endpoints?.loki) sources.push(createLokiSource({ ...input.endpoints.loki, ...base }));
  return sources.map((source) => bindSource(source, graph, workspaceId));
}

export const KNOWN_SOURCE_IDS = [
  SANDBOX_SOURCE_ID,
  CLOUDWATCH_LOGS_SOURCE_ID,
  CLOUDWATCH_METRICS_SOURCE_ID,
  AWS_EVENTS_SOURCE_ID,
  KUBERNETES_SOURCE_ID,
  PROMETHEUS_SOURCE_ID,
  LOKI_SOURCE_ID,
  GCP_SOURCE_ID,
  AZURE_LOGS_SOURCE_ID,
  AZURE_METRICS_SOURCE_ID,
  OCI_LOGGING_SOURCE_ID,
  OCI_MONITORING_SOURCE_ID,
  "zenith.kubernetes",
] as const;
