/**
 * container_service / static_site → Deployment (+ Service, optional HPA);
 * scheduled_job → CronJob.
 *
 * Hardening applied to every pod (no opt-out except the two render options
 * documented on `K8sRenderContext`):
 *   runAsNonRoot, seccomp RuntimeDefault, no privilege escalation, all
 *   capabilities dropped, read-only root filesystem with a bounded emptyDir at
 *   /tmp, no service-account token unless asked for, no service-link env
 *   injection, resources requests == limits.
 *
 * Secrets: an `EnvEntry` with `secretRef` becomes a `secretKeyRef` pointing at
 * the Secret object whose NAME is derived from the reference. The value is
 * never read or rendered here.
 *
 * Honest limits:
 *   - `runAsNonRoot` without `runAsUser` needs an image that declares a
 *     non-root USER; an image that runs as root is refused by the kubelet
 *     (`CreateContainerConfigError`, surfaced by `runtime()` as a signal).
 *   - Probes are derived from `healthPath`/`port`; nothing here knows whether
 *     the application actually answers there.
 *   - With `autoscale` the Deployment deliberately omits `spec.replicas` so the
 *     HPA owns it; drift on `replicas` is then expected and meaningless.
 */
import type { ContainerServiceSpec, EnvEntry, ScheduledJobSpec, StaticSiteSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { LABEL, MANAGED_BY_VALUE, SECRET_DATA_KEY, type K8sObject, type K8sRenderContext, type RenderResult } from "../types";
import { looksLikeSecretRef, objectName, secretObjectName } from "../naming";
import { isRecord } from "../util";
import { identityAccess } from "./identity";
import {
  TMP_MOUNT,
  TMP_VOLUME,
  computeResources,
  containerSecurityContext,
  ctxNamespace,
  metadata,
  optNumber,
  optString,
  podSecurityContext,
  readOnlyRoot,
  renderError,
  reqNumber,
  selectorLabels,
  specOf,
  validEnvKey,
} from "./common";

export const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,254}$/;

function imageOf(node: ResourceNode, ctx: K8sRenderContext): string {
  const artifact = specOf(node).artifact as ContainerServiceSpec["artifact"] | undefined;
  if (!isRecord(artifact) || typeof artifact.type !== "string") throw renderError(`${node.address}: spec.artifact is missing.`);
  let ref: string | undefined;
  if (artifact.type === "image") ref = artifact.ref;
  else ref = ctx.resolveImage?.(node, artifact);
  if (!ref) {
    throw renderError(
      `${node.address}: artifact of type "${artifact.type}" has no image reference yet; a build must produce one and the executor must pass it as resolveImage.`
    );
  }
  if (!IMAGE_RE.test(ref)) throw renderError(`${node.address}: image reference is not well-formed.`);
  return ref;
}

/** The pod-level `env` for a service: plain values verbatim, secrets by reference only. */
export function renderEnv(node: ResourceNode, env: readonly EnvEntry[] | undefined): Record<string, unknown>[] {
  if (env === undefined) return [];
  if (!Array.isArray(env)) throw renderError(`${node.address}: spec.env must be a list.`);
  const seen = new Set<string>();
  return env.map((e) => {
    const entry = e as { key?: unknown; value?: unknown; secretRef?: unknown };
    if (typeof entry.key !== "string" || !validEnvKey(entry.key)) throw renderError(`${node.address}: env key "${String(entry.key).slice(0, 60)}" is not a valid variable name.`);
    if (seen.has(entry.key)) throw renderError(`${node.address}: env key "${entry.key}" appears more than once.`);
    seen.add(entry.key);
    if (entry.secretRef !== undefined) {
      if (entry.value !== undefined) throw renderError(`${node.address}: env ${entry.key} has both value and secretRef.`);
      if (typeof entry.secretRef !== "string" || !looksLikeSecretRef(entry.secretRef)) {
        throw renderError(`${node.address}: env ${entry.key} secretRef is not a reference (expected scheme:path).`);
      }
      return {
        name: entry.key,
        valueFrom: { secretKeyRef: { name: secretObjectName(entry.secretRef), key: SECRET_DATA_KEY } },
      };
    }
    if (typeof entry.value !== "string") throw renderError(`${node.address}: env ${entry.key} needs a string value or a secretRef.`);
    return { name: entry.key, value: entry.value };
  });
}

