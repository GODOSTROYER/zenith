/**
 * Usage metering from durable records (PROD-MAN-06).
 *
 * Every metered quantity is derived from a record that already exists for another reason, never from a counter held in
 * memory and never from a model's say-so:
 *
 *   managed_resource_hours  `platform.resources` (ownership = managed). The interval is [created_at, now) clipped to the
 *                           period, or [created_at, updated_at) once the resource is `deleted`. Resources that are only
 *                           planned, failed or `unknown` are not metered: Zenith does not infer a run it did not observe.
 *                           Limitation: updated_at of a deleted resource is the last write, so a resource whose row was
 *                           touched after deletion reads slightly long.
 *   build_minutes           `platform.build_launches` in the terminal phase: accepted_at to the provider finish.
 *   storage_gb_month        `platform.portability_exports`: bytes of verified exports retained for the tenant (they are
 *                           never deleted by Zenith), decimal GB at collection time or period end, whichever is earlier.
 *   operations_executed     `platform.operations` that finished in the period. Informational; not charged.
 *   egress_gb_estimated     the latest `platform.cost_estimates` per environment (`assumptions.egressGb`). A COST model
 *                           assumption, NOT a measurement: it is flagged `estimated`, shown, and never charged.
 *
 * Collection is idempotent (one row per workspace, meter, source and period) and level-triggered: running it twice, late
 * or concurrently converges on the same rows. A period that already has an invoice is closed and is left alone.
 * Each query is bounded; a workspace that exceeds the bound is reported `truncated` rather than silently under-counted.
 */
import type { Sql } from "@/lib/controlplane/types";
import { periodBounds, periodOf } from "./period";
import { ESTIMATED_METERS, METER_UNITS, type Meter } from "./plans";
import { isPeriodClosed, upsertUsage } from "./store";

export const COLLECTION_ROW_LIMIT = 20_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const GB = 1_000_000_000;

export interface UsageSample { meter: Meter; sourceId: string; quantity: number; detail: Record<string, unknown> }

export interface CollectionResult {
  workspaceId: string;
  period: string;
  closed: boolean;
  written: number;
  unchanged: number;
  truncated: string[];
}

const time = (v: string | Date | null): number | null => (v === null ? null : new Date(v).getTime());

/** Overlap of [from, to) with the period window, in ms (never negative). */
export function overlapMs(from: number, to: number, windowStart: number, windowEnd: number): number {
  return Math.max(0, Math.min(to, windowEnd) - Math.max(from, windowStart));
}

/** Pure: managed-resource hours for one resource row. */
export function resourceHours(row: { status: string; created_at: string | Date; updated_at: string | Date }, period: string, now: Date): number {
  if (["planned", "failed", "unknown"].includes(row.status)) return 0;
  const { start, end } = periodBounds(period);
  const created = time(row.created_at) as number;
  const stop = row.status === "deleted" ? (time(row.updated_at) as number) : now.getTime();
  return overlapMs(created, stop, start.getTime(), end.getTime()) / HOUR_MS;
}

