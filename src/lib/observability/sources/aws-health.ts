/**
 * AWS runtime health reads: ECS services, ELBv2 target health, RDS instances.
 *
 * Evidence level: `contract` — mocked SDK only.
 *
 * This is the observability-side READ of "what is actually running right now"
 * (spec §8 runtime state). It overlaps with resource drivers' `runtime()` on
 * purpose, so incident traversal can use it before every driver exists;
 * drivers may later delegate here. Everything is read-only:
 *   - ECS `DescribeServices` → desired / running / pending counts and the
 *     deployment rollout state; a `FAILED` rollout is a signal.
 *   - ECS `ListTasks(STOPPED)` + `DescribeTasks` → recently stopped tasks whose
 *     stop code or container reason says they FAILED (out of memory, essential
 *     container exited, failed to start, spot interruption). Normal
 *     scheduler/user stops are not failures and are ignored.
 *   - ELBv2 `DescribeTargetHealth` for the service's target groups (from the
 *     service's own `loadBalancers`) or for a load balancer's target groups →
 *     counts by state and the provider's reason codes.
 *   - RDS `DescribeDBInstances` → instance status.
 *
 * Signals are short machine-readable strings, only from data actually read:
 * `target_unhealthy:2`, `target_reason:Target.FailedHealthChecks:2`,
 * `task_stopped:OutOfMemory`, `deployment_failed`, `db_status:storage-full`,
 * `read_failed:AccessDenied`. Anything that could not be read is `unknown` —
 * a failed or denied call never becomes "healthy".
 */
import {
  DescribeServicesCommand,
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  type Service,
  type Task,
} from "@aws-sdk/client-ecs";
import {
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
  type TargetHealthDescription,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { DescribeDBInstancesCommand, RDSClient } from "@aws-sdk/client-rds";
import type { AwsSession } from "@/lib/credentials/types";
import type { HealthState, Observation, ResourceGraph, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { throwIfAborted } from "../abort";
import { awsContext, dbInstanceOf, ecsServiceOf, loadBalancerArnOf, parseArn, type AwsContext } from "./aws-resolve";
import { abortable, chunk, mapPool } from "./util";

export const HEALTH_SOURCE = {
  ecs: "observability.aws.ecs@1",
  elbv2: "observability.aws.elbv2@1",
  rds: "observability.aws.rds@1",
  unsupported: "observability.health@1",
} as const;

const STOPPED_WINDOW_MS = 30 * 60_000;
const MAX_TARGET_GROUPS = 5;
const FAILURE_STOP_CODES = new Set(["TaskFailedToStart", "EssentialContainerExited", "SpotInterruption", "InfrastructureHealth"]);

export interface AwsHealthDeps {
  session: AwsSession;
  graph: ResourceGraph;
  observations?: readonly Observation[];
  signal: AbortSignal;
  now: () => Date;
}

const unknownState = (node: ResourceNode, source: string, observedAt: string, signal: string): RuntimeState => ({
  address: node.address,
  health: "unknown",
  counts: {},
  signals: [signal],
  observedAt,
  source,
  simulated: false,
});

/** `read_failed:AccessDenied`-style signal from a thrown SDK error; the message text is never included. */
export function readFailedSignal(err: unknown): string {
  const name = err instanceof Error ? err.name : "Error";
  return `read_failed:${/^[A-Za-z0-9_.]{1,64}$/.test(name) ? name : "Error"}`;
}

/* ------------------------------- target health ----------------------------- */

export interface TargetSummary {
  /** `targets_healthy`, `targets_unhealthy`, `targets_initial`, … as read */
  counts: Record<string, number>;
  /** provider reason code → number of unhealthy targets reporting it */
  reasons: Record<string, number>;
  healthy: number;
  /** `unhealthy` + `unavailable` targets */
  unhealthy: number;
  registered: number;
}

/** Aggregate `DescribeTargetHealth` descriptions into counts and reason-code tallies. */
export function summarizeTargets(descriptions: readonly TargetHealthDescription[]): TargetSummary {
  const byState = new Map<string, number>();
  const reasons: Record<string, number> = {};
  for (const d of descriptions) {
    const state = d.TargetHealth?.State ?? "unavailable";
    byState.set(state, (byState.get(state) ?? 0) + 1);
    if (state === "unhealthy" || state === "unavailable") {
      const reason = d.TargetHealth?.Reason;
      if (reason && /^[A-Za-z0-9_.]{1,64}$/.test(reason)) reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
  }
  const counts: Record<string, number> = {};
  for (const [state, n] of byState) counts[`targets_${state.replace(/\./g, "_")}`] = n;
  counts.targets_healthy ??= 0;
  counts.targets_unhealthy ??= 0;
  return { counts, reasons, healthy: byState.get("healthy") ?? 0, unhealthy: (byState.get("unhealthy") ?? 0) + (byState.get("unavailable") ?? 0), registered: descriptions.length };
}

/** `target_unhealthy:2`, `target_reason:Target.FailedHealthChecks:2` — only from what was read. */
export function targetSignals(t: TargetSummary): string[] {
  const signals: string[] = [];
  if (t.unhealthy > 0) signals.push(`target_unhealthy:${t.unhealthy}`);
  for (const [reason, n] of Object.entries(t.reasons).sort(([a], [b]) => a.localeCompare(b))) signals.push(`target_reason:${reason}:${n}`);
  return signals;
}

function mergeTargets(all: TargetSummary[]): TargetSummary {
  const merged: TargetSummary = { counts: {}, reasons: {}, healthy: 0, unhealthy: 0, registered: 0 };
  for (const s of all) {
    for (const [k, v] of Object.entries(s.counts)) merged.counts[k] = (merged.counts[k] ?? 0) + v;
    for (const [k, v] of Object.entries(s.reasons)) merged.reasons[k] = (merged.reasons[k] ?? 0) + v;
    merged.healthy += s.healthy;
    merged.unhealthy += s.unhealthy;
    merged.registered += s.registered;
  }
  return merged;
}

async function readTargetHealth(elb: ElasticLoadBalancingV2Client, tgArns: string[], signal: AbortSignal): Promise<TargetSummary> {
  const parts: TargetSummary[] = [];
  for (const arn of tgArns.slice(0, MAX_TARGET_GROUPS)) {
    throwIfAborted(signal);
    const res = await abortable(elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: arn }), { abortSignal: signal }), signal);
    parts.push(summarizeTargets(res.TargetHealthDescriptions ?? []));
  }
  return mergeTargets(parts);
}

