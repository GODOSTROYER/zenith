/**
 * Waiting for a rollout and rolling back.
 *
 * waitForRollout follows `kubectl rollout status`: the controller has observed
 * the latest generation, every replica is updated, no old replicas remain, and
 * all updated replicas are available; `ProgressDeadlineExceeded` is a failure.
 *
 * rollback is the server-side-apply equivalent of `kubectl rollout undo`:
 *   kubectl  replaces `spec.template` with the target ReplicaSet's template
 *            (minus the controller's `pod-template-hash` label) via a JSON patch.
 *   here     the same template swap, but applied with SSA under the `zenith`
 *            manager. Because SSA replaces the manager's whole applied set, the
 *            apply body is what `zenith` currently owns (`extractOwned`) with
 *            only `spec.template` replaced; replicas, strategy, labels and the
 *            rest survive. The Deployment controller then rolls the pods and
 *            bumps `deployment.kubernetes.io/revision` exactly as for undo.
 * Differences from kubectl: ownership is preserved (no `Update` manager entry),
 * `force` is false (a conflicting manager blocks the rollback and is reported),
 * and `kubectl.kubernetes.io/restartedAt` is dropped from the restored template
 * because the operations manager owns that field (restoring it would conflict).
 *
 * Idempotency: with `operationId`, the applied object records it in
 * `zenith.dev/last-rollback`; a retry of the same operation returns
 * `already_applied` instead of rolling back one revision further. The marker is
 * part of what `zenith` owns, so the next declarative apply removes it.
 *
 * Honest limit: exercised against a fake API server that models revisions,
 * ReplicaSets and server-side-apply ownership; not yet a real cluster.
 */
import { PatchStrategy, type KubernetesObject } from "@kubernetes/client-node";
import type { KubernetesSession } from "@/lib/credentials/types";
import { READ_ONLY_KINDS, conflictsFrom, createK8sClient, listByKind, ownedBy, readObject, toK8sError, type K8sClient } from "./client";
import { extractOwned } from "./fields";
import { ANNOTATION, FIELD_MANAGER, K8sError } from "./types";
import { dig, isRecord, plain } from "./util";

