/**
 * Kubernetes source (`kubernetes`): pod logs and events via the API server.
 *
 * Evidence level: `contract` — exercised only against a fake `CoreV1Api`
 * (and a fake KubeConfig). Never run against a real cluster or `kind`.
 *
 * The session is injected (`KubernetesSession.kubeConfig()` returns a
 * configured `@kubernetes/client-node` KubeConfig); this source builds no
 * credentials. It uses the client-node v2 object-parameter API:
 * `listNamespacedPod`, `readNamespacedPodLog` (with `sinceSeconds`,
 * `tailLines`, `limitBytes`, `timestamps`) and `listNamespacedEvent` (with a
 * `fieldSelector` on `involvedObject`).
 *
 * Nothing user-controlled is spliced into a selector:
 *   - the text filter is applied here, in process, as a case-sensitive
 *     substring on the lines the API returned — Kubernetes has no log query
 *     language, so there is nothing to inject into;
 *   - label selectors come from the graph node's `spec.selector` and are built
 *     only from keys/values that satisfy Kubernetes' label grammar (which
 *     excludes `,` `=` `!` and whitespace);
 *   - event field selectors use pod/workload names that satisfy the DNS-1123
 *     grammar; a name that does not is skipped and reported.
 *
 * Bounds: at most 10 pods per resource, 5 containers per pod, 30 container log
 * reads and 1 MiB per read; `tailLines` is the query limit. `to` is applied
 * client-side because the log API only takes a relative `sinceSeconds`.
 * Namespaces outside `allowedNamespaces` (the connection's list, when given)
 * are refused.
 */
import type { KubernetesSession } from "@/lib/credentials/types";
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";
import { SourceTimeoutError, raceAbort, throwIfAborted } from "../abort";
import { errorMessage, inferSeverity, isRecord, meetsMinSeverity, severityFilterNote, sortNewestFirst, traceContext } from "../normalize";
import { sanitizeEvent, sanitizeLog, sanitizeReason } from "../redact";
import type { EventQuery, LogQuery, NormalizedEvent, NormalizedLog, ObservabilitySource, QueryResult, Severity } from "../types";
import { bindingOf, coversScope, nodesInScope, sameEnvironment, type EnvironmentBinding } from "./scope";
import { abortable, mapPool } from "./util";

export const KUBERNETES_SOURCE_ID = "kubernetes";

/* ------------------------ the slice of CoreV1Api we use -------------------- */

export interface KubePodLike {
  metadata?: { name?: string };
  spec?: { containers?: { name?: string }[] };
}

export interface KubeEventLike {
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  lastTimestamp?: Date | string;
  firstTimestamp?: Date | string;
  eventTime?: Date | string;
  reportingComponent?: string;
  involvedObject?: { kind?: string; name?: string; namespace?: string };
  metadata?: { creationTimestamp?: Date | string };
}

/** Structural subset of `@kubernetes/client-node` v2's `CoreV1Api` (object-parameter style). */
export interface KubernetesCoreApi {
  listNamespacedPod(p: { namespace: string; labelSelector?: string; limit?: number }): Promise<{ items?: KubePodLike[] }>;
  readNamespacedPodLog(p: {
    name: string;
    namespace: string;
    container?: string;
    sinceSeconds?: number;
    tailLines?: number;
    limitBytes?: number;
    timestamps?: boolean;
  }): Promise<string>;
  listNamespacedEvent(p: { namespace: string; fieldSelector?: string; limit?: number }): Promise<{ items?: KubeEventLike[] }>;
}

export interface KubernetesSourceConfig {
  session: KubernetesSession;
  graph: ResourceGraph;
  workspaceId?: string;
  /** the connection's namespaces; when non-empty, anything else is refused */
  allowedNamespaces?: readonly string[];
  /** build the API from the session's KubeConfig; default `kc.makeApiClient(CoreV1Api)` */
  api?: (kubeConfig: unknown) => KubernetesCoreApi | Promise<KubernetesCoreApi>;
  /** deadline for ONE API call (default 6 s): a hung pod read fails that pod, not the whole query */
  callTimeoutMs?: number;
  now?: () => Date;
}

