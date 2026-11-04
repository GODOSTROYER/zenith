/**
 * Loki logs source (`loki`): `/loki/api/v1/query_range` with LogQL.
 *
 * Evidence level: `contract` — exercised only against a local fake HTTP
 * server implementing the response shape. Never run against a real Loki.
 *
 * Injection safety: the LogQL sent is always
 *
 *     {<selector>} |= "<escaped text>"
 *
 * where the selector is `name="value"` matchers from the resource graph (label
 * names sanitized to the LogQL identifier grammar, values escaped as string
 * literals) and the optional line filter is the caller's text as ONE escaped
 * double-quoted string literal (`logqlStringLiteral`): backslash, quote,
 * newline, control characters escaped; backticks, pipes and braces stay inert
 * inside the quotes. The text filter is a case-sensitive substring, as `|=`
 * defines it. A node with no usable labels is not queried — `{}` would select
 * every stream.
 *
 * One query per node (address-labelled results), newest first
 * (`direction=backward`). Severity comes from Loki's `detected_level`/`level`
 * label when the stream has one, otherwise from message heuristics; either way
 * `native.severityHeuristic` says which, and the label is never mistaken for a
 * value the application vouched for.
 */
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";
import { throwIfAborted } from "../abort";
import { joinMatchers, lokiLineFilter, matchersFrom } from "../escape";
import { errorMessage, inferSeverity, isRecord, levelWord, meetsMinSeverity, severityFilterNote, sortNewestFirst, traceContext, type SeverityHeuristic } from "../normalize";
import { sanitizeLog, sanitizeReason } from "../redact";
import type { LogQuery, NormalizedLog, ObservabilitySource, QueryResult, Severity } from "../types";
import { getJson, normalizeBaseUrl, type HttpEndpointConfig } from "./http";
import { DEFAULT_LABEL_MAP, selectorLabelsFor, type LabelMap } from "./labels";
import { bindingOf, coversScope, nodesInScope, sameEnvironment, type EnvironmentBinding } from "./scope";
import { mapPool } from "./util";

export const LOKI_SOURCE_ID = "loki";
const LOKI_KINDS = new Set<string>(["container_service", "kubernetes_namespace", "function", "scheduled_job"]);
const MAX_NODES = 10;

export interface LokiConfig extends HttpEndpointConfig {
  graph: ResourceGraph;
  workspaceId?: string;
  labelMap?: LabelMap;
}

/** `{selector} |= "text"` for one node's labels; undefined when no usable label exists. Exported for tests. */
export function buildLogQL(labels: Record<string, string>, text: string | undefined): string | undefined {
  const selector = joinMatchers(matchersFrom(labels));
  if (selector === undefined) return undefined;
  return text ? `${selector} ${lokiLineFilter(text)}` : selector;
}

