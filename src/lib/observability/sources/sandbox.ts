/**
 * Sandbox observability source: wraps `@/lib/logsim`.
 *
 * Everything this source returns is SIMULATED — `logsim` generates
 * deterministic application lines and health from the sandbox's deployment
 * records; nothing was measured on real infrastructure. Every result carries
 * `simulated: true` and every RuntimeState from `health()` does too, so the
 * label survives the fabric merge (`simulated` is true if any contributor is).
 *
 * Address → service mapping: a sandbox node's `origin[0]` is the manifest
 * service id logsim is keyed by (override with `serviceIdFor`). Nodes without
 * one are not served and are reported as such rather than guessed.
 *
 * `@/lib/logsim` pulls in the product store, so the default dependency is
 * imported lazily — importing the observability barrel does not open a store.
 */
import type { AppLogLine, HealthEvent, ServiceHealth } from "@/lib/logsim";
import type { ResourceGraph, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { inferSeverity, meetsMinSeverity, severityFilterNote, sortNewestFirst, traceContext, tsMs } from "../normalize";
import { sanitizeEvent, sanitizeLog } from "../redact";
import type { EventQuery, LogQuery, NormalizedEvent, NormalizedLog, ObservabilitySource, QueryResult, Severity, SignalScope } from "../types";
import { bindingOf, coversScope, nodesInScope, sameEnvironment, type EnvironmentBinding } from "./scope";

export const SANDBOX_SOURCE_ID = "sandbox.logsim";

type MaybePromise<T> = T | Promise<T>;

/** The slice of logsim this source needs; tests inject fakes, production lazily loads the real thing. */
export interface SandboxDeps {
  getServiceLogs(envId: string, serviceId: string): MaybePromise<AppLogLine[]>;
  health(envId: string, serviceId: string): MaybePromise<ServiceHealth>;
  healthHistory?(envId: string, serviceId: string): MaybePromise<HealthEvent[]>;
}

export function logsimDeps(): SandboxDeps {
  return {
    async getServiceLogs(envId, serviceId) {
      return (await import("@/lib/logsim")).getServiceLogs(envId, serviceId);
    },
    async health(envId, serviceId) {
      return (await import("@/lib/logsim")).health(envId, serviceId);
    },
    async healthHistory(envId, serviceId) {
      return (await import("@/lib/logsim")).healthHistory(envId, serviceId);
    },
  };
}

export interface SandboxSourceConfig {
  graph: ResourceGraph;
  workspaceId?: string;
  deps?: SandboxDeps;
  /** manifest service id for a node; default: `origin[0]` */
  serviceIdFor?(node: ResourceNode): string | undefined;
  now?: () => Date;
}

export interface SandboxSource extends ObservabilitySource {
  /** simulated runtime state for every sandbox service in scope (used by `resourceHealth`) */
  health(scope: SignalScope): Promise<RuntimeState[]>;
}

const SERVED_KINDS = new Set<string>(["container_service", "scheduled_job", "function", "static_site"]);
const isSandboxService = (n: ResourceNode) => n.provider === "sandbox" && SERVED_KINDS.has(n.kind);
const defaultServiceId = (n: ResourceNode): string | undefined => n.origin[0];

export function createSandboxSource(config: SandboxSourceConfig): SandboxSource {
  const deps = config.deps ?? logsimDeps();
  const binding: EnvironmentBinding = bindingOf(config.graph, config.workspaceId);
  const serviceIdFor = config.serviceIdFor ?? defaultServiceId;
  const now = config.now ?? (() => new Date());

  const served = (scope: SignalScope) =>
    nodesInScope(config.graph, scope, isSandboxService)
      .map((node) => ({ node, serviceId: serviceIdFor(node) }))
      .filter((x): x is { node: ResourceNode; serviceId: string } => typeof x.serviceId === "string" && x.serviceId !== "");

  const empty = <T>(): QueryResult<T> => ({ items: [], sources: [SANDBOX_SOURCE_ID], truncated: false, simulated: true, unavailable: [] });

  return {
    id: SANDBOX_SOURCE_ID,
    provider: "sandbox",
    supports: ["log", "event", "health"],
    covers: (scope) => coversScope(binding, config.graph, scope, isSandboxService),

    async searchLogs(q: LogQuery): Promise<QueryResult<NormalizedLog>> {
      if (!sameEnvironment(binding, q.scope)) return empty();
      const from = Date.parse(q.range.from);
      const to = q.range.to === undefined ? now().getTime() : Date.parse(q.range.to);
      const limit = q.limit ?? 200;
      const out: NormalizedLog[] = [];
      for (const { node, serviceId } of served(q.scope)) {
        for (const line of await deps.getServiceLogs(binding.environmentId, serviceId)) {
          const at = tsMs(line.ts);
          if (at < from || at > to) continue;
          if (q.text && !line.line.includes(q.text)) continue;
          const guess = inferSeverity(line.line);
          // logsim's stream is the one real signal it has: stderr lines are errors even if the text says nothing
          const severity: Severity = guess.severity === "unknown" && line.stream === "stderr" ? "error" : guess.severity;
          if (!meetsMinSeverity(severity, q.minSeverity)) continue;
          const trace = traceContext(line.line);
          const native: Record<string, unknown> = { simulated: true, seq: line.seq, stream: line.stream, serviceId };
          if (guess.heuristic) native.severityHeuristic = guess.heuristic;
          out.push(
            sanitizeLog({
              timestamp: new Date(at).toISOString(),
              address: node.address,
              provider: "sandbox",
              environmentId: binding.environmentId,
              severity,
              message: line.line,
              ...trace,
              attributes: { stream: line.stream, simulated: true },
              native,
            })
          );
        }
      }
      const sorted = sortNewestFirst(out, (l) => l.timestamp);
      const result: QueryResult<NormalizedLog> = {
        items: sorted.slice(0, limit),
        sources: [SANDBOX_SOURCE_ID],
        truncated: sorted.length > limit,
        simulated: true,
        unavailable: [],
      };
      const notes = ["simulated: sandbox logs are generated, not collected from running infrastructure"];
      if (q.minSeverity && q.minSeverity !== "unknown") notes.push(severityFilterNote);
      result.notes = notes;
      return result;
    },

    async searchEvents(q: EventQuery): Promise<QueryResult<NormalizedEvent>> {
      if (!sameEnvironment(binding, q.scope)) return empty();
      const from = Date.parse(q.range.from);
      const to = q.range.to === undefined ? now().getTime() : Date.parse(q.range.to);
      const limit = q.limit ?? 200;
      const out: NormalizedEvent[] = [];
      for (const { node, serviceId } of served(q.scope)) {
        for (const h of (await deps.healthHistory?.(binding.environmentId, serviceId)) ?? []) {
          const at = tsMs(h.at);
          if (at < from || at > to) continue;
          out.push(
            sanitizeEvent({
              timestamp: new Date(at).toISOString(),
              address: node.address,
              provider: "sandbox",
              environmentId: binding.environmentId,
              severity: h.status === "degraded" ? "warn" : "info",
              type: `sandbox.health.${h.status}`,
              message: h.reason,
              native: { simulated: true, serviceId, revisionNumber: h.revisionNumber },
            })
          );
        }
      }
      const sorted = sortNewestFirst(out, (e) => e.timestamp);
      return {
        items: sorted.slice(0, limit),
        sources: [SANDBOX_SOURCE_ID],
        truncated: sorted.length > limit,
        simulated: true,
        unavailable: [],
        notes: ["simulated: sandbox health history is derived from deployment records"],
      };
    },

    async health(scope: SignalScope): Promise<RuntimeState[]> {
      if (!sameEnvironment(binding, scope)) return [];
      const observedAt = now().toISOString();
      const states: RuntimeState[] = [];
      for (const { node, serviceId } of served(scope)) {
        states.push(toRuntimeState(node.address, await deps.health(binding.environmentId, serviceId), observedAt));
      }
      return states;
    },
  };
}

/**
 * ServiceHealth → RuntimeState. "Nothing deployed" (desired 0) is `unknown`,
 * not `unhealthy`: no deployment means there is no state to be healthy or not.
 */
export function toRuntimeState(address: string, h: ServiceHealth, observedAt: string): RuntimeState {
  const desired = Number(h.replicasDesired);
  const ready = Number(h.replicasReady);
  const base = { address, observedAt, source: SANDBOX_SOURCE_ID, simulated: true } as const;
  if (!Number.isFinite(desired) || desired <= 0) return { ...base, health: "unknown", counts: {}, signals: ["nothing_deployed"] };
  const notReady = Math.max(0, desired - Math.max(0, ready));
  const counts = { desired, ready: Math.max(0, ready), unhealthy: notReady };
  if (h.status === "ok" && notReady === 0) return { ...base, health: "healthy", counts, signals: [] };
  return { ...base, health: ready <= 0 ? "unhealthy" : "degraded", counts, signals: notReady > 0 ? [`replicas_not_ready:${notReady}`] : ["status_degraded"] };
}
