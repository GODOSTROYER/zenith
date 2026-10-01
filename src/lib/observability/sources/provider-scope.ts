/** Bind provider-owned sources to a tenant, including their direct query methods. */
import type { ResourceGraph } from "@/lib/resources/types";
import { namespaceOf, selectorLabels } from "@/lib/providers/kubernetes/renderers/common";
import { tenantNamespace } from "@/lib/providers/zenith/tenancy";
import { createK8sClient } from "@/lib/providers/kubernetes/client";
import type { KubernetesSession } from "@/lib/credentials/types";
import type { KubernetesCoreApi } from "./kubernetes";
import type { ObservabilitySource, SignalScope } from "../types";
import { unavailableResult } from "../normalize";
import { bindingOf, sameEnvironment } from "./scope";

export function bindSource(source: ObservabilitySource, graph: ResourceGraph, workspaceId?: string): ObservabilitySource {
  const binding = bindingOf(graph, workspaceId);
  const accepts = (scope: SignalScope) => sameEnvironment(binding, scope);
  return {
    ...source,
    covers: (scope) => accepts(scope) && (source.covers?.(scope) ?? true),
    ...(source.searchLogs ? { searchLogs: (q, signal) => accepts(q.scope) ? source.searchLogs!(q, signal) : Promise.resolve(unavailableResult(source.id, "Scope is unavailable.")) } : {}),
    ...(source.queryMetrics ? { queryMetrics: (q, signal) => accepts(q.scope) ? source.queryMetrics!(q, signal) : Promise.resolve(unavailableResult(source.id, "Scope is unavailable.")) } : {}),
    ...(source.searchEvents ? { searchEvents: (q, signal) => accepts(q.scope) ? source.searchEvents!(q, signal) : Promise.resolve(unavailableResult(source.id, "Scope is unavailable.")) } : {}),
    ...(source.searchTraces ? { searchTraces: (q, signal) => accepts(q.scope) ? source.searchTraces!(q, signal) : Promise.resolve(unavailableResult(source.id, "Scope is unavailable.")) } : {}),
  };
}

/** Use exactly the renderer's namespace/selector conventions for managed workloads. */
export function kubernetesSignalGraph(graph: ResourceGraph, workspaceId?: string, managed = false): ResourceGraph {
  const ctx = { environmentId: graph.environmentId, node: (address: string) => graph.nodes.find((n) => n.address === address) };
  return { ...graph, nodes: graph.nodes.map((node) => {
    if (node.ownership !== "managed" || (node.provider !== "kubernetes" && !(managed && node.provider === "zenith"))) return node;
    const namespace = managed && workspaceId ? tenantNamespace(workspaceId, graph.environmentId) : namespaceOf(node, graph.environmentId, ctx.node);
    return { ...node, provider: "kubernetes", spec: { ...node.spec, namespace, ...(node.kind === "container_service" ? { selector: selectorLabels(node, ctx) } : {}) } };
  }) };
}

/** Apply the provider's namespace ownership guard before reading any pods or events.
 * An empty connection allowlist means Zenith-created namespaces only, never all namespaces.
 */
export async function scopedKubernetesApi(session: KubernetesSession, graph: ResourceGraph): Promise<KubernetesCoreApi> {
  const client = await createK8sClient(session, { environmentId: graph.environmentId, requestTimeoutMs: 6000 });
  return {
    async listNamespacedPod(p) { await client.guard.assert(p.namespace); return client.core.listNamespacedPod(p); },
    async readNamespacedPodLog(p) { await client.guard.assert(p.namespace); return client.core.readNamespacedPodLog(p); },
    async listNamespacedEvent(p) { await client.guard.assert(p.namespace); return client.core.listNamespacedEvent(p); },
  };
}
