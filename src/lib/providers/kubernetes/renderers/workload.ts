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

const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,254}$/;

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

function identityServiceAccount(node: ResourceNode, ctx: K8sRenderContext): string | undefined {
  const match = ctx.nodes?.().find(
    (n) =>
      n.kind === "identity" &&
      n.ownership === "managed" &&
      (n.provider === "kubernetes" || n.provider === "zenith") &&
      isRecord(n.spec) &&
      n.spec.workload === node.address
  );
  return match ? objectName(match) : undefined;
}

interface PodParts {
  labels: Record<string, string>;
  spec: Record<string, unknown>;
}

function podParts(
  node: ResourceNode,
  ctx: K8sRenderContext,
  container: Record<string, unknown>,
  extra: { component: string; zones?: number; replicas?: number; restartPolicy?: "Always" | "Never" | "OnFailure" }
): PodParts {
  const ro = readOnlyRoot(ctx);
  const sec = { readOnlyRootFilesystem: ro, runAsUser: ctx.runAsUser };
  const sa = identityServiceAccount(node, ctx);
  const selector = selectorLabels(node, ctx);
  const c = {
    ...container,
    securityContext: containerSecurityContext(sec),
    ...(ro ? { volumeMounts: [TMP_MOUNT] } : {}),
  };
  const spec: Record<string, unknown> = {
    ...(sa ? { serviceAccountName: sa } : {}),
    automountServiceAccountToken: ctx.automountServiceAccountToken === true,
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
    labels: { ...selector, [LABEL.managedBy]: MANAGED_BY_VALUE, [LABEL.component]: extra.component },
    spec,
  };
}

function hasWhitespaceOrControl(s: string): boolean {
  return [...s].some((ch) => ch.charCodeAt(0) <= 32 || ch.charCodeAt(0) === 127);
}

function httpProbes(path: string, hasPort: boolean): Record<string, unknown> {
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
const NEVER = "0 0 1 1 *";

export function renderScheduledJob(node: ResourceNode, ctx: K8sRenderContext): RenderResult {
  const notes: string[] = [];
  const namespace = ctxNamespace(node, ctx);
  const name = objectName(node);
  const s = specOf(node) as unknown as Partial<ScheduledJobSpec>;
  const schedule = optString(node, "schedule");
  if (schedule !== undefined && !CRON_ALIASES.has(schedule) && !(CRON_FIELDS.test(schedule.trim()) && schedule.length <= 100)) {
    throw renderError(`${node.address}: schedule "${schedule.slice(0, 60)}" is not a cron expression.`);
  }
  const resources = computeResources(node, reqNumber(node, "vcpu", { min: 0.001, max: 256 }), reqNumber(node, "memoryMb", { min: 4, max: 1_048_576 }));
  const container: Record<string, unknown> = { name: "job", image: imageOf(node, ctx), env: renderEnv(node, s.env), resources };
  const pod = podParts(node, ctx, container, { component: "job", restartPolicy: "Never" });
  if (schedule === undefined) notes.push(`${node.address}: no schedule in the spec, so the CronJob is suspended; run it on demand.`);
  const cron: K8sObject = {
    apiVersion: "batch/v1",
    kind: "CronJob",
    metadata: metadata(node, ctx, { name, namespace, labels: { [LABEL.name]: name } }),
    spec: {
      schedule: schedule ?? NEVER,
      ...(schedule === undefined ? { suspend: true } : {}),
      concurrencyPolicy: "Forbid",
      startingDeadlineSeconds: 300,
      successfulJobsHistoryLimit: 3,
      failedJobsHistoryLimit: 3,
      jobTemplate: {
        spec: {
          backoffLimit: 2,
          ttlSecondsAfterFinished: 86400,
          template: { metadata: { labels: pod.labels }, spec: pod.spec },
        },
      },
    },
  };
  return { objects: [cron], notes };
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
  }
  return out;
}
