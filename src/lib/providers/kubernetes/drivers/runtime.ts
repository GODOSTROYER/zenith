/**
 * Runtime state readers: what is running now, as counts and short
 * machine-readable signals. Read-only.
 *
 * Signals are built ONLY from whitelisted reason codes (`CrashLoopBackOff`,
 * `ImagePullBackOff`, `OOMKilled`, …) so free text in a pod status (which an
 * attacker-controlled image could influence) never becomes a signal. Pod
 * listing is bounded (100); when more exist the `pods_truncated` signal says so
 * and pod-derived counts are lower bounds.
 *
 * Health semantics:
 *   healthy    every desired replica is ready and updated, no bad signal
 *   degraded   some replicas ready, a rollout in progress, or intentionally scaled to zero
 *   unhealthy  desired > 0 and none ready, or a progress deadline was exceeded
 *   unknown    could not read (or cannot be judged from what this object exposes)
 */
import type { HealthState } from "@/lib/resources/types";
import type { RuntimeArgs } from "./shared";
import { READ_ONLY_KINDS, listByKind } from "../client";
import { evaluateRollout } from "../rollout";
import { dig, isRecord } from "../util";
import { cronJobReadback, statefulSetReadback } from "./readback";

type RuntimePart = { health: HealthState; counts: Record<string, number>; signals: string[] };

/** The only waiting/terminated reasons that become signals, mapped to a stable signal name. */
const REASON_SIGNALS: Record<string, string> = {
  CrashLoopBackOff: "crashloopbackoff",
  ImagePullBackOff: "imagepullbackoff",
  ErrImagePull: "imagepullbackoff",
  InvalidImageName: "imagepullbackoff",
  CreateContainerConfigError: "container_config_error",
  CreateContainerError: "container_config_error",
  RunContainerError: "container_config_error",
  OOMKilled: "oomkilled",
  Error: "container_error",
};

const MAX_PODS = 100;

function tally(pods: Record<string, unknown>[]): { counts: Record<string, number>; signals: Map<string, number> } {
  const counts = { pods: pods.length, running: 0, pending: 0, failed: 0, succeeded: 0, restarts: 0, containers_ready: 0, containers_total: 0 };
  const signals = new Map<string, number>();
  const bump = (s: string) => signals.set(s, (signals.get(s) ?? 0) + 1);
  for (const p of pods) {
    const phase = dig(p, "status", "phase");
    if (phase === "Running") counts.running++;
    else if (phase === "Pending") counts.pending++;
    else if (phase === "Failed") counts.failed++;
    else if (phase === "Succeeded") counts.succeeded++;
    const conditions = dig(p, "status", "conditions");
    if (Array.isArray(conditions) && conditions.some((c) => isRecord(c) && c.type === "PodScheduled" && c.status === "False" && c.reason === "Unschedulable")) bump("unschedulable");
    const statuses = dig(p, "status", "containerStatuses");
    if (!Array.isArray(statuses)) continue;
    for (const cs of statuses) {
      if (!isRecord(cs)) continue;
      counts.containers_total++;
      if (cs.ready === true) counts.containers_ready++;
      if (typeof cs.restartCount === "number") counts.restarts += cs.restartCount;
      for (const reason of [dig(cs, "state", "waiting", "reason"), dig(cs, "state", "terminated", "reason"), dig(cs, "lastState", "terminated", "reason")]) {
        const sig = typeof reason === "string" ? REASON_SIGNALS[reason] : undefined;
        if (sig) bump(sig);
      }
    }
  }
  return { counts, signals };
}

