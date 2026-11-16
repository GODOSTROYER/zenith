/**
 * Small pure helpers shared by the probes: reading observed attributes
 * honestly, comparing them with what a driver expects, parsing runtime
 * signals, and summarizing metric series. No I/O.
 */
import { canonical } from "@/lib/controlplane/digest";
import type { MetricSeries } from "@/lib/observability/types";
import type { Observation, RuntimeState } from "@/lib/resources/types";
import { REDACTED, isSecretKeyName, sanitizeText } from "./sanitize";

/* ------------------------------ observed values ----------------------------- */

/** The first attribute of `names` whose value was actually read, else undefined. Never reads `unknown`. */
export function known(obs: Observation, ...names: string[]): { name: string; value: unknown; observedAt: string } | undefined {
  for (const name of names) {
    const v = obs.attributes?.[name];
    if (v && v.state === "known") return { name, value: v.value, observedAt: v.observedAt };
  }
  return undefined;
}

const isScalar = (v: unknown): v is string | number | boolean => ["string", "number", "boolean"].includes(typeof v);

/** Cloud APIs return "3" for 3 and "true" for true: scalars compare by text, structures canonically. */
export const sameValue = (a: unknown, b: unknown): boolean => (isScalar(a) && isScalar(b) ? String(a) === String(b) : canonical(a) === canonical(b));

export interface AttributeDiff {
  attribute: string;
  desired: unknown;
  observed: unknown;
}

export interface Comparison {
  /** expected attributes whose observed value was actually read */
  compared: number;
  diffs: AttributeDiff[];
  /** expected attributes nobody read: unverified, not "matching" */
  unread: string[];
}

/** Compare driver-expected attributes against the known observed ones; `only` restricts to some names. */
export function compareExpected(expected: Record<string, unknown>, obs: Observation, only?: ReadonlySet<string>): Comparison {
  const out: Comparison = { compared: 0, diffs: [], unread: [] };
  for (const attribute of Object.keys(expected).sort()) {
    if (only && !only.has(attribute)) continue;
    const desired = expected[attribute];
    if (desired === undefined) continue;
    const seen = obs.attributes?.[attribute];
    if (!seen || seen.state !== "known") {
      out.unread.push(attribute);
      continue;
    }
    out.compared += 1;
    // a credential-named attribute is compared, but its values are never echoed
    if (!sameValue(desired, seen.value)) out.diffs.push(isSecretKeyName(attribute) ? { attribute, desired: REDACTED, observed: REDACTED } : { attribute, desired, observed: seen.value });
  }
  return out;
}

/* --------------------------------- runtime --------------------------------- */

const SIGNAL = /^[a-z][a-z_]{0,40}(?::[A-Za-z0-9_.-]{1,64}){0,2}$/;

export interface ParsedSignals {
  /** every well-formed signal, sanitized */
  all: string[];
  /** malformed signals that were dropped */
  dropped: number;
  stopped: string[];
  exitCodes: number[];
  reasons: { code: string; count: number }[];
  targetUnhealthy: number | undefined;
  deploymentFailed: boolean;
  deploymentInProgress: boolean;
  imagePull: boolean;
  oom: boolean;
  dbStatus: string | undefined;
  readFailed: string | undefined;
  countsNotRead: boolean;
  noRunningTasks: boolean;
  scaledToZero: boolean;
  /** at least one signal says something about the state (not merely "could not read it") */
  informative: boolean;
}

/** Signals that only say a read did not happen; they carry no information about the resource. */
const UNINFORMATIVE: ReadonlySet<string> = new Set(["read_failed", "counts_not_read", "identifier_unresolved", "not_found", "not_supported", "unsupported"]);

/**
 * Runtime signals are short machine-readable strings a driver or the
 * observability fabric derived from provider data (`target_unhealthy:2`,
 * `task_stopped:OutOfMemory`, `deployment_failed`, `db_status:storage-full`).
 * They are still external strings: only the strict grammar above is accepted.
 */
export function parseSignals(rt: RuntimeState): ParsedSignals {
  const out: ParsedSignals = {
    all: [],
    dropped: 0,
    stopped: [],
    exitCodes: [],
    reasons: [],
    targetUnhealthy: undefined,
    deploymentFailed: false,
    deploymentInProgress: false,
    imagePull: false,
    oom: false,
    dbStatus: undefined,
    readFailed: undefined,
    countsNotRead: false,
    noRunningTasks: false,
    scaledToZero: false,
    informative: false,
  };
  for (const raw of Array.isArray(rt.signals) ? rt.signals.slice(0, 64) : []) {
    if (typeof raw !== "string" || !SIGNAL.test(raw)) {
      out.dropped += 1;
      continue;
    }
    out.all.push(raw);
    const [name, a, b] = raw.split(":");
    if (!UNINFORMATIVE.has(name)) out.informative = true;
    switch (name) {
      case "target_unhealthy":
        out.targetUnhealthy = (out.targetUnhealthy ?? 0) + (Number(a) || 0);
        break;
      case "target_reason":
        if (a) out.reasons.push({ code: a, count: Number(b) || 1 });
        break;
      case "task_stopped":
        if (a) out.stopped.push(a);
        break;
      case "task_exit_code": {
        const n = Number(a);
        if (Number.isInteger(n)) out.exitCodes.push(n);
        break;
      }
      case "deployment_failed":
        out.deploymentFailed = true;
        break;
      case "deployment_in_progress":
        out.deploymentInProgress = true;
        break;
      case "image_pull_failed":
        out.imagePull = true;
        break;
      case "waiting":
        if (a && /^(?:ImagePullBackOff|ErrImagePull)$/.test(a)) out.imagePull = true;
        break;
      case "db_status":
        out.dbStatus = a;
        break;
      case "read_failed":
        out.readFailed = a ?? "error";
        break;
      case "counts_not_read":
        out.countsNotRead = true;
        break;
      case "no_running_tasks":
        out.noRunningTasks = true;
        break;
      case "scaled_to_zero":
        out.scaledToZero = true;
        break;
      default:
    }
  }
  for (const s of out.stopped) {
    if (/^(?:OutOfMemory|OOMKilled)$/i.test(s)) out.oom = true;
    if (/(?:CannotPull|ImagePull|ErrImagePull)/i.test(s)) out.imagePull = true;
  }
  if (out.exitCodes.includes(137)) out.oom = true;
  return out;
}

export const num = (counts: Record<string, number> | undefined, key: string): number | undefined => {
  const v = counts?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

/* --------------------------------- metrics --------------------------------- */

export interface SeriesSummary {
  points: number;
  nonZero: number;
  /** mean of the last (up to) 5 points */
  recentMean: number;
  peak: number;
  unit: string;
}

export function summarizeSeries(series: MetricSeries): SeriesSummary | undefined {
  const values = (series.points ?? []).map((p) => p.value).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (values.length === 0) return undefined;
  const recent = values.slice(-5);
  return {
    points: values.length,
    nonZero: values.filter((v) => v > 0).length,
    recentMean: recent.reduce((a, b) => a + b, 0) / recent.length,
    peak: Math.max(...values),
    unit: sanitizeText(series.unit, 24),
  };
}

/** Utilization as a percentage, or undefined when the unit is not understood (never guessed). */
export function toPercent(value: number, unit: string): number | undefined {
  const u = unit.trim().toLowerCase();
  if (u === "percent" || u === "%" || u === "pct") return value;
  if (u === "ratio" || u === "fraction") return value * 100;
  return undefined;
}

export const round = (n: number, places = 1): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
