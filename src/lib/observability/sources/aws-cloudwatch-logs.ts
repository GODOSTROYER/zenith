/**
 * CloudWatch Logs source (`aws.cloudwatch-logs`).
 *
 * Evidence level: `contract` — exercised only against mocked SDK clients
 * (aws-sdk-client-mock). Nothing here has run against real CloudWatch or
 * LocalStack.
 *
 * Log groups come from the graph (see `aws-resolve.ts`); a node whose group
 * cannot be read from what the platform knows is reported `unavailable`, never
 * guessed. The session is injected — the source never builds credentials and
 * must be used inside the credential broker's `withSession` callback.
 *
 * How a search works, and its honest limits:
 *   - `FilterLogEvents` returns events OLDEST first and has no reverse order,
 *     so "the latest 200 lines" cannot be asked for directly. The search walks
 *     BACKWARDS from `range.to` in windows that start at 15 minutes and grow
 *     4x, draining each window (bounded pages) and stopping as soon as `limit`
 *     matching lines are in hand — so what is returned is genuinely the newest
 *     matches. Call and page budgets bound the work; when a budget stops the
 *     walk early the result is `truncated` and a note says how far back it
 *     looked. A window that could not be drained inside its page budget is
 *     called out too, because its newest lines may be missing. A soft time
 *     budget (`softDeadlineMs`, 8 s by default, below the fabric's 10 s hard
 *     per-source timeout) stops the walk the same way, so a slow CloudWatch
 *     yields the newest lines read so far instead of nothing.
 *   - The text filter is ONE quoted CloudWatch filter term built by
 *     `cloudWatchFilterPattern` (backslash and quote escaped, control
 *     characters flattened). Raw text never reaches the pattern language.
 *     Matching is case-sensitive and substring-like, as CloudWatch defines it.
 *   - Severity is inferred from the message (JSON level field, `level=`,
 *     uppercase token); the inference used is recorded in
 *     `native.severityHeuristic`. It is not a CloudWatch field.
 *   - ECS `awslogs` stream names (`<prefix>/<container>/<task-id>`) are parsed
 *     into `native.ecsContainer` / `native.ecsTaskId`.
 *   - `aggregate()` (Logs Insights) is an additional, non-fan-out entry point
 *     for counts over time; it polls with a bounded wait and stops the query
 *     on timeout or abort.
 */
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  GetQueryResultsCommand,
  StartQueryCommand,
  StopQueryCommand,
  type FilteredLogEvent,
} from "@aws-sdk/client-cloudwatch-logs";
import type { AwsSession } from "@/lib/credentials/types";
import type { Observation, ResourceGraph, ResourceNode } from "@/lib/resources/types";
import { SourceTimeoutError, sleep, throwIfAborted } from "../abort";
import { cloudWatchFilterPattern, insightsStringLiteral } from "../escape";
import { effectiveStepSec } from "../query";
import {
  errorMessage,
  inferSeverity,
  meetsMinSeverity,
  severityFilterNote,
  sortNewestFirst,
  traceContext,
} from "../normalize";
import { sanitizeLog, sanitizeReason } from "../redact";
import type { LogQuery, MetricPoint, MetricSeries, NormalizedLog, ObservabilitySource, QueryResult, SignalScope } from "../types";
import { awsContext, logGroupsOf, type AwsContext } from "./aws-resolve";
import { bindingOf, coversScope, nodesInScope, sameEnvironment, type EnvironmentBinding } from "./scope";
import { abortable, mapPool } from "./util";

export const CLOUDWATCH_LOGS_SOURCE_ID = "aws.cloudwatch-logs";

export interface CloudWatchLogsLimits {
  /** log groups searched per query; the rest are reported in a note */
  maxLogGroups: number;
  /** FilterLogEvents calls per log group per query */
  maxCallsPerGroup: number;
  /** pages drained per time window before the window is declared unfinished */
  maxPagesPerWindow: number;
  /** log groups queried at once */
  groupConcurrency: number;
  /** size of the newest window; later windows grow 4x */
  initialWindowMs: number;
  /**
   * Soft time budget for one search. When it elapses the walk stops and the
   * newest lines read so far are returned, `truncated`, with a note — instead
   * of the fabric's hard per-source timeout discarding everything. Keep it
   * below the fabric timeout (default 10 s).
   */
  softDeadlineMs: number;
  /** Logs Insights polling interval */
  insightsPollMs: number;
  /** Logs Insights: longest total wait before the query is stopped */
  insightsMaxWaitMs: number;
}

