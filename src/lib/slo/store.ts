/**
 * Control-store access for service objectives (PROD-OPS-01).
 *
 * Tenancy classification (tests/controlplane/tenancy.test.ts conventions; like `ops/store.ts` these are NOT in
 * `controlplane/db/repos`, callers pass the platform `Sql`):
 *   addSamples / sampleWindows / pruneSamples     SYSTEM: `slo_samples` holds only good/total counts per SLI name
 *   recordMeasurement / listMeasurements          SYSTEM: `slo_measurements` is append-only platform evidence (no workspace)
 *   workflowCompletionWindows / dispatchLatencyWindows
 *                                                 SYSTEM aggregate reads over platform.operations across all workspaces:
 *                                                 counts only, no workspace id, payload or principal leaves the query
 *
 * Time is the database's clock for every window and bucket.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import { BURN_WINDOW_SECONDS, type BurnWindow } from "./definitions";
import type { GoodTotal } from "./sli";

export const SAMPLE_BUCKET_SECONDS = 300;
export const SAMPLE_RETENTION_DAYS = 35;
export const BUDGET_WINDOW_KEY = "budget" as const;
export type WindowKey = BurnWindow | typeof BUDGET_WINDOW_KEY;

const num = (v: string | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));
const SLI = /^[a-z][a-z0-9_]{0,63}$/;

/** Window lengths in seconds, with the budget window in days. */
export function windowSeconds(budgetDays: number): Record<WindowKey, number> {
  return { ...BURN_WINDOW_SECONDS, budget: budgetDays * 86_400 };
}

const KEYS: readonly WindowKey[] = ["5m", "30m", "1h", "6h", "3d", "budget"];

/* --------------------------------- samples -------------------------------- */

export interface SampleInput { sli: string; good: number; total: number }

/** Add counts to the current five-minute bucket. Additive: concurrent writers sum correctly. Zero-total entries are skipped. */
export async function addSamples(sql: Sql, entries: readonly SampleInput[]): Promise<number> {
  let written = 0;
  for (const e of entries) {
    if (!SLI.test(e.sli)) throw new ControlStoreError("invalid_input", "sli must be a lowercase identifier.", { field: "sli" });
    if (!Number.isSafeInteger(e.good) || !Number.isSafeInteger(e.total) || e.good < 0 || e.total < 0 || e.good > e.total) {
      throw new ControlStoreError("invalid_input", "good and total must be non-negative integers with good <= total.", { field: "total" });
    }
    if (e.total === 0) continue;
    await sql.query(
      `insert into platform.slo_samples as s (sli, bucket_start, good, total)
       values ($1, to_timestamp(floor(extract(epoch from clock_timestamp()) / $4::int) * $4::int), $2::bigint, $3::bigint)
       on conflict (sli, bucket_start) do update
         set good = s.good + excluded.good, total = s.total + excluded.total, updated_at = clock_timestamp()`,
      [e.sli, e.good, e.total, SAMPLE_BUCKET_SECONDS]);
    written++;
  }
  return written;
}

/** Whole buckets overlapping each window, summed per SLI. */
export async function sampleWindows(sql: Sql, sli: string, budgetDays: number): Promise<Record<WindowKey, GoodTotal>> {
  if (!SLI.test(sli)) throw new ControlStoreError("invalid_input", "sli must be a lowercase identifier.", { field: "sli" });
  const secs = windowSeconds(budgetDays);
  const cols = KEYS.map((k, i) => `coalesce(sum(good) filter (where bucket_start + make_interval(secs => $2::int) > clock_timestamp() - make_interval(secs => $${i + 3}::int)), 0)::text as g_${i},
       coalesce(sum(total) filter (where bucket_start + make_interval(secs => $2::int) > clock_timestamp() - make_interval(secs => $${i + 3}::int)), 0)::text as t_${i}`).join(",\n       ");
  const rows = await sql.query<Record<string, string>>(
    `select ${cols} from platform.slo_samples where sli = $1 and bucket_start > clock_timestamp() - make_interval(secs => $${KEYS.length + 3}::int)`,
    [sli, SAMPLE_BUCKET_SECONDS, ...KEYS.map((k) => secs[k]), secs.budget + SAMPLE_BUCKET_SECONDS]);
  const r = rows[0] ?? {};
  const out = {} as Record<WindowKey, GoodTotal>;
  KEYS.forEach((k, i) => { out[k] = { good: num(r[`g_${i}`]), total: num(r[`t_${i}`]) }; });
  return out;
}

