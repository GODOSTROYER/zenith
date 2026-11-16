/**
 * Query validation for the observability fabric (spec §20, ADR-0011).
 *
 * Every query that reaches a source has been through here: strict zod schemas
 * (unknown keys are rejected, not ignored), a time range that is ordered, not
 * in the future and at most seven days wide, and limits clamped to hard caps.
 * Sources may therefore assume a well-formed query — but they still never
 * splice `text` into a query language unescaped (see `escape.ts`), because a
 * source can also be called directly.
 *
 * A malformed query is the caller's bug and throws `ObservabilityInputError`.
 * That is the only thing in this module that throws; a backend being slow or
 * broken is never an input error.
 */
import { z } from "zod";
import type { EventQuery, LogQuery, MetricQuery, Severity, SignalScope, TimeRange } from "./types";

/* --------------------------------- limits --------------------------------- */

export const LOG_LIMIT_DEFAULT = 200;
export const LOG_LIMIT_MAX = 1000;
export const EVENT_LIMIT_DEFAULT = 200;
export const EVENT_LIMIT_MAX = 1000;
export const TRACE_LIMIT_DEFAULT = 50;
export const TRACE_LIMIT_MAX = 200;
export const METRICS_PER_QUERY_MAX = 20;
export const SERIES_PER_QUERY_MAX = 50;
/** Longest span a single query may cover. */
export const MAX_RANGE_MS = 7 * 24 * 3600 * 1000;
/** `to` may be this far ahead of the server clock (client skew) and is clamped to now. */
export const FUTURE_SKEW_MS = 60_000;
/** Datapoints per series are bounded by raising the step, never by dropping points. */
export const MAX_POINTS_PER_SERIES = 1440;
export const TEXT_MAX_CHARS = 256;

export const SEVERITIES = ["trace", "debug", "info", "warn", "error", "fatal", "unknown"] as const satisfies readonly Severity[];

