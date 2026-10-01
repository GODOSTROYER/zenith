/**
 * Azure observability sources for the federated fabric (ADR-0011): Log
 * Analytics for logs, Azure Monitor metrics for a small portable metric table.
 * Evidence level: `contract` — a fake Log Analytics / ARM only, never a live
 * workspace.
 *
 * Invariants
 *   - Query text is never built from raw user text. The KQL is a fixed
 *     template; every variable part (app names, the text filter, the limit) is
 *     a validated parameter rendered by `kql.ts`, and the time range travels
 *     as the API's own `timespan`, not inside the query.
 *   - Identifiers are never guessed. A workload's Container App name and its
 *     Log Analytics workspace id come from that node's latest OBSERVATION
 *     (`externalId` ARM id, `native.customerId`); a node that has none is
 *     reported as `unavailable` with the reason, never queried by an invented
 *     name.
 *   - Log lines are untrusted data. They are returned as data, bounded and
 *     scrubbed of secret-shaped strings here (and again by the fabric).
 *   - A slow, forbidden or throttled backend is an `unavailable` entry, not an
 *     exception; only a caller abort rejects.
 *   - Signals are not pretended equal to AWS's. Container Apps console logs
 *     carry no severity (severity is `unknown`; `minSeverity` is reported as
 *     not applied); the metric table names Azure's own units (`cpu.usage` is
 *     nanocores, not a percent).
 *
 * Portable metric table (Azure Monitor, `Microsoft.Insights/metrics`):
 *   replica.count       Microsoft.App/containerApps        Replicas              Average  Count
 *   cpu.usage           Microsoft.App/containerApps        UsageNanoCores        Average  NanoCores
 *   memory.working_set  Microsoft.App/containerApps        WorkingSetBytes       Average  Bytes
 *   http.requests       Microsoft.App/containerApps        Requests              Total    Count
 *   db.cpu              Microsoft.DBforPostgreSQL/flexibleServers  cpu_percent        Average  Percent
 *   db.connections      Microsoft.DBforPostgreSQL/flexibleServers  active_connections  Average  Count
 *   db.free_storage     Microsoft.DBforPostgreSQL/flexibleServers  storage_free        Minimum  Bytes
 *   cache.cpu           Microsoft.Cache/redis              percentProcessorTime  Average  Percent
 *   queue.depth         Microsoft.ServiceBus/namespaces    ActiveMessages (EntityName = queue)  Maximum  Count
 */
import type { AzureSession } from "@/lib/credentials/types";
import type { LogQuery, MetricPoint, MetricQuery, MetricSeries, NormalizedLog, ObservabilitySource, QueryResult, SignalScope } from "@/lib/observability/types";
import type { Observation, ResourceGraph, ResourceNode } from "@/lib/resources/types";
import { armClient, ArmError, parseArmId, safeText, sendJson } from "@/lib/providers/azure/arm";
import { redactDeep } from "@/lib/providers/azure/kit";
import { kqlInt, kqlString } from "@/lib/providers/azure/kql";
import { scopedName } from "@/lib/providers/azure/naming";
import { API } from "@/lib/providers/azure/platform";

export const AZURE_LOGS_SOURCE_ID = "azure.log-analytics";
export const AZURE_METRICS_SOURCE_ID = "azure.monitor-metrics";

const LOG_DEFAULT_LIMIT = 200;
const LOG_MAX_LIMIT = 1000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOG_QUERY_HOST = "https://api.loganalytics.io";

/**
 * WS-OBS adds `notes` to `QueryResult` and `covers` to `ObservabilitySource`
 * (both optional) on its own branch. They are declared here too so this module
 * compiles against either version of the contract; the shapes are identical.
 */
export type AzureQueryResult<T> = QueryResult<T> & { notes?: string[] };
export type AzureObservabilitySource = Omit<ObservabilitySource, "searchLogs" | "queryMetrics"> & {
  covers?(scope: SignalScope): boolean;
  searchLogs?(q: LogQuery, signal: AbortSignal): Promise<AzureQueryResult<NormalizedLog>>;
  queryMetrics?(q: MetricQuery, signal: AbortSignal): Promise<AzureQueryResult<MetricSeries>>;
};

