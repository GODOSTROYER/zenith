/**
 * Readback beyond "the object exists": what the controllers actually did.
 *
 * StatefulSet  ordered readiness of the ordinals, revision convergence, and
 *              the state of every PersistentVolumeClaim the claim templates
 *              produce. A StatefulSet whose pods are ready but whose claims are
 *              Pending or Lost is not healthy: its data is not where it should be.
 * CronJob      the outcome of the Jobs it created. The CronJob object alone
 *              cannot say whether the last run succeeded.
 *
 * Read-only. Every signal is built from a fixed vocabulary or a count; free text
 * from the cluster (which a workload's image can influence) never becomes one.
 */
import type { HealthState } from "@/lib/resources/types";
import { READ_ONLY_KINDS, listByKind, listObjects, type K8sClient } from "../client";
import { LABEL } from "../types";
import { dig, isRecord } from "../util";

export interface ReadbackPart {
  counts: Record<string, number>;
  signals: string[];
  /** a verdict that caps the health the caller computed (never raises it) */
  cap?: HealthState;
}

const MAX_ITEMS = 200;

function selectorOf(match: unknown): string | undefined {
  if (!isRecord(match)) return undefined;
  const parts = Object.entries(match)
    .filter(([, v]) => typeof v === "string")
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v as string}`);
  return parts.length > 0 ? parts.join(",") : undefined;
}

const ordinalOf = (podName: string, stsName: string): number | undefined => {
  const m = new RegExp(`^${stsName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`).exec(podName);
  return m ? Number(m[1]) : undefined;
};

const podReady = (pod: Record<string, unknown>): boolean => {
  const conditions = dig(pod, "status", "conditions");
  return Array.isArray(conditions) && conditions.some((c) => isRecord(c) && c.type === "Ready" && c.status === "True");
};

/** The claim names a StatefulSet's templates produce for ordinals 0..desired-1. */
export function expectedClaimNames(live: Record<string, unknown>, desired: number): string[] {
  const name = dig(live, "metadata", "name");
  const templates = dig(live, "spec", "volumeClaimTemplates");
  if (typeof name !== "string" || !Array.isArray(templates)) return [];
  const out: string[] = [];
  for (const t of templates) {
    const tn = dig(t, "metadata", "name");
    if (typeof tn !== "string") continue;
    for (let i = 0; i < desired; i++) out.push(`${tn}-${name}-${i}`);
  }
  return out.sort();
}

/**
 * Ordered readiness + claim readback for a StatefulSet. `pods` are the pods
 * already listed by the caller (same selector as the StatefulSet).
 */
export async function statefulSetReadback(client: K8sClient, namespace: string, live: Record<string, unknown>, pods: Record<string, unknown>[]): Promise<ReadbackPart> {
  const counts: Record<string, number> = {};
  const signals: string[] = [];
  let cap: HealthState | undefined;
  const name = String(dig(live, "metadata", "name") ?? "");
  const desiredRaw = dig(live, "spec", "replicas");
  const desired = typeof desiredRaw === "number" ? desiredRaw : 1;
  const policy = dig(live, "spec", "podManagementPolicy");

  // Ordered readiness: with OrderedReady, ordinal i is never ready before ordinal i-1.
  const ready = new Set<number>();
  const present = new Set<number>();
  for (const p of pods) {
    const o = ordinalOf(String(dig(p, "metadata", "name") ?? ""), name);
    if (o === undefined) continue;
    present.add(o);
    if (podReady(p)) ready.add(o);
  }
  let prefix = 0;
  while (ready.has(prefix)) prefix++;
  counts.ordinals_present = present.size;
  counts.ordinals_ready_prefix = prefix;
  if (policy !== "Parallel") {
    const highest = ready.size > 0 ? Math.max(...ready) : -1;
    if (highest >= prefix) {
      signals.push("ordinal_gap");
      cap = "degraded";
    }
  }

  // Revision convergence: only meaningful without a staged partition.
  const partitionRaw = dig(live, "spec", "updateStrategy", "rollingUpdate", "partition");
  const partition = typeof partitionRaw === "number" ? partitionRaw : 0;
  counts.partition = partition;
  const current = dig(live, "status", "currentRevision");
  const update = dig(live, "status", "updateRevision");
  if (partition === 0 && typeof current === "string" && typeof update === "string" && current !== update) {
    signals.push("revision_not_converged");
    cap = cap ?? "degraded";
  }
  if (partition > 0 && partition < desired) signals.push(`staged_rollout:partition_${partition}`);

  // Claims: every template x ordinal must exist and be Bound.
  const wanted = expectedClaimNames(live, desired);
  if (wanted.length > 0) {
    const selector = selectorOf(dig(live, "spec", "selector", "matchLabels"));
    const list = await listObjects(client, "PersistentVolumeClaim", namespace, { ...(selector ? { labelSelector: selector } : {}), limit: MAX_ITEMS, maxPages: 1 });
    const byName = new Map<string, Record<string, unknown>>();
    for (const c of list.items) byName.set(String(dig(c, "metadata", "name") ?? ""), c);
    let bound = 0;
    let pending = 0;
    let lost = 0;
    let missing = 0;
    for (const claim of wanted) {
      const c = byName.get(claim);
      if (!c) {
        missing++;
        continue;
      }
      const phase = dig(c, "status", "phase");
      if (phase === "Bound") bound++;
      else if (phase === "Lost") lost++;
      else pending++;
    }
    counts.claims_expected = wanted.length;
    counts.claims_bound = bound;
    if (pending > 0) signals.push(`pvc_pending:${pending}`);
    if (lost > 0) signals.push(`pvc_lost:${lost}`);
    if (missing > 0) signals.push(`pvc_missing:${missing}`);
    if (lost > 0) cap = "unhealthy";
    else if (pending > 0 || missing > 0) cap = cap === "unhealthy" ? cap : "degraded";
    if (list.truncated) signals.push("pvcs_truncated");
  }
  return { counts, signals, cap };
}

const FINISH_REASONS: Record<string, string> = {
  BackoffLimitExceeded: "job_backoff_limit_exceeded",
  DeadlineExceeded: "job_deadline_exceeded",
};

type JobOutcome = "succeeded" | "failed" | "running";

function jobOutcome(job: Record<string, unknown>): { outcome: JobOutcome; signal?: string } {
  const conditions = dig(job, "status", "conditions");
  if (Array.isArray(conditions)) {
    for (const c of conditions) {
      if (!isRecord(c) || c.status !== "True") continue;
      if (c.type === "Complete") return { outcome: "succeeded" };
      if (c.type === "Failed") return { outcome: "failed", signal: typeof c.reason === "string" ? FINISH_REASONS[c.reason] : undefined };
    }
  }
  return { outcome: "running" };
}

/** What the Jobs a CronJob created say about it. `live` is the CronJob. */
export async function cronJobReadback(client: K8sClient, namespace: string, live: Record<string, unknown>): Promise<{ part: ReadbackPart; health: HealthState }> {
  const counts: Record<string, number> = {};
  const signals: string[] = [];
  const name = String(dig(live, "metadata", "name") ?? "");
  const uid = dig(live, "metadata", "uid");
  const labels = dig(live, "spec", "jobTemplate", "metadata", "labels");
  const selector = isRecord(labels) ? selectorOf({ [LABEL.name]: labels[LABEL.name], [LABEL.partOf]: labels[LABEL.partOf] }) : undefined;
  const listing = await listByKind(client, READ_ONLY_KINDS.Job, namespace, { ...(selector ? { labelSelector: selector } : {}), limit: MAX_ITEMS, maxPages: 1 });
  const mine = listing.items.filter((j) => {
    const owners = dig(j, "metadata", "ownerReferences");
    return Array.isArray(owners) && owners.some((o) => isRecord(o) && o.kind === "CronJob" && o.name === name && (uid === undefined || o.uid === uid));
  });
  const when = (j: Record<string, unknown>) => String(dig(j, "metadata", "creationTimestamp") ?? "");
  mine.sort((a, b) => (when(b) < when(a) ? -1 : when(b) > when(a) ? 1 : 0));
  let succeeded = 0;
  let failed = 0;
  let running = 0;
  let latestFinished: { outcome: JobOutcome; signal?: string } | undefined;
  for (const j of mine) {
    const o = jobOutcome(j);
    if (o.outcome === "succeeded") succeeded++;
    else if (o.outcome === "failed") failed++;
    else running++;
    if (!latestFinished && o.outcome !== "running") latestFinished = o;
  }
  counts.jobs = mine.length;
  counts.jobs_succeeded = succeeded;
  counts.jobs_failed = failed;
  counts.jobs_running = running;
  if (listing.truncated) signals.push("jobs_truncated");
  const lastSuccess = dig(live, "status", "lastSuccessfulTime");
  const lastSchedule = dig(live, "status", "lastScheduleTime");
  let health: HealthState = "unknown";
  if (latestFinished?.outcome === "failed") {
    health = "unhealthy";
    signals.push("last_run_failed");
    if (latestFinished.signal) signals.push(latestFinished.signal);
  } else if (latestFinished?.outcome === "succeeded") {
    health = "healthy";
  } else if (typeof lastSuccess === "string" && typeof lastSchedule === "string" && lastSuccess >= lastSchedule) {
    // history limits of 0 remove finished Jobs; the CronJob still records the last success
    health = "healthy";
  } else if (running > 0) {
    signals.push("first_run_in_progress");
  }
  return { part: { counts, signals }, health };
}
