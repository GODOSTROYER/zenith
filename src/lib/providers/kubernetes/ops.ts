/**
 * Day-two operations on Kubernetes workloads: restart, scale, logs, events.
 *
 * Every operation re-checks, immediately before acting, that the target object
 * exists, is in an allowed namespace, and carries Zenith's ownership marks for
 * THIS environment AND this node's address. Namespace and name are derived
 * from the node; nothing the caller (a model, an API client) supplies can
 * choose a different object.
 *
 * Field managers. Day-two changes use `zenith-ops`, not `zenith`:
 *   server-side apply REPLACES the applying manager's whole applied set, so a
 *   partial apply under `zenith` (just the restart annotation) would delete
 *   every other field `zenith` owns. `zenith-ops` owns only what it sets, so
 *   the next declarative apply neither conflicts with it nor removes it.
 *
 * Honest limits:
 *   - restart is refused with a field-manager conflict when another manager
 *     (for example `kubectl rollout restart`) already owns
 *     `kubectl.kubernetes.io/restartedAt` with a different value; Zenith does
 *     not force (ADR-0015).
 *   - scale is a merge patch on the scale subresource (an Update by
 *     `zenith-ops`). A later declarative apply that wants a different replica
 *     count will report a conflict rather than silently undoing the change.
 *   - logs and event text are EXTERNAL DATA: bounded, credential-redacted, and
 *     returned as data, never interpreted.
 */
import { PatchStrategy, setHeaderOptions, type KubernetesObject } from "@kubernetes/client-node";
import type { DriverContext, NativeOperationResult } from "@/lib/drivers/types";
import type { KubernetesSession } from "@/lib/credentials/types";
import type { ResourceNode } from "@/lib/resources/types";
import { READ_ONLY_KINDS, conflictsFrom, createK8sClient, isNamespacedKind, listByKind, listObjects, ownedBy, readObject, toK8sError, type K8sClient } from "./client";
import { ANNOTATION, K8sError, OPS_FIELD_MANAGER, type ObjectRef, type SupportedKind } from "./types";
import { rollback, rollbackStatefulSet } from "./rollout";
import { targetFor } from "./target";
import { dig, isRecord, plain, redactText, truncate } from "./util";

type Ctx = DriverContext<KubernetesSession>;

export const MAX_SCALE = 1000;
export const LOG_DEFAULTS = { tailLines: 200, maxTailLines: 2000, limitBytes: 64 * 1024, maxLimitBytes: 256 * 1024 } as const;

/* ------------------------------ common target ------------------------------ */

interface OwnedTarget {
  client: K8sClient;
  ref: ObjectRef;
  live: Record<string, unknown>;
}

/** GET the node's object and refuse unless Zenith owns it for this environment and address. */
export async function loadOwned(ctx: Ctx, node: ResourceNode, kind: SupportedKind): Promise<OwnedTarget> {
  const ref = targetFor(kind, node, ctx.environmentId);
  const client = createK8sClient(ctx.session, { signal: ctx.signal, environmentId: ctx.environmentId });
  if (isNamespacedKind(kind)) await client.guard.assert(ref.namespace as string);
  const live = await readObject(client, ref);
  if (!live) throw new K8sError("not_found", `${kind} ${ref.name} does not exist in ${ref.namespace ?? "the cluster"}.`);
  const own = ownedBy(live, ctx.environmentId);
  if (!own.owned) throw new K8sError("ownership_conflict", `${kind} ${ref.name} is not managed by Zenith for this environment (${own.reason}); refusing to act on it.`);
  if (dig(live, "metadata", "annotations", ANNOTATION.resource) !== node.address) {
    throw new K8sError("ownership_conflict", `${kind} ${ref.name} belongs to a different resource than ${node.address}; refusing to act on it.`);
  }
  return { client, ref, live };
}

function failure(summary: string, e: unknown): NativeOperationResult {
  const err = toK8sError(e);
  return { ok: false, summary: `${summary}: ${err.message}`, data: { code: err.code }, simulated: false };
}

