/**
 * The observability fabric (spec §20, ADR-0011): one query surface over many
 * backends.
 *
 * A query is validated (strict schema, ordered/non-future/≤7-day range, hard
 * limits), then sent in parallel to every source that supports the signal and
 * covers the scope. The answers are merged, re-bounded and re-sanitized here —
 * so even a source that forgot to redact or to honour `limit` cannot leak text
 * or overflow the response.
 *
 * Partial answers are labeled, never fatal:
 *   - a source that throws, rejects or exceeds the per-source timeout (default
 *     10 s) becomes an `unavailable` entry naming it and (redacted) why;
 *   - the other sources' items are still returned;
 *   - `simulated` is true if ANY contributing source is simulated;
 *   - when no source can answer at all, the result says so instead of being
 *     silently empty.
 * The only things that throw are a malformed query (`ObservabilityInputError`,
 * the caller's bug) and a caller-initiated abort (the signal's reason, because
 * then nobody wants the answer).
 *
 * Tenant boundary: logs and events whose `environmentId` differs from the
 * scope's are dropped, and when the scope names addresses, items from other
 * addresses are dropped. Sources are constructed per environment with sessions
 * the credential broker already scoped; this is the second line.
 */
import { SourceTimeoutError, throwIfAborted, withLinkedDeadline } from "./abort";
import { errorMessage, meetsMinSeverity, severityFilterNote, sortNewestFirst, tsMs } from "./normalize";
import {
  MAX_POINTS_PER_SERIES,
  SERIES_PER_QUERY_MAX,
  validateEventQuery,
  validateLogQuery,
  validateMetricQuery,
  validateTraceQuery,
} from "./query";
import { sanitizeEvent, sanitizeLog, sanitizeMessage, sanitizeNative, sanitizeReason } from "./redact";
import type {
  EventQuery,
  LogQuery,
  MetricQuery,
  MetricSeries,
  NormalizedEvent,
  NormalizedLog,
  ObservabilityFabric,
  ObservabilitySource,
  QueryResult,
  SignalScope,
  SignalType,
  TimeRange,
  TraceSpanSummary,
} from "./types";

export const DEFAULT_SOURCE_TIMEOUT_MS = 10_000;

export interface FabricOptions {
  /** per-source deadline; a source still running at this point is reported `unavailable` */
  timeoutMs?: number;
  /** injectable clock for range validation */
  now?: () => Date;
}

interface Answer<T> {
  source: ObservabilitySource;
  result: QueryResult<T>;
}

interface FanOut<T> {
  answers: Answer<T>[];
  unavailable: { source: string; reason: string }[];
  notes: string[];
}