function workloadIdentityNode(node: ResourceNode, ctx: K8sRenderContext): ResourceNode | undefined {
  const matches = ctx.nodes?.().filter(
    (n) =>
      n.kind === "identity" &&
      n.ownership === "managed" &&
      (n.provider === "kubernetes" || n.provider === "zenith") &&
      isRecord(n.spec) &&
      n.spec.workload === node.address
  ) ?? [];
  if (matches.length > 1) throw renderError(`${node.address}: several Kubernetes identities select this workload.`);
  const match = matches[0];
  if (match && ctxNamespace(match, ctx) !== ctxNamespace(node, ctx)) throw renderError(`${node.address}: its ServiceAccount must be in the workload namespace.`);
  return match;
}

export interface PodParts {
  labels: Record<string, string>;
  spec: Record<string, unknown>;
  notes: string[];
}

export function podParts(
  node: ResourceNode,
  ctx: K8sRenderContext,
  container: Record<string, unknown>,
  extra: { component: string; zones?: number; replicas?: number; restartPolicy?: "Always" | "Never" | "OnFailure" }
): PodParts {
  const ro = readOnlyRoot(ctx);
  const sec = { readOnlyRootFilesystem: ro, runAsUser: ctx.runAsUser };
  const identity = workloadIdentityNode(node, ctx);
  const access = identity && identityAccess(identity, ctx);
  const sa = identity && objectName(identity);
  const selector = selectorLabels(node, ctx);
  const c = {
    ...container,
    securityContext: containerSecurityContext(sec),
    ...(ro ? { volumeMounts: [TMP_MOUNT] } : {}),
  };
  const spec: Record<string, unknown> = {
    ...(sa ? { serviceAccountName: sa } : {}),
    automountServiceAccountToken: access?.automount ?? ctx.automountServiceAccountToken === true,
    enableServiceLinks: false,
    ...(extra.restartPolicy ? { restartPolicy: extra.restartPolicy } : {}),
    securityContext: podSecurityContext(sec),
    containers: [c],
    ...(ro ? { volumes: [TMP_VOLUME] } : {}),
    ...((extra.zones ?? 1) > 1 && (extra.replicas ?? 1) > 1
      ? {
          topologySpreadConstraints: [
            { maxSkew: 1, topologyKey: "topology.kubernetes.io/zone", whenUnsatisfiable: "ScheduleAnyway", labelSelector: { matchLabels: selector } },
          ],
        }
      : {}),
  };
  return {
    labels: { ...selector, [LABEL.managedBy]: MANAGED_BY_VALUE, [LABEL.component]: extra.component, ...access?.podLabels },
    spec,
    notes: access?.notes ?? [],
  };
}

function hasWhitespaceOrControl(s: string): boolean {
  return [...s].some((ch) => ch.charCodeAt(0) <= 32 || ch.charCodeAt(0) === 127);
}

export function httpProbes(path: string, hasPort: boolean): Record<string, unknown> {
  if (!path.startsWith("/") || hasWhitespaceOrControl(path) || path.length > 512) throw renderError(`health path "${path.slice(0, 40)}" must start with "/" and contain no whitespace.`);
  if (!hasPort) return {};
  const httpGet = { path, port: "http" };
  return {
    startupProbe: { httpGet, periodSeconds: 5, failureThreshold: 30 },
    readinessProbe: { httpGet, periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 },
    livenessProbe: { httpGet, periodSeconds: 20, timeoutSeconds: 3, failureThreshold: 3 },
  };
}