export const DEFAULT_CLOUDWATCH_LOGS_LIMITS: CloudWatchLogsLimits = {
  maxLogGroups: 10,
  maxCallsPerGroup: 12,
  maxPagesPerWindow: 3,
  groupConcurrency: 4,
  initialWindowMs: 15 * 60_000,
  softDeadlineMs: 8000,
  insightsPollMs: 1000,
  insightsMaxWaitMs: 30_000,
};

export interface CloudWatchLogsConfig {
  session: AwsSession;
  graph: ResourceGraph;
  /** `localstack` when the session's transport is the emulator */
  provider?: "aws" | "localstack";
  workspaceId?: string;
  /** latest driver observations, the preferred source of native identifiers */
  observations?: readonly Observation[];
  limits?: Partial<CloudWatchLogsLimits>;
}

export interface CloudWatchLogsSource extends ObservabilitySource {
  /**
   * Count of lines matching `text` per time bucket, via CloudWatch Logs
   * Insights. Not part of the fan-out contract; call it directly for
   * aggregate questions ("how many matching lines per minute?").
   */
  aggregate(q: { scope: SignalScope; range: { from: string; to: string }; text?: string; stepSec?: number }, signal: AbortSignal): Promise<QueryResult<MetricSeries>>;
}

const LOG_KINDS = new Set<string>(["log_group", "container_service", "function", "scheduled_job"]);

interface Target {
  group: string;
  address: string;
}