const MAX_PODS_PER_TARGET = 10;
const MAX_CONTAINERS_PER_POD = 5;
const MAX_CONTAINER_READS = 30;
const MAX_TARGETS = 10;
const LIMIT_BYTES = 1024 * 1024;

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const LABEL_KEY = /^(?:[A-Za-z0-9]([-A-Za-z0-9_.]{0,251}[A-Za-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const LABEL_VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)?$/;
const KIND = /^[A-Za-z]{1,40}$/;

const isK8sNode = (n: ResourceNode) => n.provider === "kubernetes" && (n.kind === "container_service" || n.kind === "kubernetes_namespace");

interface Target {
  node: ResourceNode;
  namespace: string;
  /** `k=v,k2=v2`, or undefined = every pod in the namespace */
  labelSelector?: string;
  workload?: { kind: string; name: string };
}

/** Each call gets its own deadline; a call still pending at it is abandoned and fails with a timeout. */
function withCallTimeout(api: KubernetesCoreApi, ms: number): KubernetesCoreApi {
  const guard = async <T>(work: Promise<T>): Promise<T> => {
    try {
      return await raceAbort(work, AbortSignal.timeout(ms));
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") throw new SourceTimeoutError(ms);
      throw err;
    }
  };
  return {
    listNamespacedPod: (p) => guard(api.listNamespacedPod(p)),
    readNamespacedPodLog: (p) => guard(api.readNamespacedPodLog(p)),
    listNamespacedEvent: (p) => guard(api.listNamespacedEvent(p)),
  };
}

export function createKubernetesSource(config: KubernetesSourceConfig): ObservabilitySource {
  const binding: EnvironmentBinding = bindingOf(config.graph, config.workspaceId);
  const callTimeoutMs = config.callTimeoutMs ?? 6000;
  const now = config.now ?? (() => new Date());
  const allowed = config.allowedNamespaces && config.allowedNamespaces.length > 0 ? new Set(config.allowedNamespaces) : undefined;

  async function api(): Promise<KubernetesCoreApi> {
    const kc = config.session.kubeConfig();
    if (config.api) return withCallTimeout(await config.api(kc), callTimeoutMs);
    if (!isRecord(kc) || typeof kc.makeApiClient !== "function") throw new Error("session.kubeConfig() did not return a KubeConfig");
    const { CoreV1Api } = await import("@kubernetes/client-node");
    return withCallTimeout((kc.makeApiClient as (c: unknown) => KubernetesCoreApi)(CoreV1Api), callTimeoutMs);
  }

  /** Resolve scope → targets; reasons for nodes that cannot be targeted. */
  function targetsFor(scope: LogQuery["scope"]): { targets: Target[]; problems: string[]; skipped: number } {
    const targets: Target[] = [];
    const problems: string[] = [];
    for (const node of nodesInScope(config.graph, scope, isK8sNode)) {
      const r = resolveTarget(node);
      if (!r.ok) problems.push(r.reason);
      else if (allowed && !allowed.has(r.value.namespace)) problems.push(`${node.address}: namespace "${r.value.namespace}" is not in this connection's allowed namespaces`);
      else targets.push(r.value);
    }
    return { targets: targets.slice(0, MAX_TARGETS), problems, skipped: Math.max(0, targets.length - MAX_TARGETS) };
  }

  return {
    id: KUBERNETES_SOURCE_ID,
    provider: "kubernetes",
    supports: ["log", "event"],
    covers: (scope) => coversScope(binding, config.graph, scope, isK8sNode),

    async searchLogs(q: LogQuery, signal: AbortSignal): Promise<QueryResult<NormalizedLog>> {
      const result: QueryResult<NormalizedLog> = { items: [], sources: [], truncated: false, simulated: false, unavailable: [], notes: [] };
      if (!sameEnvironment(binding, q.scope)) return { ...result, notes: [] };
      const fail = (reason: string) => result.unavailable.push({ source: KUBERNETES_SOURCE_ID, reason: sanitizeReason(reason) });
      const limit = q.limit ?? 200;
      const fromMs = Date.parse(q.range.from);
      const toMs = q.range.to === undefined ? now().getTime() : Date.parse(q.range.to);
      const sinceSeconds = Math.min(7 * 86_400, Math.max(1, Math.ceil((now().getTime() - fromMs) / 1000)));

      const { targets, problems, skipped } = targetsFor(q.scope);
      problems.forEach(fail);
      if (skipped > 0) result.notes!.push(`${skipped} more resource(s) not read (limit ${MAX_TARGETS} per query)`);
      if (targets.length === 0) return finalize(result);

      let core: KubernetesCoreApi;
      try {
        core = await api();
      } catch (err) {
        fail(`could not build Kubernetes client: ${errorMessage(err)}`);
        return finalize(result);
      }

      // 1. pods (and their containers) per target
      const podsPerTarget = await mapPool(targets, 3, signal, async (t) => {
        try {
          return { t, pods: await listPods(core, t, signal) };
        } catch (err) {
          throwIfAborted(signal);
          return { t, error: errorMessage(err) };
        }
      });
      const reads: { t: Target; pod: string; container: string | undefined }[] = [];
      for (const p of podsPerTarget) {
        if ("error" in p) {
          fail(`${p.t.node.address}: listing pods failed: ${p.error}`);
          continue;
        }
        addSource(result.sources);
        if (p.pods.length === 0) result.notes!.push(`${p.t.node.address}: no pods matched in namespace ${p.t.namespace}`);
        for (const pod of p.pods) for (const container of pod.containers) reads.push({ t: p.t, pod: pod.name, container });
      }
      if (reads.length > MAX_CONTAINER_READS) {
        result.truncated = true;
        result.notes!.push(`${reads.length - MAX_CONTAINER_READS} container log(s) not read (limit ${MAX_CONTAINER_READS} per query)`);
        reads.length = MAX_CONTAINER_READS;
      }

      // 2. logs per container
      const merged: NormalizedLog[] = [];
      await mapPool(reads, 5, signal, async (r) => {
        try {
          const raw = await abortable(
            core.readNamespacedPodLog({
              name: r.pod,
              namespace: r.t.namespace,
              ...(r.container ? { container: r.container } : {}),
              sinceSeconds,
              tailLines: limit,
              limitBytes: LIMIT_BYTES,
              timestamps: true,
            }),
            signal
          );
          const parsed = parseLogLines(String(raw ?? ""), { fromMs, toMs, text: q.text, minSeverity: q.minSeverity });
          for (const line of parsed.lines) {
            merged.push(toLog(line, r, binding.environmentId));
          }
          if (parsed.total >= limit || Buffer.byteLength(String(raw ?? ""), "utf8") >= LIMIT_BYTES) result.truncated = true;
        } catch (err) {
          throwIfAborted(signal);
          fail(`${r.t.node.address} ${r.pod}${r.container ? `/${r.container}` : ""}: ${errorMessage(err)}`);
        }
      });

      const sorted = sortNewestFirst(merged, (l) => l.timestamp);
      result.items = sorted.slice(0, limit);
      if (sorted.length > limit) result.truncated = true;
      if (q.minSeverity && q.minSeverity !== "unknown") result.notes!.push(severityFilterNote);
      return finalize(result);
    },

    async searchEvents(q: EventQuery, signal: AbortSignal): Promise<QueryResult<NormalizedEvent>> {
      const result: QueryResult<NormalizedEvent> = { items: [], sources: [], truncated: false, simulated: false, unavailable: [], notes: [] };
      if (!sameEnvironment(binding, q.scope)) return { ...result, notes: [] };
      const fail = (reason: string) => result.unavailable.push({ source: KUBERNETES_SOURCE_ID, reason: sanitizeReason(reason) });
      const limit = q.limit ?? 200;
      const fromMs = Date.parse(q.range.from);
      const toMs = q.range.to === undefined ? now().getTime() : Date.parse(q.range.to);

      const { targets, problems, skipped } = targetsFor(q.scope);
      problems.forEach(fail);
      if (skipped > 0) result.notes!.push(`${skipped} more resource(s) not read (limit ${MAX_TARGETS} per query)`);
      if (targets.length === 0) return finalize(result);

      let core: KubernetesCoreApi;
      try {
        core = await api();
      } catch (err) {
        fail(`could not build Kubernetes client: ${errorMessage(err)}`);
        return finalize(result);
      }

      const merged: NormalizedEvent[] = [];
      await mapPool(targets, 3, signal, async (t) => {
        try {
          const objects = await involvedObjects(core, t, signal);
          const all: KubeEventLike[] = [];
          for (const selector of objects.length > 0 ? objects : [undefined]) {
            const res = await abortable(
              core.listNamespacedEvent({ namespace: t.namespace, ...(selector ? { fieldSelector: selector } : {}), limit: Math.min(limit, 500) }),
              signal
            );
            all.push(...(res.items ?? []));
          }
          addSource(result.sources);
          for (const e of all) {
            const ev = toEvent(e, t, binding.environmentId);
            if (!ev) continue;
            const at = Date.parse(ev.timestamp);
            if (at >= fromMs && at <= toMs) merged.push(ev);
          }
        } catch (err) {
          throwIfAborted(signal);
          fail(`${t.node.address}: ${errorMessage(err)}`);
        }
      });

      const sorted = sortNewestFirst(merged, (e) => e.timestamp);
      result.items = sorted.slice(0, limit);
      result.truncated = sorted.length > limit;
      result.notes!.push("Kubernetes retains events for a limited time (an hour by default; cluster-configured)");
      return finalize(result);
    },
  };
}

function addSource(sources: string[]): void {
  if (!sources.includes(KUBERNETES_SOURCE_ID)) sources.push(KUBERNETES_SOURCE_ID);
}

function finalize<T>(result: QueryResult<T>): QueryResult<T> {
  if (result.notes && result.notes.length === 0) delete result.notes;
  return result;
}

/* -------------------------------- targets --------------------------------- */

function resolveTarget(node: ResourceNode): { ok: true; value: Target } | { ok: false; reason: string } {
  const spec = node.spec;
  const rawNs = typeof spec.namespace === "string" ? spec.namespace : node.kind === "kubernetes_namespace" && typeof spec.name === "string" ? spec.name : undefined;
  if (!rawNs || !DNS_LABEL.test(rawNs)) return { ok: false, reason: `${node.address}: no valid Kubernetes namespace (spec.namespace)` };
  const target: Target = { node, namespace: rawNs };
  if (node.kind === "container_service") {
    const selector = selectorOf(spec.selector ?? spec.matchLabels ?? spec.podLabels);
    if (!selector) return { ok: false, reason: `${node.address}: no usable pod selector (spec.selector must be a map of valid Kubernetes labels)` };
    target.labelSelector = selector;
    const wname = typeof spec.workloadName === "string" ? spec.workloadName : undefined;
    const wkind = typeof spec.workloadKind === "string" ? spec.workloadKind : "Deployment";
    if (wname && DNS_SUBDOMAIN.test(wname) && KIND.test(wkind)) target.workload = { kind: wkind, name: wname };
  }
  return { ok: true, value: target };
}

/** `k=v,k2=v2` from a label map, only if EVERY entry satisfies the Kubernetes label grammar. */
function selectorOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof v !== "string" || !LABEL_KEY.test(k) || !LABEL_VALUE.test(v) || v === "") return undefined;
    parts.push(`${k}=${v}`);
  }
  return parts.length > 0 && parts.length <= 10 ? parts.join(",") : undefined;
}

