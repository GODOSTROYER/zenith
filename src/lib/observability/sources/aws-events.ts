/**
 * AWS events source (`aws.events`): ECS service events and deployments.
 *
 * Evidence level: `contract` — mocked SDK only.
 *
 * What is and is not here:
 *   - ECS `DescribeServices` returns each service's most recent 100 events
 *     (`(service web) has reached a steady state.`, placement failures, task
 *     starts/stops, …) and its deployments with a rollout state. Both become
 *     `NormalizedEvent`s. ECS keeps no older events, so a query that reaches
 *     further back than the oldest returned event is silently incomplete —
 *     the result carries a note saying so.
 *   - CloudTrail is NOT queried. Management-event history (who changed what)
 *     is a separate source that has not been built; the note says so instead of
 *     the absence looking like "nothing happened".
 *   - ALB target health transitions are not events: `DescribeTargetHealth` is a
 *     point-in-time state read, exposed through `resourceHealth()`.
 *
 * Event messages are text ECS wrote; they are classified by fixed patterns into
 * `type`/`severity` and are redacted/bounded like any other untrusted text.
 */
import { DescribeServicesCommand, ECSClient, type Deployment, type Service, type ServiceEvent } from "@aws-sdk/client-ecs";
import type { AwsSession } from "@/lib/credentials/types";
import type { Observation, ResourceGraph, ResourceNode } from "@/lib/resources/types";
import { throwIfAborted } from "../abort";
import { errorMessage, sortNewestFirst } from "../normalize";
import { sanitizeEvent, sanitizeReason } from "../redact";
import type { EventQuery, NormalizedEvent, ObservabilitySource, QueryResult, Severity } from "../types";
import { awsContext, ecsServiceOf, type AwsContext } from "./aws-resolve";
import { bindingOf, coversScope, nodesInScope, sameEnvironment, type EnvironmentBinding } from "./scope";
import { abortable, chunk, mapPool } from "./util";

export const AWS_EVENTS_SOURCE_ID = "aws.events";
const DESCRIBE_BATCH = 10;

export interface AwsEventsConfig {
  session: AwsSession;
  graph: ResourceGraph;
  provider?: "aws" | "localstack";
  workspaceId?: string;
  observations?: readonly Observation[];
}

export const AWS_EVENT_NOTES = [
  "ECS keeps only the latest 100 events per service; older service events are not available",
  "CloudTrail management events are not queried (no CloudTrail source is implemented)",
  "load balancer target health transitions are point-in-time state, not events; see resourceHealth()",
] as const;

const isEcsNode = (n: ResourceNode) => (n.provider === "aws" || n.provider === "localstack") && n.kind === "container_service";

export function createAwsEventsSource(config: AwsEventsConfig): ObservabilitySource {
  const provider = config.provider ?? "aws";
  const binding: EnvironmentBinding = bindingOf(config.graph, config.workspaceId);
  const ctx: AwsContext = awsContext(config.graph, config.observations);

  return {
    id: AWS_EVENTS_SOURCE_ID,
    provider,
    supports: ["event"],
    covers: (scope) => coversScope(binding, config.graph, scope, isEcsNode),

    async searchEvents(q: EventQuery, signal: AbortSignal): Promise<QueryResult<NormalizedEvent>> {
      const result: QueryResult<NormalizedEvent> = { items: [], sources: [], truncated: false, simulated: false, unavailable: [], notes: [] };
      if (!sameEnvironment(binding, q.scope)) return { ...result, notes: [] };
      const from = Date.parse(q.range.from);
      const to = q.range.to === undefined ? Date.now() : Date.parse(q.range.to);
      const limit = q.limit ?? 200;
      const fail = (reason: string) => result.unavailable.push({ source: AWS_EVENTS_SOURCE_ID, reason: sanitizeReason(reason) });

      // group services by cluster: DescribeServices takes one cluster and up to 10 services
      const byCluster = new Map<string, { service: string; address: string }[]>();
      for (const node of nodesInScope(config.graph, q.scope, isEcsNode)) {
        const r = ecsServiceOf(ctx, node);
        if (!r.ok) {
          fail(r.reason);
          continue;
        }
        const list = byCluster.get(r.value.cluster) ?? [];
        list.push({ service: r.value.service, address: node.address });
        byCluster.set(r.value.cluster, list);
      }

      const batches = [...byCluster].flatMap(([cluster, services]) => chunk(services, DESCRIBE_BATCH).map((batch) => ({ cluster, batch })));
      if (batches.length > 0) {
        const ecs = config.session.client(ECSClient);
        const all: NormalizedEvent[] = [];
        let answered = false;
        await mapPool(batches, 3, signal, async ({ cluster, batch }) => {
          try {
            const res = await abortable(
              ecs.send(new DescribeServicesCommand({ cluster, services: batch.map((b) => b.service) }), { abortSignal: signal }),
              signal
            );
            answered = true;
            for (const f of res.failures ?? []) fail(`cluster ${cluster}: ${f.arn ?? "service"} ${f.reason ?? "failure"}${f.detail ? ` (${f.detail})` : ""}`);
            for (const svc of res.services ?? []) {
              const owner = batch.find((b) => b.service === svc.serviceName);
              if (!owner) continue;
              all.push(...eventsOf(svc, owner.address, cluster, provider, binding.environmentId));
            }
          } catch (err) {
            throwIfAborted(signal);
            fail(`cluster ${cluster}: ${errorMessage(err)}`);
          }
        });
        if (answered) result.sources.push(AWS_EVENTS_SOURCE_ID);
        const inRange = all.filter((e) => Date.parse(e.timestamp) >= from && Date.parse(e.timestamp) <= to);
        const sorted = sortNewestFirst(inRange, (e) => e.timestamp);
        result.items = sorted.slice(0, limit);
        result.truncated = sorted.length > limit;
      }
      result.notes = [...AWS_EVENT_NOTES];
      return result;
    },
  };
}