export function createCloudWatchLogsSource(config: CloudWatchLogsConfig): CloudWatchLogsSource {
  const provider = config.provider ?? "aws";
  const limits = { ...DEFAULT_CLOUDWATCH_LOGS_LIMITS, ...config.limits };
  const binding: EnvironmentBinding = bindingOf(config.graph, config.workspaceId);
  const ctx: AwsContext = awsContext(config.graph, config.observations);
  const isLogNode = (n: ResourceNode) => (n.provider === "aws" || n.provider === "localstack") && LOG_KINDS.has(n.kind);
  const client = (): CloudWatchLogsClient => config.session.client(CloudWatchLogsClient);
  const empty = <T>(): QueryResult<T> => ({ items: [], sources: [], truncated: false, simulated: false, unavailable: [] });

  /** Resolve the scope to log groups; collect why some nodes could not be resolved. */
  function targetsFor(scope: SignalScope): { targets: Target[]; unresolved: string[]; skipped: number } {
    const byGroup = new Map<string, Target & { rank: number }>();
    const unresolved: string[] = [];
    for (const node of nodesInScope(config.graph, scope, isLogNode)) {
      const r = logGroupsOf(ctx, node);
      if (!r.ok) {
        unresolved.push(r.reason);
        continue;
      }
      // a service that owns the group names it better than the bare log_group node
      const rank = node.kind === "log_group" ? 1 : 0;
      for (const group of r.value) {
        const cur = byGroup.get(group);
        if (!cur || rank < cur.rank) byGroup.set(group, { group, address: node.address, rank });
      }
    }
    const all = [...byGroup.values()].sort((a, b) => (a.address === b.address ? a.group.localeCompare(b.group) : a.address.localeCompare(b.address)));
    return { targets: all.slice(0, limits.maxLogGroups), unresolved, skipped: Math.max(0, all.length - limits.maxLogGroups) };
  }

  return {
    id: CLOUDWATCH_LOGS_SOURCE_ID,
    provider,
    supports: ["log"],
    covers: (scope) => coversScope(binding, config.graph, scope, isLogNode),

    async searchLogs(q: LogQuery, signal: AbortSignal): Promise<QueryResult<NormalizedLog>> {
      if (!sameEnvironment(binding, q.scope)) return empty();
      const range = rangeMs(q.range);
      const limit = q.limit ?? 200;
      const { targets, unresolved, skipped } = targetsFor(q.scope);
      const result: QueryResult<NormalizedLog> = { items: [], sources: [], truncated: false, simulated: false, unavailable: [], notes: [] };
      for (const reason of unresolved) result.unavailable.push({ source: CLOUDWATCH_LOGS_SOURCE_ID, reason });
      if (skipped > 0) result.notes!.push(`${skipped} more log group(s) not searched (limit ${limits.maxLogGroups} per query)`);
      if (targets.length === 0) return finalize(result);

      const cw = client();
      const soft = AbortSignal.timeout(limits.softDeadlineMs);
      const pattern = q.text ? cloudWatchFilterPattern(q.text) : undefined;
      const perGroup = await mapPool(targets, limits.groupConcurrency, signal, async (target) => {
        try {
          return { target, read: await readGroup(cw, target, { range, pattern, limit, minSeverity: q.minSeverity, provider, environmentId: binding.environmentId, limits, soft }, signal) };
        } catch (err) {
          throwIfAborted(signal);
          return { target, failure: err instanceof SourceTimeoutError ? err.message : sanitizeReason(errorMessage(err)) };
        }
      });

      let answered = false;
      const merged: NormalizedLog[] = [];
      for (const g of perGroup) {
        if ("failure" in g) {
          result.unavailable.push({ source: CLOUDWATCH_LOGS_SOURCE_ID, reason: `log group ${g.target.group}: ${g.failure}` });
          continue;
        }
        answered = true;
        merged.push(...g.read.logs);
        if (g.read.truncated) result.truncated = true;
        result.notes!.push(...g.read.notes);
      }
      const sorted = sortNewestFirst(merged, (l) => l.timestamp);
      result.items = sorted.slice(0, limit);
      if (sorted.length > limit) result.truncated = true;
      if (answered) result.sources.push(CLOUDWATCH_LOGS_SOURCE_ID);
      if (result.truncated) result.notes!.push("results are the newest matches: the search walks backwards from the end of the range because FilterLogEvents has no reverse order");
      if (q.minSeverity && q.minSeverity !== "unknown") result.notes!.push(severityFilterNote);
      return finalize(result);
    },

    async aggregate(q, signal): Promise<QueryResult<MetricSeries>> {
      if (!sameEnvironment(binding, q.scope)) return empty();
      const range = rangeMs(q.range);
      const { targets, unresolved, skipped } = targetsFor(q.scope);
      const result: QueryResult<MetricSeries> = { items: [], sources: [], truncated: false, simulated: false, unavailable: [], notes: [] };
      for (const reason of unresolved) result.unavailable.push({ source: CLOUDWATCH_LOGS_SOURCE_ID, reason });
      if (skipped > 0) result.notes!.push(`${skipped} more log group(s) not included (limit ${limits.maxLogGroups} per query)`);
      if (targets.length === 0) return finalize(result);

      const stepSec = Math.max(60, Math.ceil(effectiveStepSec(q.stepSec, range.to - range.from) / 60) * 60);
      const queryString = insightsQuery(q.text, stepSec);
      const groups = targets.map((t) => t.group);
      try {
        const rows = await runInsights(client(), groups, range, queryString, limits, signal);
        result.sources.push(CLOUDWATCH_LOGS_SOURCE_ID);
        result.items.push({
          metric: "logs.matching.count",
          unit: "Count",
          provider,
          native: { source: "logs-insights", logGroups: groups, query: queryString, stepSec, statistics: rows.statistics },
          points: rows.points,
        });
      } catch (err) {
        throwIfAborted(signal);
        result.unavailable.push({ source: CLOUDWATCH_LOGS_SOURCE_ID, reason: `logs insights: ${sanitizeReason(errorMessage(err))}` });
      }
      return finalize(result);
    },
  };
}

function finalize<T>(result: QueryResult<T>): QueryResult<T> {
  if (result.notes && result.notes.length === 0) delete result.notes;
  return result;
}

function rangeMs(range: { from: string; to?: string }): { from: number; to: number } {
  return { from: Date.parse(range.from), to: range.to === undefined ? Date.now() : Date.parse(range.to) };
}

/* ------------------------------ FilterLogEvents ---------------------------- */

