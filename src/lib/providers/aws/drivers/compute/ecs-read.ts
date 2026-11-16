/**
 * `aws:ecs_service` read side: locate the service, observe its configuration,
 * read what is running, verify steady state, discover candidates.
 *
 * All calls are read-only ECS/tagging-API calls.
 *
 * Locating: `externalId` is the service ARN (`…:service/<cluster>/<name>` —
 * the cluster is part of it). Without one the service is found by its Zenith
 * tags through the Resource Groups Tagging API, never by name.
 *
 * Runtime (what is actually running) is kept apart from observation (what is
 * configured): desired/running/pending counts, the PRIMARY deployment's
 * rollout state, and — bounded to ten tasks — why recent tasks stopped, turned
 * into short signals (`task_stopped:OutOfMemory`). `stoppedReason` strings come
 * from the cloud and are DATA: they are matched against a fixed list of
 * classes and never copied into a signal.
 */
import { DescribeServicesCommand, DescribeTaskDefinitionCommand, DescribeTasksCommand, ECSClient, ListClustersCommand, ListServicesCommand, ListTasksCommand, type Service, type Task, type TaskDefinition } from "@aws-sdk/client-ecs";
import type { AwsSession } from "@/lib/credentials/types";
import type { DiscoveredResource, ResourceDriver } from "@/lib/drivers/types";
import type { HealthState, Observation, ResourceNode, RuntimeState } from "@/lib/resources/types";
import {
  attempt,
  attributesOf,
  boundNative,
  chunk,
  failedObservation,
  hasZenithManagedTag,
  nodeName,
  paginate,
  parseArn,
  runtimeState,
  standardVerification,
  unknownReasonOf,
  unknownValue,
  type AwsFailure,
} from "@/lib/providers/aws/drivers/shared";
import { expectedEcsService } from "./ecs-service-compile";
import { failureOf, findByTags, lowerTagMap, type AwsCtx } from "./support/sdk";
import { DRIVER_IDS } from "./types";

export const ECS_SERVICE_ID = DRIVER_IDS.ecsService;

/** Names of attributes that come from the task definition rather than the service. */
const FROM_TASK_DEFINITION = new Set(["cpu", "memoryMb", "image", "port"]);

export interface ServiceLocation {
  arn: string;
  cluster: string;
  service: string;
  /** tags, when the lookup already returned them */
  tags?: Record<string, string>;
}

export type Located = { ok: true; value: ServiceLocation } | { ok: false; failure: AwsFailure; externalId?: string };

/** `arn:aws:ecs:r:a:service/<cluster>/<service>` → its two names. The old ARN form has no cluster and cannot be used. */
export function locationFromArn(arn: string): ServiceLocation | undefined {
  const a = parseArn(arn);
  if (!a || a.service !== "ecs" || !a.resource.startsWith("service/")) return undefined;
  const parts = a.resource.slice("service/".length).split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  return { arn, cluster: parts[0], service: parts[1] };
}

export async function locateService(ctx: AwsCtx, node: ResourceNode, externalId?: string): Promise<Located> {
  if (externalId) {
    const loc = locationFromArn(externalId);
    return loc
      ? { ok: true, value: loc }
      : { ok: false, externalId, failure: { kind: "error", code: "InvalidExternalId", summary: "externalId is not an ECS service ARN that names its cluster (service/<cluster>/<name>)." } };
  }
  try {
    const found = await findByTags(ctx, node, "ecs:service");
    if (found.length > 1) return { ok: false, failure: { kind: "error", code: "Ambiguous", summary: `${found.length} ECS services carry the tags of ${node.address}.` } };
    if (found.length === 0) return { ok: false, failure: { kind: "missing", code: "NotFoundByTags", summary: "No ECS service carries this node's Zenith tags (the tag index is eventually consistent)." } };
    const loc = locationFromArn(found[0].arn);
    if (!loc) return { ok: false, externalId: found[0].arn, failure: { kind: "error", code: "UnsupportedArn", summary: "The service ARN does not name its cluster (old ARN format); enable the long ARN format." } };
    return { ok: true, value: { ...loc, tags: found[0].tags } };
  } catch (e) {
    return { ok: false, failure: failureOf(ctx, e) };
  }
}

/** Describe one service. `undefined` = the API said it does not exist (missing or INACTIVE). */
export async function describeService(ctx: AwsCtx, ecs: ECSClient, loc: ServiceLocation): Promise<Service | undefined> {
  const res = await ecs.send(new DescribeServicesCommand({ cluster: loc.cluster, services: [loc.service], include: ["TAGS"] }), { abortSignal: ctx.signal });
  const svc = res.services?.[0];
  if (!svc || svc.status === "INACTIVE") return undefined;
  return svc;
}

