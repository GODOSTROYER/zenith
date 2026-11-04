/**
 * provider_native `k8s:StatefulSet` → headless Service + StatefulSet with
 * volumeClaimTemplates; `k8s:CronJob` → CronJob (PROD-LIFE-07).
 *
 * StatefulSet guarantees, all rendered rather than left to cluster defaults:
 *   - ordered rollout: `podManagementPolicy: OrderedReady` (default) and a
 *     RollingUpdate whose `partition` is explicit. Ordinals >= partition get
 *     the new revision, highest first; a partition above 0 stages a rollout.
 *   - persistent data: one claim template per volume. The template carries
 *     Zenith's ownership marks (labels and the resource/environment annotations,
 *     but NOT the spec digest: claim templates are immutable, and a digest that
 *     changes with every spec edit would make every later apply fail), so the
 *     PVCs the controller creates are positively owned and teardown can find
 *     and delete them, and only them.
 *   - explicit PVC retention. The cluster default (Retain/Retain) is rendered
 *     out loud. `Delete` is refused unless the config acknowledges data loss.
 *   - the pod hardening every Zenith workload gets (non-root, seccomp, no
 *     escalation, no capabilities, read-only root with a bounded /tmp).
 *
 * Honest limits:
 *   - volumeClaimTemplates, selector, serviceName and podManagementPolicy are
 *     immutable in Kubernetes. A change is refused before any object is applied
 *     (apply preflight, `immutability.ts`); growing a volume needs the claims
 *     expanded in place, which this renderer does not do.
 *   - `runAsNonRoot` without `runAsUser` needs an image with a non-root USER.
 *   - `persistentVolumeClaimRetentionPolicy` needs Kubernetes 1.32 or newer; an
 *     older API server drops the field, and observe then reports the mismatch.
 */
import { parseNativeConfig } from "@/lib/resources/native-registry";
import type { CronJobNativeConfig, StatefulSetNativeConfig } from "@/lib/resources/native-k8s-workloads";
import type { ResourceNode } from "@/lib/resources/types";
import { ANNOTATION, LABEL, MANAGED_BY_VALUE, type K8sObject, type K8sRenderContext, type RenderResult } from "../types";
import { objectName } from "../naming";
import { isRecord } from "../util";
import { TMP_MOUNT, computeResources, ctxNamespace, metadata, renderError, selectorLabels, specOf } from "./common";
import {
  NEVER,
  buildCronJob,
  checkSchedule,
  httpProbes,
  podParts,
  readCronPolicy,
  renderEnv,
} from "./workload";

export const VOLUME_CLAIM_ANNOTATIONS = [ANNOTATION.resource, ANNOTATION.environment] as const;

function parseNative<T>(node: ResourceNode): T {
  const spec = specOf(node);
  const parsed = parseNativeConfig(node.provider, node.nativeType, spec.config);
  if (!parsed.ok) {
    const first = parsed.issues[0];
    throw renderError(`${node.address}: ${first.path.length ? `config.${first.path.join(".")}: ` : ""}${first.message}`);
  }
  return parsed.config as T;
}

export const statefulConfigOf = (node: ResourceNode): StatefulSetNativeConfig => parseNative<StatefulSetNativeConfig>(node);
export const cronConfigOf = (node: ResourceNode): CronJobNativeConfig => parseNative<CronJobNativeConfig>(node);

/** `StatefulSet` claim name for a volume: `<claim>-<statefulset>-<ordinal>` is the PVC the controller makes. */
export const claimTemplateName = (claim: string): string => claim;

/** The Pod's volume name for a claim template (identical to the template name, so the mount binds to it). */
const volumeName = (claim: string): string => claim;