interface PodRef {
  name: string;
  containers: (string | undefined)[];
}

async function listPods(core: KubernetesCoreApi, t: Target, signal: AbortSignal): Promise<PodRef[]> {
  const res = await abortable(core.listNamespacedPod({ namespace: t.namespace, ...(t.labelSelector ? { labelSelector: t.labelSelector } : {}), limit: 50 }), signal);
  const pods: PodRef[] = [];
  for (const p of (res.items ?? []).slice().sort((a, b) => (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? ""))) {
    const name = p.metadata?.name;
    if (!name || !DNS_SUBDOMAIN.test(name)) continue;
    const containers = (p.spec?.containers ?? []).map((c) => c.name).filter((n): n is string => typeof n === "string" && DNS_LABEL.test(n)).slice(0, MAX_CONTAINERS_PER_POD);
    pods.push({ name, containers: containers.length > 0 ? containers : [undefined] });
    if (pods.length >= MAX_PODS_PER_TARGET) break;
  }
  return pods;
}

/** `involvedObject` field selectors for a target's pods and workload; empty = the whole namespace. */
async function involvedObjects(core: KubernetesCoreApi, t: Target, signal: AbortSignal): Promise<string[]> {
  if (t.node.kind === "kubernetes_namespace") return [];
  const selectors: string[] = [];
  for (const pod of await listPods(core, t, signal)) selectors.push(`involvedObject.kind=Pod,involvedObject.name=${pod.name}`);
  if (t.workload) selectors.push(`involvedObject.kind=${t.workload.kind},involvedObject.name=${t.workload.name}`);
  return selectors;
}

