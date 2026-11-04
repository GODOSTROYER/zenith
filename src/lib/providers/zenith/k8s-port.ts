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
 * Tests inject a recording fake toolkit for unit coverage and wire the real
 * Kubernetes renderer/apply to a local fake HTTP API for integration coverage.
 * Both provide contract evidence, never proof of real-cluster admission.
 *
 * The integration contract is pinned in `k8s-contract.test.ts`: every
 * `ZENITH_EXTRA_KINDS` entry must be accepted and ordered by the Kubernetes
 * provider, and the restated `OWNERSHIP` vocabulary must match its constants.
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

/** Additional namespaced kinds required by managed tenancy and routing. */
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
  /** Explicit cloud cluster and identity mechanism; annotations never prove effective access. */
  workloadIdentity?: { cluster: string; mechanism: "eks-irsa" | "eks-pod-identity" | "gke" | "aks" };
  /** Pure lookup of resolved, non-secret cloud attributes; never a credential callback. */
  resolveAttribute?(address: string, attribute: string): unknown;
}

/**
 * The toolkit uses its input for both graph lookup and rendering. Preserve every
 * node for identity matching, but make unselected Kubernetes/Zenith nodes
 * lookup-only with a referenced ownership view. The source graph is untouched;
 * this view never changes persisted ownership or permits applying those nodes.
 */
function toolkitGraphView(nodes: readonly ResourceNode[], views: readonly ResourceNode[]): ResourceNode[] {
  const selected = new Map(views.map((node) => [node.address, node]));
  return nodes.map((node) => selected.get(node.address) ?? (
    (node.provider === "zenith" || node.provider === "kubernetes") && node.ownership === "managed"
      ? { ...node, ownership: "referenced" as const }
      : node
  ));
}

/** Render a selected subset with the full graph available for neighbour/identity lookup. */
export function renderToolkitGraph(
  toolkit: Pick<KubernetesToolkit, "renderGraph">,
  nodes: readonly ResourceNode[],
  views: readonly ResourceNode[],
  base: ToolkitRenderBase
): ToolkitRenderResult {
  if (views.length === 0) return { objects: [], notes: [] };
  const graph = toolkitGraphView(nodes, views);
  const rendered = toolkit.renderGraph(graph, base);
  // Temporary lookup views must not become public claims about source ownership.
  const lookupNotes = new Set(graph.flatMap((view, index) => view.ownership !== nodes[index].ownership
    ? [`${view.address}: referenced node is never rendered or applied.`] : []));
  return { objects: rendered.objects, notes: rendered.notes.filter((note) => !lookupNotes.has(note)) };
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