/* ---------------------------------- ECS ------------------------------------ */

export interface EcsFacts {
  desired?: number;
  running?: number;
  pending?: number;
  status?: string;
  deploymentFailed: boolean;
  deploymentInProgress: boolean;
  targets?: TargetSummary;
  /** reason → number of recently stopped tasks */
  stoppedReasons: Map<string, number>;
}

/** Health classification for one ECS service from facts already read. Pure. Exported for tests. */
export function classifyEcs(f: EcsFacts): { health: HealthState; counts: Record<string, number>; signals: string[] } {
  const counts: Record<string, number> = {};
  const signals: string[] = [];
  if (f.desired !== undefined) counts.desired = f.desired;
  if (f.running !== undefined) counts.running = f.running;
  if (f.pending !== undefined) counts.pending = f.pending;
  if (f.targets) {
    Object.assign(counts, f.targets.counts);
    signals.push(...targetSignals(f.targets));
  }
  let stoppedTotal = 0;
  for (const [reason, n] of [...f.stoppedReasons].sort(([a], [b]) => a.localeCompare(b))) {
    signals.push(`task_stopped:${reason}`);
    stoppedTotal += n;
  }
  if (stoppedTotal > 0) counts.tasks_stopped_recent = stoppedTotal;
  if (f.deploymentFailed) signals.push("deployment_failed");
  if (f.deploymentInProgress) signals.push("deployment_in_progress");
  if (f.status === "INACTIVE" || f.status === "DRAINING") signals.push(`service_${f.status.toLowerCase()}`);

  if (f.desired === undefined || f.running === undefined) return { health: "unknown", counts, signals: [...signals, "counts_not_read"] };
  if (f.status === "INACTIVE") return { health: "unhealthy", counts, signals };
  if (f.desired === 0) return { health: "degraded", counts, signals: [...signals, "scaled_to_zero"] };
  if (f.running === 0) return { health: "unhealthy", counts, signals: [...signals, "no_running_tasks"] };
  const allTargetsDown = f.targets !== undefined && f.targets.registered > 0 && f.targets.healthy === 0;
  if (allTargetsDown) return { health: "unhealthy", counts, signals };
  const degraded = f.running < f.desired || (f.targets?.unhealthy ?? 0) > 0 || f.deploymentFailed;
  return { health: degraded ? "degraded" : "healthy", counts, signals };
}