/* --------------------------------- logs ----------------------------------- */

const TS_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))[ \t](.*)$/s;

export interface ParsedLine {
  timestamp: string;
  message: string;
  severity: Severity;
  heuristic?: string;
}

/**
 * Split a `timestamps=true` log body into lines. Lines outside `[fromMs, toMs]`,
 * without the text, below `minSeverity`, or without a parseable timestamp are
 * dropped; `total` counts every well-formed line the API returned (for
 * truncation detection).
 */
export function parseLogLines(body: string, f: { fromMs: number; toMs: number; text?: string; minSeverity?: Severity }): { lines: ParsedLine[]; total: number } {
  const lines: ParsedLine[] = [];
  let total = 0;
  for (const raw of body.split("\n")) {
    const m = TS_LINE.exec(raw.replace(/\r$/, ""));
    if (!m) continue;
    total++;
    const at = Date.parse(m[1]);
    if (!Number.isFinite(at) || at < f.fromMs || at > f.toMs) continue;
    if (f.text && !m[2].includes(f.text)) continue;
    const guess = inferSeverity(m[2]);
    if (!meetsMinSeverity(guess.severity, f.minSeverity)) continue;
    lines.push({ timestamp: new Date(at).toISOString(), message: m[2], severity: guess.severity, heuristic: guess.heuristic });
  }
  return { lines, total };
}