function containerOf(node: ResourceNode, td: TaskDefinition) {
  const defs = td.containerDefinitions ?? [];
  return defs.find((c) => c.name === nodeName(node.address)) ?? defs[0];
}

/* --------------------------------- observe -------------------------------- */

export const ecsObserve: NonNullable<ResourceDriver<AwsSession>["observe"]> = async (ctx, node, externalId): Promise<Observation> => {
  const names = Object.keys(expectedEcsService(node));
  const located = await locateService(ctx, node, externalId);
  if (!located.ok) return failedObservation(ctx, node, ECS_SERVICE_ID, names, located.failure, located.externalId);
  const loc = located.value;
  const ecs = ctx.session.client(ECSClient);

  let svc: Service | undefined;
  try {
    svc = await describeService(ctx, ecs, loc);
  } catch (e) {
    return failedObservation(ctx, node, ECS_SERVICE_ID, names, failureOf(ctx, e), loc.arn);
  }
  if (!svc) {
    return failedObservation(ctx, node, ECS_SERVICE_ID, names, { kind: "missing", code: "ServiceNotFound", summary: "DescribeServices reports no active service." }, loc.arn);
  }

  const td = svc.taskDefinition
    ? await attempt(async () => (await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: svc.taskDefinition }), { abortSignal: ctx.signal })).taskDefinition, ctx.signal)
    : undefined;
  const taskDefinition = td?.ok ? td.value : undefined;
  const container = taskDefinition ? containerOf(node, taskDefinition) : undefined;

  const values: Record<string, unknown> = {};
  if (svc.desiredCount !== undefined) values.replicas = svc.desiredCount;
  if (svc.launchType !== undefined) values.launchType = svc.launchType;
  const assign = svc.networkConfiguration?.awsvpcConfiguration?.assignPublicIp;
  if (svc.networkConfiguration?.awsvpcConfiguration) values.assignPublicIp = assign === "ENABLED";
  if (taskDefinition) {
    if (taskDefinition.cpu !== undefined && Number.isFinite(Number(taskDefinition.cpu))) values.cpu = Number(taskDefinition.cpu);
    if (taskDefinition.memory !== undefined && Number.isFinite(Number(taskDefinition.memory))) values.memoryMb = Number(taskDefinition.memory);
    if (container?.image) values.image = container.image;
    const firstPort = [...(container?.portMappings ?? [])].map((p) => p.containerPort).filter((p): p is number => typeof p === "number").sort((a, b) => a - b)[0];
    if (firstPort !== undefined) values.port = firstPort;
  }
  const attributes = attributesOf(ctx, names, values);
  if (td && !td.ok) {
    for (const n of names) if (FROM_TASK_DEFINITION.has(n)) attributes[n] = unknownValue(unknownReasonOf(td.failure), td.failure.summary);
  }

  const tags = loc.tags ?? lowerTagMap(svc.tags);
  const native = boundNative(
    {
      clusterName: loc.cluster,
      serviceName: loc.service,
      targetGroupArns: (svc.loadBalancers ?? []).map((l) => l.targetGroupArn).filter((a): a is string => typeof a === "string"),
      ...(container?.logConfiguration?.options?.["awslogs-group"] ? { logGroupName: container.logConfiguration.options["awslogs-group"] } : {}),
      status: svc.status,
      taskDefinition: svc.taskDefinition,
      ...(taskDefinition ? { taskRoleArn: taskDefinition.taskRoleArn, executionRoleArn: taskDefinition.executionRoleArn } : {}),
      ...(container?.image && names.indexOf("image") < 0 ? { image: container.image } : {}),
      tags,
    },
    { priority: ["clusterName", "serviceName", "targetGroupArns", "logGroupName", "tags"] }
  );
  return {
    address: node.address,
    externalId: svc.serviceArn ?? loc.arn,
    presence: "present",
    attributes,
    native,
    observedAt: ctx.now().toISOString(),
    source: ECS_SERVICE_ID,
    simulated: false,
  };
};

/* --------------------------------- runtime -------------------------------- */

export type StopClass = "OutOfMemory" | "CannotPullContainer" | "EssentialContainerExited" | "ResourceInitializationError" | "FailedHealthChecks" | "Interrupted" | "Other";

/**
 * Classify why a task stopped. Returns `undefined` for routine stops (a
 * deployment replacing tasks, scaling in, a user stop). For a one-shot job
 * (`oneShot`) an essential container that exited 0 is success, not a signal;
 * for a service any exit of the essential container is a failure.
 */