/**
 * The StatefulSet driver also serves the dev-tier postgres/redis nodes, which are a fixed single replica
 * with no revision history to roll back to. Scale and rollback are for native StatefulSets only.
 */
function refuseDevTierStateful(node: ResourceNode, operation: string): NativeOperationResult | undefined {
  if (node.nativeType === "k8s:StatefulSet" && node.kind !== "provider_native") {
    return { ok: false, summary: `${operation} does not apply to the single-replica dev-tier ${node.kind}; declare a native k8s:StatefulSet for a scalable workload.`, data: { code: "unsupported" }, simulated: false };
  }
  return undefined;
}

const workloadKind = (node: ResourceNode): SupportedKind => {
  if (node.nativeType === "k8s:StatefulSet") return "StatefulSet";
  if (node.nativeType === "k8s:CronJob") return "CronJob";
  return "Deployment";
};

/* --------------------------------- restart --------------------------------- */

/**
 * `service.restart`: set `kubectl.kubernetes.io/restartedAt` on the pod template
 * (what `kubectl rollout restart` does) by server-side apply under `zenith-ops`.
 * The annotation VALUE is the operation id, so replaying the same operation is a
 * no-op instead of a second restart.
 */
export async function restartWorkload(ctx: Ctx, node: ResourceNode): Promise<NativeOperationResult> {
  const kind = workloadKind(node);
  if (kind !== "Deployment" && kind !== "StatefulSet") return { ok: false, summary: `service.restart does not apply to ${kind}.`, simulated: false };
  try {
    const { client, ref, live } = await loadOwned(ctx, node, kind);
    const opId = ctx.operationId ?? `ts-${ctx.now().toISOString()}`;
    const current = dig(live, "spec", "template", "metadata", "annotations", ANNOTATION.restartedAt);
    const generation = dig(live, "metadata", "generation");
    if (current === opId) {
      return {
        ok: true,
        summary: `${kind} ${ref.name} was already restarted by this operation.`,
        data: { kind, name: ref.name, namespace: ref.namespace, restartedAt: opId, alreadyApplied: true, generation },
        simulated: false,
      };
    }
    const body = {
      apiVersion: ref.apiVersion,
      kind,
      metadata: {
        name: ref.name,
        namespace: ref.namespace,
        annotations: {
          [ANNOTATION.lastOperation]: opId,
          ...(ctx.fence ? { [ANNOTATION.fenceToken]: String(ctx.fence.token) } : {}),
        },
      },
      spec: { template: { metadata: { annotations: { [ANNOTATION.restartedAt]: opId } } } },
    };
    const got = plain<Record<string, unknown>>(
      await client.objects.patch(body as KubernetesObject, undefined, undefined, OPS_FIELD_MANAGER, false, PatchStrategy.ServerSideApply)
    );
    return {
      ok: true,
      summary: `Restarted ${kind} ${ref.name}; its pods are rolling.`,
      data: { kind, name: ref.name, namespace: ref.namespace, restartedAt: opId, alreadyApplied: false, generation: dig(got, "metadata", "generation") },
      simulated: false,
    };
  } catch (e) {
    const conflicts = conflictsFrom(e);
    if (conflicts.length > 0) {
      const who = [...new Set(conflicts.map((c) => c.manager).filter(Boolean))].join(", ") || "another manager";
      return {
        ok: false,
        summary: `Restart blocked: ${ANNOTATION.restartedAt} is owned by ${who}. Zenith does not force field ownership.`,
        data: { code: "field_conflict", managers: [...new Set(conflicts.map((c) => c.manager).filter(Boolean))] },
        simulated: false,
      };
    }
    return failure("Restart failed", e);
  }
}

/* --------------------------------- rollback -------------------------------- */

/**
 * `deployment.rollback`: see `rollback()` in rollout.ts for the kubectl-undo equivalence and its limits.
 * A StatefulSet rolls back through its ControllerRevisions (`rollbackStatefulSet`); its volumes are never
 * touched, so the previous revision must be able to read what the newer one wrote.
 */
