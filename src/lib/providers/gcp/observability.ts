/**
 * Federated observability over Cloud Logging and Cloud Monitoring
 * (`ObservabilitySource`, ADR-0011): Zenith asks Google at query time and
 * normalizes the answer; nothing is ingested.
 *
 * Logs — `entries:list` (POST) with a filter Zenith builds:
 *   - resource selection comes from resources Zenith already knows
 *     (`resources(scope)`: address, native type, externalId). Names that go
 *     into the filter are taken from externalIds that matched strict patterns
 *     and are escaped as string literals; nothing from the query's free text
 *     is placed anywhere except inside one escaped literal;
 *   - the caller's `text` is a substring search, inserted as a single quoted
 *     literal (backslash and quote escaped, control characters dropped,
 *     ≤ 200 chars), never as query syntax;
 *   - time bounds are re-serialized from parsed dates, severity from a closed
 *     map, the page size is clamped to 1–1000 (default 200), one page only
 *     (`truncated` when Google has more).
 * Log text is untrusted data: each message is scrubbed for credential shapes
 * (bearer tokens, JWTs, Google tokens, PEM blocks), bounded to 2000 chars and
 * returned as data; it is never interpreted.
 *
 * Metrics — `timeSeries.list` (GET) for a small portable table (below). Each
 * portable metric maps to exactly one Monitoring metric type, aligner and
 * reducer; a metric not in the table, or not applicable to a resource type,
 * is reported under `unavailable`, never approximated.
 *
 * Honest limits: exercised against a fake server only (contract evidence).
 * The Monitoring resource label formats (notably `redis_instance.instance_id`)
 * follow Google's public metric reference and are matched both ways where the
 * documentation is ambiguous; they have not been verified against a live
 * project. The source holds no session: each query runs inside
 * `withSession` supplied by the credential broker.
 */
import type { GcpSession } from "@/lib/credentials/types";
import type {
  LogQuery,
  MetricPoint,
  MetricQuery,
  MetricSeries,
  NormalizedLog,
  ObservabilitySource,
  QueryResult,
  Severity,
  SignalScope,
} from "@/lib/observability/types";
import { scrub } from "./errors";
import { gcpCall, gcpGet, type RestContext } from "./rest";

export interface GcpResourceRef {
  address: string;
  nativeType: string;
  /** provider-side id recorded by an observation, e.g. `projects/p/locations/r/services/s` */
  externalId: string;
}

export interface GcpObservabilityOptions {
  /** run `fn` inside a credential-broker session for this query */
  withSession<T>(fn: (session: GcpSession) => Promise<T>): Promise<T>;
  /** the environment's known resources (recorded observations); the source never guesses names */
  resources(scope: SignalScope): Promise<GcpResourceRef[]>;
}

const LOGGING = "https://logging.googleapis.com/v2";
const MONITORING = "https://monitoring.googleapis.com/v3";
const MAX_RESOURCES = 20;
const MAX_TEXT = 200;
const MAX_MESSAGE = 2000;
const MAX_SERIES = 20;
const MAX_POINTS = 1000;

export const SOURCE_ID = "gcp.cloud-logging+monitoring";

/* ------------------------------ filter building ----------------------------- */

/** A Cloud Logging / Monitoring filter string literal: quoted, `\` and `"` escaped, control characters removed. */
export function filterLiteral(text: string, max = MAX_TEXT): string {
  const cleaned = String(text)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, max)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `"${cleaned}"`;
}

const SEVERITY_FLOOR: Record<Severity, string | undefined> = {
  trace: "DEBUG",
  debug: "DEBUG",
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
  fatal: "CRITICAL",
  unknown: undefined,
};

function severityOf(s: unknown): Severity {
  switch (String(s ?? "").toUpperCase()) {
    case "DEBUG":
      return "debug";
    case "INFO":
    case "NOTICE":
      return "info";
    case "WARNING":
      return "warn";
    case "ERROR":
      return "error";
    case "CRITICAL":
    case "ALERT":
    case "EMERGENCY":
      return "fatal";
    default:
      return "unknown";
  }
}

const lastSegment = (id: string): string => id.split("/").pop() ?? id;

/** `projects/p/logs/run.googleapis.com%2Fstderr` → `run.googleapis.com/stderr` */
function logNameOf(name: string): string {
  const i = name.indexOf("/logs/");
  const tail = i >= 0 ? name.slice(i + 6) : name;
  try {
    return decodeURIComponent(tail).slice(0, 200);
  } catch {
    return tail.slice(0, 200);
  }
}