export function classifyStop(task: Pick<Task, "stopCode" | "stoppedReason" | "containers">, opts: { oneShot?: boolean } = {}): { class: StopClass; exitCodes: number[] } | undefined {
  const reason = `${task.stoppedReason ?? ""} ${(task.containers ?? []).map((c) => c.reason ?? "").join(" ")}`;
  const exitCodes = (task.containers ?? []).map((c) => c.exitCode).filter((c): c is number => typeof c === "number" && c !== 0);
  const code = String(task.stopCode ?? "");
  if (/OutOfMemory|memory usage/i.test(reason)) return { class: "OutOfMemory", exitCodes };
  if (/CannotPullContainer/i.test(reason)) return { class: "CannotPullContainer", exitCodes };
  if (/ResourceInitializationError/i.test(reason)) return { class: "ResourceInitializationError", exitCodes };
  if (/failed ELB health checks|failed container health checks/i.test(reason)) return { class: "FailedHealthChecks", exitCodes };
  if (code === "SpotInterruption" || code === "TerminationNotice") return { class: "Interrupted", exitCodes };
  if (code === "EssentialContainerExited" || /Essential container in task exited/i.test(reason)) {
    if (opts.oneShot && exitCodes.length === 0) return undefined;
    return { class: "EssentialContainerExited", exitCodes };
  }
  if (code === "UserInitiated" || code === "ServiceSchedulerInitiated") return undefined;
  if (code === "TaskFailedToStart") return { class: "Other", exitCodes };
  return undefined;
}

const MAX_STOPPED = 10;

/** Stopped-task signals for a cluster/service (or a task family, for jobs). Bounded to ten tasks. */
export async function stoppedTaskSignals(
  ctx: AwsCtx,
  ecs: ECSClient,
  query: { cluster: string; serviceName?: string; family?: string; oneShot?: boolean }
): Promise<{ signals: string[]; failures: number; sampled: number } | { unreadable: AwsFailure }> {
  const listed = await attempt(
    () => ecs.send(new ListTasksCommand({ cluster: query.cluster, desiredStatus: "STOPPED", maxResults: MAX_STOPPED, ...(query.serviceName ? { serviceName: query.serviceName } : {}), ...(query.family ? { family: query.family } : {}) }), { abortSignal: ctx.signal }),
    ctx.signal
  );
  if (!listed.ok) return { unreadable: listed.failure };
  const arns = (listed.value.taskArns ?? []).slice(0, MAX_STOPPED);
  if (arns.length === 0) return { signals: [], failures: 0, sampled: 0 };
  const described = await attempt(() => ecs.send(new DescribeTasksCommand({ cluster: query.cluster, tasks: arns }), { abortSignal: ctx.signal }), ctx.signal);
  if (!described.ok) return { unreadable: described.failure };
  const classes = new Set<StopClass>();
  const exits = new Set<number>();
  let failures = 0;
  for (const t of described.value.tasks ?? []) {
    const c = classifyStop(t, { oneShot: query.oneShot });
    if (!c) continue;
    failures += 1;
    classes.add(c.class);
    for (const code of c.exitCodes) exits.add(code);
  }
  const signals = [...[...classes].sort().slice(0, 5).map((c) => `task_stopped:${c}`), ...[...exits].sort((a, b) => a - b).slice(0, 3).map((c) => `exit_code:${c}`)];
  return { signals, failures, sampled: (described.value.tasks ?? []).length };
}

export function rolloutOf(svc: Service): { primary?: { rolloutState?: string }; active: number } {
  const live = (svc.deployments ?? []).filter((d) => d.status !== "INACTIVE");
  return { primary: live.find((d) => d.status === "PRIMARY"), active: live.length };
}

export const ecsRuntime: NonNullable<ResourceDriver<AwsSession>["runtime"]> = async (ctx, node, externalId): Promise<RuntimeState> => {
  const located = await locateService(ctx, node, externalId);
  if (!located.ok) {
    return runtimeState(ctx, node, ECS_SERVICE_ID, located.failure.kind === "missing" ? "unhealthy" : "unknown", {}, [located.failure.kind === "missing" ? "service_missing" : `read_failed:${located.failure.code}`]);
  }
  const loc = located.value;
  const ecs = ctx.session.client(ECSClient);
  let svc: Service | undefined;
  try {
    svc = await describeService(ctx, ecs, loc);
  } catch (e) {
    const f = failureOf(ctx, e);
    return runtimeState(ctx, node, ECS_SERVICE_ID, f.kind === "missing" ? "unhealthy" : "unknown", {}, [f.kind === "missing" ? "service_missing" : f.kind === "inaccessible" ? "access_denied" : `read_failed:${f.code}`]);
  }
  if (!svc) return runtimeState(ctx, node, ECS_SERVICE_ID, "unhealthy", {}, ["service_missing"]);

  const desired = svc.desiredCount ?? 0;
  const running = svc.runningCount ?? 0;
  const pending = svc.pendingCount ?? 0;
  const { primary, active } = rolloutOf(svc);
  const counts: Record<string, number> = { desired, running, pending, deployments: active };
  const signals: string[] = [];

  if (primary?.rolloutState === "FAILED") signals.push("rollout_failed");
  else if (primary?.rolloutState === "IN_PROGRESS") signals.push("rollout_in_progress");
  if (pending > 0) signals.push(`pending_tasks:${pending}`);
  if (desired === 0) signals.push("desired_zero");

  const stopped = await stoppedTaskSignals(ctx, ecs, { cluster: loc.cluster, serviceName: loc.service });
  if ("unreadable" in stopped) signals.push("stopped_tasks_unreadable");
  else {
    counts.stoppedFailures = stopped.failures;
    signals.push(...stopped.signals);
  }

  let health: HealthState;
  if (primary?.rolloutState === "FAILED") health = "unhealthy";
  else if (desired === 0) health = "healthy";
  else if (running === 0) health = "unhealthy";
  else if (running < desired || pending > 0 || primary?.rolloutState === "IN_PROGRESS" || active > 1) health = "degraded";
  else health = "healthy";
  return runtimeState(ctx, node, ECS_SERVICE_ID, health, counts, signals);
};

