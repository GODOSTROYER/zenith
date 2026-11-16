/**
 * Control-store access for the fairness layer (PROD-OPS-02).
 *
 * Tenancy classification (tests/controlplane/tenancy.test.ts conventions):
 *   getMaintenance / setMaintenance / maintenanceHistory   SYSTEM: the single global row, no tenant data
 *   getTenantQuota / putTenantQuota / deleteTenantQuota    WORKSPACE-BOUND: every statement filters on workspace_id
 *   listTenantQuotas / queueDepths / drainStatus           SYSTEM reads for the operator surface: each returned row
 *                                                          carries its workspace id; counts only, no payloads
 *   activeOperationCount / queuedJobCount                  WORKSPACE-BOUND counts
 *
 * Deliberately NOT exported from `controlplane/db/repos` so the bound-repo
 * completeness guard is unchanged; callers pass the platform `Sql` explicitly.
 */
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError, requireText } from "@/lib/controlplane/db/errors";
import type { MaintenanceMode, MaintenanceState } from "./maintenance";
import { MAINTENANCE_MODES } from "./maintenance";

/* ------------------------------ maintenance ------------------------------ */

interface MaintenanceRow { mode: MaintenanceMode; reason: string; version: number; updated_by: string; updated_at: string }

const OFF: MaintenanceState = { mode: "off", reason: "", version: 0, source: "default" };

export async function getMaintenance(sql: Sql): Promise<MaintenanceState> {
  const rows = await sql.query<MaintenanceRow>("select mode, reason, version, updated_by, updated_at from platform.ops_maintenance where id = 'global'");
  if (!rows.length) return OFF;
  const r = rows[0];
  return { mode: r.mode, reason: r.reason, version: r.version, updatedBy: r.updated_by, updatedAt: String(r.updated_at), source: "database" };
}

export interface SetMaintenanceInput {
  mode: MaintenanceMode;
  reason?: string;
  actor: string;
  /** 0 = "I expect no row yet"; omitted = unconditional */
  expectedVersion?: number;
}

export async function setMaintenance(sql: Sql, input: SetMaintenanceInput): Promise<MaintenanceState> {
  if (!(MAINTENANCE_MODES as readonly string[]).includes(input.mode)) throw new ControlStoreError("invalid_input", "mode must be off, dispatch_paused or read_only.", { field: "mode" });
  const actor = requireText("actor", input.actor, 128);
  const reason = (input.reason ?? "").trim();
  if (reason.length > 300) throw new ControlStoreError("invalid_input", "reason is too long (max 300 characters).", { field: "reason" });
  if (input.mode !== "off" && reason === "") throw new ControlStoreError("invalid_input", "A reason is required to enter maintenance.", { field: "reason" });
  return sql.tx(async (tx) => {
    const rows = await tx.query<MaintenanceRow>(
      `insert into platform.ops_maintenance as m (id, mode, reason, version, updated_by)
       values ('global', $1, $2, 1, $3)
       on conflict (id) do update
         set mode = excluded.mode, reason = excluded.reason, version = m.version + 1, updated_by = excluded.updated_by, updated_at = clock_timestamp()
       where ($4::int is null or m.version = $4::int)
       returning mode, reason, version, updated_by, updated_at`,
      [input.mode, reason, actor, input.expectedVersion ?? null]
    );
    if (!rows.length) {
      const current = await getMaintenance(tx);
      throw new ControlStoreError("conflict", "Maintenance mode changed since you read it; reload and retry.", { currentVersion: current.version });
    }
    const r = rows[0];
    await tx.query("insert into platform.ops_maintenance_history (mode, reason, version, actor) values ($1, $2, $3::int, $4)", [r.mode, r.reason, r.version, actor]);
    return { mode: r.mode, reason: r.reason, version: r.version, updatedBy: r.updated_by, updatedAt: String(r.updated_at), source: "database" as const };
  });
}

export interface MaintenanceHistoryEntry { seq: number; mode: MaintenanceMode; reason: string; version: number; actor: string; at: string }

export async function maintenanceHistory(sql: Sql, limit = 20): Promise<MaintenanceHistoryEntry[]> {
  const n = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const rows = await sql.query<{ seq: number; mode: MaintenanceMode; reason: string; version: number; actor: string; at: string }>(
    "select seq, mode, reason, version, actor, at from platform.ops_maintenance_history order by seq desc limit $1::int", [n]);
  return rows.map((r) => ({ seq: Number(r.seq), mode: r.mode, reason: r.reason, version: r.version, actor: r.actor, at: String(r.at) }));
}