/** Service + Deployment (+ HPA) for a `container_service`; the same shape serves a prebuilt `static_site` image. */
export function renderContainerService(node: ResourceNode, ctx: K8sRenderContext): RenderResult {
  const notes: string[] = [];
  const isSite = node.kind === "static_site";
  const namespace = ctxNamespace(node, ctx);
  const name = objectName(node);
  const s = specOf(node) as unknown as Partial<ContainerServiceSpec & StaticSiteSpec>;

  const replicas = isSite ? 1 : reqNumber(node, "replicas", { min: 0, max: 1000, int: true });
  const port = isSite ? 8080 : optNumber(node, "port", { min: 1, max: 65535, int: true });
  const healthPath = isSite ? "/" : optString(node, "healthPath");
  const resources = isSite
    ? computeResources(node, 0.1, 128)
    : computeResources(node, reqNumber(node, "vcpu", { min: 0.001, max: 256 }), reqNumber(node, "memoryMb", { min: 4, max: 1_048_576 }));
  const zones = isSite ? 1 : optNumber(node, "zones", { min: 1, max: 10, int: true }) ?? 1;
  const image = imageOf(node, ctx);
  if (isSite) notes.push(`${node.address}: static sites on Kubernetes run a prebuilt image on port 8080 (an unprivileged static server); the site's files must already be baked into that image.`);

  const container: Record<string, unknown> = {
    name: "app",
    image,
    ...(port !== undefined ? { ports: [{ name: "http", containerPort: port, protocol: "TCP" }] } : {}),
    env: renderEnv(node, isSite ? [] : (s.env as EnvEntry[] | undefined)),
    resources,
    ...(healthPath !== undefined ? httpProbes(healthPath, port !== undefined) : {}),
  };
  if (healthPath !== undefined && port === undefined) notes.push(`${node.address}: healthPath is set but no port is declared, so no HTTP probes were rendered.`);
  if (port !== undefined && healthPath === undefined) {
    container.readinessProbe = { tcpSocket: { port: "http" }, periodSeconds: 10, failureThreshold: 3 };
  }

  const pod = podParts(node, ctx, container, { component: isSite ? "static-site" : (s.workload ?? "web"), zones, replicas });
  notes.push(...pod.notes);
  const selector = selectorLabels(node, ctx);
  const autoscale = ctx.autoscale === true && replicas > 1;

  const deployment: K8sObject = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: metadata(node, ctx, { name, namespace, labels: { [LABEL.name]: name, [LABEL.component]: pod.labels[LABEL.component] } }),
    spec: {
      ...(autoscale ? {} : { replicas }),
      revisionHistoryLimit: 10,
      selector: { matchLabels: selector },
      strategy: { type: "RollingUpdate", rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
      template: { metadata: { labels: pod.labels }, spec: pod.spec },
    },
  };
  const objects: K8sObject[] = [deployment];

  if (port !== undefined) {
    objects.push({
      apiVersion: "v1",
      kind: "Service",
      metadata: metadata(node, ctx, { name, namespace, labels: { [LABEL.name]: name } }),
      spec: { type: "ClusterIP", selector, ports: [{ name: "http", port, targetPort: "http", protocol: "TCP" }] },
    });
  }

  if (autoscale) {
    objects.push({
      apiVersion: "autoscaling/v2",
      kind: "HorizontalPodAutoscaler",
      metadata: metadata(node, ctx, { name, namespace, labels: { [LABEL.name]: name } }),
      spec: {
        scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name },
        minReplicas: replicas,
        maxReplicas: replicas * 2,
        metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 70 } } }],
      },
    });
    notes.push(`${node.address}: a HorizontalPodAutoscaler (min ${replicas}, max ${replicas * 2}) owns the replica count; service.scale is refused while it exists.`);
  }
  return { objects, notes };
}

const CRON_ALIASES = new Set(["@yearly", "@annually", "@monthly", "@weekly", "@daily", "@midnight", "@hourly"]);
const CRON_FIELDS = /^(\S+\s+){4}\S+$/;
/** A schedule that never fires in practice; used with `suspend` when the spec names none. */
export const NEVER = "0 0 1 1 *";

export type ConcurrencyPolicy = "Allow" | "Forbid" | "Replace";
export const CONCURRENCY_POLICIES: readonly ConcurrencyPolicy[] = ["Allow", "Forbid", "Replace"];

/** The CronJob behaviour knobs. Defaults reproduce what Zenith always rendered. */
export interface CronPolicy {
  concurrencyPolicy: ConcurrencyPolicy;
  startingDeadlineSeconds: number;
  successfulJobsHistoryLimit: number;
  failedJobsHistoryLimit: number;
  backoffLimit: number;
  ttlSecondsAfterFinished: number;
  activeDeadlineSeconds?: number;
  /** IANA zone name; absent means the controller manager's zone (normally UTC) */
  timeZone?: string;
}

export const DEFAULT_CRON_POLICY: Readonly<CronPolicy> = {
  concurrencyPolicy: "Forbid",
  startingDeadlineSeconds: 300,
  successfulJobsHistoryLimit: 3,
  failedJobsHistoryLimit: 3,
  backoffLimit: 2,
  ttlSecondsAfterFinished: 86400,
};