/** Map one described service to events. Exported for tests. */
export function eventsOf(svc: Service, address: string, cluster: string, provider: string, environmentId: string): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  const serviceName = svc.serviceName ?? "";
  for (const e of svc.events ?? []) {
    const ev = fromServiceEvent(e, { address, cluster, serviceName, provider, environmentId });
    if (ev) out.push(ev);
  }
  for (const d of svc.deployments ?? []) {
    const ev = fromDeployment(d, { address, cluster, serviceName, provider, environmentId });
    if (ev) out.push(ev);
  }
  return out;
}

interface Ctx {
  address: string;
  cluster: string;
  serviceName: string;
  provider: string;
  environmentId: string;
}

function fromServiceEvent(e: ServiceEvent, c: Ctx): NormalizedEvent | undefined {
  if (!(e.createdAt instanceof Date) || Number.isNaN(e.createdAt.getTime()) || typeof e.message !== "string") return undefined;
  const { type, severity } = classifyEcsMessage(e.message);
  return sanitizeEvent({
    timestamp: e.createdAt.toISOString(),
    address: c.address,
    provider: c.provider,
    environmentId: c.environmentId,
    severity,
    type,
    message: e.message,
    native: { cluster: c.cluster, service: c.serviceName, ecsEventId: e.id },
  });
}

function fromDeployment(d: Deployment, c: Ctx): NormalizedEvent | undefined {
  const at = d.updatedAt ?? d.createdAt;
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return undefined;
  const rollout = (d.rolloutState ?? "UNKNOWN").toLowerCase();
  const severity: Severity = d.rolloutState === "FAILED" ? "error" : "info";
  return sanitizeEvent({
    timestamp: at.toISOString(),
    address: c.address,
    provider: c.provider,
    environmentId: c.environmentId,
    severity,
    type: `ecs.deployment.${rollout}`,
    message: d.rolloutStateReason ?? `deployment ${d.id ?? ""} is ${d.status ?? "unknown"} (rollout ${rollout})`.replace("  ", " "),
    native: {
      cluster: c.cluster,
      service: c.serviceName,
      deploymentId: d.id,
      status: d.status,
      rolloutState: d.rolloutState,
      taskDefinition: d.taskDefinition,
      desiredCount: d.desiredCount,
      runningCount: d.runningCount,
      pendingCount: d.pendingCount,
      failedTasks: d.failedTasks,
    },
  });
}

const ECS_PATTERNS: { re: RegExp; type: string; severity: Severity }[] = [
  { re: /has reached a steady state/i, type: "ecs.service.steady_state", severity: "info" },
  { re: /unable to consistently start tasks successfully/i, type: "ecs.service.unstable", severity: "error" },
  { re: /is unhealthy in/i, type: "ecs.service.target_unhealthy", severity: "warn" },
  { re: /unable to place a task/i, type: "ecs.service.placement_failed", severity: "warn" },
  { re: /(?:CannotPullContainer|ResourceInitializationError|failed to (?:launch|start)|unable to (?:launch|start))/i, type: "ecs.service.task_failed", severity: "error" },
  { re: /deployment failed|failed to reach a steady state/i, type: "ecs.service.deployment_failed", severity: "error" },
  { re: /rolling back|rollback/i, type: "ecs.service.deployment_rollback", severity: "warn" },
  { re: /deployment completed/i, type: "ecs.service.deployment_completed", severity: "info" },
  { re: /has started \d+ tasks?/i, type: "ecs.service.tasks_started", severity: "info" },
  { re: /has stopped \d+ running tasks?/i, type: "ecs.service.tasks_stopped", severity: "info" },
  { re: /has begun draining connections/i, type: "ecs.service.draining", severity: "info" },
  { re: /(?:deregistered|registered) \d+ targets?/i, type: "ecs.service.target_registration", severity: "info" },
];

/** Fixed-pattern classification of an ECS service event message. */
export function classifyEcsMessage(message: string): { type: string; severity: Severity } {
  for (const p of ECS_PATTERNS) if (p.re.test(message)) return { type: p.type, severity: p.severity };
  return { type: "ecs.service.event", severity: "info" };
}