export function createObservabilityFabric(sources: ObservabilitySource[], options: FabricOptions = {}): ObservabilityFabric {
  const ids = new Set<string>();
  for (const s of sources) {
    if (ids.has(s.id)) throw new Error(`Duplicate observability source id: ${s.id}`);
    ids.add(s.id);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive number");
  const nowMs = () => (options.now ? options.now() : new Date()).getTime();

  async function fanOut<T>(
    signalType: SignalType,
    scope: SignalScope,
    call: (source: ObservabilitySource, signal: AbortSignal) => Promise<QueryResult<T>> | undefined,
    parent: AbortSignal | undefined
  ): Promise<FanOut<T>> {
    throwIfAborted(parent);
    const out: FanOut<T> = { answers: [], unavailable: [], notes: [] };
    const selected: ObservabilitySource[] = [];
    for (const source of sources) {
      if (!source.supports.includes(signalType)) continue;
      try {
        if (source.covers && !source.covers(scope)) continue;
      } catch (err) {
        out.unavailable.push({ source: source.id, reason: `scope check failed: ${sanitizeReason(errorMessage(err))}` });
        continue;
      }
      selected.push(source);
    }
    if (selected.length === 0) {
      out.unavailable.push({ source: "fabric", reason: `no observability source supports ${signalType} signals for this scope` });
      return out;
    }

    const settled = await Promise.all(
      selected.map(async (source) => {
        try {
          const result = await withLinkedDeadline(parent, timeoutMs, async (signal) => {
            const pending = call(source, signal);
            if (!pending) throw new Error(`source does not implement ${signalType} queries`);
            return pending;
          });
          return { ok: true as const, source, result };
        } catch (err) {
          // a caller abort is the caller's decision, not a source failure
          throwIfAborted(parent);
          const reason = err instanceof SourceTimeoutError ? err.message : sanitizeReason(errorMessage(err));
          return { ok: false as const, source, failure: reason };
        }
      })
    );

    for (const s of settled) {
      if (!s.ok) {
        out.unavailable.push({ source: s.source.id, reason: s.failure });
        continue;
      }
      out.answers.push({ source: s.source, result: s.result });
      for (const u of s.result.unavailable ?? []) out.unavailable.push({ source: sanitizeReason(u.source, 128), reason: sanitizeReason(u.reason) });
      for (const n of s.result.notes ?? []) out.notes.push(sanitizeReason(n, 300));
    }
    return out;
  }

  function finish<T>(items: T[], limit: number, fan: FanOut<T>, extraNotes: string[] = []): QueryResult<T> {
    const contributing = fan.answers;
    const sourceIds = new Set<string>();
    for (const a of contributing) {
      // a source that names nothing and reported no failure answered as itself;
      // one that reported failures and named nothing answered nothing
      const named = a.result.sources.length > 0 ? a.result.sources : a.result.unavailable.length === 0 ? [a.source.id] : [];
      for (const id of named) sourceIds.add(sanitizeReason(id, 128));
    }
    const notes = [...new Set([...fan.notes, ...extraNotes])];
    const result: QueryResult<T> = {
      items: items.slice(0, limit),
      sources: [...sourceIds],
      truncated: items.length > limit || contributing.some((a) => a.result.truncated),
      simulated: contributing.some((a) => a.result.simulated),
      unavailable: fan.unavailable,
    };
    if (notes.length) result.notes = notes;
    return result;
  }

  const inRange = (timestamp: string, range: TimeRange & { to: string }): boolean => {
    const t = tsMs(timestamp);
    return t === Number.NEGATIVE_INFINITY || (t >= Date.parse(range.from) && t <= Date.parse(range.to));
  };
  const inScope = (item: { environmentId: string; address?: string }, scope: SignalScope): boolean =>
    item.environmentId === scope.environmentId && (!scope.addresses?.length || item.address === undefined || scope.addresses.includes(item.address));

  return {
    async searchLogs(input: LogQuery, signal?: AbortSignal): Promise<QueryResult<NormalizedLog>> {
      const query = validateLogQuery(input, nowMs());
      const fan = await fanOut<NormalizedLog>("log", query.scope, (s, sig) => s.searchLogs?.(query, sig), signal);
      const items = sortNewestFirst(
        fan.answers
          .flatMap((a) => a.result.items)
          .map(sanitizeLog)
          .filter((l) => inScope(l, query.scope) && inRange(l.timestamp, query.range) && meetsMinSeverity(l.severity, query.minSeverity)),
        (l) => l.timestamp
      );
      const filterNote = query.minSeverity && query.minSeverity !== "unknown" ? [severityFilterNote] : [];
      return finish(items, query.limit, fan, filterNote);
    },

    async queryMetrics(input: MetricQuery, signal?: AbortSignal): Promise<QueryResult<MetricSeries>> {
      const query = validateMetricQuery(input, nowMs());
      const fan = await fanOut<MetricSeries>("metric", query.scope, (s, sig) => s.queryMetrics?.(query, sig), signal);
      let pointsCut = false;
      const series = fan.answers
        .flatMap((a) => a.result.items)
        .map((s) => {
          const points = s.points.filter((p) => Number.isFinite(p.value) && tsMs(p.timestamp) > Number.NEGATIVE_INFINITY);
          if (points.length > MAX_POINTS_PER_SERIES) pointsCut = true;
          return { ...s, points: points.slice(0, MAX_POINTS_PER_SERIES), native: sanitizeNative(s.native).value };
        });
      const merged = finish(series, SERIES_PER_QUERY_MAX, fan, pointsCut ? [`series were cut to ${MAX_POINTS_PER_SERIES} points`] : []);
      if (pointsCut) merged.truncated = true;
      return merged;
    },

    async searchEvents(input: EventQuery, signal?: AbortSignal): Promise<QueryResult<NormalizedEvent>> {
      const query = validateEventQuery(input, nowMs());
      const fan = await fanOut<NormalizedEvent>("event", query.scope, (s, sig) => s.searchEvents?.(query, sig), signal);
      const items = sortNewestFirst(
        fan.answers
          .flatMap((a) => a.result.items)
          .map(sanitizeEvent)
          .filter((e) => inScope(e, query.scope) && inRange(e.timestamp, query.range)),
        (e) => e.timestamp
      );
      return finish(items, query.limit, fan);
    },

    async searchTraces(input, signal?: AbortSignal): Promise<QueryResult<TraceSpanSummary>> {
      const query = validateTraceQuery(input, nowMs());
      const fan = await fanOut<TraceSpanSummary>("trace", query.scope, (s, sig) => s.searchTraces?.(query, sig), signal);
      const items = sortNewestFirst(
        fan.answers.flatMap((a) => a.result.items).map(sanitizeTrace),
        (t) => t.startedAt
      );
      return finish(items, query.limit, fan);
    },
  };
}

function sanitizeTrace(t: TraceSpanSummary): TraceSpanSummary {
  return { ...t, rootName: sanitizeMessage(t.rootName).message.slice(0, 256), native: sanitizeNative(t.native).value };
}