const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/;

function boundedInt(where: string, key: string, v: unknown, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw renderError(`${where}: ${key} must be an integer between ${min} and ${max}.`);
  return v;
}

/**
 * Validate a free-form policy object (portable `spec.cronPolicy` or native
 * `config`). Unknown keys are refused so a typo cannot silently leave the
 * default in force.
 */
export function readCronPolicy(where: string, raw: unknown): CronPolicy {
  const out: CronPolicy = { ...DEFAULT_CRON_POLICY };
  if (raw === undefined) return out;
  if (!isRecord(raw)) throw renderError(`${where}: cronPolicy must be an object.`);
  const known = new Set(["concurrencyPolicy", "startingDeadlineSeconds", "successfulJobsHistoryLimit", "failedJobsHistoryLimit", "backoffLimit", "ttlSecondsAfterFinished", "activeDeadlineSeconds", "timeZone"]);
  for (const k of Object.keys(raw)) if (!known.has(k)) throw renderError(`${where}: cronPolicy.${k} is not a recognised setting.`);
  if (raw.concurrencyPolicy !== undefined) {
    if (typeof raw.concurrencyPolicy !== "string" || !(CONCURRENCY_POLICIES as readonly string[]).includes(raw.concurrencyPolicy)) {
      throw renderError(`${where}: cronPolicy.concurrencyPolicy must be one of ${CONCURRENCY_POLICIES.join(", ")}.`);
    }
    out.concurrencyPolicy = raw.concurrencyPolicy as ConcurrencyPolicy;
  }
  if (raw.startingDeadlineSeconds !== undefined) out.startingDeadlineSeconds = boundedInt(where, "cronPolicy.startingDeadlineSeconds", raw.startingDeadlineSeconds, 10, 86_400);
  if (raw.successfulJobsHistoryLimit !== undefined) out.successfulJobsHistoryLimit = boundedInt(where, "cronPolicy.successfulJobsHistoryLimit", raw.successfulJobsHistoryLimit, 0, 100);
  if (raw.failedJobsHistoryLimit !== undefined) out.failedJobsHistoryLimit = boundedInt(where, "cronPolicy.failedJobsHistoryLimit", raw.failedJobsHistoryLimit, 0, 100);
  if (raw.backoffLimit !== undefined) out.backoffLimit = boundedInt(where, "cronPolicy.backoffLimit", raw.backoffLimit, 0, 20);
  if (raw.ttlSecondsAfterFinished !== undefined) out.ttlSecondsAfterFinished = boundedInt(where, "cronPolicy.ttlSecondsAfterFinished", raw.ttlSecondsAfterFinished, 60, 2_592_000);
  if (raw.activeDeadlineSeconds !== undefined) out.activeDeadlineSeconds = boundedInt(where, "cronPolicy.activeDeadlineSeconds", raw.activeDeadlineSeconds, 1, 604_800);
  if (raw.timeZone !== undefined) {
    if (typeof raw.timeZone !== "string" || raw.timeZone.length > 64 || !TIME_ZONE.test(raw.timeZone)) throw renderError(`${where}: cronPolicy.timeZone must be an IANA time zone name such as Europe/Paris.`);
    out.timeZone = raw.timeZone;
  }
  return out;
}

export function checkSchedule(where: string, schedule: string | undefined): void {
  if (schedule !== undefined && !CRON_ALIASES.has(schedule) && !(CRON_FIELDS.test(schedule.trim()) && schedule.length <= 100)) {
    throw renderError(`${where}: schedule "${schedule.slice(0, 60)}" is not a cron expression.`);
  }
}

export interface CronJobInput {
  node: ResourceNode;
  ctx: K8sRenderContext;
  schedule: string | undefined;
  suspend: boolean | undefined;
  policy: CronPolicy;
  container: Record<string, unknown>;
}

