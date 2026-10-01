/**
 * The thin adapter between the Zenith-managed provider and the Kubernetes
 * provider (`src/lib/providers/kubernetes/**`, WS-K8S).
 *
 * WHY THIS EXISTS. The managed provider REUSES the Kubernetes provider's
 * renderers, server-side apply, read and list; it does not copy them. The
 * Kubernetes provider lands on its own branch, so this module codes against a
 * structural interface that the Kubernetes provider's exports satisfy. Nothing
 * here imports `@/lib/providers/kubernetes`; the wiring is one object literal
 * at integration (shown in docs/platform/MANAGED-PLATFORM.md, "Integration"):
 *
 *   const toolkit: KubernetesToolkit = {
 *     renderGraph,                                            // kubernetes/render.ts
 *     apply: serverSideApply,                                 // kubernetes/apply.ts
 *     read: (session, ref, signal) => readObject(createK8sClient(session, { signal }), ref),
 *     list: (session, q, signal) => listObjects(createK8sClient(session, { signal }), q.kind, q.namespace, q),
 *   };
 *
 * The same boundary is what makes the provider testable without a cluster: the
 * tests inject a recording fake toolkit. A fake is a fake: it proves this
 * module's own behavior (what it renders, what it refuses, what it hands to
 * apply), never that a real API server accepts the objects.
 *
 * DEPENDENCIES ON THE KUBERNETES PROVIDER (recorded for the orchestrator):
 *   1. `KIND_INFO`/`APPLY_ORDER` must accept three kinds the tenancy layer
 *      renders: `ResourceQuota` (v1), `LimitRange` (v1) and `HTTPRoute`
 *      (gateway.networking.k8s.io/v1), all namespaced. Until then the real
 *      apply refuses them ("Zenith does not apply ..."). `ZENITH_EXTRA_KINDS`
 *      names exactly which.
 *   2. The ownership vocabulary below (ADR-0015) is restated, not imported.
 *      `OWNERSHIP` is pinned by a test here; an integration test should assert
 *      it equals `kubernetes/types.ts`.
 */
import type { KubernetesSession } from "@/lib/credentials/types";
import type { ArtifactSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";

/* ---------------------------- ADR-0015 vocabulary --------------------------- */

export const OWNERSHIP = {
  managedByLabel: "app.kubernetes.io/managed-by",
  managedByValue: "zenith",
  partOfLabel: "app.kubernetes.io/part-of",
  nameLabel: "app.kubernetes.io/name",
  resourceAnnotation: "zenith.dev/resource",
  environmentAnnotation: "zenith.dev/environment",
  specDigestAnnotation: "zenith.dev/spec-digest",
  secretRefAnnotation: "zenith.dev/secret-ref",
} as const;

/** Kinds the tenancy layer renders that the Kubernetes provider's `KIND_INFO` did not list when this was written. */
export const ZENITH_EXTRA_KINDS: readonly { apiVersion: string; kind: string; namespaced: true }[] = [
  { apiVersion: "v1", kind: "ResourceQuota", namespaced: true },
  { apiVersion: "v1", kind: "LimitRange", namespaced: true },
  { apiVersion: "gateway.networking.k8s.io/v1", kind: "HTTPRoute", namespaced: true },
];

/* --------------------------------- objects --------------------------------- */

export interface K8sObject {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    [extra: string]: unknown;
  };
  spec?: Record<string, unknown>;
  [extra: string]: unknown;
}

export interface ObjectRef {
  apiVersion: string;
  kind: string;
  /** absent for cluster-scoped kinds (Namespace) */
  namespace?: string;
  name: string;
}

/** The fields of the Kubernetes provider's `K8sRenderContext` this module sets. */
export interface ToolkitRenderBase {
  environmentId: string;
  /** forces every node's namespace (the tenant namespace) */
  namespace?: string;
  resolveImage?(node: ResourceNode, artifact: ArtifactSpec): string | undefined;
  clusterIssuers?: { dns01?: string; http01?: string };
  ingressControllerNamespace?: string;
  autoscale?: boolean;
  readOnlyRootFilesystem?: boolean;
  automountServiceAccountToken?: boolean;
  resolveDnsTarget?(targetAddress: string): string | undefined;
}