interface ReadOptions {
  range: { from: number; to: number };
  pattern: string | undefined;
  limit: number;
  minSeverity: LogQuery["minSeverity"];
  provider: string;
  environmentId: string;
  limits: CloudWatchLogsLimits;
  /** aborts when the soft time budget elapses; distinct from the caller's signal */
  soft: AbortSignal;
}

interface GroupRead {
  logs: NormalizedLog[];
  truncated: boolean;
  notes: string[];
}

/**
 * Newest `limit` matching lines of one log group, found by walking backwards in
 * growing windows (see the module comment). Exported for tests.
 */
export async function readGroup(client: CloudWatchLogsClient, target: Target, opts: ReadOptions, signal: AbortSignal): Promise<GroupRead> {
  const { range, limits } = opts;
  const linked = AbortSignal.any([signal, opts.soft]);
  const logs: NormalizedLog[] = [];
  const seen = new Set<string>();
  const notes: string[] = [];
  let truncated = false;
  let calls = 0;
  let end = range.to;
  let size = limits.initialWindowMs;
  /** oldest millisecond fully read so far; the newest windows are always read first */
  let coveredFrom: number | undefined;
  const pageSize = Math.min(1000, Math.max(opts.limit, 50));
  const searchedBack = () => (coveredFrom === undefined ? "no window was fully read" : `searched back to ${new Date(coveredFrom).toISOString()} only`);

  try {
    while (end >= range.from) {
      const start = Math.max(range.from, end - size);
      let token: string | undefined;
      let pages = 0;
      do {
        if (calls >= limits.maxCallsPerGroup) {
          truncated = true;
          notes.push(`${target.group}: call budget (${limits.maxCallsPerGroup}) reached; ${searchedBack()}`);
          return { logs, truncated, notes };
        }
        throwIfAborted(linked);
        const page = await abortable(
          client.send(
            new FilterLogEventsCommand({
              logGroupName: target.group,
              startTime: start,
              endTime: end,
              ...(opts.pattern ? { filterPattern: opts.pattern } : {}),
              limit: pageSize,
              ...(token ? { nextToken: token } : {}),
            }),
            { abortSignal: linked }
          ),
          linked
        );
        calls++;
        pages++;
        for (const e of page.events ?? []) {
          const log = normalizeEvent(e, target, opts);
          if (!log) continue;
          const id = e.eventId ?? `${e.logStreamName}:${e.timestamp}:${log.message.length}`;
          if (seen.has(id)) continue;
          seen.add(id);
          if (meetsMinSeverity(log.severity, opts.minSeverity)) logs.push(log);
        }
        token = page.nextToken;
      } while (token && pages < limits.maxPagesPerWindow);

      if (token) {
        truncated = true;
        notes.push(`${target.group}: window ${new Date(start).toISOString()}..${new Date(end).toISOString()} not fully read (page budget ${limits.maxPagesPerWindow}); its newest lines may be missing`);
      } else {
        coveredFrom = start;
      }
      if (logs.length >= opts.limit) {
        if (start > range.from) truncated = true;
        break;
      }
      if (start <= range.from) break;
      end = start - 1;
      size *= 4;
    }
  } catch (err) {
    // the soft budget elapsed (the caller did not abort): keep what was read, newest first, and say so
    if (opts.soft.aborted && !signal.aborted) {
      // nothing was read at all: that is a failure to answer, not a short answer
      if (calls === 0) throw new SourceTimeoutError(limits.softDeadlineMs);
      truncated = true;
      notes.push(`${target.group}: time budget (${limits.softDeadlineMs} ms) reached; ${searchedBack()}`);
      return { logs, truncated, notes };
    }
    throw err;
  }
  return { logs, truncated, notes };
}

const ECS_STREAM = /^([^/]+)\/([^/]+)\/([A-Za-z0-9-]{8,64})$/;

/** ECS awslogs stream name → container and task id (`ecs/web/<task-id>`); undefined for other shapes. */
export function parseEcsLogStream(stream: string | undefined): { prefix: string; container: string; taskId: string } | undefined {
  const m = stream ? ECS_STREAM.exec(stream) : null;
  return m ? { prefix: m[1], container: m[2], taskId: m[3] } : undefined;
}