/** Why a stopped task failed, or undefined when it stopped normally (scheduler/user initiated). */
export function taskFailureReason(t: Task): string | undefined {
  const text = [t.stoppedReason, ...(t.containers ?? []).map((c) => c.reason)].filter(Boolean).join(" ");
  if (/out ?of ?memory|oomkill|exit code 137/i.test(text)) return "OutOfMemory";
  if (t.stopCode && FAILURE_STOP_CODES.has(t.stopCode)) return t.stopCode;
  return undefined;
}

async function recentStoppedReasons(ecs: ECSClient, cluster: string, service: string, nowMs: number, signal: AbortSignal): Promise<Map<string, number>> {
  const reasons = new Map<string, number>();
  const listed = await abortable(
    ecs.send(new ListTasksCommand({ cluster, serviceName: service, desiredStatus: "STOPPED", maxResults: 10 }), { abortSignal: signal }),
    signal
  );
  const arns = listed.taskArns ?? [];
  if (arns.length === 0) return reasons;
  const described = await abortable(ecs.send(new DescribeTasksCommand({ cluster, tasks: arns }), { abortSignal: signal }), signal);
  for (const t of described.tasks ?? []) {
    const stoppedAt = t.stoppedAt instanceof Date ? t.stoppedAt.getTime() : NaN;
    if (!Number.isFinite(stoppedAt) || nowMs - stoppedAt > STOPPED_WINDOW_MS) continue;
    const reason = taskFailureReason(t);
    if (reason) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  return reasons;
}

async function ecsHealth(nodes: ResourceNode[], ctx: AwsContext, deps: AwsHealthDeps): Promise<RuntimeState[]> {
  const observedAt = deps.now().toISOString();
  const out: RuntimeState[] = [];
  const byCluster = new Map<string, { node: ResourceNode; service: string }[]>();
  for (const node of nodes) {
    const r = ecsServiceOf(ctx, node);
    if (!r.ok) {
      out.push(unknownState(node, HEALTH_SOURCE.ecs, observedAt, "identifier_unresolved"));
      continue;
    }
    const list = byCluster.get(r.value.cluster) ?? [];
    list.push({ node, service: r.value.service });
    byCluster.set(r.value.cluster, list);
  }
  if (byCluster.size === 0) return out;
  const ecs = deps.session.client(ECSClient);
  const elb = deps.session.client(ElasticLoadBalancingV2Client);

  const batches = [...byCluster].flatMap(([cluster, items]) => chunk(items, 10).map((batch) => ({ cluster, batch })));
  const perBatch = await mapPool(batches, 3, deps.signal, async ({ cluster, batch }) => {
    const states: RuntimeState[] = [];
    let described: Service[] = [];
    try {
      const res = await abortable(ecs.send(new DescribeServicesCommand({ cluster, services: batch.map((b) => b.service) }), { abortSignal: deps.signal }), deps.signal);
      described = res.services ?? [];
    } catch (err) {
      throwIfAborted(deps.signal);
      for (const b of batch) states.push(unknownState(b.node, HEALTH_SOURCE.ecs, observedAt, readFailedSignal(err)));
      return states;
    }
    for (const b of batch) {
      const svc = described.find((s) => s.serviceName === b.service);
      if (!svc) {
        states.push(unknownState(b.node, HEALTH_SOURCE.ecs, observedAt, "not_found"));
        continue;
      }
      states.push(await ecsServiceState(ecs, elb, cluster, b.service, b.node, svc, deps, observedAt));
    }
    return states;
  });
  for (const s of perBatch) out.push(...s);
  return out;
}

async function ecsServiceState(
  ecs: ECSClient,
  elb: ElasticLoadBalancingV2Client,
  cluster: string,
  service: string,
  node: ResourceNode,
  svc: Service,
  deps: AwsHealthDeps,
  observedAt: string
): Promise<RuntimeState> {
  const facts: EcsFacts = {
    desired: svc.desiredCount,
    running: svc.runningCount,
    pending: svc.pendingCount,
    status: svc.status,
    deploymentFailed: (svc.deployments ?? []).some((d) => d.rolloutState === "FAILED"),
    deploymentInProgress: (svc.deployments ?? []).some((d) => d.rolloutState === "IN_PROGRESS"),
    stoppedReasons: new Map(),
  };
  const partial: string[] = [];
  let targetsUnreadable = false;
  const tgArns = [...new Set((svc.loadBalancers ?? []).map((l) => l.targetGroupArn).filter((a): a is string => typeof a === "string" && parseArn(a)?.service === "elasticloadbalancing"))];
  if (tgArns.length > 0) {
    try {
      facts.targets = await readTargetHealth(elb, tgArns, deps.signal);
    } catch (err) {
      throwIfAborted(deps.signal);
      targetsUnreadable = true;
      partial.push(`targets_${readFailedSignal(err)}`);
    }
  }
  try {
    facts.stoppedReasons = await recentStoppedReasons(ecs, cluster, service, deps.now().getTime(), deps.signal);
  } catch (err) {
    throwIfAborted(deps.signal);
    partial.push(`stopped_tasks_${readFailedSignal(err)}`);
  }
  const c = classifyEcs(facts);
  // counts look fine but the load balancer's view could not be read: not "healthy", just unverified
  const health: HealthState = targetsUnreadable && c.health === "healthy" ? "unknown" : c.health;
  return { address: node.address, health, counts: c.counts, signals: [...c.signals, ...partial], observedAt, source: HEALTH_SOURCE.ecs, simulated: false };
}

/* ----------------------------- load balancers ------------------------------ */

async function lbHealth(nodes: ResourceNode[], ctx: AwsContext, deps: AwsHealthDeps): Promise<RuntimeState[]> {
  const observedAt = deps.now().toISOString();
  const elb = deps.session.client(ElasticLoadBalancingV2Client);
  return mapPool(nodes, 3, deps.signal, async (node): Promise<RuntimeState> => {
    const arn = loadBalancerArnOf(ctx, node);
    if (!arn || parseArn(arn)?.service !== "elasticloadbalancing") return unknownState(node, HEALTH_SOURCE.elbv2, observedAt, "identifier_unresolved");
    try {
      const lbs = await abortable(elb.send(new DescribeLoadBalancersCommand({ LoadBalancerArns: [arn] }), { abortSignal: deps.signal }), deps.signal);
      const lb = lbs.LoadBalancers?.[0];
      if (!lb) return unknownState(node, HEALTH_SOURCE.elbv2, observedAt, "not_found");
      const tgs = await abortable(elb.send(new DescribeTargetGroupsCommand({ LoadBalancerArn: arn }), { abortSignal: deps.signal }), deps.signal);
      const tgArns = (tgs.TargetGroups ?? []).map((t) => t.TargetGroupArn).filter((a): a is string => typeof a === "string");
      const targets = tgArns.length > 0 ? await readTargetHealth(elb, tgArns, deps.signal) : undefined;
      const state = lb.State?.Code ?? "unknown";
      const counts: Record<string, number> = { target_groups: tgArns.length, ...(targets?.counts ?? {}) };
      const signals = [`lb_state:${state}`, ...(targets ? targetSignals(targets) : [])];
      if (targets && tgArns.length > MAX_TARGET_GROUPS) signals.push(`target_groups_truncated:${MAX_TARGET_GROUPS}`);
      let health: HealthState;
      if (state === "failed") health = "unhealthy";
      else if (state !== "active") health = state === "provisioning" || state === "active_impaired" ? "degraded" : "unknown";
      else if (targets && targets.registered > 0 && targets.healthy === 0) health = "unhealthy";
      else if (targets && targets.unhealthy > 0) health = "degraded";
      else health = "healthy";
      return { address: node.address, health, counts, signals, observedAt, source: HEALTH_SOURCE.elbv2, simulated: false };
    } catch (err) {
      throwIfAborted(deps.signal);
      return unknownState(node, HEALTH_SOURCE.elbv2, observedAt, readFailedSignal(err));
    }
  });
}

/* ----------------------------------- RDS ----------------------------------- */

const RDS_HEALTHY = new Set(["available"]);
const RDS_DEGRADED = new Set([
  "backing-up",
  "modifying",
  "upgrading",
  "maintenance",
  "renaming",
  "rebooting",
  "starting",
  "creating",
  "configuring-enhanced-monitoring",
  "configuring-iam-database-auth",
  "configuring-log-exports",
  "converting-to-vpc",
  "moving-to-vpc",
  "resetting-master-credentials",
  "storage-optimization",
  "storage-initialization",
]);
const RDS_UNHEALTHY = new Set(["failed", "stopped", "stopping", "storage-full", "inaccessible-encryption-credentials", "inaccessible-encryption-credentials-recoverable", "restore-error", "deleting", "incompatible-network", "incompatible-option-group", "incompatible-parameters", "incompatible-restore"]);

/** RDS `DBInstanceStatus` → health. Statuses this table does not know are `unknown`, not `healthy`. */
export function classifyRdsStatus(status: string | undefined): HealthState {
  if (!status) return "unknown";
  if (RDS_HEALTHY.has(status)) return "healthy";
  if (RDS_DEGRADED.has(status)) return "degraded";
  if (RDS_UNHEALTHY.has(status)) return "unhealthy";
  return "unknown";
}

async function rdsHealth(nodes: ResourceNode[], ctx: AwsContext, deps: AwsHealthDeps): Promise<RuntimeState[]> {
  const observedAt = deps.now().toISOString();
  const rds = deps.session.client(RDSClient);
  return mapPool(nodes, 3, deps.signal, async (node): Promise<RuntimeState> => {
    const id = dbInstanceOf(ctx, node);
    if (!id.ok) return unknownState(node, HEALTH_SOURCE.rds, observedAt, "identifier_unresolved");
    try {
      const res = await abortable(rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: id.value }), { abortSignal: deps.signal }), deps.signal);
      const db = res.DBInstances?.[0];
      if (!db) return unknownState(node, HEALTH_SOURCE.rds, observedAt, "not_found");
      const status = db.DBInstanceStatus;
      const safe = status && /^[a-z0-9-]{1,64}$/.test(status) ? status : "unrecognized";
      return { address: node.address, health: classifyRdsStatus(status), counts: {}, signals: [`db_status:${safe}`], observedAt, source: HEALTH_SOURCE.rds, simulated: false };
    } catch (err) {
      throwIfAborted(deps.signal);
      const code = err instanceof Error ? err.name : "";
      return unknownState(node, HEALTH_SOURCE.rds, observedAt, code === "DBInstanceNotFoundFault" ? "not_found" : readFailedSignal(err));
    }
  });
}

/* --------------------------------- entry ----------------------------------- */

export const AWS_HEALTH_KINDS = ["container_service", "load_balancer", "postgres", "mysql"] as const;

/** Runtime state for the AWS nodes given (already filtered to readable kinds). */
export async function awsHealth(nodes: ResourceNode[], deps: AwsHealthDeps): Promise<RuntimeState[]> {
  const ctx = awsContext(deps.graph, deps.observations);
  const [ecs, lbs, dbs] = await Promise.all([
    ecsHealth(nodes.filter((n) => n.kind === "container_service"), ctx, deps),
    lbHealth(nodes.filter((n) => n.kind === "load_balancer"), ctx, deps),
    rdsHealth(nodes.filter((n) => n.kind === "postgres" || n.kind === "mysql"), ctx, deps),
  ]);
  return [...ecs, ...lbs, ...dbs];
}