export async function rollbackWorkload(ctx: Ctx, node: ResourceNode, input: Record<string, unknown>): Promise<NativeOperationResult> {
  try {
    const to = input.toRevision;
    if (to !== undefined && (typeof to !== "number" || !Number.isInteger(to) || to < 1)) throw new K8sError("bad_input", "toRevision must be a positive integer.");
    const kind = workloadKind(node);
    if (kind !== "Deployment" && kind !== "StatefulSet") throw new K8sError("unsupported", "deployment.rollback applies to Deployments and StatefulSets.");
    const dev = refuseDevTierStateful(node, "deployment.rollback");
    if (dev) return dev;
    const { ref } = await loadOwned(ctx, node, kind);
    const run = kind === "Deployment" ? rollback : rollbackStatefulSet;
    const r = await run({ namespace: ref.namespace as string, name: ref.name }, ctx.session, {
      signal: ctx.signal,
      environmentId: ctx.environmentId,
      toRevision: to as number | undefined,
      operationId: ctx.operationId,
    });
    return {
      ok: true,
      summary:
        r.status === "already_applied"
          ? `${kind} ${ref.name} is already at revision ${r.toRevision}.`
          : `Rolled back ${kind} ${ref.name} from revision ${r.fromRevision} to ${r.toRevision}; its pods are rolling${kind === "StatefulSet" ? " in reverse ordinal order. Its volumes were not changed." : "."}`,
      data: { kind, name: ref.name, namespace: ref.namespace, ...r },
      simulated: false,
    };
  } catch (e) {
    return failure("Rollback failed", e);
  }
}

/* ---------------------------------- scale ---------------------------------- */

/**
 * `service.scale`: set the replica count through the scale subresource.
 * StatefulSets scale one ordinal at a time. A scale-down of a StatefulSet whose
 * retention policy deletes claims on scale (`whenScaled: Delete`) destroys the
 * removed ordinals' data and is refused unless the input acknowledges it.
 */
export async function scaleWorkload(ctx: Ctx, node: ResourceNode, input: Record<string, unknown>): Promise<NativeOperationResult> {
  const replicas = input.replicas;
  if (typeof replicas !== "number" || !Number.isInteger(replicas) || replicas < 0 || replicas > MAX_SCALE) {
    return { ok: false, summary: `replicas must be an integer between 0 and ${MAX_SCALE}.`, data: { code: "bad_input" }, simulated: false };
  }
  const kind = workloadKind(node);
  if (kind !== "Deployment" && kind !== "StatefulSet") return { ok: false, summary: `service.scale applies to Deployments and StatefulSets, not ${kind}.`, data: { code: "unsupported" }, simulated: false };
  const dev = refuseDevTierStateful(node, "service.scale");
  if (dev) return dev;
  try {
    const { client, ref, live } = await loadOwned(ctx, node, kind);
    const hpa = await findHpa(client, ref, kind);
    if (hpa) {
      return {
        ok: false,
        summary: `${kind} ${ref.name} is managed by HorizontalPodAutoscaler ${hpa}; it would undo a manual scale. Change the spec replicas (min) instead.`,
        data: { code: "hpa_manages_replicas", hpa },
        simulated: false,
      };
    }
    const from = dig(live, "spec", "replicas");
    const previous = typeof from === "number" ? from : 1;
    if (previous === replicas) {
      return { ok: true, summary: `${kind} ${ref.name} already has ${replicas} replica(s).`, data: { from: previous, to: replicas, alreadyApplied: true }, simulated: false };
    }
    if (kind === "StatefulSet" && replicas < previous && dig(live, "spec", "persistentVolumeClaimRetentionPolicy", "whenScaled") === "Delete" && input.acknowledgeDataLoss !== true) {
      return {
        ok: false,
        summary: `StatefulSet ${ref.name} deletes the volume claims of removed ordinals when scaled down (whenScaled: Delete). Scaling from ${previous} to ${replicas} destroys that data; pass acknowledgeDataLoss: true to proceed.`,
        data: { code: "data_loss_unacknowledged", from: previous, to: replicas },
        simulated: false,
      };
    }
    const patch = { name: ref.name, namespace: ref.namespace as string, body: { spec: { replicas } }, fieldManager: OPS_FIELD_MANAGER };
    if (kind === "Deployment") await client.apps.patchNamespacedDeploymentScale(patch, setHeaderOptions("Content-Type", PatchStrategy.MergePatch));
    else await client.apps.patchNamespacedStatefulSetScale(patch, setHeaderOptions("Content-Type", PatchStrategy.MergePatch));
    return { ok: true, summary: `Scaled ${kind} ${ref.name} from ${previous} to ${replicas}.`, data: { from: previous, to: replicas, alreadyApplied: false }, simulated: false };
  } catch (e) {
    return failure("Scale failed", e);
  }
}

