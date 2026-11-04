/** Release calls stay inside one broker session; errors expose codes, never API bodies. */
import type { KubernetesSession } from "@/lib/credentials/types";
import type { DriverContext } from "@/lib/drivers/types";
import { StepFailedError } from "@/lib/execution/errors";
import type { ResourceNode } from "@/lib/resources/types";
import { createK8sClient, ownedBy, readObject, toK8sError, type K8sClient } from "../client";
import { objectName } from "../naming";
import { targetFor } from "../target";
import { ANNOTATION, type ObjectRef } from "../types";
import { dig, isRecord } from "../util";

export type ReleaseContext = DriverContext<KubernetesSession>;
export type WorkloadKind = "Deployment" | "StatefulSet";
export interface OwnedWorkload { client: K8sClient; ref: ObjectRef; live: Record<string, unknown>; kind: WorkloadKind }

export function releaseContext(ctx: DriverContext): ReleaseContext {
  const session = ctx.session as Partial<KubernetesSession> | undefined;
  if (ctx.provider !== "kubernetes" || session?.provider !== "kubernetes" || typeof session.kubeConfig !== "function") {
    throw new StepFailedError("Kubernetes release requires a matching broker session.");
  }
  if (!ctx.workspaceId || !ctx.environmentId) throw new StepFailedError("Kubernetes release requires a workspace and environment.");
  return { ...ctx, session: session as KubernetesSession };
}

export function boundedContext(ctx: DriverContext, timeoutMs: number): ReleaseContext {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw new StepFailedError("Kubernetes release timeout must be 1..3600000 ms.");
  }
  const scoped = releaseContext(ctx);
  return { ...scoped, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]) };
}

export function assertKey(key: string): void {
  if (typeof key !== "string" || !key.length || key.length > 1024 || /[\x00-\x1f\x7f]/.test(key)) {
    throw new StepFailedError("Kubernetes release requires a bounded idempotency key.");
  }
}

export function workloadKind(ctx: ReleaseContext, node: ResourceNode): WorkloadKind {
  if (node.provider !== ctx.provider || node.ownership !== "managed") throw new StepFailedError("Kubernetes release requires a managed workload of this provider.");
  if (node.nativeType === "k8s:Deployment") return "Deployment";
  if (node.nativeType === "k8s:StatefulSet") return "StatefulSet";
  throw new StepFailedError("Kubernetes release supports Deployment and StatefulSet workloads only.");
}

export function assertOwnership(ctx: ReleaseContext, node: ResourceNode, live: Record<string, unknown>): void {
  if (!ownedBy(live, ctx.environmentId).owned || dig(live, "metadata", "annotations", ANNOTATION.resource) !== node.address) {
    throw new StepFailedError("Kubernetes release target is outside this environment or resource.");
  }
  // Existing renderers bind globally unique environment ids, rather than workspace annotations.
  const workspace = dig(live, "metadata", "annotations", "zenith.dev/workspace");
  if (workspace !== undefined && workspace !== ctx.workspaceId) throw new StepFailedError("Kubernetes release target is outside this workspace.");
  if (dig(live, "metadata", "deletionTimestamp")) throw new StepFailedError("Kubernetes release target is being deleted.");
}

export async function loadWorkload(ctx: ReleaseContext, node: ResourceNode, client?: K8sClient): Promise<OwnedWorkload> {
  const kind = workloadKind(ctx, node);
  const ref = targetFor(kind, node, ctx.environmentId, node.externalRef);
  const api = client ?? createK8sClient(ctx.session, { signal: ctx.signal, environmentId: ctx.environmentId });
  await api.guard.assert(ref.namespace as string);
  const live = await readObject(api, ref);
  if (!live) throw new StepFailedError("Kubernetes release workload does not exist.");
  assertOwnership(ctx, node, live);
  if (typeof dig(live, "metadata", "uid") !== "string" || typeof dig(live, "metadata", "resourceVersion") !== "string") {
    throw new Error("Kubernetes workload identity is unknown.");
  }
  return { client: api, ref, live, kind };
}

export function mainContainer(node: ResourceNode, podSpec: unknown): Record<string, unknown> {
  const containers = dig(podSpec, "containers");
  if (!Array.isArray(containers) || !containers.length || containers.some((c) => !isRecord(c) || typeof c.name !== "string")) {
    throw new StepFailedError("Kubernetes workload has no identifiable container.");
  }
  const selected = containers.find((c) => c.name === objectName(node)) ?? (containers.length === 1 ? containers[0] : undefined);
  if (!isRecord(selected)) throw new StepFailedError("Kubernetes workload container selection is ambiguous.");
  return selected;
}

export function assertPinnedImage(uri: unknown, imageDigest?: string): asserts uri is string {
  if (typeof uri !== "string" || uri.length > 500 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(uri) || (imageDigest !== undefined && !uri.endsWith(`@${imageDigest}`))) {
    throw new StepFailedError("Bring a pre-built image pinned by a matching sha256 digest for Kubernetes release.");
  }
}

export function releaseFailure(e: unknown): never {
  if (e instanceof StepFailedError) throw e;
  const code = toK8sError(e).code;
  if (["field_conflict", "forbidden", "unauthorized", "invalid", "bad_input", "namespace_forbidden", "unsupported", "session_invalid"].includes(code)) {
    throw new StepFailedError(`Kubernetes release refused (${code}).`);
  }
  throw new Error(`Kubernetes release outcome is unknown (${code}).`);
}

export async function pause(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("Kubernetes release wait ended; outcome is unknown.");
  await new Promise<void>((resolve, reject) => {
    const done = () => { signal.removeEventListener("abort", aborted); resolve(); };
    const timer = setTimeout(done, 1000);
    const aborted = () => { clearTimeout(timer); reject(new Error("Kubernetes release wait ended; outcome is unknown.")); };
    signal.addEventListener("abort", aborted, { once: true });
  });
}
