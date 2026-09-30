/**
 * Pure rendering of resource nodes into Kubernetes objects (ADR-0015).
 *
 *   renderObjects(node, ctx) → K8sObject[]        one node's objects
 *   renderNode(node, ctx)    → { objects, notes } the same plus plain-language notes
 *   renderGraph(nodes, base) → { objects, notes } a whole environment, ordered for apply
 *
 * Deterministic: no I/O, clock or randomness; the same input renders
 * byte-identical output, which is what makes server-side apply a no-op when
 * nothing changed. Only `managed` nodes on the kubernetes/zenith providers
 * render; `referenced`/`external` nodes render nothing (never applied, never
 * adopted).
 *
 * No secret value is ever in a rendered object: Secrets carry a reference
 * annotation and no data; env entries with a `secretRef` become
 * `secretKeyRef`s to that Secret's derived name.
 */
import type { ResourceNode } from "@/lib/resources/types";
import { APPLY_ORDER, ANNOTATION, KIND_INFO, LABEL, MANAGED_BY_VALUE, K8sError, isSupportedKind, refKey, type K8sObject, type K8sRenderContext, type RenderResult, type SupportedKind } from "./types";
import { isDnsLabel } from "./naming";
import { renderDataStore } from "./renderers/data";
import { renderIdentity, renderSecret, renderVolume } from "./renderers/identity";
import { renderCertificate, renderDnsRecord, renderFirewall, renderLoadBalancer, renderNamespace } from "./renderers/network";
import { renderContainerService, renderScheduledJob } from "./renderers/workload";

const K8S_PROVIDERS = new Set(["kubernetes", "zenith"]);

type Renderer = (node: ResourceNode, ctx: K8sRenderContext) => RenderResult;

const RENDERERS: Record<string, Renderer> = {
  network: renderNamespace,
  kubernetes_namespace: renderNamespace,
  firewall: renderFirewall,
  load_balancer: renderLoadBalancer,
  dns_record: renderDnsRecord,
  tls_certificate: renderCertificate,
  container_service: renderContainerService,
  static_site: renderContainerService,
  scheduled_job: renderScheduledJob,
  postgres: renderDataStore,
  redis: renderDataStore,
  mysql: renderDataStore,
  secret: renderSecret,
  identity: renderIdentity,
  volume: renderVolume,
};

/** Kinds this renderer can realize on Kubernetes. */
export const RENDERABLE_KINDS: readonly string[] = Object.keys(RENDERERS);

const MAX_OBJECT_BYTES = 512 * 1024;

/** Every rendered object must carry the ownership marks and be structurally sound before anything can apply it. */
function validateRendered(node: ResourceNode, ctx: K8sRenderContext, objects: readonly K8sObject[]): void {
  for (const o of objects) {
    const where = `${node.address} → ${o.kind}/${o.metadata?.name}`;
    if (!isSupportedKind(o.kind) || KIND_INFO[o.kind].apiVersion !== o.apiVersion) {
      throw new K8sError("render_error", `${where}: unsupported apiVersion/kind ${o.apiVersion} ${o.kind}.`);
    }
    if (typeof o.metadata?.name !== "string" || !isDnsLabel(o.metadata.name)) throw new K8sError("render_error", `${where}: name is not a DNS label.`);
    const namespaced = KIND_INFO[o.kind].namespaced;
    if (namespaced && !(typeof o.metadata.namespace === "string" && isDnsLabel(o.metadata.namespace))) throw new K8sError("render_error", `${where}: namespaced kind needs a valid namespace.`);
    if (!namespaced && o.metadata.namespace !== undefined) throw new K8sError("render_error", `${where}: cluster-scoped kind must not name a namespace.`);
    if (o.metadata.labels?.[LABEL.managedBy] !== MANAGED_BY_VALUE) throw new K8sError("render_error", `${where}: missing ${LABEL.managedBy}.`);
    if (o.metadata.annotations?.[ANNOTATION.environment] !== ctx.environmentId) throw new K8sError("render_error", `${where}: missing ${ANNOTATION.environment}.`);
    if (o.metadata.annotations?.[ANNOTATION.resource] !== node.address) throw new K8sError("render_error", `${where}: missing ${ANNOTATION.resource}.`);
    if (o.kind === "Secret" && ("data" in o || "stringData" in o)) throw new K8sError("render_error", `${where}: a rendered Secret must not carry data.`);
    if (Buffer.byteLength(JSON.stringify(o), "utf8") > MAX_OBJECT_BYTES) throw new K8sError("render_error", `${where}: object exceeds ${MAX_OBJECT_BYTES} bytes.`);
  }
}