export async function collectUsageSamples(sql: Sql, workspaceId: string, period: string, now: Date): Promise<{ samples: UsageSample[]; truncated: string[] }> {
  const { start, end } = periodBounds(period);
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const samples: UsageSample[] = [];
  const truncated: string[] = [];

  const resources = await sql.query<{ id: string; status: string; created_at: string; updated_at: string; kind: string; provider: string }>(
    `select id, status, created_at, updated_at, kind, provider from platform.resources
      where workspace_id = $1 and ownership = 'managed' and status in ('provisioning','active','updating','deleting','deleted')
        and created_at < $3::timestamptz and (status <> 'deleted' or updated_at > $2::timestamptz)
      order by id limit $4::int`, [workspaceId, startIso, endIso, COLLECTION_ROW_LIMIT + 1]);
  if (resources.length > COLLECTION_ROW_LIMIT) truncated.push("managed_resource_hours");
  for (const r of resources.slice(0, COLLECTION_ROW_LIMIT)) {
    const hours = resourceHours(r, period, now);
    if (hours > 0) samples.push({ meter: "managed_resource_hours", sourceId: r.id, quantity: hours, detail: { kind: r.kind, provider: r.provider, status: r.status } });
  }

  const builds = await sql.query<{ operation_id: string; service_address: string; accepted_at: string; finished: string | null; terminal_status: string | null }>(
    `select operation_id, service_address, accepted_at, coalesce(provider_finished_at, observed_at) as finished, terminal_status
       from platform.build_launches
      where workspace_id = $1 and phase = 'terminal' and accepted_at >= $2::timestamptz and accepted_at < $3::timestamptz
      order by operation_id, service_address limit $4::int`, [workspaceId, startIso, endIso, COLLECTION_ROW_LIMIT + 1]);
  if (builds.length > COLLECTION_ROW_LIMIT) truncated.push("build_minutes");
  for (const b of builds.slice(0, COLLECTION_ROW_LIMIT)) {
    const finished = time(b.finished);
    const accepted = time(b.accepted_at) as number;
    if (finished === null || finished < accepted) continue;
    samples.push({ meter: "build_minutes", sourceId: `${b.operation_id}:${b.service_address}`, quantity: (finished - accepted) / MINUTE_MS, detail: { terminalStatus: b.terminal_status } });
  }

  // The retained bytes at the earlier of collection time and period end.
  const asOf = new Date(Math.min(now.getTime(), end.getTime())).toISOString();
  const stored = await sql.query<{ bytes: string | number | null; exports: string | number }>(
    "select coalesce(sum(byte_size), 0) as bytes, count(*) as exports from platform.portability_exports where workspace_id = $1 and created_at < $2::timestamptz", [workspaceId, asOf]);
  const bytes = Number(stored[0]?.bytes ?? 0);
  if (bytes > 0) samples.push({ meter: "storage_gb_month", sourceId: "portability_exports", quantity: bytes / GB, detail: { exports: Number(stored[0]?.exports ?? 0), asOf } });

  const ops = await sql.query<{ n: string | number }>(
    "select count(*) as n from platform.operations where workspace_id = $1 and status in ('succeeded','failed','uncertain') and finished_at >= $2::timestamptz and finished_at < $3::timestamptz", [workspaceId, startIso, endIso]);
  const executed = Number(ops[0]?.n ?? 0);
  if (executed > 0) samples.push({ meter: "operations_executed", sourceId: "operations", quantity: executed, detail: {} });

  // COST-modeled egress: the newest estimate per environment computed before the period ended. An estimate, never a reading.
  const estimates = await sql.query<{ environment_id: string; egress: string | number | null; catalog_version: string; computed_at: string }>(
    `select distinct on (environment_id) environment_id, (estimate->'assumptions'->>'egressGb')::numeric as egress, catalog_version, computed_at
       from platform.cost_estimates
      where workspace_id = $1 and environment_id is not null and computed_at < $2::timestamptz and estimate->'assumptions' ? 'egressGb'
      order by environment_id, computed_at desc limit $3::int`, [workspaceId, endIso, COLLECTION_ROW_LIMIT]);
  for (const e of estimates) {
    const gb = Number(e.egress);
    if (Number.isFinite(gb) && gb > 0) samples.push({ meter: "egress_gb_estimated", sourceId: e.environment_id, quantity: gb, detail: { catalogVersion: e.catalog_version, computedAt: new Date(e.computed_at).toISOString(), basis: "cost_estimate_assumption" } });
  }
  return { samples, truncated };
}

/** Read the workspace's durable records and upsert its usage rows for one period. */
export async function collectUsage(sql: Sql, workspaceId: string, period: string, now: Date): Promise<CollectionResult> {
  if (await isPeriodClosed(sql, workspaceId, period)) return { workspaceId, period, closed: true, written: 0, unchanged: 0, truncated: [] };
  const { samples, truncated } = await collectUsageSamples(sql, workspaceId, period, now);
  let written = 0;
  let unchanged = 0;
  let closed = false;
  for (const s of samples) {
    const r = await upsertUsage(sql, { workspaceId, meter: s.meter, sourceId: s.sourceId, period, quantity: s.quantity, unit: METER_UNITS[s.meter], estimated: ESTIMATED_METERS.has(s.meter), detail: s.detail });
    if (r === "written") written += 1;
    else if (r === "unchanged") unchanged += 1;
    else closed = true;
  }
  return { workspaceId, period, closed, written, unchanged, truncated };
}

/** The periods a pass should keep current: the one in progress and the one before it (late records land there). */
export function activePeriods(now: Date): string[] {
  const current = periodOf(now);
  const prev = periodOf(new Date(periodBounds(current).start.getTime() - 1));
  return [prev, current];
}