export function createLokiSource(config: LokiConfig): ObservabilitySource {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const http = { ...config, baseUrl };
  const binding: EnvironmentBinding = bindingOf(config.graph, config.workspaceId);
  const labelMap = config.labelMap ?? DEFAULT_LABEL_MAP;
  const isLokiNode = (n: ResourceNode) => LOKI_KINDS.has(n.kind);

  return {
    id: LOKI_SOURCE_ID,
    provider: "loki",
    supports: ["log"],
    covers: (scope) => coversScope(binding, config.graph, scope, isLokiNode),

    async searchLogs(q: LogQuery, signal: AbortSignal): Promise<QueryResult<NormalizedLog>> {
      const result: QueryResult<NormalizedLog> = { items: [], sources: [], truncated: false, simulated: false, unavailable: [], notes: [] };
      if (!sameEnvironment(binding, q.scope)) return { ...result, notes: [] };
      const fail = (reason: string) => result.unavailable.push({ source: LOKI_SOURCE_ID, reason: sanitizeReason(reason) });
      const limit = q.limit ?? 200;
      const fromMs = Date.parse(q.range.from);
      const toMs = q.range.to === undefined ? Date.now() : Date.parse(q.range.to);

      const queries: { node: ResourceNode; logql: string }[] = [];
      for (const node of nodesInScope(config.graph, q.scope, isLokiNode)) {
        const logql = buildLogQL(selectorLabelsFor(node, labelMap), q.text);
        if (logql === undefined) fail(`${node.address}: no labels usable as a Loki stream selector`);
        else queries.push({ node, logql });
      }
      if (queries.length > MAX_NODES) {
        result.notes!.push(`${queries.length - MAX_NODES} more resource(s) not queried (limit ${MAX_NODES} per query)`);
        queries.length = MAX_NODES;
      }

      const outcomes = await mapPool(queries, 4, signal, async (qq) => {
        try {
          const params = new URLSearchParams({
            query: qq.logql,
            start: msToNs(fromMs),
            end: msToNs(toMs),
            limit: String(limit),
            direction: "backward",
          });
          return { qq, body: await getJson(http, "/loki/api/v1/query_range", params, signal) };
        } catch (err) {
          throwIfAborted(signal);
          return { qq, error: errorMessage(err) };
        }
      });

      const merged: NormalizedLog[] = [];
      for (const o of outcomes) {
        if ("error" in o) {
          fail(`${o.qq.node.address}: ${o.error}`);
          continue;
        }
        const parsed = parseStreams(o.body, o.qq.node, binding.environmentId, q.minSeverity);
        if (!parsed.ok) {
          fail(`${o.qq.node.address}: ${parsed.reason}`);
          continue;
        }
        if (!result.sources.includes(LOKI_SOURCE_ID)) result.sources.push(LOKI_SOURCE_ID);
        merged.push(...parsed.logs);
        // a full page means there may be more behind it
        if (parsed.entries >= limit) result.truncated = true;
      }
      const sorted = sortNewestFirst(merged, (l) => l.timestamp);
      result.items = sorted.slice(0, limit);
      if (sorted.length > limit) result.truncated = true;
      if (q.minSeverity && q.minSeverity !== "unknown") result.notes!.push(severityFilterNote);
      if (result.notes!.length === 0) delete result.notes;
      return result;
    },
  };
}

function msToNs(ms: number): string {
  return (BigInt(Math.trunc(ms)) * 1_000_000n).toString();
}

/** Loki nanosecond string → ISO string with millisecond precision. */
export function nsToIso(ns: string): string | undefined {
  if (!/^\d{1,20}$/.test(ns)) return undefined;
  const ms = Number(BigInt(ns) / 1_000_000n);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

type Parsed = { ok: true; logs: NormalizedLog[]; entries: number } | { ok: false; reason: string };

/** Parse a `query_range` streams response into logs. Exported for tests. */
export function parseStreams(body: unknown, node: ResourceNode, environmentId: string, minSeverity: Severity | undefined): Parsed {
  if (!isRecord(body)) return { ok: false, reason: "response was not an object" };
  if (body.status !== "success") return { ok: false, reason: typeof body.error === "string" ? body.error : "query failed" };
  const data = body.data;
  if (!isRecord(data) || data.resultType !== "streams" || !Array.isArray(data.result)) return { ok: false, reason: "unexpected result shape (expected streams)" };
  const logs: NormalizedLog[] = [];
  let entries = 0;
  for (const s of data.result) {
    if (!isRecord(s) || !Array.isArray(s.values)) continue;
    const labels: Record<string, string> = {};
    if (isRecord(s.stream)) for (const [k, v] of Object.entries(s.stream).slice(0, 30)) if (typeof v === "string") labels[k] = v;
    const labelLevel = levelWord(labels.detected_level ?? labels.level ?? "");
    for (const v of s.values) {
      if (!Array.isArray(v) || typeof v[0] !== "string" || typeof v[1] !== "string") continue;
      entries++;
      const timestamp = nsToIso(v[0]);
      if (!timestamp) continue;
      const guess = inferSeverity(v[1]);
      const severity: Severity = labelLevel ?? guess.severity;
      const heuristic: SeverityHeuristic | undefined = labelLevel ? "detected_level" : guess.heuristic;
      if (!meetsMinSeverity(severity, minSeverity)) continue;
      const native: Record<string, unknown> = { backend: "loki", labels, timestampNs: v[0] };
      if (heuristic) native.severityHeuristic = heuristic;
      logs.push(
        sanitizeLog({
          timestamp,
          address: node.address,
          provider: node.provider,
          environmentId,
          severity,
          message: v[1],
          ...traceContext(v[1]),
          attributes: {},
          native,
        })
      );
    }
  }
  return { ok: true, logs, entries };
}