export interface AzureObservabilityConfig {
  session: AzureSession;
  graph: ResourceGraph;
  workspaceId?: string;
  /** latest observations; identifiers are read from them */
  observations?: readonly Observation[];
}

/* -------------------------------- resolution -------------------------------- */

interface Ctx {
  graph: ResourceGraph;
  byAddress: Map<string, ResourceNode>;
  obs: Map<string, Observation>;
}

function ctxOf(c: AzureObservabilityConfig): Ctx {
  return {
    graph: c.graph,
    byAddress: new Map(c.graph.nodes.map((n) => [n.address, n])),
    obs: new Map((c.observations ?? []).filter((o) => o.presence === "present").map((o) => [o.address, o])),
  };
}

const inScope = (scope: SignalScope, graph: ResourceGraph): boolean => scope.environmentId === graph.environmentId;

function nodesFor(ctx: Ctx, scope: SignalScope, kinds: readonly string[]): ResourceNode[] {
  const wanted = scope.addresses && scope.addresses.length > 0 ? new Set(scope.addresses) : undefined;
  return ctx.graph.nodes.filter((n) => n.provider === "azure" && n.ownership === "managed" && kinds.includes(n.kind) && (!wanted || wanted.has(n.address))).sort((a, b) => (a.address < b.address ? -1 : 1));
}

type Resolved<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Name of the ARM resource an observation found: the last segment of its `externalId`. */
function armNameOf(ctx: Ctx, node: ResourceNode): Resolved<string> {
  const id = ctx.obs.get(node.address)?.externalId;
  const parsed = id ? parseArmId(id) : undefined;
  const name = parsed?.segments[parsed.segments.length - 1]?.name;
  return name && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) ? { ok: true, value: name } : { ok: false, reason: `${node.address} has no observation with an Azure resource id` };
}

function workspaceCustomerId(ctx: Ctx, workload: ResourceNode): Resolved<string> {
  const group = ctx.graph.nodes.find((n) => n.kind === "log_group" && n.provider === "azure" && n.spec.workload === workload.address);
  if (!group) return { ok: false, reason: `${workload.address} has no log group node` };
  const id = ctx.obs.get(group.address)?.native?.customerId;
  return typeof id === "string" && GUID.test(id) ? { ok: true, value: id.toLowerCase() } : { ok: false, reason: `${group.address} has no observation with a workspace id` };
}

function isoOrThrow(v: string): string {
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error("invalid timestamp");
  return new Date(t).toISOString();
}

const empty = <T>(): AzureQueryResult<T> => ({ items: [], sources: [], truncated: false, simulated: false, unavailable: [], notes: [] });

function unavailableFrom(source: string, e: unknown): { source: string; reason: string } {
  if (e instanceof ArmError) {
    const why = e.kind === "forbidden" ? "access denied" : e.kind === "throttled" ? `throttled${e.retryAfterSec !== undefined ? ` (retry after ${e.retryAfterSec}s)` : ""}` : e.kind === "not_found" ? "not found" : safeText(e.message, 160);
    return { source, reason: why };
  }
  return { source, reason: e instanceof Error ? safeText(e.message, 160) : "query failed" };
}

const SCRUB = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b|\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}|(?:AccountKey|SharedAccessKey|Password|pwd|secret|token|api[_-]?key)["']?\s*[=:]\s*["']?[^\s;&"',]{4,}/gi;
const scrub = (s: string): string => s.replace(SCRUB, "[REDACTED]");

/* ---------------------------------- logs ------------------------------------ */