const sleepDefault = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new K8sError("aborted", "The operation was aborted."));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new K8sError("aborted", "The operation was aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/* ------------------------------- rollout wait ------------------------------ */

export interface RolloutSnapshot {
  generation?: number;
  observedGeneration?: number;
  desiredReplicas: number;
  replicas?: number;
  updatedReplicas?: number;
  readyReplicas?: number;
  availableReplicas?: number;
}

export type RolloutState = "complete" | "failed" | "timeout" | "aborted" | "not_found";

export interface RolloutResult {
  state: RolloutState;
  /** plain-language; no object content */
  reason: string;
  snapshot?: RolloutSnapshot;
  polls: number;
}

export interface RolloutOptions {
  kind?: "Deployment" | "StatefulSet";
  signal?: AbortSignal;
  /** default 300 000 ms */
  timeoutMs?: number;
  /** default 2 000 ms */
  pollIntervalMs?: number;
  environmentId?: string;
  requestTimeoutMs?: number;
  /** injectable for tests */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Evaluate a live Deployment or StatefulSet against the rollout-complete rules. Pure. */
export function evaluateRollout(kind: "Deployment" | "StatefulSet", live: Record<string, unknown>): { done: boolean; failed?: string; reason: string; snapshot: RolloutSnapshot } {
  const gen = num(dig(live, "metadata", "generation"));
  const status = isRecord(live.status) ? live.status : {};
  const observed = num(status.observedGeneration);
  const desired = num(dig(live, "spec", "replicas")) ?? 1;
  const snapshot: RolloutSnapshot = {
    generation: gen,
    observedGeneration: observed,
    desiredReplicas: desired,
    replicas: num(status.replicas),
    updatedReplicas: num(status.updatedReplicas),
    readyReplicas: num(status.readyReplicas),
    availableReplicas: num(status.availableReplicas),
  };
  if (gen !== undefined && (observed ?? 0) < gen) return { done: false, reason: "waiting for the controller to observe the latest spec", snapshot };

  if (kind === "Deployment") {
    const conditions = Array.isArray(status.conditions) ? status.conditions : [];
    const progressing = conditions.find((c) => isRecord(c) && c.type === "Progressing");
    if (isRecord(progressing) && progressing.reason === "ProgressDeadlineExceeded") {
      return { done: false, failed: "ProgressDeadlineExceeded", reason: "the rollout exceeded its progress deadline", snapshot };
    }
    const updated = snapshot.updatedReplicas ?? 0;
    if (updated < desired) return { done: false, reason: `${updated} of ${desired} replicas updated`, snapshot };
    if ((snapshot.replicas ?? 0) > updated) return { done: false, reason: "old replicas are still terminating", snapshot };
    if ((snapshot.availableReplicas ?? 0) < updated) return { done: false, reason: `${snapshot.availableReplicas ?? 0} of ${updated} updated replicas available`, snapshot };
    return { done: true, reason: "rollout complete", snapshot };
  }

  const ready = snapshot.readyReplicas ?? 0;
  if (ready < desired) return { done: false, reason: `${ready} of ${desired} replicas ready`, snapshot };
  if ((snapshot.updatedReplicas ?? 0) < desired) return { done: false, reason: `${snapshot.updatedReplicas ?? 0} of ${desired} replicas updated`, snapshot };
  const current = status.currentRevision;
  const update = status.updateRevision;
  if (typeof update === "string" && current !== update) return { done: false, reason: "waiting for the update revision to become current", snapshot };
  return { done: true, reason: "rollout complete", snapshot };
}

const TRANSIENT = new Set(["api_error", "unreachable", "timeout"]);

export async function waitForRollout(
  target: { namespace: string; name: string },
  session: KubernetesSession,
  opts: RolloutOptions = {}
): Promise<RolloutResult> {
  const kind = opts.kind ?? "Deployment";
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const poll = Math.max(1, opts.pollIntervalMs ?? 2000);
  const sleep = opts.sleep ?? sleepDefault;
  const now = opts.now ?? Date.now;
  const client = createK8sClient(session, { signal: opts.signal, environmentId: opts.environmentId, requestTimeoutMs: opts.requestTimeoutMs });
  await client.guard.assert(target.namespace);
  const ref = { apiVersion: "apps/v1", kind, namespace: target.namespace, name: target.name };
  const deadline = now() + timeoutMs;
  let polls = 0;
  let last: RolloutSnapshot | undefined;
  let transient = 0;
  for (;;) {
    if (opts.signal?.aborted) return { state: "aborted", reason: "aborted", snapshot: last, polls };
    polls++;
    try {
      const live = await readObject(client, ref);
      transient = 0;
      if (!live) return { state: "not_found", reason: `${kind} ${target.name} does not exist`, snapshot: last, polls };
      const ev = evaluateRollout(kind, live);
      last = ev.snapshot;
      if (ev.failed) return { state: "failed", reason: `${ev.failed}: ${ev.reason}`, snapshot: last, polls };
      if (ev.done) return { state: "complete", reason: ev.reason, snapshot: last, polls };
      if (now() >= deadline) return { state: "timeout", reason: `timed out after ${timeoutMs} ms: ${ev.reason}`, snapshot: last, polls };
    } catch (e) {
      const err = toK8sError(e);
      if (err.code === "aborted") return { state: "aborted", reason: "aborted", snapshot: last, polls };
      if (!TRANSIENT.has(err.code) || ++transient > 3) throw err;
      if (now() >= deadline) return { state: "timeout", reason: `timed out after ${timeoutMs} ms (API errors)`, snapshot: last, polls };
    }
    try {
      await sleep(Math.min(poll, Math.max(1, deadline - now())), opts.signal);
    } catch {
      return { state: "aborted", reason: "aborted", snapshot: last, polls };
    }
  }
}

/* --------------------------------- rollback -------------------------------- */

export interface RollbackOptions {
  signal?: AbortSignal;
  /** required: rollback is only ever applied to an object owned by this environment */
  environmentId: string;
  /** roll back to this revision (default: the one before the current revision) */
  toRevision?: number;
  /** retries of the same operation do not roll back further */
  operationId?: string;
  requestTimeoutMs?: number;
}

export interface RollbackResult {
  status: "rolled_back" | "already_applied";
  fromRevision: number;
  toRevision: number;
  generation?: number;
}

const revisionOf = (o: Record<string, unknown>): number | undefined => {
  const raw = dig(o, "metadata", "annotations", ANNOTATION.revision);
  const n = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

function selectorString(matchLabels: unknown): string | undefined {
  if (!isRecord(matchLabels)) return undefined;
  const parts = Object.entries(matchLabels)
    .filter(([, v]) => typeof v === "string")
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v as string}`);
  return parts.length > 0 ? parts.join(",") : undefined;
}

async function replicaSetsOf(client: K8sClient, deployment: Record<string, unknown>, namespace: string): Promise<Record<string, unknown>[]> {
  const selector = selectorString(dig(deployment, "spec", "selector", "matchLabels"));
  if (!selector) throw new K8sError("rollback_unavailable", "The Deployment has no label selector to find its ReplicaSets.");
  const uid = dig(deployment, "metadata", "uid");
  const { items } = await listByKind(client, READ_ONLY_KINDS.ReplicaSet, namespace, { labelSelector: selector, limit: 100, maxPages: 2 });
  return items.filter((rs) => {
    const owners = dig(rs, "metadata", "ownerReferences");
    return Array.isArray(owners) && owners.some((o) => isRecord(o) && o.kind === "Deployment" && (uid === undefined || o.uid === uid));
  });
}

/** The pod template of a ReplicaSet as a Deployment would hold it: no controller hash, no restart marker. */
function restorableTemplate(rs: Record<string, unknown>): Record<string, unknown> {
  const template = plain<Record<string, unknown>>(dig(rs, "spec", "template") ?? {});
  const meta = isRecord(template.metadata) ? template.metadata : (template.metadata = {});
  if (meta.creationTimestamp === null) delete meta.creationTimestamp;
  if (isRecord(meta.labels)) delete meta.labels["pod-template-hash"];
  if (isRecord(meta.annotations)) {
    delete meta.annotations[ANNOTATION.restartedAt];
    if (Object.keys(meta.annotations).length === 0) delete meta.annotations;
  }
  return template;
}

export async function rollback(target: { namespace: string; name: string }, session: KubernetesSession, opts: RollbackOptions): Promise<RollbackResult> {
  const client = createK8sClient(session, { signal: opts.signal, environmentId: opts.environmentId, requestTimeoutMs: opts.requestTimeoutMs });
  await client.guard.assert(target.namespace);
  const ref = { apiVersion: "apps/v1", kind: "Deployment", namespace: target.namespace, name: target.name };
  const live = await readObject(client, ref);
  if (!live) throw new K8sError("not_found", `Deployment ${target.name} does not exist.`);
  const own = ownedBy(live, opts.environmentId);
  if (!own.owned) throw new K8sError("ownership_conflict", `Deployment ${target.name} is not managed by Zenith for this environment (${own.reason}); not rolled back.`);

  const current = revisionOf(live);
  if (current === undefined) throw new K8sError("rollback_unavailable", "The Deployment has no revision yet; there is nothing to roll back to.");
  if (opts.operationId && dig(live, "metadata", "annotations", ANNOTATION.lastRollback) === opts.operationId) {
    return { status: "already_applied", fromRevision: current, toRevision: current };
  }

  const sets = await replicaSetsOf(client, live, target.namespace);
  const byRevision = new Map<number, Record<string, unknown>>();
  for (const rs of sets) {
    const r = revisionOf(rs);
    if (r !== undefined) byRevision.set(r, rs);
  }
  let wanted = opts.toRevision;
  if (wanted === undefined) {
    const earlier = [...byRevision.keys()].filter((r) => r < current).sort((a, b) => b - a);
    wanted = earlier[0];
  }
  if (wanted === undefined) throw new K8sError("rollback_unavailable", "There is no earlier revision to roll back to.");
  if (wanted === current) return { status: "already_applied", fromRevision: current, toRevision: current };
  const rs = byRevision.get(wanted);
  if (!rs) throw new K8sError("rollback_unavailable", `Revision ${wanted} is not in the Deployment's history (revisionHistoryLimit may have pruned it).`);

  const owned = extractOwned(live, FIELD_MANAGER);
  if (!owned) {
    throw new K8sError("rollback_unavailable", "No server-side-apply ownership record for field manager zenith; refusing to rewrite the Deployment.");
  }
  const spec = isRecord(owned.spec) ? owned.spec : {};
  const meta = isRecord(owned.metadata) ? owned.metadata : {};
  const annotations = isRecord(meta.annotations) ? { ...meta.annotations } : {};
  if (opts.operationId) annotations[ANNOTATION.lastRollback] = opts.operationId;
  const body = {
    ...owned,
    metadata: { ...meta, ...(Object.keys(annotations).length > 0 ? { annotations } : {}) },
    spec: { ...spec, template: restorableTemplate(rs) },
  };

  try {
    const got = plain<Record<string, unknown>>(
      await client.objects.patch(body as KubernetesObject, undefined, undefined, FIELD_MANAGER, false, PatchStrategy.ServerSideApply)
    );
    const generation = num(dig(got, "metadata", "generation"));
    return { status: "rolled_back", fromRevision: current, toRevision: wanted, generation };
  } catch (e) {
    const conflicts = conflictsFrom(e);
    if (conflicts.length > 0) {
      throw new K8sError("field_conflict", `Rollback blocked: ${conflicts.length} field(s) are owned by another manager (${conflicts.map((c) => c.field).slice(0, 6).join(", ")}). Zenith does not force.`, 409);
    }
    throw toK8sError(e);
  }
}