export function renderStatefulSet(node: ResourceNode, ctx: K8sRenderContext): RenderResult {
  const cfg = statefulConfigOf(node);
  const notes: string[] = [];
  const namespace = ctxNamespace(node, ctx);
  const name = objectName(node);
  const selector = selectorLabels(node, ctx);

  const container: Record<string, unknown> = {
    name: "app",
    image: cfg.image,
    ...(cfg.command ? { command: cfg.command } : {}),
    ...(cfg.args ? { args: cfg.args } : {}),
    ...(cfg.port !== undefined ? { ports: [{ name: "http", containerPort: cfg.port, protocol: "TCP" }] } : {}),
    env: renderEnv(node, cfg.env),
    resources: computeResources(node, cfg.vcpu, cfg.memoryMb),
  };
  if (cfg.healthPath !== undefined) Object.assign(container, httpProbes(cfg.healthPath, cfg.port !== undefined));
  else if (cfg.readinessCommand !== undefined) {
    container.readinessProbe = { exec: { command: cfg.readinessCommand }, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 6 };
  } else if (cfg.port !== undefined) {
    container.readinessProbe = { tcpSocket: { port: "http" }, periodSeconds: 10, failureThreshold: 3 };
  } else {
    notes.push(`${node.address}: no port, healthPath or readinessCommand, so the pods are Ready as soon as they start; ordered rollout then waits on nothing real.`);
  }

  const podCtx: K8sRenderContext = { ...ctx, ...(cfg.runAsUser !== undefined ? { runAsUser: cfg.runAsUser } : {}) };
  const pod = podParts(node, podCtx, container, { component: "stateful", zones: cfg.zones, replicas: cfg.replicas });
  notes.push(...pod.notes);

  // podParts mounts only /tmp; the claims are mounted here.
  const mounts = [...cfg.volumeClaims.map((v) => ({ name: volumeName(v.name), mountPath: v.mountPath })), ...(Array.isArray((pod.spec.containers as Record<string, unknown>[])[0].volumeMounts) ? [TMP_MOUNT] : [])];
  (pod.spec.containers as Record<string, unknown>[])[0].volumeMounts = mounts;
  const sc = isRecord(pod.spec.securityContext) ? pod.spec.securityContext : (pod.spec.securityContext = {});
  const fsGroup = cfg.fsGroup ?? cfg.runAsUser;
  if (fsGroup !== undefined) {
    sc.fsGroup = fsGroup;
    sc.fsGroupChangePolicy = "OnRootMismatch";
  } else {
    notes.push(`${node.address}: no fsGroup or runAsUser, so the volumes keep the storage driver's ownership; a non-root image may not be able to write them.`);
  }
  pod.spec.terminationGracePeriodSeconds = cfg.terminationGracePeriodSeconds;

  const base = metadata(node, ctx, { name, namespace, labels: { [LABEL.name]: name, [LABEL.component]: "stateful" } });
  const claimAnnotations = Object.fromEntries(VOLUME_CLAIM_ANNOTATIONS.map((k) => [k, (base.annotations ?? {})[k]])) as Record<string, string>;
  const claimLabels = { [LABEL.managedBy]: MANAGED_BY_VALUE, [LABEL.partOf]: (base.labels ?? {})[LABEL.partOf], [LABEL.name]: name, [LABEL.component]: "data" };
  const claims = cfg.volumeClaims.map((v) => ({
    metadata: { name: claimTemplateName(v.name), labels: claimLabels, annotations: claimAnnotations },
    spec: {
      accessModes: v.accessModes ?? ["ReadWriteOnce"],
      resources: { requests: { storage: `${v.sizeGb}Gi` } },
      ...(v.storageClass !== undefined ? { storageClassName: v.storageClass } : {}),
    },
  }));

  const sts: K8sObject = {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: base,
    spec: {
      serviceName: name,
      replicas: cfg.replicas,
      podManagementPolicy: cfg.rollout.podManagementPolicy,
      revisionHistoryLimit: cfg.rollout.revisionHistoryLimit,
      ...(cfg.rollout.minReadySeconds > 0 ? { minReadySeconds: cfg.rollout.minReadySeconds } : {}),
      updateStrategy: { type: "RollingUpdate", rollingUpdate: { partition: cfg.rollout.partition } },
      persistentVolumeClaimRetentionPolicy: { whenDeleted: cfg.retention.whenDeleted, whenScaled: cfg.retention.whenScaled },
      selector: { matchLabels: selector },
      template: { metadata: { labels: pod.labels }, spec: pod.spec },
      volumeClaimTemplates: claims,
    },
  };
  const svc: K8sObject = {
    apiVersion: "v1",
    kind: "Service",
    metadata: metadata(node, ctx, { name, namespace, labels: { [LABEL.name]: name } }),
    spec: {
      clusterIP: "None",
      selector,
      ...(cfg.port !== undefined ? { ports: [{ name: "http", port: cfg.port, targetPort: "http", protocol: "TCP" }] } : {}),
    },
  };

  if (cfg.rollout.partition > 0) notes.push(`${node.address}: partition ${cfg.rollout.partition} stages the rollout; ordinals below it keep the old revision until the partition is lowered.`);
  if (cfg.rollout.podManagementPolicy === "Parallel") notes.push(`${node.address}: podManagementPolicy Parallel starts and stops pods together; rollout is still ordinal-ordered but pod start-up is not.`);
  notes.push(`${node.address}: claim templates, selector, serviceName and podManagementPolicy cannot change once applied; a change is refused before anything is applied.`);
  notes.push(
    cfg.retention.whenDeleted === "Retain" && cfg.retention.whenScaled === "Retain"
      ? `${node.address}: PVCs are retained when the StatefulSet is deleted or scaled down; environment teardown removes them only when stateful deletion is allowed.`
      : `${node.address}: PVC retention is ${cfg.retention.whenDeleted}/${cfg.retention.whenScaled} (deleted/scaled) with data loss acknowledged; the cluster removes the claims, and their data, itself.`
  );
  return { objects: [svc, sts], notes };
}