async function findHpa(client: K8sClient, ref: ObjectRef, kind: "Deployment" | "StatefulSet" = "Deployment"): Promise<string | undefined> {
  try {
    const list = await listObjects(client, "HorizontalPodAutoscaler", ref.namespace as string, { limit: 100, maxPages: 1 });
    const hit = list.items.find((h) => dig(h, "spec", "scaleTargetRef", "name") === ref.name && dig(h, "spec", "scaleTargetRef", "kind") === kind);
    const name = dig(hit, "metadata", "name");
    return typeof name === "string" ? name : undefined;
  } catch (e) {
    const err = toK8sError(e);
    // no HPA API (or not allowed to list) means there is nothing we can see that would revert the scale
    if (err.code === "not_found" || err.code === "unsupported" || err.code === "forbidden") return undefined;
    throw err;
  }
}

/* ----------------------------------- pods ---------------------------------- */

function selectorOf(live: Record<string, unknown>): string | undefined {
  const match = dig(live, "spec", "selector", "matchLabels");
  if (!isRecord(match)) return undefined;
  const parts = Object.entries(match).filter(([, v]) => typeof v === "string").sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v as string}`);
  return parts.length > 0 ? parts.join(",") : undefined;
}

async function podsOf(client: K8sClient, live: Record<string, unknown>, namespace: string, limit = 50): Promise<Record<string, unknown>[]> {
  const labelSelector = selectorOf(live);
  if (!labelSelector) return [];
  return (await listByKind(client, READ_ONLY_KINDS.Pod, namespace, { labelSelector, limit, maxPages: 1 })).items;
}

/* ----------------------------------- logs ---------------------------------- */

const POD_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const CONTAINER_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

function intInput(v: unknown, def: number, min: number, max: number, label: string): number {
  if (v === undefined) return def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new K8sError("bad_input", `${label} must be an integer between ${min} and ${max}.`);
  return v;
}

/** `container.logs`: a bounded, redacted tail of one pod's log. */
export async function readLogs(ctx: Ctx, node: ResourceNode, input: Record<string, unknown>): Promise<NativeOperationResult> {
  try {
    const tailLines = intInput(input.tailLines, LOG_DEFAULTS.tailLines, 1, LOG_DEFAULTS.maxTailLines, "tailLines");
    const limitBytes = intInput(input.limitBytes, LOG_DEFAULTS.limitBytes, 1, LOG_DEFAULTS.maxLimitBytes, "limitBytes");
    const sinceSeconds = input.sinceSeconds === undefined ? undefined : intInput(input.sinceSeconds, 0, 1, 86_400, "sinceSeconds");
    const previous = input.previous === true;
    if (input.pod !== undefined && (typeof input.pod !== "string" || !POD_NAME.test(input.pod))) throw new K8sError("bad_input", "pod is not a valid pod name.");
    if (input.container !== undefined && (typeof input.container !== "string" || !CONTAINER_NAME.test(input.container))) throw new K8sError("bad_input", "container is not a valid container name.");

    const kind = workloadKind(node);
    const { client, ref, live } = await loadOwned(ctx, node, kind);
    const pods = await podsOf(client, live, ref.namespace as string);
    if (pods.length === 0) return { ok: false, summary: `No pods found for ${kind} ${ref.name}.`, data: { code: "no_pods" }, simulated: false };
    const byName = new Map(pods.map((p) => [String(dig(p, "metadata", "name")), p]));
    let podName: string;
    if (typeof input.pod === "string") {
      if (!byName.has(input.pod)) throw new K8sError("not_found", `Pod ${input.pod} does not belong to ${kind} ${ref.name}.`);
      podName = input.pod;
    } else {
      const ranked = [...byName.entries()].sort(([an, a], [bn, b]) => {
        const running = (p: Record<string, unknown>) => (dig(p, "status", "phase") === "Running" ? 1 : 0);
        const ts = (p: Record<string, unknown>) => String(dig(p, "metadata", "creationTimestamp") ?? "");
        return running(b) - running(a) || (ts(b) < ts(a) ? -1 : ts(b) > ts(a) ? 1 : 0) || (an < bn ? -1 : 1);
      });
      podName = ranked[0][0];
    }
    const text = await client.core.readNamespacedPodLog({
      name: podName,
      namespace: ref.namespace as string,
      container: input.container as string | undefined,
      tailLines,
      limitBytes,
      previous,
      ...(sinceSeconds !== undefined ? { sinceSeconds } : {}),
    });
    const raw = typeof text === "string" ? text : String(text ?? "");
    const truncated = raw.length > limitBytes;
    const body = redactText(truncate(raw, limitBytes));
    return {
      ok: true,
      summary: `Read ${body === "" ? 0 : body.split("\n").length} log line(s) from pod ${podName}.`,
      data: { pod: podName, container: input.container ?? null, previous, lines: body === "" ? 0 : body.split("\n").length, truncated, text: body },
      simulated: false,
    };
  } catch (e) {
    return failure("Reading logs failed", e);
  }
}

/* ---------------------------------- events --------------------------------- */

export const EVENT_DEFAULT_LIMIT = 30;

/** `events.read`: recent events for the node's object and its pods, newest first, bounded and redacted. */
export async function readEvents(ctx: Ctx, node: ResourceNode, input: Record<string, unknown> = {}): Promise<NativeOperationResult> {
  try {
    const limit = intInput(input.limit, EVENT_DEFAULT_LIMIT, 1, 100, "limit");
    const kind = workloadKind(node);
    const ref = targetFor(kind, node, ctx.environmentId);
    const client = createK8sClient(ctx.session, { signal: ctx.signal, environmentId: ctx.environmentId });
    await client.guard.assert(ref.namespace as string);
    const names = new Set<string>([ref.name]);
    const live = await readObject(client, ref);
    if (live) for (const p of await podsOf(client, live, ref.namespace as string, 100)) names.add(String(dig(p, "metadata", "name")));
    const list = await listByKind(client, READ_ONLY_KINDS.Event, ref.namespace as string, { limit: 500, maxPages: 1 });
    const when = (e: Record<string, unknown>) => String(dig(e, "lastTimestamp") ?? dig(e, "eventTime") ?? dig(e, "metadata", "creationTimestamp") ?? "");
    const events = list.items
      .filter((e) => names.has(String(dig(e, "involvedObject", "name"))))
      .sort((a, b) => (when(b) < when(a) ? -1 : when(b) > when(a) ? 1 : 0))
      .slice(0, limit)
      .map((e) => ({
        type: dig(e, "type") === "Warning" ? "Warning" : "Normal",
        reason: truncate(String(dig(e, "reason") ?? ""), 64),
        message: truncate(redactText(String(dig(e, "message") ?? "")), 300),
        count: typeof dig(e, "count") === "number" ? dig(e, "count") : 1,
        last: when(e) || null,
        object: { kind: String(dig(e, "involvedObject", "kind") ?? ""), name: String(dig(e, "involvedObject", "name") ?? "") },
      }));
    return { ok: true, summary: `Read ${events.length} event(s) for ${kind} ${ref.name}.`, data: { events, namespace: ref.namespace, name: ref.name }, simulated: false };
  } catch (e) {
    return failure("Reading events failed", e);
  }
}