export interface ToolkitRenderResult {
  objects: K8sObject[];
  notes: string[];
}

export interface ToolkitApplyOptions {
  dryRun?: boolean;
  signal?: AbortSignal;
  environmentId?: string;
  resolveSecret?: (ref: string) => Promise<string | null | undefined>;
  log?: (line: string) => void;
  requestTimeoutMs?: number;
}

export interface ToolkitApplyItem {
  ref: ObjectRef;
  /** created | configured | unchanged | conflict | ownership_conflict | error | skipped */
  status: string;
  message?: string;
  errorCode?: string;
}

export interface ToolkitApplyReport {
  ok: boolean;
  dryRun: boolean;
  /** true when preflight refused the whole batch; nothing was applied */
  refused: boolean;
  results: ToolkitApplyItem[];
}

export interface ToolkitListQuery {
  apiVersion?: string;
  kind: string;
  namespace?: string;
  labelSelector?: string;
  limit?: number;
}

export interface ToolkitListResult {
  items: Record<string, unknown>[];
  truncated: boolean;
  /** the cluster does not serve the kind (for example a missing CRD) */
  unavailable: boolean;
}

/**
 * What the managed provider needs from the Kubernetes provider. Every method
 * takes the (tenant-scoped) `KubernetesSession`; none constructs credentials.
 */
export interface KubernetesToolkit {
  /** `renderGraph(nodes, base)` of the Kubernetes provider: pure, deterministic, ordered for apply. */
  renderGraph(nodes: readonly ResourceNode[], base: ToolkitRenderBase): ToolkitRenderResult;
  /** server-side apply with field manager `zenith`, `force: false` and the ownership guard. */
  apply(objects: readonly K8sObject[], session: KubernetesSession, opts: ToolkitApplyOptions): Promise<ToolkitApplyReport>;
  /** read one object; `undefined` when it does not exist. Read-only. */
  read(session: KubernetesSession, ref: ObjectRef, signal?: AbortSignal): Promise<Record<string, unknown> | undefined>;
  /** bounded list. Read-only. */
  list(session: KubernetesSession, query: ToolkitListQuery, signal?: AbortSignal): Promise<ToolkitListResult>;
}

/* --------------------------- helpers on objects ---------------------------- */

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `get(obj, "spec", "template")` without throwing on a missing link. */
export function dig(value: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = value;
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof key === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[key];
    } else {
      if (!isRecord(cur)) return undefined;
      cur = cur[key];
    }
  }
  return cur;
}

/**
 * Every pod spec inside a workload object (Deployment, StatefulSet, Job,
 * DaemonSet, ReplicaSet: `spec.template.spec`; CronJob:
 * `spec.jobTemplate.spec.template.spec`; Pod: `spec`). Returned by reference so
 * callers that own the object can harden it; validation only reads.
 */
export function podSpecsOf(obj: K8sObject): Record<string, unknown>[] {
  switch (obj.kind) {
    case "Pod": {
      return isRecord(obj.spec) ? [obj.spec] : [];
    }
    case "CronJob": {
      const s = dig(obj, "spec", "jobTemplate", "spec", "template", "spec");
      return isRecord(s) ? [s] : [];
    }
    case "Deployment":
    case "StatefulSet":
    case "DaemonSet":
    case "ReplicaSet":
    case "Job": {
      const s = dig(obj, "spec", "template", "spec");
      return isRecord(s) ? [s] : [];
    }
    default:
      return [];
  }
}

/** Kinds that run pods; anything else carries no pod spec. */
export const WORKLOAD_KINDS: ReadonlySet<string> = new Set(["Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob"]);