export function renderNativeCronJob(node: ResourceNode, ctx: K8sRenderContext): RenderResult {
  const cfg = cronConfigOf(node);
  checkSchedule(node.address, cfg.schedule);
  const policy = readCronPolicy(node.address, {
    ...(cfg.concurrencyPolicy !== undefined ? { concurrencyPolicy: cfg.concurrencyPolicy } : {}),
    ...(cfg.startingDeadlineSeconds !== undefined ? { startingDeadlineSeconds: cfg.startingDeadlineSeconds } : {}),
    ...(cfg.successfulJobsHistoryLimit !== undefined ? { successfulJobsHistoryLimit: cfg.successfulJobsHistoryLimit } : {}),
    ...(cfg.failedJobsHistoryLimit !== undefined ? { failedJobsHistoryLimit: cfg.failedJobsHistoryLimit } : {}),
    ...(cfg.backoffLimit !== undefined ? { backoffLimit: cfg.backoffLimit } : {}),
    ...(cfg.activeDeadlineSeconds !== undefined ? { activeDeadlineSeconds: cfg.activeDeadlineSeconds } : {}),
    ...(cfg.ttlSecondsAfterFinished !== undefined ? { ttlSecondsAfterFinished: cfg.ttlSecondsAfterFinished } : {}),
    ...(cfg.timeZone !== undefined ? { timeZone: cfg.timeZone } : {}),
  });
  const container: Record<string, unknown> = {
    name: "job",
    image: cfg.image,
    ...(cfg.command ? { command: cfg.command } : {}),
    ...(cfg.args ? { args: cfg.args } : {}),
    env: renderEnv(node, cfg.env),
    resources: computeResources(node, cfg.vcpu, cfg.memoryMb),
  };
  const podCtx: K8sRenderContext = { ...ctx, ...(cfg.runAsUser !== undefined ? { runAsUser: cfg.runAsUser } : {}) };
  return buildCronJob({ node, ctx: podCtx, schedule: cfg.schedule, suspend: cfg.suspend, policy, container });
}

const NATIVE_RENDERERS: Record<string, (node: ResourceNode, ctx: K8sRenderContext) => RenderResult> = {
  "k8s:StatefulSet": renderStatefulSet,
  "k8s:CronJob": renderNativeCronJob,
};

/** Dispatch for `provider_native` nodes: only the registered, parsed shapes render; anything else is refused. */
export function renderProviderNative(node: ResourceNode, ctx: K8sRenderContext): RenderResult {
  const render = NATIVE_RENDERERS[node.nativeType];
  if (!render) throw renderError(`${node.address}: native type ${node.nativeType} has no Kubernetes renderer (supported: ${Object.keys(NATIVE_RENDERERS).join(", ")}).`);
  return render(node, ctx);
}

/* ------------------------------ expectations ------------------------------ */

/** What `observe` compares a native StatefulSet to; units match `statefulSetDef.attributes`. */
export function statefulExpectations(node: ResourceNode): Record<string, unknown> {
  const cfg = statefulConfigOf(node);
  return {
    managedByZenith: true,
    replicas: cfg.replicas,
    image: cfg.image,
    pvcRetentionWhenDeleted: cfg.retention.whenDeleted,
    pvcRetentionWhenScaled: cfg.retention.whenScaled,
    podManagementPolicy: cfg.rollout.podManagementPolicy,
    partition: cfg.rollout.partition,
    volumeClaims: cfg.volumeClaims.map((v) => `${v.name}:${v.sizeGb}Gi`).sort(),
  };
}

export function cronExpectations(node: ResourceNode): Record<string, unknown> {
  const cfg = cronConfigOf(node);
  const policy = readCronPolicy(node.address, {
    ...(cfg.concurrencyPolicy !== undefined ? { concurrencyPolicy: cfg.concurrencyPolicy } : {}),
    ...(cfg.successfulJobsHistoryLimit !== undefined ? { successfulJobsHistoryLimit: cfg.successfulJobsHistoryLimit } : {}),
    ...(cfg.failedJobsHistoryLimit !== undefined ? { failedJobsHistoryLimit: cfg.failedJobsHistoryLimit } : {}),
  });
  return {
    managedByZenith: true,
    image: cfg.image,
    schedule: cfg.schedule ?? NEVER,
    suspend: cfg.suspend === true || cfg.schedule === undefined,
    concurrencyPolicy: policy.concurrencyPolicy,
    successfulJobsHistoryLimit: policy.successfulJobsHistoryLimit,
    failedJobsHistoryLimit: policy.failedJobsHistoryLimit,
  };
}