/* ------------------------------ tenant quotas ----------------------------- */

export interface TenantQuota {
  workspaceId: string;
  weight: number;
  apiRatePerSec?: number;
  apiBurst?: number;
  maxConcurrentRequests?: number;
  maxActiveOperations?: number;
  maxQueuedJobs?: number;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

interface QuotaRow {
  workspace_id: string; weight: number; api_rate_per_sec: string | number | null; api_burst: number | null;
  max_concurrent_requests: number | null; max_active_operations: number | null; max_queued_jobs: number | null;
  version: number; updated_by: string; updated_at: string;
}
const QUOTA_COLUMNS = "workspace_id, weight, api_rate_per_sec, api_burst, max_concurrent_requests, max_active_operations, max_queued_jobs, version, updated_by, updated_at";
const num = (v: string | number | null): number | undefined => (v === null || v === undefined ? undefined : Number(v));
const toQuota = (r: QuotaRow): TenantQuota => ({
  workspaceId: r.workspace_id, weight: r.weight,
  ...(num(r.api_rate_per_sec) !== undefined ? { apiRatePerSec: num(r.api_rate_per_sec) } : {}),
  ...(r.api_burst !== null ? { apiBurst: r.api_burst } : {}),
  ...(r.max_concurrent_requests !== null ? { maxConcurrentRequests: r.max_concurrent_requests } : {}),
  ...(r.max_active_operations !== null ? { maxActiveOperations: r.max_active_operations } : {}),
  ...(r.max_queued_jobs !== null ? { maxQueuedJobs: r.max_queued_jobs } : {}),
  version: r.version, updatedBy: r.updated_by, updatedAt: String(r.updated_at),
});

export async function getTenantQuota(sql: Sql, workspaceId: string): Promise<TenantQuota | null> {
  const rows = await sql.query<QuotaRow>(`select ${QUOTA_COLUMNS} from platform.tenant_quotas where workspace_id = $1`, [requireText("workspaceId", workspaceId)]);
  return rows.length ? toQuota(rows[0]) : null;
}

export async function listTenantQuotas(sql: Sql, limit = 100): Promise<TenantQuota[]> {
  const n = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const rows = await sql.query<QuotaRow>(`select ${QUOTA_COLUMNS} from platform.tenant_quotas order by workspace_id limit $1::int`, [n]);
  return rows.map(toQuota);
}

export interface PutTenantQuotaInput {
  workspaceId: string;
  weight?: number;
  /** null clears an override back to the platform default */
  apiRatePerSec?: number | null;
  apiBurst?: number | null;
  maxConcurrentRequests?: number | null;
  maxActiveOperations?: number | null;
  maxQueuedJobs?: number | null;
  actor: string;
  expectedVersion?: number;
}

function check(name: string, value: number | null | undefined, min: number, max: number, integer: boolean): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
    throw new ControlStoreError("invalid_input", `${name} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}.`, { field: name });
  return value;
}

/** Full replace of one workspace's overrides (omitted/null fields mean "platform default"). */
export async function putTenantQuota(sql: Sql, input: PutTenantQuotaInput): Promise<TenantQuota> {
  const ws = requireText("workspaceId", input.workspaceId);
  const actor = requireText("actor", input.actor, 128);
  const weight = check("weight", input.weight ?? 1, 1, 100, true) as number;
  const rows = await sql.query<QuotaRow>(
    `insert into platform.tenant_quotas as q
       (workspace_id, weight, api_rate_per_sec, api_burst, max_concurrent_requests, max_active_operations, max_queued_jobs, version, updated_by)
     values ($1, $2::int, $3::numeric, $4::int, $5::int, $6::int, $7::int, 1, $8)
     on conflict (workspace_id) do update
       set weight = excluded.weight, api_rate_per_sec = excluded.api_rate_per_sec, api_burst = excluded.api_burst,
           max_concurrent_requests = excluded.max_concurrent_requests, max_active_operations = excluded.max_active_operations,
           max_queued_jobs = excluded.max_queued_jobs, version = q.version + 1, updated_by = excluded.updated_by, updated_at = clock_timestamp()
     where ($9::int is null or q.version = $9::int)
     returning ${QUOTA_COLUMNS}`,
    [
      ws, weight,
      check("apiRatePerSec", input.apiRatePerSec, 0.001, 100_000, false),
      check("apiBurst", input.apiBurst, 1, 100_000, true),
      check("maxConcurrentRequests", input.maxConcurrentRequests, 1, 10_000, true),
      check("maxActiveOperations", input.maxActiveOperations, 1, 100_000, true),
      check("maxQueuedJobs", input.maxQueuedJobs, 1, 1_000_000, true),
      actor, input.expectedVersion ?? null,
    ]
  );
  if (rows.length) return toQuota(rows[0]);
  const current = await getTenantQuota(sql, ws);
  throw new ControlStoreError("conflict", "The quota changed since you read it; reload and retry.", { currentVersion: current?.version ?? 0 });
}