/** The fixed query template; `apps` and `text` are the only variable parts, both rendered as KQL literals. */
export function buildConsoleLogQuery(apps: readonly string[], text: string | undefined, limit: number): string {
  if (apps.length === 0 || apps.length > 50) throw new Error("need 1–50 app names");
  const list = apps.map((a) => kqlString(a, 64)).join(", ");
  const lines = [
    `ContainerAppConsoleLogs_CL`,
    `| where ContainerAppName_s in (${list}) or ContainerGroupName_s has_any (${list})`,
  ];
  if (text !== undefined && text !== "") lines.push(`| where Log_s contains ${kqlString(text, 200)}`);
  lines.push(`| project TimeGenerated, ContainerAppName_s, ContainerName_s, RevisionName_s, Stream_s, Log_s`, `| order by TimeGenerated desc`, `| take ${kqlInt(limit, 1, LOG_MAX_LIMIT + 1)}`);
  return lines.join("\n");
}

export function createAzureLogsSource(config: AzureObservabilityConfig): AzureObservabilitySource {
  const ctx = ctxOf(config);
  const covers = (scope: SignalScope): boolean => inScope(scope, config.graph) && nodesFor(ctx, scope, ["container_service", "scheduled_job"]).length > 0;
  return {
    id: AZURE_LOGS_SOURCE_ID,
    provider: "azure",
    supports: ["log"],
    covers,
    async searchLogs(q: LogQuery, signal: AbortSignal): Promise<AzureQueryResult<NormalizedLog>> {
      const result = empty<NormalizedLog>();
      if (!inScope(q.scope, config.graph)) return result;
      let from: string;
      let to: string;
      try {
        from = isoOrThrow(q.range.from);
        to = isoOrThrow(q.range.to ?? new Date().toISOString());
      } catch {
        result.unavailable.push({ source: AZURE_LOGS_SOURCE_ID, reason: "invalid time range" });
        return result;
      }
      const limit = Math.min(Math.max(Math.trunc(q.limit ?? LOG_DEFAULT_LIMIT), 1), LOG_MAX_LIMIT);
      // group workloads by workspace; one query per workspace
      const byWorkspace = new Map<string, { names: string[]; byName: Map<string, string> }>();
      for (const node of nodesFor(ctx, q.scope, ["container_service", "scheduled_job"])) {
        const name = armNameOf(ctx, node);
        const ws = workspaceCustomerId(ctx, node);
        if (!name.ok || !ws.ok) {
          result.unavailable.push({ source: AZURE_LOGS_SOURCE_ID, reason: !name.ok ? name.reason : (ws as { reason: string }).reason });
          continue;
        }
        const entry = byWorkspace.get(ws.value) ?? { names: [] as string[], byName: new Map<string, string>() };
        entry.names.push(name.value);
        entry.byName.set(name.value, node.address);
        byWorkspace.set(ws.value, entry);
      }
      if (q.minSeverity && q.minSeverity !== "trace") result.notes!.push("minSeverity was not applied: Container Apps console logs carry no severity.");
      for (const [workspace, entry] of byWorkspace) {
        if (signal.aborted) throw signal.reason ?? new Error("aborted");
        let query: string;
        try {
          query = buildConsoleLogQuery(entry.names, q.text, limit + 1);
        } catch (e) {
          result.unavailable.push({ source: AZURE_LOGS_SOURCE_ID, reason: e instanceof Error ? safeText(e.message, 120) : "invalid query" });
          continue;
        }
        try {
          const r = await sendJson<{ tables?: { columns?: { name?: string }[]; rows?: unknown[][] }[] }>(config.session, signal, "POST", `${LOG_QUERY_HOST}/v1/workspaces/${workspace}/query`, { body: { query, timespan: `${from}/${to}` } });
          const table = r.body.tables?.[0];
          const cols = (table?.columns ?? []).map((c) => String(c.name ?? ""));
          const rows = table?.rows ?? [];
          for (const row of rows.slice(0, limit)) {
            const rec: Record<string, unknown> = {};
            cols.forEach((c, i) => (rec[c] = row[i]));
            const app = String(rec.ContainerAppName_s ?? "");
            const when = typeof rec.TimeGenerated === "string" ? rec.TimeGenerated : undefined;
            if (!when) continue;
            result.items.push({
              timestamp: new Date(when).toISOString(),
              address: entry.byName.get(app),
              provider: "azure",
              environmentId: config.graph.environmentId,
              severity: "unknown",
              message: scrub(String(rec.Log_s ?? "")).slice(0, 4000),
              attributes: { stream: String(rec.Stream_s ?? ""), revision: String(rec.RevisionName_s ?? ""), container: String(rec.ContainerName_s ?? "") },
              native: redactDeep({ workspace, containerApp: app }) as Record<string, unknown>,
            });
          }
          if (rows.length > limit) result.truncated = true;
          if (!result.sources.includes(AZURE_LOGS_SOURCE_ID)) result.sources.push(AZURE_LOGS_SOURCE_ID);
        } catch (e) {
          if (signal.aborted) throw signal.reason ?? e;
          result.unavailable.push(unavailableFrom(AZURE_LOGS_SOURCE_ID, e));
        }
      }
      result.items.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
      if (result.items.length > limit) {
        result.items.length = limit;
        result.truncated = true;
      }
      if (result.notes!.length === 0) delete result.notes;
      return result;
    },
  };
}