function normalizeEvent(e: FilteredLogEvent, target: Target, opts: ReadOptions): NormalizedLog | undefined {
  if (typeof e.timestamp !== "number" || typeof e.message !== "string") return undefined;
  const guess = inferSeverity(e.message);
  const native: Record<string, unknown> = { logGroup: target.group };
  if (e.logStreamName) native.logStream = e.logStreamName;
  if (e.eventId) native.eventId = e.eventId;
  if (typeof e.ingestionTime === "number") native.ingestionTime = new Date(e.ingestionTime).toISOString();
  const ecs = parseEcsLogStream(e.logStreamName);
  if (ecs) {
    native.ecsContainer = ecs.container;
    native.ecsTaskId = ecs.taskId;
  }
  if (guess.heuristic) native.severityHeuristic = guess.heuristic;
  return sanitizeLog({
    timestamp: new Date(e.timestamp).toISOString(),
    address: target.address,
    provider: opts.provider,
    environmentId: opts.environmentId,
    severity: guess.severity,
    message: e.message,
    ...traceContext(e.message),
    attributes: {},
    native,
  });
}

/* ------------------------------ Logs Insights ------------------------------ */

/** `filter @message like "<escaped>" | stats count(*) as matches by bin(<n>s)`; the step is an integer we computed, never user text. */
export function insightsQuery(text: string | undefined, stepSec: number): string {
  const step = Math.max(60, Math.floor(stepSec));
  const filter = text ? `filter @message like ${insightsStringLiteral(text)} | ` : "";
  return `${filter}stats count(*) as matches by bin(${step}s)`;
}

interface InsightsRows {
  points: MetricPoint[];
  statistics: Record<string, number>;
}

async function runInsights(
  cw: CloudWatchLogsClient,
  groups: string[],
  range: { from: number; to: number },
  queryString: string,
  limits: CloudWatchLogsLimits,
  signal: AbortSignal
): Promise<InsightsRows> {
  const started = await abortable(
    cw.send(
      new StartQueryCommand({
        logGroupNames: groups,
        startTime: Math.floor(range.from / 1000),
        endTime: Math.ceil(range.to / 1000),
        queryString,
        limit: 10_000,
      }),
      { abortSignal: signal }
    ),
    signal
  );
  const queryId = started.queryId;
  if (!queryId) throw new Error("StartQuery returned no queryId");

  const deadline = Date.now() + limits.insightsMaxWaitMs;
  try {
    for (;;) {
      throwIfAborted(signal);
      const res = await abortable(cw.send(new GetQueryResultsCommand({ queryId }), { abortSignal: signal }), signal);
      const status = res.status ?? "Unknown";
      if (status === "Complete") return { points: toPoints(res.results ?? []), statistics: statsOf(res.statistics) };
      if (status !== "Running" && status !== "Scheduled") throw new Error(`query ended with status ${status}`);
      if (Date.now() + limits.insightsPollMs > deadline) throw new Error(`did not finish within ${Math.round(limits.insightsMaxWaitMs / 1000)}s`);
      await sleep(limits.insightsPollMs, signal);
    }
  } catch (err) {
    // best effort: stop a query we will never read so it does not keep scanning (and billing) after we gave up
    void Promise.resolve(cw.send(new StopQueryCommand({ queryId }))).catch(() => undefined);
    throw err;
  }
}

function statsOf(s: { recordsMatched?: number; recordsScanned?: number; bytesScanned?: number } | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof s?.recordsMatched === "number") out.recordsMatched = s.recordsMatched;
  if (typeof s?.recordsScanned === "number") out.recordsScanned = s.recordsScanned;
  if (typeof s?.bytesScanned === "number") out.bytesScanned = s.bytesScanned;
  return out;
}

function toPoints(rows: { field?: string; value?: string }[][]): MetricPoint[] {
  const points: MetricPoint[] = [];
  for (const row of rows) {
    const bin = row.find((f) => f.field?.startsWith("bin("))?.value;
    const count = row.find((f) => f.field === "matches")?.value;
    const at = bin ? Date.parse(`${bin.replace(" ", "T")}${/[zZ]|[+-]\d\d:?\d\d$/.test(bin) ? "" : "Z"}`) : NaN;
    const value = Number(count);
    if (Number.isFinite(at) && Number.isFinite(value)) points.push({ timestamp: new Date(at).toISOString(), value });
  }
  return points.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}