/** The one CronJob shape: portable `scheduled_job` nodes and the native `k8s:CronJob` both render through it. */
export function buildCronJob(input: CronJobInput): RenderResult {
  const { node, ctx, schedule, policy } = input;
  const notes: string[] = [];
  const namespace = ctxNamespace(node, ctx);
  const name = objectName(node);
  const pod = podParts(node, ctx, input.container, { component: "job", restartPolicy: "Never" });
  notes.push(...pod.notes);
  const suspended = input.suspend === true || schedule === undefined;
  if (schedule === undefined) notes.push(`${node.address}: no schedule in the spec, so the CronJob is suspended; run it on demand.`);
  if (policy.concurrencyPolicy === "Replace") notes.push(`${node.address}: concurrencyPolicy Replace cancels a still-running Job when the next one is due; use it only for idempotent work.`);
  if (policy.concurrencyPolicy === "Allow") notes.push(`${node.address}: concurrencyPolicy Allow lets runs overlap; the job must tolerate concurrent executions.`);
  const selector = selectorLabels(node, ctx);
  const cron: K8sObject = {
    apiVersion: "batch/v1",
    kind: "CronJob",
    metadata: metadata(node, ctx, { name, namespace, labels: { [LABEL.name]: name } }),
    spec: {
      schedule: schedule ?? NEVER,
      ...(policy.timeZone !== undefined ? { timeZone: policy.timeZone } : {}),
      ...(suspended ? { suspend: true } : {}),
      concurrencyPolicy: policy.concurrencyPolicy,
      startingDeadlineSeconds: policy.startingDeadlineSeconds,
      successfulJobsHistoryLimit: policy.successfulJobsHistoryLimit,
      failedJobsHistoryLimit: policy.failedJobsHistoryLimit,
      jobTemplate: {
        // Job objects carry the ownership selector so readback can list exactly this CronJob's runs.
        metadata: { labels: { ...selector, [LABEL.managedBy]: MANAGED_BY_VALUE, [LABEL.component]: "job" } },
        spec: {
          backoffLimit: policy.backoffLimit,
          ...(policy.activeDeadlineSeconds !== undefined ? { activeDeadlineSeconds: policy.activeDeadlineSeconds } : {}),
          ttlSecondsAfterFinished: policy.ttlSecondsAfterFinished,
          template: { metadata: { labels: pod.labels }, spec: pod.spec },
        },
      },
    },
  };
  return { objects: [cron], notes };
}

export function renderScheduledJob(node: ResourceNode, ctx: K8sRenderContext): RenderResult {
  const s = specOf(node) as unknown as Partial<ScheduledJobSpec> & { cronPolicy?: unknown };
  const schedule = optString(node, "schedule");
  checkSchedule(node.address, schedule);
  const policy = readCronPolicy(node.address, s.cronPolicy);
  const resources = computeResources(node, reqNumber(node, "vcpu", { min: 0.001, max: 256 }), reqNumber(node, "memoryMb", { min: 4, max: 1_048_576 }));
  const container: Record<string, unknown> = { name: "job", image: imageOf(node, ctx), env: renderEnv(node, s.env), resources };
  return buildCronJob({ node, ctx, schedule, suspend: undefined, policy, container });
}

/** What `observe` compares to: the pieces of a workload spec that are rendered 1:1. */
export function workloadExpectations(node: ResourceNode): Record<string, unknown> {
  const s = specOf(node) as unknown as Partial<ContainerServiceSpec & ScheduledJobSpec>;
  const out: Record<string, unknown> = { managedByZenith: true };
  if (node.kind === "static_site") {
    out.replicas = 1;
    out.port = 8080;
    out.healthPath = "/";
    if (s.artifact?.type === "image") out.image = s.artifact.ref;
    return out;
  }
  if (typeof s.replicas === "number") out.replicas = s.replicas;
  if (typeof s.vcpu === "number") out.cpuMillicores = Math.max(1, Math.round(s.vcpu * 1000));
  if (typeof s.memoryMb === "number") out.memoryMi = Math.round(s.memoryMb);
  if (typeof s.port === "number") out.port = s.port;
  if (typeof s.healthPath === "string" && typeof s.port === "number") out.healthPath = s.healthPath;
  if (s.artifact?.type === "image") out.image = s.artifact.ref;
  if (node.kind === "scheduled_job") {
    delete out.replicas;
    delete out.port;
    delete out.healthPath;
    out.schedule = typeof s.schedule === "string" ? s.schedule : NEVER;
    out.suspend = typeof s.schedule !== "string";
    const policy = readCronPolicy(node.address, (s as { cronPolicy?: unknown }).cronPolicy);
    out.concurrencyPolicy = policy.concurrencyPolicy;
    out.successfulJobsHistoryLimit = policy.successfulJobsHistoryLimit;
    out.failedJobsHistoryLimit = policy.failedJobsHistoryLimit;
  }
  return out;
}