export async function podBasedRuntime({ client, ref, live }: RuntimeArgs): Promise<RuntimePart> {
  let cap: HealthState | undefined;
  const kind = ref.kind === "StatefulSet" ? "StatefulSet" : "Deployment";
  const ev = evaluateRollout(kind, live);
  const counts: Record<string, number> = {
    desired: ev.snapshot.desiredReplicas,
    ready: ev.snapshot.readyReplicas ?? (kind === "Deployment" ? (ev.snapshot.availableReplicas ?? 0) : 0),
    updated: ev.snapshot.updatedReplicas ?? 0,
    available: ev.snapshot.availableReplicas ?? 0,
  };
  const signals: string[] = [];
  let listedPods: Record<string, unknown>[] = [];

  const match = dig(live, "spec", "selector", "matchLabels");
  if (isRecord(match) && ref.namespace) {
    const labelSelector = Object.entries(match)
      .filter(([, v]) => typeof v === "string")
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v as string}`)
      .join(",");
    const pods = (await listByKind(client, READ_ONLY_KINDS.Pod, ref.namespace, { labelSelector, limit: MAX_PODS, maxPages: 1 })).items;
    listedPods = pods;
    const t = tally(pods);
    Object.assign(counts, t.counts);
    for (const [sig, n] of [...t.signals].sort(([a], [b]) => (a < b ? -1 : 1))) signals.push(`${sig}:${n}`);
    if (pods.length >= MAX_PODS) signals.push("pods_truncated");
  }
  if (kind === "StatefulSet" && ref.namespace) {
    const extra = await statefulSetReadback(client, ref.namespace, live, listedPods);
    Object.assign(counts, extra.counts);
    signals.push(...extra.signals);
    cap = extra.cap;
  }
  if (ev.failed) signals.push(ev.failed === "ProgressDeadlineExceeded" ? "rollout_deadline_exceeded" : "rollout_failed");
  else if (!ev.done && counts.desired > 0) signals.push("rollout_in_progress");

  const bad = signals.some((s) => /^(crashloopbackoff|imagepullbackoff|oomkilled|container_config_error|container_error):/.test(s));
  let health: HealthState;
  if (counts.desired === 0) {
    health = "degraded";
    signals.push("scaled_to_zero");
  } else if (ev.failed || counts.ready === 0) health = "unhealthy";
  else if (counts.ready < counts.desired || bad || !ev.done) health = "degraded";
  else health = "healthy";
  // Readback may only lower health: a Ready pod with a Pending or Lost claim is not a serving database.
  const order: HealthState[] = ["unhealthy", "degraded", "healthy"];
  if (cap && order.indexOf(cap) < order.indexOf(health)) health = cap;
  return { health, counts, signals };
}

export async function cronJobRuntime({ client, ref, live }: RuntimeArgs): Promise<RuntimePart> {
  const active = dig(live, "status", "active");
  const suspended = dig(live, "spec", "suspend") === true;
  const signals: string[] = [];
  const counts: Record<string, number> = { active: Array.isArray(active) ? active.length : 0, suspended: suspended ? 1 : 0 };
  if (suspended) signals.push("suspended");
  const scheduled = dig(live, "status", "lastScheduleTime") !== undefined;
  if (!scheduled && !suspended) signals.push("never_scheduled");
  // The CronJob alone cannot say whether its last run succeeded; the Jobs it created can. Without
  // any run, health is not guessed.
  if (!scheduled || !ref.namespace) return { health: "unknown", counts, signals };
  const { part, health } = await cronJobReadback(client, ref.namespace, live);
  Object.assign(counts, part.counts);
  signals.push(...part.signals);
  return { health, counts, signals };
}

export async function pvcRuntime({ live }: RuntimeArgs): Promise<RuntimePart> {
  const phase = dig(live, "status", "phase");
  if (phase === "Bound") return { health: "healthy", counts: { bound: 1 }, signals: [] };
  if (phase === "Lost") return { health: "unhealthy", counts: { bound: 0 }, signals: ["pvc_lost"] };
  return { health: "degraded", counts: { bound: 0 }, signals: ["pvc_pending"] };
}

export async function certificateRuntime({ live }: RuntimeArgs): Promise<RuntimePart> {
  const conditions = dig(live, "status", "conditions");
  const ready = Array.isArray(conditions) ? conditions.find((c) => isRecord(c) && c.type === "Ready") : undefined;
  if (!isRecord(ready)) return { health: "unknown", counts: {}, signals: ["no_ready_condition"] };
  if (ready.status === "True") return { health: "healthy", counts: { ready: 1 }, signals: [] };
  const reason = typeof ready.reason === "string" && /^[A-Za-z0-9]{1,40}$/.test(ready.reason) ? ready.reason : "Unknown";
  return { health: "degraded", counts: { ready: 0 }, signals: [`certificate_not_ready:${reason}`] };
}

export async function ingressRuntime({ live }: RuntimeArgs): Promise<RuntimePart> {
  const lb = dig(live, "status", "loadBalancer", "ingress");
  const has = Array.isArray(lb) && lb.length > 0;
  return has ? { health: "healthy", counts: { addresses: (lb as unknown[]).length }, signals: [] } : { health: "degraded", counts: { addresses: 0 }, signals: ["no_address"] };
}

export async function namespaceRuntime({ live }: RuntimeArgs): Promise<RuntimePart> {
  const phase = dig(live, "status", "phase");
  if (phase === "Active") return { health: "healthy", counts: { active: 1 }, signals: [] };
  if (phase === "Terminating") return { health: "unhealthy", counts: { active: 0 }, signals: ["namespace_terminating"] };
  return { health: "unknown", counts: {}, signals: [] };
}