/** Render one node. Throws `K8sError("render_error")` when the node cannot be realized honestly. */
export function renderNode(node: ResourceNode, ctx: K8sRenderContext): RenderResult {
  if (!K8S_PROVIDERS.has(node.provider)) return { objects: [], notes: [] };
  if (node.ownership !== "managed") return { objects: [], notes: [`${node.address}: ${node.ownership} node is never rendered or applied.`] };
  if (!node.nativeType.startsWith("k8s:")) throw new K8sError("render_error", `${node.address}: native type ${node.nativeType} is not a Kubernetes type.`);
  const renderer = RENDERERS[node.kind];
  if (!renderer) throw new K8sError("render_error", `${node.address}: kind ${node.kind} cannot be realized on Kubernetes.`);
  const result = renderer(node, ctx);
  validateRendered(node, ctx, result.objects);
  return result;
}

export function renderObjects(node: ResourceNode, ctx: K8sRenderContext): K8sObject[] {
  return renderNode(node, ctx).objects;
}

/** Namespace-first, then dependency order (`APPLY_ORDER`), then namespace and name: a stable, safe apply sequence. */
export function applyOrder<T extends { kind: string; metadata: { name: string; namespace?: string } }>(objects: readonly T[]): T[] {
  const rank = (k: string) => {
    const i = APPLY_ORDER.indexOf(k as SupportedKind);
    return i === -1 ? APPLY_ORDER.length : i;
  };
  return objects
    .map((o, i) => ({ o, i }))
    .sort(
      (a, b) =>
        rank(a.o.kind) - rank(b.o.kind) ||
        (a.o.metadata.namespace ?? "").localeCompare(b.o.metadata.namespace ?? "") ||
        a.o.metadata.name.localeCompare(b.o.metadata.name) ||
        a.i - b.i
    )
    .map((x) => x.o);
}

/**
 * Render every Kubernetes node of an environment, refuse two nodes that would
 * produce the same object, and return the union ordered for apply.
 */
export function renderGraph(
  nodes: readonly ResourceNode[],
  base: Omit<K8sRenderContext, "node" | "nodes">
): RenderResult {
  const byAddress = new Map(nodes.map((n) => [n.address, n]));
  const ctx: K8sRenderContext = { ...base, node: (a) => byAddress.get(a), nodes: () => nodes };
  const owner = new Map<string, string>();
  const objects: K8sObject[] = [];
  const notes: string[] = [];
  for (const node of [...nodes].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))) {
    const r = renderNode(node, ctx);
    notes.push(...r.notes);
    for (const o of r.objects) {
      const key = refKey({ kind: o.kind, namespace: o.metadata.namespace, name: o.metadata.name });
      const prior = owner.get(key);
      if (prior !== undefined && prior !== node.address) {
        throw new K8sError("render_error", `${node.address} and ${prior} would both render ${o.kind} "${o.metadata.name}"${o.metadata.namespace ? ` in ${o.metadata.namespace}` : ""}; rename one.`);
      }
      owner.set(key, node.address);
      objects.push(o);
    }
  }
  return { objects: applyOrder(objects), notes };
}