/** Drop buckets older than the retention. Returns how many were removed. */
export async function pruneSamples(sql: Sql): Promise<number> {
  const rows = await sql.query<{ n: string | number }>(
    "with d as (delete from platform.slo_samples where bucket_start < clock_timestamp() - make_interval(days => $1::int) returning 1) select count(*)::int as n from d",
    [SAMPLE_RETENTION_DAYS]);
  return num(rows[0]?.n);
}

/* ------------------------- durable operation indicators ------------------------- */

/**
 * Workflow completion: operations that finished in the window as succeeded, over those that finished as succeeded,
 * failed or uncertain. Cancelled, expired, rejected and denied are not outcomes of the platform's execution.
 */
export async function workflowCompletionWindows(sql: Sql, budgetDays: number): Promise<Record<WindowKey, GoodTotal>> {
  const secs = windowSeconds(budgetDays);
  const cols = KEYS.map((k, i) => `count(*) filter (where status = 'succeeded' and finished_at > clock_timestamp() - make_interval(secs => $${i + 1}::int))::text as g_${i},
       count(*) filter (where finished_at > clock_timestamp() - make_interval(secs => $${i + 1}::int))::text as t_${i}`).join(",\n       ");
  const rows = await sql.query<Record<string, string>>(
    `select ${cols} from platform.operations
      where status in ('succeeded','failed','uncertain') and finished_at is not null
        and finished_at > clock_timestamp() - make_interval(secs => $${KEYS.length + 1}::int)`,
    [...KEYS.map((k) => secs[k]), secs.budget]);
  const r = rows[0] ?? {};
  const out = {} as Record<WindowKey, GoodTotal>;
  KEYS.forEach((k, i) => { out[k] = { good: num(r[`g_${i}`]), total: num(r[`t_${i}`]) }; });
  return out;
}

/**
 * Dispatch latency: among operations that required no approval and have started, those that started within
 * `thresholdSeconds` of being created. Operations that waited for a human are excluded (their wait is not the
 * platform's latency). Operations that have not started yet are not counted until they do.
 */
export async function dispatchLatencyWindows(sql: Sql, thresholdSeconds: number, budgetDays: number): Promise<Record<WindowKey, GoodTotal>> {
  if (!(thresholdSeconds > 0)) throw new ControlStoreError("invalid_input", "thresholdSeconds must be positive.", { field: "thresholdSeconds" });
  const secs = windowSeconds(budgetDays);
  const cols = KEYS.map((k, i) => `count(*) filter (where started_at - created_at <= make_interval(secs => $1::double precision) and started_at > clock_timestamp() - make_interval(secs => $${i + 2}::int))::text as g_${i},
       count(*) filter (where started_at > clock_timestamp() - make_interval(secs => $${i + 2}::int))::text as t_${i}`).join(",\n       ");
  const rows = await sql.query<Record<string, string>>(
    `select ${cols} from platform.operations
      where approval_required = false and started_at is not null
        and started_at > clock_timestamp() - make_interval(secs => $${KEYS.length + 2}::int)`,
    [thresholdSeconds, ...KEYS.map((k) => secs[k]), secs.budget]);
  const r = rows[0] ?? {};
  const out = {} as Record<WindowKey, GoodTotal>;
  KEYS.forEach((k, i) => { out[k] = { good: num(r[`g_${i}`]), total: num(r[`t_${i}`]) }; });
  return out;
}

/* ------------------------------- measurements ------------------------------- */