/* --------------------------------- verify --------------------------------- */

export const ecsVerify: NonNullable<ResourceDriver<AwsSession>["verify"]> = async (ctx, node, observation, runtime) => {
  const base = standardVerification(ctx, node, observation, expectedEcsService(node), "The ECS service");
  if (observation.presence !== "present") return base;
  let state = runtime;
  if (!state) {
    try {
      state = await ecsRuntime(ctx, node, observation.externalId);
    } catch (e) {
      failureOf(ctx, e);
    }
  }
  const checks = [...base.checks];
  if (!state || state.health === "unknown") {
    checks.push({ id: "steady_state", description: "The service is at steady state (one completed deployment, running = desired)", passed: "unknown", detail: "runtime could not be read" });
  } else {
    const steady = state.counts.running === state.counts.desired && state.counts.deployments === 1 && !state.signals.some((s) => s === "rollout_failed" || s === "rollout_in_progress");
    checks.push({
      id: "steady_state",
      description: "The service is at steady state (one completed deployment, running = desired)",
      passed: steady,
      ...(steady ? {} : { detail: `running ${state.counts.running ?? "?"}/${state.counts.desired ?? "?"}, deployments ${state.counts.deployments ?? "?"}${state.signals.length ? `, signals ${state.signals.join(",")}` : ""}` }),
    });
  }
  const status = checks.some((c) => c.passed === false) ? "failed" : checks.some((c) => c.passed === "unknown") ? "unknown" : "passed";
  return { ...base, checks, status };
};

/* -------------------------------- discover -------------------------------- */

const MAX_DISCOVERED = 100;

export const ecsDiscover: NonNullable<ResourceDriver<AwsSession>["discover"]> = async (ctx): Promise<DiscoveredResource[]> => {
  const ecs = ctx.session.client(ECSClient);
  const clusters = await paginate<string>(
    async (token) => {
      const res = await ecs.send(new ListClustersCommand({ maxResults: 100, ...(token ? { nextToken: token } : {}) }), { abortSignal: ctx.signal });
      return { items: res.clusterArns ?? [], next: res.nextToken };
    },
    { maxPages: 3, signal: ctx.signal }
  );
  const out: DiscoveredResource[] = [];
  for (const clusterArn of clusters.items.sort()) {
    if (out.length >= MAX_DISCOVERED) break;
    const serviceArns = await paginate<string>(
      async (token) => {
        const res = await ecs.send(new ListServicesCommand({ cluster: clusterArn, maxResults: 100, ...(token ? { nextToken: token } : {}) }), { abortSignal: ctx.signal });
        return { items: res.serviceArns ?? [], next: res.nextToken };
      },
      { maxPages: 2, signal: ctx.signal }
    );
    for (const batch of chunk(serviceArns.items.sort(), 10)) {
      const res = await ecs.send(new DescribeServicesCommand({ cluster: clusterArn, services: batch, include: ["TAGS"] }), { abortSignal: ctx.signal });
      for (const svc of res.services ?? []) {
        if (!svc.serviceArn || !svc.serviceName || svc.status === "INACTIVE") continue;
        out.push({
          provider: "aws",
          kind: "container_service",
          nativeType: "aws:ecs_service",
          externalId: svc.serviceArn,
          name: svc.serviceName,
          region: ctx.region,
          zenithTagged: hasZenithManagedTag(lowerTagMap(svc.tags)),
          attributes: {
            cluster: clusterArn.slice(clusterArn.lastIndexOf("/") + 1),
            desiredCount: svc.desiredCount ?? 0,
            runningCount: svc.runningCount ?? 0,
            launchType: svc.launchType ?? "unknown",
            status: svc.status ?? "unknown",
          },
        });
        if (out.length >= MAX_DISCOVERED) break;
      }
      if (out.length >= MAX_DISCOVERED) break;
    }
  }
  return out;
};