/* --------------------------------- metrics ---------------------------------- */

type Agg = "Average" | "Total" | "Maximum" | "Minimum";

export interface AzureMetricDef {
  portable: string;
  armType: string;
  metricName: string;
  aggregation: Agg;
  unit: string;
  kind: string;
  /** dimension filter for the node (queues) */
  filter?: (node: ResourceNode) => string | undefined;
}

export const AZURE_METRIC_TABLE: readonly AzureMetricDef[] = [
  { portable: "replica.count", armType: "Microsoft.App/containerApps", metricName: "Replicas", aggregation: "Average", unit: "Count", kind: "container_service" },
  { portable: "cpu.usage", armType: "Microsoft.App/containerApps", metricName: "UsageNanoCores", aggregation: "Average", unit: "NanoCores", kind: "container_service" },
  { portable: "memory.working_set", armType: "Microsoft.App/containerApps", metricName: "WorkingSetBytes", aggregation: "Average", unit: "Bytes", kind: "container_service" },
  { portable: "http.requests", armType: "Microsoft.App/containerApps", metricName: "Requests", aggregation: "Total", unit: "Count", kind: "container_service" },
  { portable: "db.cpu", armType: "Microsoft.DBforPostgreSQL/flexibleServers", metricName: "cpu_percent", aggregation: "Average", unit: "Percent", kind: "postgres" },
  { portable: "db.connections", armType: "Microsoft.DBforPostgreSQL/flexibleServers", metricName: "active_connections", aggregation: "Average", unit: "Count", kind: "postgres" },
  { portable: "db.free_storage", armType: "Microsoft.DBforPostgreSQL/flexibleServers", metricName: "storage_free", aggregation: "Minimum", unit: "Bytes", kind: "postgres" },
  { portable: "cache.cpu", armType: "Microsoft.Cache/redis", metricName: "percentProcessorTime", aggregation: "Average", unit: "Percent", kind: "redis" },
  { portable: "queue.depth", armType: "Microsoft.ServiceBus/namespaces", metricName: "ActiveMessages", aggregation: "Maximum", unit: "Count", kind: "queue", filter: (n) => `EntityName eq '${scopedName(n.address, { max: 260 })}'` },
];

const TABLE = new Map(AZURE_METRIC_TABLE.map((d) => [d.portable, d] as const));
const INTERVALS: [number, string][] = [[60, "PT1M"], [300, "PT5M"], [900, "PT15M"], [1800, "PT30M"], [3600, "PT1H"], [21600, "PT6H"], [43200, "PT12H"], [86400, "P1D"]];
const intervalFor = (stepSec: number | undefined): string => (INTERVALS.find(([s]) => s >= (stepSec ?? 300)) ?? INTERVALS[INTERVALS.length - 1])[1];
const AGG_KEY: Record<Agg, string> = { Average: "average", Total: "total", Maximum: "maximum", Minimum: "minimum" };

