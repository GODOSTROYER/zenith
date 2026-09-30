/**
 * Everything the investigation engine may touch, as injected ports
 * (spec §21, ADR-0014).
 *
 * The engine itself does no I/O: no provider SDK, no store, no clock, no
 * network, no process. A caller (the `incident.investigate` capability handler)
 * wires each port to an already-authorized, READ-ONLY implementation:
 *
 *   observe / runtime / expected   resource drivers (`ResourceDriver.observe`,
 *                                  `.runtime`, `.expectedAttributes`) inside a
 *                                  credential-broker session the caller holds
 *   searchLogs / queryMetrics /    the observability fabric (`logs.read`,
 *   searchEvents                   `metrics.read`, `events.read`)
 *   recentChanges / drift          the operations ledger and the drift engine
 *   httpProbe                      the caller's SAFE prober (SSRF-guarded,
 *                                  allowlisted to the environment's own hosts);
 *                                  the engine never opens a socket itself
 *   policyDryRun                   the policy engine in dry-run mode: it
 *                                  decides, it records nothing and executes
 *                                  nothing
 *
 * Contract every implementation must keep:
 *   - read-only: a port never mutates the environment;
 *   - tenant-scoped by the caller: the engine passes the workspace/environment
 *     it was given, and a port must refuse anything outside it;
 *   - honest: return `unknown`/`unavailable` states rather than guess; throwing
 *     is allowed and is reported as unknown evidence, never as a pass;
 *   - bounded: the optional `signal` aborts when the engine's per-probe
 *     timeout fires. Ports that cannot be cancelled are simply abandoned.
 *
 * No credentials pass through here: sessions live inside the implementations.
 */
import type { CapabilityRequest } from "@/lib/capabilities/catalog";
import type { EventQuery, LogQuery, MetricQuery, MetricSeries, NormalizedEvent, NormalizedLog, QueryResult } from "@/lib/observability/types";
import type { PolicyDecision } from "@/lib/policy/types";
import type { DriftReport, Observation, RuntimeState } from "@/lib/resources/types";

export interface PortOptions {
  /** aborts when the engine gives up on the call (per-probe timeout) */
  signal?: AbortSignal;
}

/** One thing that changed in the environment recently: a deploy, an apply, a drift event, a config edit. */
export interface RecentChange {
  /** ISO timestamp */
  at: string;
  /** `deployment`, `rollback`, `apply`, `drift`, `config`, `scale`, `restart`, … (free vocabulary, matched by prefix) */
  kind: string;
  /** one line; untrusted text (it can come from a commit message), sanitized before use */
  summary: string;
  operationId?: string;
}

export interface HttpProbeResult {
  /** HTTP status, when a response arrived */
  status?: number;
  latencyMs?: number;
  /** transport-level failure text (`ENOTFOUND`, `CERT_HAS_EXPIRED`, `ETIMEDOUT`, …); untrusted */
  error?: string;
}

/** Desired attributes as a driver would compare them (`ResourceDriver.expectedAttributes`). */
export type ExpectedAttributes = Record<string, unknown>;

export interface InvestigationPorts {
  observe(address: string, opts?: PortOptions): Promise<Observation>;
  runtime(address: string, opts?: PortOptions): Promise<RuntimeState>;
  /** desired attributes for an address, in the same names/units `observe` reads */
  expected(address: string): ExpectedAttributes | Promise<ExpectedAttributes>;
  searchLogs(query: LogQuery, opts?: PortOptions): Promise<QueryResult<NormalizedLog>>;
  queryMetrics(query: MetricQuery, opts?: PortOptions): Promise<QueryResult<MetricSeries>>;
  /** optional: provider/orchestrator events (ECS service events, Kubernetes events) */
  searchEvents?(query: EventQuery, opts?: PortOptions): Promise<QueryResult<NormalizedEvent>>;
  recentChanges(environmentId: string, sinceIso: string, opts?: PortOptions): Promise<RecentChange[]>;
  /** the latest drift report for the environment, or null when none has been computed */
  drift(environmentId: string, opts?: PortOptions): Promise<DriftReport | null>;
  /** optional: executed by the caller's safe prober; absent means no end-to-end probe was made */
  httpProbe?(url: string, opts?: PortOptions): Promise<HttpProbeResult>;
  /** what policy would decide for this request, without recording or executing anything */
  policyDryRun(request: CapabilityRequest, opts?: PortOptions): Promise<PolicyDecision>;
  now(): Date;
  /** optional: investigation id source; default is a digest of environment + start time */
  newId?(): string;
}