export type MeasurementKind = "rpo" | "rto" | "capacity";
export type MeasurementSource = "restore-rehearsal" | "recovery-drill" | "capacity-test" | "manual";

export interface MeasurementInput {
  kind: MeasurementKind;
  source: MeasurementSource;
  /** seconds for rpo and rto, requests per second for capacity */
  value: number;
  withinTarget?: boolean;
  targetVersion?: string;
  recordedBy: string;
  /** fixed numeric / ISO-time / short-token fields only; the writer code chooses the keys */
  details?: Record<string, string | number | boolean | null>;
  measuredAt: Date;
}

export interface Measurement {
  id: string;
  kind: MeasurementKind;
  source: MeasurementSource;
  value: number;
  unit: "seconds" | "requests_per_second";
  withinTarget: boolean | null;
  targetVersion: string | null;
  recordedBy: string;
  details: Record<string, string | number | boolean | null>;
  measuredAt: string;
  recordedAt: string;
}

interface MeasurementRow { id: string; kind: MeasurementKind; source: MeasurementSource; value: number | string; unit: Measurement["unit"]; within_target: boolean | null; target_version: string | null; recorded_by: string; details: Measurement["details"] | string; measured_at: string; recorded_at: string }
const COLS = "id, kind, source, value, unit, within_target, target_version, recorded_by, details, measured_at::text as measured_at, recorded_at::text as recorded_at";
const toMeasurement = (r: MeasurementRow): Measurement => ({
  id: r.id, kind: r.kind, source: r.source, value: Number(r.value), unit: r.unit, withinTarget: r.within_target, targetVersion: r.target_version,
  recordedBy: r.recorded_by, details: typeof r.details === "string" ? JSON.parse(r.details) as Measurement["details"] : r.details, measuredAt: r.measured_at, recordedAt: r.recorded_at,
});

export async function recordMeasurement(sql: Sql, input: MeasurementInput): Promise<Measurement> {
  if (!Number.isFinite(input.value) || input.value < 0) throw new ControlStoreError("invalid_input", "value must be a non-negative number.", { field: "value" });
  if (!(input.measuredAt instanceof Date) || Number.isNaN(input.measuredAt.getTime())) throw new ControlStoreError("invalid_input", "measuredAt must be a valid time.", { field: "measuredAt" });
  if (input.measuredAt.getTime() > Date.now() + 5 * 60_000) throw new ControlStoreError("invalid_input", "measuredAt is in the future.", { field: "measuredAt" });
  const recordedBy = input.recordedBy.trim();
  if (recordedBy.length < 1 || recordedBy.length > 128) throw new ControlStoreError("invalid_input", "recordedBy must be 1 to 128 characters.", { field: "recordedBy" });
  const details: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(input.details ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(k)) throw new ControlStoreError("invalid_input", "details keys must be short identifiers.", { field: "details" });
    details[k] = typeof v === "string" ? v.slice(0, 200) : v;
  }
  const unit = input.kind === "capacity" ? "requests_per_second" : "seconds";
  const rows = await sql.query<MeasurementRow>(
    `insert into platform.slo_measurements (id, kind, source, value, unit, within_target, target_version, recorded_by, details, measured_at)
     values ($1, $2, $3, $4::double precision, $5, $6::boolean, $7, $8, $9::text::jsonb, $10::timestamptz) returning ${COLS}`,
    [`slm_${randomUUID().replace(/-/g, "")}`, input.kind, input.source, input.value, unit, input.withinTarget ?? null, input.targetVersion ?? null, recordedBy, JSON.stringify(details), input.measuredAt.toISOString()]);
  return toMeasurement(rows[0]);
}

export async function listMeasurements(sql: Sql, kind: MeasurementKind, limit = 10): Promise<Measurement[]> {
  const n = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const rows = await sql.query<MeasurementRow>(`select ${COLS} from platform.slo_measurements where kind = $1 order by seq desc limit $2::int`, [kind, n]);
  return rows.map(toMeasurement);
}