export class ObservabilityInputError extends Error {
  readonly code = "invalid_query";
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid observability query: ${issues.join("; ")}`);
    this.name = "ObservabilityInputError";
    this.issues = issues;
  }
}

/* --------------------------------- schemas -------------------------------- */

const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/, "must be an identifier");
/** `service/web`, `dns_record/app.example.com`, `resource/db` — no whitespace, quotes or query syntax. */
const addressSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.:/@+-]*$/, "must be a resource address");

const scopeSchema = z
  .object({
    workspaceId: idSchema,
    projectId: idSchema.optional(),
    environmentId: idSchema,
    addresses: z.array(addressSchema).max(100).optional(),
  })
  .strict();

const isoSchema = z.string().datetime({ offset: true });
const rangeSchema = z.object({ from: isoSchema, to: isoSchema.optional() }).strict();

/** Filter text: a plain substring. Empty/whitespace-only means "no filter"; NUL is refused. */
const textSchema = z
  .string()
  .max(TEXT_MAX_CHARS)
  .refine((s) => !s.includes("\u0000"), "must not contain NUL")
  .transform((s) => (s.trim() === "" ? undefined : s))
  .optional();

const limitSchema = z.number().int().min(1).optional();

const logQuerySchema = z
  .object({
    scope: scopeSchema,
    range: rangeSchema,
    text: textSchema,
    minSeverity: z.enum(SEVERITIES).optional(),
    limit: limitSchema,
  })
  .strict();

const metricName = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_.]*$/, "must be a portable metric name like cpu.utilization");
const metricQuerySchema = z
  .object({
    scope: scopeSchema,
    range: rangeSchema,
    metrics: z.array(metricName).min(1).max(METRICS_PER_QUERY_MAX),
    stepSec: z.number().int().min(1).max(86_400).optional(),
  })
  .strict();

const eventQuerySchema = z.object({ scope: scopeSchema, range: rangeSchema, limit: limitSchema }).strict();
const traceQuerySchema = eventQuerySchema;

/* ---------------------------------- range --------------------------------- */

export interface NormalizedRange {
  /** ISO, UTC, millisecond precision */
  from: string;
  to: string;
  fromMs: number;
  toMs: number;
}

/**
 * Validate and canonicalize a time range against the server clock.
 * `to` defaults to now; a `to` within `FUTURE_SKEW_MS` ahead is clamped to now,
 * anything further ahead (or any `from` in the future) is rejected.
 */
export function normalizeRange(range: TimeRange, nowMs: number): NormalizedRange {
  const parsed = rangeSchema.safeParse(range);
  if (!parsed.success) throw new ObservabilityInputError(zodIssues(parsed.error, "range"));
  return finishRange(parsed.data, nowMs);
}

function finishRange(range: { from: string; to?: string }, nowMs: number): NormalizedRange {
  const fromMs = Date.parse(range.from);
  let toMs = range.to === undefined ? nowMs : Date.parse(range.to);
  const issues: string[] = [];
  if (!Number.isFinite(fromMs)) issues.push("range.from is not a valid timestamp");
  if (!Number.isFinite(toMs)) issues.push("range.to is not a valid timestamp");
  if (issues.length) throw new ObservabilityInputError(issues);
  if (fromMs > nowMs) issues.push("range.from is in the future");
  if (toMs > nowMs + FUTURE_SKEW_MS) issues.push("range.to is in the future");
  else if (toMs > nowMs) toMs = nowMs;
  if (!(fromMs < toMs)) issues.push("range.from must be before range.to");
  else if (toMs - fromMs > MAX_RANGE_MS) issues.push("range spans more than 7 days");
  if (issues.length) throw new ObservabilityInputError(issues);
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), fromMs, toMs };
}

/* ------------------------------- normalizers ------------------------------ */

const clampLimit = (limit: number | undefined, dflt: number, max: number): number => Math.min(limit ?? dflt, max);

function zodIssues(error: z.ZodError, prefix?: string): string[] {
  return error.issues.map((i) => {
    const path = [...(prefix ? [prefix] : []), ...i.path].join(".");
    return path ? `${path}: ${i.message}` : i.message;
  });
}

/** Scope with `addresses` de-duplicated and sorted so equal queries are equal. */
function canonicalScope(scope: z.infer<typeof scopeSchema>): SignalScope {
  const out: SignalScope = { workspaceId: scope.workspaceId, environmentId: scope.environmentId };
  if (scope.projectId !== undefined) out.projectId = scope.projectId;
  if (scope.addresses !== undefined) out.addresses = [...new Set(scope.addresses)].sort();
  return out;
}

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ObservabilityInputError(zodIssues(parsed.error));
  return parsed.data;
}

/** Validate a bare scope (used by `resourceHealth`, which has no time range). */
export function parseScope(input: unknown): SignalScope {
  return canonicalScope(parse(scopeSchema, input));
}

/** A validated query: `range` is canonical (`to` always present) and `limit` is always set. */
export type ValidLogQuery = LogQuery & { range: { from: string; to: string }; limit: number };
export type ValidEventQuery = EventQuery & { range: { from: string; to: string }; limit: number };
export type ValidMetricQuery = MetricQuery & { range: { from: string; to: string }; stepSec: number };
export type ValidTraceQuery = { scope: SignalScope; range: { from: string; to: string }; limit: number };

export function validateLogQuery(input: unknown, nowMs: number): ValidLogQuery {
  const q = parse(logQuerySchema, input);
  const range = finishRange(q.range, nowMs);
  const out: ValidLogQuery = {
    scope: canonicalScope(q.scope),
    range: { from: range.from, to: range.to },
    limit: clampLimit(q.limit, LOG_LIMIT_DEFAULT, LOG_LIMIT_MAX),
  };
  if (q.text !== undefined) out.text = q.text;
  if (q.minSeverity !== undefined) out.minSeverity = q.minSeverity;
  return out;
}

export function validateEventQuery(input: unknown, nowMs: number): ValidEventQuery {
  const q = parse(eventQuerySchema, input);
  const range = finishRange(q.range, nowMs);
  return {
    scope: canonicalScope(q.scope),
    range: { from: range.from, to: range.to },
    limit: clampLimit(q.limit, EVENT_LIMIT_DEFAULT, EVENT_LIMIT_MAX),
  };
}

export function validateTraceQuery(input: unknown, nowMs: number): ValidTraceQuery {
  const q = parse(traceQuerySchema, input);
  const range = finishRange(q.range, nowMs);
  return {
    scope: canonicalScope(q.scope),
    range: { from: range.from, to: range.to },
    limit: clampLimit(q.limit, TRACE_LIMIT_DEFAULT, TRACE_LIMIT_MAX),
  };
}

export function validateMetricQuery(input: unknown, nowMs: number): ValidMetricQuery {
  const q = parse(metricQuerySchema, input);
  const range = finishRange(q.range, nowMs);
  return {
    scope: canonicalScope(q.scope),
    range: { from: range.from, to: range.to },
    metrics: [...new Set(q.metrics)],
    stepSec: effectiveStepSec(q.stepSec, range.toMs - range.fromMs),
  };
}

/**
 * Step (seconds) for a metric query: what the caller asked for, else about 120
 * points on a 60-second grid, and never so fine that a series would exceed
 * `MAX_POINTS_PER_SERIES` — a coarser answer is honest, a truncated one is not.
 */
export function effectiveStepSec(requested: number | undefined, spanMs: number): number {
  const spanSec = Math.ceil(spanMs / 1000);
  const fallback = Math.max(60, Math.ceil(spanSec / 120 / 60) * 60);
  const floor = Math.ceil(spanSec / MAX_POINTS_PER_SERIES);
  return Math.max(requested ?? fallback, floor);
}
