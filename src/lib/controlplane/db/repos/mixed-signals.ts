/**
 * Read-only joins that feed the mixed run's ordering rules (PROD-MIX-04 follow-up): the latest reconcile drift report of a
 * child environment and the release-safety migration classes of a child operation. They read other requirements' tables
 * (`drift_reports` from reconcile/OBS-01, `release_runs` from LIFE-10) and write nothing. Every statement names the workspace.
 */
import type { Sql } from "@/lib/controlplane/types";
import type { DriftFinding } from "@/lib/resources/types";

export interface ChildDriftReport {
  computedAt: string;
  findings: DriftFinding[];
  unobserved: string[];
  simulated: boolean;
}

const parse = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());

/**
 * The newest drift report of the child environment computed after the child operation was created (an older report
 * describes the state before this child applied and says nothing about it). With no operation id the newest report counts.
 */
export async function latestChildDriftReport(sql: Sql, input: { workspaceId: string; environmentId: string; operationId?: string }): Promise<ChildDriftReport | null> {
  const rows = await sql.query<{ computed_at: unknown; findings: unknown; unobserved: unknown; simulated: boolean }>(
    `select d.computed_at, d.findings, d.unobserved, d.simulated
       from platform.drift_reports d
      where d.workspace_id = $1 and d.environment_id = $2
        and ($3::text is null or d.computed_at >= (select o.created_at from platform.operations o where o.workspace_id = $1 and o.id = $3 and o.environment_id = $2))
      order by d.computed_at desc, d.recorded_at desc, d.id desc limit 1`,
    [input.workspaceId, input.environmentId, input.operationId ?? null]);
  const row = rows[0];
  if (!row) return null;
  return { computedAt: iso(row.computed_at), findings: parse<DriftFinding[]>(row.findings) ?? [], unobserved: parse<string[]>(row.unobserved) ?? [], simulated: row.simulated === true };
}

export interface ChildMigrationClass {
  runId: string;
  class: "data" | "contract" | "unclassified";
  state: string;
  status: string;
}

/**
 * Release runs of the child operation (or of the child environment when no operation is bound) whose migration is a data,
 * contract or unclassified one (LIFE-10 classification). Refused and rolled-back runs are not migrations in play.
 */
export async function childMigrationClasses(sql: Sql, input: { workspaceId: string; environmentId: string; operationId?: string }): Promise<ChildMigrationClass[]> {
  const rows = await sql.query<{ id: string; klass: string; state: string; status: string }>(
    `select r.id, r.migration->>'class' as klass, r.state, coalesce(r.migration->>'status', 'none') as status
       from platform.release_runs r
      where r.workspace_id = $1 and r.environment_id = $2 and ($3::text is null or r.operation_id = $3)
        and r.migration->>'class' in ('data', 'contract', 'unclassified') and r.state not in ('refused', 'rolled_back')
      order by r.created_at desc, r.id desc limit 50`,
    [input.workspaceId, input.environmentId, input.operationId ?? null]);
  return rows.map((row) => ({ runId: row.id, class: row.klass as ChildMigrationClass["class"], state: row.state, status: row.status }));
}
