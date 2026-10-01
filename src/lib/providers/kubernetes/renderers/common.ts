/**
 * Helpers every renderer shares: object metadata, namespace resolution, spec
 * readers that fail loudly, and the hardened pod building blocks.
 *
 * Pure. No I/O, no clock, no randomness: the same node and context produce
 * byte-identical objects, which is what makes server-side apply idempotent.
 */
import type { ResourceNode } from "@/lib/resources/types";
import { ANNOTATION, K8sError, LABEL, MANAGED_BY_VALUE, TIER_DEV_ONLY, type K8sMetadata, type K8sRenderContext } from "../types";
import { defaultNamespace, labelValue, objectName } from "../naming";
import { isRecord } from "../util";

export function renderError(message: string): K8sError {
  return new K8sError("render_error", message);
}

/* ------------------------------ spec readers ------------------------------ */

export function specOf(node: ResourceNode): Record<string, unknown> {
  if (!isRecord(node.spec)) throw renderError(`${node.address}: spec must be an object.`);
  return node.spec;
}

export function reqString(node: ResourceNode, key: string): string {
  const v = specOf(node)[key];
  if (typeof v !== "string" || v === "") throw renderError(`${node.address}: spec.${key} must be a non-empty string.`);
  return v;
}

export function optString(node: ResourceNode, key: string): string | undefined {
  const v = specOf(node)[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw renderError(`${node.address}: spec.${key} must be a string.`);
  return v;
}

export function reqNumber(node: ResourceNode, key: string, opts: { min?: number; max?: number; int?: boolean } = {}): number {
  const v = specOf(node)[key];
  return checkNumber(node, key, v, opts);
}

export function optNumber(node: ResourceNode, key: string, opts: { min?: number; max?: number; int?: boolean } = {}): number | undefined {
  const v = specOf(node)[key];
  return v === undefined ? undefined : checkNumber(node, key, v, opts);
}

function checkNumber(node: ResourceNode, key: string, v: unknown, opts: { min?: number; max?: number; int?: boolean }): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw renderError(`${node.address}: spec.${key} must be a finite number.`);
  if (opts.int && !Number.isInteger(v)) throw renderError(`${node.address}: spec.${key} must be an integer.`);
  if (opts.min !== undefined && v < opts.min) throw renderError(`${node.address}: spec.${key} must be ≥ ${opts.min}.`);
  if (opts.max !== undefined && v > opts.max) throw renderError(`${node.address}: spec.${key} must be ≤ ${opts.max}.`);
  return v;
}

/* ------------------------------- namespaces -------------------------------- */

const NETWORK_KINDS = new Set(["network", "kubernetes_namespace"]);

function explicitNamespace(node: ResourceNode): string | undefined {
  const s = node.spec;
  if (!isRecord(s)) return undefined;
  const ns = NETWORK_KINDS.has(node.kind) ? (s.namespace ?? s.name) : s.namespace;
  return typeof ns === "string" && ns !== "" ? ns : undefined;
}

/**
 * The namespace a node lives in: its own `spec.namespace`, else the namespace of
 * the network node it depends on (the network IS the namespace on Kubernetes),
 * else the environment's default. Without graph access (observe, operations)
 * only the first and last rules apply; expansion must therefore write
 * `spec.namespace` on every Kubernetes-bound node (contract note in the
 * handoff).
 */
export function namespaceOf(node: ResourceNode, environmentId: string, lookup?: (address: string) => ResourceNode | undefined): string {
  const own = explicitNamespace(node);
  if (own) return own;
  if (lookup) {
    for (const dep of [...node.dependsOn].sort()) {
      const d = lookup(dep);
      if (d && NETWORK_KINDS.has(d.kind)) {
        const ns = explicitNamespace(d);
        if (ns) return ns;
        return defaultNamespace(environmentId);
      }
    }
  }
  return defaultNamespace(environmentId);
}

export function ctxNamespace(node: ResourceNode, ctx: K8sRenderContext): string {
  return ctx.namespace ?? namespaceOf(node, ctx.environmentId, ctx.node);
}