/** Remove a workspace's overrides. True when a row existed. */
export async function deleteTenantQuota(sql: Sql, workspaceId: string): Promise<boolean> {
  const rows = await sql.query<{ workspace_id: string }>("delete from platform.tenant_quotas where workspace_id = $1 returning workspace_id", [requireText("workspaceId", workspaceId)]);
  return rows.length > 0;
}

/* --------------------------------- counts --------------------------------- */

/** Operations a worker is (or is about to be) executing for this workspace. */
export async function activeOperationCount(sql: Sql, workspaceId: string, excludeOperationId?: string): Promise<number> {
  const rows = await sql.query<{ n: number }>(
    "select count(*)::int as n from platform.operations where workspace_id = $1 and status in ('queued','running') and ($2::text is null or id <> $2::text)",
    [requireText("workspaceId", workspaceId), excludeOperationId ?? null]);
  return rows[0]?.n ?? 0;
}

export async function queuedJobCount(sql: Sql, workspaceId: string): Promise<{ workspace: number; global: number }> {
  const rows = await sql.query<{ in_workspace: number; in_total: number }>(
    `select (count(*) filter (where workspace_id = $1))::int as in_workspace, count(*)::int as in_total
       from platform.runner_jobs where status = 'queued'`, [requireText("workspaceId", workspaceId)]);
  return { workspace: rows[0]?.in_workspace ?? 0, global: rows[0]?.in_total ?? 0 };
}

export interface QueueDepth { workspaceId: string; queuedJobs: number; activeOperations: number }
export interface DrainStatus {
  queuedOperations: number;
  runningOperations: number;
  queuedRunnerJobs: number;
  activeRunnerJobs: number;
  /** nothing queued or running anywhere: safe to stop workers or take the store down */
  drained: boolean;
  /** the busiest workspaces, bounded; counts only */
  busiest: QueueDepth[];
}

export async function drainStatus(sql: Sql, busiestLimit = 10): Promise<DrainStatus> {
  const n = Math.min(Math.max(Math.trunc(busiestLimit), 1), 50);
  const totals = await sql.query<{ q_ops: number; r_ops: number; q_jobs: number; a_jobs: number }>(
    `select (select count(*) from platform.operations where status = 'queued')::int as q_ops,
            (select count(*) from platform.operations where status = 'running')::int as r_ops,
            (select count(*) from platform.runner_jobs where status = 'queued')::int as q_jobs,
            (select count(*) from platform.runner_jobs where status in ('claimed','running'))::int as a_jobs`);
  const t = totals[0] ?? { q_ops: 0, r_ops: 0, q_jobs: 0, a_jobs: 0 };
  const busiest = await sql.query<{ workspace_id: string; queued_jobs: number; active_operations: number }>(
    `select workspace_id, sum(j)::int as queued_jobs, sum(o)::int as active_operations from (
        select workspace_id, count(*) as j, 0 as o from platform.runner_jobs where status = 'queued' group by workspace_id
        union all
        select workspace_id, 0 as j, count(*) as o from platform.operations where status in ('queued','running') group by workspace_id
      ) u group by workspace_id order by sum(j) + sum(o) desc, workspace_id limit $1::int`, [n]);
  return {
    queuedOperations: t.q_ops, runningOperations: t.r_ops, queuedRunnerJobs: t.q_jobs, activeRunnerJobs: t.a_jobs,
    drained: t.q_ops + t.r_ops + t.q_jobs + t.a_jobs === 0,
    busiest: busiest.map((r) => ({ workspaceId: r.workspace_id, queuedJobs: r.queued_jobs, activeOperations: r.active_operations })),
  };
}

export async function queueDepths(sql: Sql, limit = 50): Promise<QueueDepth[]> {
  return (await drainStatus(sql, limit)).busiest;
}