export function createAzureMetricsSource(config: AzureObservabilityConfig): AzureObservabilitySource {
  const ctx = ctxOf(config);
  const kinds = [...new Set(AZURE_METRIC_TABLE.map((d) => d.kind))];
  return {
    id: AZURE_METRICS_SOURCE_ID,
    provider: "azure",
    supports: ["metric"],
    covers: (scope) => inScope(scope, config.graph) && nodesFor(ctx, scope, kinds).length > 0,
    async queryMetrics(q: MetricQuery, signal: AbortSignal): Promise<AzureQueryResult<MetricSeries>> {
      const result = empty<MetricSeries>();
      if (!inScope(q.scope, config.graph)) return result;
      let timespan: string;
      try {
        timespan = `${isoOrThrow(q.range.from)}/${isoOrThrow(q.range.to ?? new Date().toISOString())}`;
      } catch {
        result.unavailable.push({ source: AZURE_METRICS_SOURCE_ID, reason: "invalid time range" });
        return result;
      }
      const arm = armClient(config.session, signal);
      const interval = intervalFor(q.stepSec);
      for (const portable of [...new Set(q.metrics)].slice(0, 12)) {
        const def = TABLE.get(portable);
        if (!def) {
          result.unavailable.push({ source: AZURE_METRICS_SOURCE_ID, reason: `metric "${String(portable).slice(0, 60)}" is not in the Azure metric table` });
          continue;
        }
        const nodes = nodesFor(ctx, q.scope, [def.kind]);
        if (nodes.length === 0) {
          result.unavailable.push({ source: AZURE_METRICS_SOURCE_ID, reason: `${portable}: no ${def.kind} node in scope` });
          continue;
        }
        for (const node of nodes) {
          if (signal.aborted) throw signal.reason ?? new Error("aborted");
          const id = ctx.obs.get(node.address)?.externalId;
          const parsed = id ? parseArmId(id) : undefined;
          if (!id || !parsed || !`${parsed.provider}/${parsed.segments[0]?.type}`.toLowerCase().startsWith(def.armType.toLowerCase())) {
            result.unavailable.push({ source: AZURE_METRICS_SOURCE_ID, reason: `${portable}: ${node.address} has no observation with a ${def.armType} id` });
            continue;
          }
          try {
            const filter = def.filter?.(node);
            const r = await arm.get<{ value?: { unit?: string; timeseries?: { data?: Record<string, unknown>[] }[] }[] }>(`${id}/providers/Microsoft.Insights/metrics`, {
              apiVersion: API.monitorMetrics,
              query: { metricnames: def.metricName, aggregation: def.aggregation, interval, timespan, ...(filter ? { $filter: filter } : {}) },
            });
            const data = r.body.value?.[0]?.timeseries?.[0]?.data ?? [];
            const points: MetricPoint[] = [];
            for (const d of data) {
              const v = d[AGG_KEY[def.aggregation]];
              if (typeof v === "number" && typeof d.timeStamp === "string") points.push({ timestamp: new Date(d.timeStamp).toISOString(), value: v });
            }
            result.items.push({ metric: portable, unit: def.unit, address: node.address, provider: "azure", native: { resource: id, metric: def.metricName, aggregation: def.aggregation, interval, datapoints: points.length }, points });
            if (!result.sources.includes(AZURE_METRICS_SOURCE_ID)) result.sources.push(AZURE_METRICS_SOURCE_ID);
          } catch (e) {
            if (signal.aborted) throw signal.reason ?? e;
            result.unavailable.push({ source: AZURE_METRICS_SOURCE_ID, reason: `${portable}: ${unavailableFrom(AZURE_METRICS_SOURCE_ID, e).reason}` });
          }
        }
      }
      if (result.notes!.length === 0) delete result.notes;
      return result;
    },
  };
}