const CLOUD_RUN_SERVICE = /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/locations\/([a-z0-9-]{2,40})\/services\/([a-z][a-z0-9-]{0,62})$/;
const CLOUD_RUN_JOB = /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/locations\/([a-z0-9-]{2,40})\/jobs\/([a-z][a-z0-9-]{0,62})$/;
const SQL_INSTANCE = /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/instances\/([a-z][a-z0-9-]{0,97})$/;
const REDIS_INSTANCE = /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/locations\/([a-z0-9-]{2,40})\/instances\/([a-z][a-z0-9-]{0,39})$/;

interface Resolved extends GcpResourceRef {
  /** the log filter clause selecting this resource */
  logClause?: string;
  /** the monitoring resource clause, by metric family */
  monitoring?: { family: "run" | "sql" | "redis"; clause: string };
  /** value of the label entries carry, for mapping a log entry back to an address */
  key?: { label: string; value: string };
}

function resolve(ref: GcpResourceRef, projectId: string): Resolved | undefined {
  const inProject = (m: RegExpExecArray | null) => (m && m[1] === projectId ? m : null);
  switch (ref.nativeType) {
    case "gcp:cloud_run_service": {
      const m = inProject(CLOUD_RUN_SERVICE.exec(ref.externalId));
      if (!m) return undefined;
      const name = filterLiteral(m[3]);
      return {
        ...ref,
        logClause: `resource.type="cloud_run_revision" AND resource.labels.service_name=${name} AND resource.labels.location=${filterLiteral(m[2])}`,
        monitoring: { family: "run", clause: `resource.type="cloud_run_revision" AND resource.labels.service_name=${name}` },
        key: { label: "service_name", value: m[3] },
      };
    }
    case "gcp:cloud_run_job": {
      const m = inProject(CLOUD_RUN_JOB.exec(ref.externalId));
      if (!m) return undefined;
      return { ...ref, logClause: `resource.type="cloud_run_job" AND resource.labels.job_name=${filterLiteral(m[3])} AND resource.labels.location=${filterLiteral(m[2])}`, key: { label: "job_name", value: m[3] } };
    }
    case "gcp:cloud_sql_instance": {
      const m = inProject(SQL_INSTANCE.exec(ref.externalId));
      if (!m) return undefined;
      const dbId = filterLiteral(`${m[1]}:${m[2]}`);
      return { ...ref, logClause: `resource.type="cloudsql_database" AND resource.labels.database_id=${dbId}`, monitoring: { family: "sql", clause: `resource.type="cloudsql_database" AND resource.labels.database_id=${dbId}` }, key: { label: "database_id", value: `${m[1]}:${m[2]}` } };
    }
    case "gcp:memorystore_instance": {
      const m = inProject(REDIS_INSTANCE.exec(ref.externalId));
      if (!m) return undefined;
      // Google documents instance_id as the instance id; some views show the full relative name — match either
      const either = `(resource.labels.instance_id=${filterLiteral(m[3])} OR resource.labels.instance_id=${filterLiteral(ref.externalId)})`;
      return { ...ref, logClause: `resource.type="redis_instance" AND ${either}`, monitoring: { family: "redis", clause: `resource.type="redis_instance" AND ${either}` }, key: { label: "instance_id", value: m[3] } };
    }
    default:
      return undefined;
  }
}

/* ------------------------------- metric table ------------------------------ */

interface MetricDef {
  family: "run" | "sql" | "redis";
  type: string;
  extra?: string;
  aligner: string;
  reducer?: string;
  unit: string;
}

export const METRIC_TABLE: Readonly<Record<string, MetricDef>> = {
  "http.requests": { family: "run", type: "run.googleapis.com/request_count", aligner: "ALIGN_RATE", reducer: "REDUCE_SUM", unit: "req/s" },
  "http.5xx.rate": { family: "run", type: "run.googleapis.com/request_count", extra: 'metric.labels.response_code_class="5xx"', aligner: "ALIGN_RATE", reducer: "REDUCE_SUM", unit: "req/s" },
  "http.latency.p99": { family: "run", type: "run.googleapis.com/request_latencies", aligner: "ALIGN_PERCENTILE_99", reducer: "REDUCE_MAX", unit: "ms" },
  "cpu.utilization": { family: "run", type: "run.googleapis.com/container/cpu/utilizations", aligner: "ALIGN_PERCENTILE_99", reducer: "REDUCE_MAX", unit: "ratio" },
  "memory.utilization": { family: "run", type: "run.googleapis.com/container/memory/utilizations", aligner: "ALIGN_PERCENTILE_99", reducer: "REDUCE_MAX", unit: "ratio" },
  "instances.count": { family: "run", type: "run.googleapis.com/container/instance_count", aligner: "ALIGN_MAX", reducer: "REDUCE_SUM", unit: "count" },
  "db.cpu.utilization": { family: "sql", type: "cloudsql.googleapis.com/database/cpu/utilization", aligner: "ALIGN_MEAN", unit: "ratio" },
  "db.connections": { family: "sql", type: "cloudsql.googleapis.com/database/postgresql/num_backends", aligner: "ALIGN_MEAN", unit: "count" },
  "cache.memory.utilization": { family: "redis", type: "redis.googleapis.com/stats/memory/usage_ratio", aligner: "ALIGN_MEAN", unit: "ratio" },
};