function toLog(line: ParsedLine, r: { t: Target; pod: string; container: string | undefined }, environmentId: string): NormalizedLog {
  const native: Record<string, unknown> = { namespace: r.t.namespace, pod: r.pod };
  if (r.container) native.container = r.container;
  if (line.heuristic) native.severityHeuristic = line.heuristic;
  return sanitizeLog({
    timestamp: line.timestamp,
    address: r.t.node.address,
    provider: "kubernetes",
    environmentId,
    severity: line.severity,
    message: line.message,
    ...traceContext(line.message),
    attributes: {},
    native,
  });
}

/* --------------------------------- events --------------------------------- */

const ERROR_REASONS = new Set(["OOMKilling", "Evicted", "BackOff", "Failed", "FailedCreate", "FailedCreatePodSandBox"]);

const asIso = (v: Date | string | undefined): string | undefined => {
  if (v === undefined) return undefined;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
};

function toEvent(e: KubeEventLike, t: Target, environmentId: string): NormalizedEvent | undefined {
  const timestamp = asIso(e.lastTimestamp) ?? asIso(e.eventTime) ?? asIso(e.firstTimestamp) ?? asIso(e.metadata?.creationTimestamp);
  if (!timestamp || typeof e.message !== "string") return undefined;
  const kind = (e.involvedObject?.kind ?? "object").toLowerCase().replace(/[^a-z0-9]/g, "");
  const reason = e.reason ?? "unknown";
  const severity: Severity = e.type === "Warning" ? (ERROR_REASONS.has(reason) ? "error" : "warn") : "info";
  const native: Record<string, unknown> = {
    namespace: t.namespace,
    reason,
    involvedObject: { kind: e.involvedObject?.kind, name: e.involvedObject?.name },
  };
  if (e.type) native.type = e.type;
  if (typeof e.count === "number") native.count = e.count;
  if (e.reportingComponent) native.reportingComponent = e.reportingComponent;
  const first = asIso(e.firstTimestamp);
  if (first) native.firstTimestamp = first;
  return sanitizeEvent({
    timestamp,
    address: t.node.address,
    provider: "kubernetes",
    environmentId,
    severity,
    type: `k8s.${kind}.${reason.toLowerCase().replace(/[^a-z0-9]/g, "")}`,
    message: e.message,
    native,
  });
}
