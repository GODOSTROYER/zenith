/**
 * Shared normalization helpers: severity, trace ids, ordering, result shape.
 *
 * Severity is HEURISTIC for every backend that does not carry a real level
 * (CloudWatch, Kubernetes container logs, most Loki streams). `inferSeverity`
 * says which heuristic fired so a source can record it in `native` — a
 * "severity" the platform guessed from the word ERROR is never presented as a
 * field the provider supplied.
 */
import { SourceTimeoutError } from "./abort";
import type { QueryResult, Severity } from "./types";

/* -------------------------------- severity -------------------------------- */

const RANK: Record<Severity, number> = { unknown: -1, trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };

export const severityRank = (s: Severity): number => RANK[s];

/**
 * Does `s` satisfy `min`? `unknown` never satisfies a minimum: when a caller
 * asks for warn-and-above, a line whose level could not be determined is not
 * evidence of a problem, and including every unclassifiable line would drown
 * the answer. Callers see a note saying so (see `severityFilterNote`).
 */
export function meetsMinSeverity(s: Severity, min: Severity | undefined): boolean {
  if (min === undefined || min === "unknown") return true;
  return RANK[s] >= RANK[min];
}

export const severityFilterNote = "minSeverity excludes lines whose severity could not be determined (severity is inferred from message text)";

export type SeverityHeuristic = "json_level" | "level_kv" | "keyword" | "detected_level" | "provider";

const LEVEL_WORDS: Record<string, Severity> = {
  trace: "trace",
  verbose: "trace",
  debug: "debug",
  dbg: "debug",
  info: "info",
  information: "info",
  notice: "info",
  warn: "warn",
  warning: "warn",
  error: "error",
  err: "error",
  severe: "error",
  fatal: "fatal",
  critical: "fatal",
  crit: "fatal",
  alert: "fatal",
  emerg: "fatal",
  emergency: "fatal",
  panic: "fatal",
};

/** Numeric levels as pino/bunyan write them (10 trace … 60 fatal). Syslog numbers are ambiguous and not guessed. */
function pinoLevel(n: number): Severity | undefined {
  if (!Number.isFinite(n) || n < 10) return undefined;
  if (n >= 60) return "fatal";
  if (n >= 50) return "error";
  if (n >= 40) return "warn";
  if (n >= 30) return "info";
  if (n >= 20) return "debug";
  return "trace";
}

export function levelWord(word: string): Severity | undefined {
  return LEVEL_WORDS[word.toLowerCase()];
}

const KV_LEVEL = /\b(?:level|lvl|severity|loglevel|log_level)["']?\s*[=:]\s*["']?([A-Za-z]{3,11})\b/i;
/** An UPPERCASE level token in the first 120 chars, as in `… ERROR req=…` or `[WARN]`. */
const KEYWORD_LEVEL = /(?:^|[\s[(|])(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL|PANIC|SEVERE)(?=$|[\s\]):|,])/;
const FAILURE_WORDS = /\b(?:exception|traceback|panic:|segmentation fault|out of memory|oomkilled|unhandled(?:rejection)?)\b/i;

const JSON_LEVEL_KEYS = ["level", "severity", "lvl", "log.level", "levelname", "loglevel"] as const;

export interface SeverityGuess {
  severity: Severity;
  heuristic?: SeverityHeuristic;
}

/**
 * Best-effort severity of a log line: JSON `level`/`severity` field, then a
 * logfmt-style `level=…`, then an uppercase level token near the start, then
 * failure vocabulary (`Exception`, `Traceback`, …) as `error`. `unknown` when
 * none applies — never a default of `info`.
 */
export function inferSeverity(message: string): SeverityGuess {
  const trimmed = message.trimStart();
  if (trimmed.startsWith("{") && trimmed.length <= 65_536) {
    const parsed = tryParseObject(trimmed);
    if (parsed) {
      for (const key of JSON_LEVEL_KEYS) {
        const v = parsed[key];
        const sev = typeof v === "string" ? levelWord(v) : typeof v === "number" ? pinoLevel(v) : undefined;
        if (sev) return { severity: sev, heuristic: "json_level" };
      }
    }
  }
  const kv = KV_LEVEL.exec(message.slice(0, 2000));
  if (kv) {
    const sev = levelWord(kv[1]);
    if (sev) return { severity: sev, heuristic: "level_kv" };
  }
  const kw = KEYWORD_LEVEL.exec(message.slice(0, 120));
  if (kw) {
    const sev = levelWord(kw[1]);
    if (sev) return { severity: sev, heuristic: "keyword" };
  }
  if (FAILURE_WORDS.test(message.slice(0, 2000))) return { severity: "error", heuristic: "keyword" };
  return { severity: "unknown" };
}

function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const TRACE_ID = /^[A-Za-z0-9_.:-]{8,128}$/;

/**
 * Trace/span ids from a JSON log line (`trace_id`, `traceId`, `span_id`, …).
 * Only values that look like ids are returned — a "trace id" field holding
 * prose is dropped, not forwarded.
 */
export function traceContext(message: string): { traceId?: string; spanId?: string } {
  const trimmed = message.trimStart();
  if (!trimmed.startsWith("{") || trimmed.length > 65_536) return {};
  const parsed = tryParseObject(trimmed);
  if (!parsed) return {};
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = parsed[k];
      if (typeof v === "string" && TRACE_ID.test(v)) return v;
    }
    return undefined;
  };
  const out: { traceId?: string; spanId?: string } = {};
  const traceId = pick("trace_id", "traceId", "traceID", "trace.id", "dd.trace_id");
  const spanId = pick("span_id", "spanId", "spanID", "span.id", "dd.span_id");
  if (traceId) out.traceId = traceId;
  if (spanId) out.spanId = spanId;
  return out;
}

/* -------------------------------- ordering -------------------------------- */

/** Millisecond value of an ISO timestamp; unparseable sorts as -Infinity (last when descending). */
export const tsMs = (iso: string): number => {
  const n = Date.parse(iso);
  return Number.isNaN(n) ? Number.NEGATIVE_INFINITY : n;
};

/** Stable sort, newest first. Ties keep input order. */
export function sortNewestFirst<T>(items: T[], ts: (item: T) => string): T[] {
  return items
    .map((item, index) => ({ item, index, at: tsMs(ts(item)) }))
    .sort((a, b) => (a.at === b.at ? a.index - b.index : a.at > b.at ? -1 : 1))
    .map((x) => x.item);
}

/* ---------------------------- shared result shape -------------------------- */

export function emptyResult<T>(): QueryResult<T> {
  return { items: [], sources: [], truncated: false, simulated: false, unavailable: [] };
}

export function unavailableResult<T>(source: string, reason: string): QueryResult<T> {
  return { items: [], sources: [], truncated: false, simulated: false, unavailable: [{ source, reason }] };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Message of anything thrown, without stack or cause. Callers sanitize before surfacing. */
export function errorMessage(err: unknown): string {
  if (err instanceof SourceTimeoutError) return err.message;
  if (err instanceof Error) return err.name && err.name !== "Error" ? `${err.name}: ${err.message}` : err.message;
  return String(err);
}