/* --------------------------------- source ---------------------------------- */

function isoOrUndefined(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function unavailableOf(source: string, outcome: string, detail?: string) {
  return { source, reason: outcome === "inaccessible" ? `access denied${detail ? `: ${detail}` : ""}` : outcome === "throttled" ? "throttled by Google; retry later" : `read error${detail ? `: ${detail}` : ""}` };
}

function messageOf(e: Record<string, unknown>): string {
  if (typeof e.textPayload === "string") return e.textPayload;
  const j = e.jsonPayload;
  if (j && typeof j === "object") {
    const o = j as Record<string, unknown>;
    for (const k of ["message", "msg", "error"]) if (typeof o[k] === "string") return o[k] as string;
    return JSON.stringify(j).slice(0, MAX_MESSAGE);
  }
  const http = e.httpRequest as Record<string, unknown> | undefined;
  if (http) return `${String(http.requestMethod ?? "")} ${String(http.status ?? "")}`.trim();
  const proto = e.protoPayload as Record<string, unknown> | undefined;
  if (proto) return `${String(proto.methodName ?? "audit")} ${String((proto.status as Record<string, unknown> | undefined)?.message ?? "")}`.trim();
  return "";
}

export function createGcpObservabilitySource(opts: GcpObservabilityOptions): ObservabilitySource {
  async function known(scope: SignalScope, projectId: string): Promise<{ resolved: Resolved[]; dropped: number }> {
    const all = await opts.resources(scope);
    const wanted = scope.addresses && scope.addresses.length > 0 ? new Set(scope.addresses) : undefined;
    const resolved = all
      .filter((r) => !wanted || wanted.has(r.address))
      .map((r) => resolve(r, projectId))
      .filter((r): r is Resolved => r !== undefined);
    return { resolved: resolved.slice(0, MAX_RESOURCES), dropped: Math.max(0, resolved.length - MAX_RESOURCES) };
  }

  return {
    id: SOURCE_ID,
    provider: "gcp",
    supports: ["log", "metric"],

    async searchLogs(q: LogQuery, signal: AbortSignal): Promise<QueryResult<NormalizedLog>> {
      const source = "gcp.cloud-logging";
      const empty = (reason: string): QueryResult<NormalizedLog> => ({ items: [], sources: [source], truncated: false, simulated: false, unavailable: [{ source, reason }] });
      const from = isoOrUndefined(q.range.from);
      const to = isoOrUndefined(q.range.to) ?? new Date().toISOString();
      if (!from) return empty("the time range is not valid");
      const requested = Math.trunc(q.limit ?? 0);
      const limit = requested >= 1 ? Math.min(requested, 1000) : 200;

      return opts.withSession(async (session) => {
        const ctx: RestContext = { session, signal };
        const { resolved, dropped } = await known(q.scope, session.projectId);
        if (resolved.length === 0) return empty("no known Cloud Run, Cloud SQL or Memorystore resources in scope");
        const clauses = [
          `(${resolved.map((r) => `(${r.logClause})`).join(" OR ")})`,
          `timestamp>=${filterLiteral(from)}`,
          `timestamp<=${filterLiteral(to)}`,
        ];
        const floor = q.minSeverity ? SEVERITY_FLOOR[q.minSeverity] : undefined;
        if (floor) clauses.push(`severity>=${floor}`);
        if (q.text && q.text.trim() !== "") clauses.push(filterLiteral(q.text.trim()));
        const res = await gcpCall(ctx, "POST", `${LOGGING}/entries:list`, {
          resourceNames: [`projects/${session.projectId}`],
          filter: clauses.join(" AND "),
          orderBy: "timestamp desc",
          pageSize: limit,
        });
        if (res.outcome !== "ok") return { items: [], sources: [source], truncated: false, simulated: false, unavailable: [unavailableOf(source, res.outcome, res.detail)] };

        const byKey = new Map<string, string>();
        for (const r of resolved) if (r.key) byKey.set(`${r.key.label}\0${r.key.value}`, r.address);
        const entries = Array.isArray(res.json.entries) ? (res.json.entries as Record<string, unknown>[]) : [];
        const items: NormalizedLog[] = entries.slice(0, limit).map((e) => {
          const labels = ((e.resource as Record<string, unknown> | undefined)?.labels ?? {}) as Record<string, unknown>;
          let address: string | undefined;
          for (const [k, v] of Object.entries(labels)) address ??= byKey.get(`${k}\0${String(v)}`);
          const trace = typeof e.trace === "string" ? lastSegment(e.trace) : undefined;
          return {
            timestamp: typeof e.timestamp === "string" ? e.timestamp : from,
            ...(address ? { address } : {}),
            provider: "gcp",
            environmentId: q.scope.environmentId,
            severity: severityOf(e.severity),
            message: scrub(messageOf(e), [], MAX_MESSAGE, true),
            ...(trace ? { traceId: trace } : {}),
            ...(typeof e.spanId === "string" ? { spanId: e.spanId } : {}),
            attributes: {},
            native: {
              logName: typeof e.logName === "string" ? logNameOf(e.logName) : undefined,
              resourceType: (e.resource as Record<string, unknown> | undefined)?.type,
              insertId: e.insertId,
            },
          };
        });
        const more = typeof res.json.nextPageToken === "string" && res.json.nextPageToken !== "";
        return {
          items,
          sources: [source],
          truncated: more || entries.length > limit || dropped > 0,
          simulated: false,
          unavailable: dropped > 0 ? [{ source, reason: `${dropped} resources beyond the first ${MAX_RESOURCES} were not queried` }] : [],
        };
      });
    },

    async queryMetrics(q: MetricQuery, signal: AbortSignal): Promise<QueryResult<MetricSeries>> {
      const source = "gcp.cloud-monitoring";
      const unavailable: { source: string; reason: string }[] = [];
      const from = isoOrUndefined(q.range.from);
      const to = isoOrUndefined(q.range.to) ?? new Date().toISOString();
      if (!from) return { items: [], sources: [source], truncated: false, simulated: false, unavailable: [{ source, reason: "the time range is not valid" }] };
      const step = Math.min(3600, Math.max(60, Math.round((q.stepSec ?? 60) / 60) * 60));

      return opts.withSession(async (session) => {
        const ctx: RestContext = { session, signal };
        const { resolved } = await known(q.scope, session.projectId);
        const items: MetricSeries[] = [];
        let truncated = false;
        for (const metric of [...new Set(q.metrics)].slice(0, 12)) {
          const def = METRIC_TABLE[metric];
          if (!def) {
            unavailable.push({ source, reason: `metric "${String(metric).slice(0, 40)}" is not in the GCP metric table` });
            continue;
          }
          const targets = resolved.filter((r) => r.monitoring?.family === def.family);
          if (targets.length === 0) {
            unavailable.push({ source, reason: `no resource in scope has ${metric}` });
            continue;
          }
          for (const t of targets) {
            if (items.length >= MAX_SERIES) {
              truncated = true;
              break;
            }
            const params = new URLSearchParams({
              filter: `metric.type=${filterLiteral(def.type)} AND ${t.monitoring!.clause}${def.extra ? ` AND ${def.extra}` : ""}`,
              "interval.startTime": from,
              "interval.endTime": to,
              "aggregation.alignmentPeriod": `${step}s`,
              "aggregation.perSeriesAligner": def.aligner,
              view: "FULL",
            });
            if (def.reducer) params.set("aggregation.crossSeriesReducer", def.reducer);
            const res = await gcpGet(ctx, `${MONITORING}/projects/${session.projectId}/timeSeries?${params.toString()}`);
            if (res.outcome !== "ok") {
              unavailable.push(unavailableOf(source, res.outcome, res.detail));
              continue;
            }
            const series = Array.isArray(res.json.timeSeries) ? (res.json.timeSeries as Record<string, unknown>[]) : [];
            const points: MetricPoint[] = [];
            for (const s of series) {
              for (const p of Array.isArray(s.points) ? (s.points as Record<string, unknown>[]) : []) {
                const v = (p.value ?? {}) as Record<string, unknown>;
                const raw = v.doubleValue ?? v.int64Value;
                const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
                const end = (p.interval as Record<string, unknown> | undefined)?.endTime;
                if (Number.isFinite(num) && typeof end === "string") points.push({ timestamp: end, value: num });
              }
            }
            points.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
            if (points.length > MAX_POINTS) truncated = true;
            items.push({
              metric,
              unit: def.unit,
              address: t.address,
              provider: "gcp",
              native: { metricType: def.type, aligner: def.aligner, ...(def.reducer ? { reducer: def.reducer } : {}), alignmentPeriodSec: step },
              points: points.slice(-MAX_POINTS),
            });
          }
        }
        return { items, sources: [source], truncated, simulated: false, unavailable };
      });
    },
  };
}