/* -------------------------------- metadata --------------------------------- */

export interface MetaOptions {
  name: string;
  /** omit for cluster-scoped kinds */
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  devOnly?: boolean;
}

/** Ownership labels and annotations (ADR-0015) plus caller extras. Key order is fixed for determinism. */
export function metadata(node: ResourceNode, ctx: K8sRenderContext, opts: MetaOptions): K8sMetadata {
  const labels: Record<string, string> = {
    [LABEL.managedBy]: MANAGED_BY_VALUE,
    [LABEL.partOf]: labelValue(ctx.environmentId),
    ...(opts.devOnly ? { [LABEL.tier]: TIER_DEV_ONLY } : {}),
    ...(opts.labels ?? {}),
  };
  const annotations: Record<string, string> = {
    [ANNOTATION.resource]: node.address,
    [ANNOTATION.environment]: ctx.environmentId,
    [ANNOTATION.specDigest]: node.specDigest,
    ...(opts.annotations ?? {}),
  };
  return {
    name: opts.name,
    ...(opts.namespace ? { namespace: opts.namespace } : {}),
    labels,
    annotations,
  };
}

/** Labels that select a node's pods. Immutable on Deployments/StatefulSets, so deliberately minimal and stable. */
export function selectorLabels(node: Pick<ResourceNode, "address">, ctx: K8sRenderContext): Record<string, string> {
  return { [LABEL.name]: objectName(node), [LABEL.partOf]: labelValue(ctx.environmentId) };
}

/* ------------------------------ pod building ------------------------------- */

/** `zenith.dev/tier` label + note for things that are not production-grade. */
export const DEV_ONLY_NOTE =
  "Dev tier: a single-replica workload on cluster storage. No high availability, no automated backups, no point-in-time recovery. It is not a production-grade managed database; prefer a managed database service for production.";

export interface PodSecurityOptions {
  readOnlyRootFilesystem: boolean;
  runAsUser?: number;
  fsGroup?: number;
}

export function podSecurityContext(opts: PodSecurityOptions): Record<string, unknown> {
  return {
    runAsNonRoot: true,
    seccompProfile: { type: "RuntimeDefault" },
    ...(opts.runAsUser !== undefined ? { runAsUser: opts.runAsUser } : {}),
    ...(opts.fsGroup !== undefined ? { fsGroup: opts.fsGroup } : {}),
  };
}

export function containerSecurityContext(opts: PodSecurityOptions): Record<string, unknown> {
  return {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: opts.readOnlyRootFilesystem,
    runAsNonRoot: true,
    capabilities: { drop: ["ALL"] },
  };
}

export function readOnlyRoot(ctx: K8sRenderContext): boolean {
  return ctx.readOnlyRootFilesystem !== false;
}

/** The scratch space a read-only root filesystem needs. Bounded so it cannot fill the node. */
export const TMP_VOLUME = { name: "tmp", emptyDir: { sizeLimit: "256Mi" } } as const;
export const TMP_MOUNT = { name: "tmp", mountPath: "/tmp" } as const;

/** `cpu` millicores string and `memory` Mi string from the portable sizes; requests equal limits (Guaranteed QoS). */
export function computeResources(node: ResourceNode, vcpu: number, memoryMb: number): Record<string, unknown> {
  if (!(vcpu > 0)) throw renderError(`${node.address}: spec.vcpu must be > 0.`);
  if (!(memoryMb > 0) || !Number.isFinite(memoryMb)) throw renderError(`${node.address}: spec.memoryMb must be > 0.`);
  const cpu = `${Math.max(1, Math.round(vcpu * 1000))}m`;
  const memory = `${Math.round(memoryMb)}Mi`;
  return { requests: { cpu, memory }, limits: { cpu, memory } };
}

const ENV_KEY = /^[-._a-zA-Z][-._a-zA-Z0-9]*$/;
export const validEnvKey = (k: string): boolean => ENV_KEY.test(k) && k.length <= 253;

