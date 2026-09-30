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
 *   gcp|azure|oci|zenith → none implemented yet: an `unavailable` source says so
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
import type { AwsSession, KubernetesSession } from "@/lib/credentials/types";
import type { Observation, ProviderKey, ResourceGraph } from "@/lib/resources/types";
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

export type PrometheusEndpoint = Omit<PrometheusConfig, "graph" | "workspaceId">;
export type LokiEndpoint = Omit<LokiConfig, "graph" | "workspaceId">;

export interface SourceEndpoints {
  prometheus?: PrometheusEndpoint;
  loki?: LokiEndpoint;
}

export interface SourceSessions {
  aws?: AwsSession;
  kubernetes?: KubernetesSession;
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

    case "kubernetes": {
      const session = sessions.kubernetes;
      if (!session) {
        sources.push(
          createUnavailableSource({
            id: KUBERNETES_SOURCE_ID,
            provider,
            supports: ["log", "event"],
            reason: "no Kubernetes session: reading cluster signals needs a credential-broker session",
          })
        );
        break;
      }
      sources.push(
        createKubernetesSource({
          ...base,
          session,
          ...(input.kubernetes?.allowedNamespaces ? { allowedNamespaces: input.kubernetes.allowedNamespaces } : {}),
          ...(input.kubernetes?.api ? { api: input.kubernetes.api } : {}),
        })
      );
      break;
    }

    default:
      // gcp / azure / oci / zenith: nothing implemented; say so instead of returning silence
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
  return sources;
}

export const KNOWN_SOURCE_IDS = [
  SANDBOX_SOURCE_ID,
  CLOUDWATCH_LOGS_SOURCE_ID,
  CLOUDWATCH_METRICS_SOURCE_ID,
  AWS_EVENTS_SOURCE_ID,
  KUBERNETES_SOURCE_ID,
  PROMETHEUS_SOURCE_ID,
  LOKI_SOURCE_ID,
] as const;
