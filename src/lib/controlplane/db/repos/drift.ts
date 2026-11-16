/**
 * Persisted drift reports (`DriftReport`, `resources/types.ts`): the result of
 * comparing desired with observed state for one environment at one moment.
 *
 * `unknown` and `inaccessible` findings, and `unobserved` addresses, are stored
 * as they are — a resource Zenith could not read is drift, not silence. History
 * is bounded per environment (default: latest 50 reports kept).
 */
import type { Sql } from "@/lib/controlplane/types";
import type { DriftFinding, DriftReport } from "@/lib/resources/types";
import { ControlStoreError, requireText } from "../errors";
import { clampLimit, json, newId } from "../sql";

export interface StoredDriftReport extends DriftReport {
  id: string;
  workspaceId: string;
}

interface DriftRow {
  id: string;
  workspace_id: string;
  environment_id: string;
  graph_digest: string;
  computed_at: string;
  findings: DriftFinding[];
  unobserved: string[];
  simulated: boolean;
}

const COLUMNS = "id, workspace_id, environment_id, graph_digest, computed_at, findings, unobserved, simulated";
export const DEFAULT_KEEP_DRIFT_REPORTS = 50;

const toReport = (row: DriftRow): StoredDriftReport => ({
  id: row.id,
  workspaceId: row.workspace_id,
  environmentId: row.environment_id,
  graphDigest: row.graph_digest,
  computedAt: row.computed_at,
  findings: row.findings,
  unobserved: row.unobserved,
  simulated: row.simulated,
});

/** Store a report (refused when the environment belongs to another workspace) and trim old ones. */
export async function insert(sql: Sql, input: { workspaceId: string; report: DriftReport; keepLatest?: number }): Promise<StoredDriftReport> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const { report } = input;
  const environmentId = requireText("environmentId", report.environmentId);
  const keep = Math.max(1, Math.min(10_000, Math.trunc(input.keepLatest ?? DEFAULT_KEEP_DRIFT_REPORTS)));
  return sql.tx(async (tx) => {
    const rows = await tx.query<DriftRow>(
      `insert into platform.drift_reports (id, workspace_id, environment_id, graph_digest, computed_at, findings, unobserved, simulated)
       select $1, $2, $3, $4, $5::timestamptz, $6::text::jsonb, $7::text::jsonb, $8::boolean
        where not exists (select 1 from platform.resources x where x.environment_id = $3 and x.workspace_id <> $2)
          and not exists (select 1 from platform.drift_reports d where d.environment_id = $3 and d.workspace_id <> $2)
       returning ${COLUMNS}`,
      [newId("drift"), workspaceId, environmentId, requireText("graphDigest", report.graphDigest, 128), report.computedAt, json(report.findings ?? []), json(report.unobserved ?? []), report.simulated]
    );
    if (rows.length === 0) throw new ControlStoreError("tenant_mismatch", "Environment not found in this workspace.", { environmentId });
    await tx.query(
      `delete from platform.drift_reports
        where workspace_id = $1 and environment_id = $2 and id in (
          select id from platform.drift_reports where workspace_id = $1 and environment_id = $2
           order by computed_at desc, recorded_at desc, id desc offset $3::bigint)`,
      [workspaceId, environmentId, keep]
    );
    return toReport(rows[0]);
  });
}

/** The most recent report of an environment (by `computedAt`), or null. */
export async function latest(sql: Sql, workspaceId: string, environmentId: string): Promise<StoredDriftReport | null> {
  const rows = await sql.query<DriftRow>(
    `select ${COLUMNS} from platform.drift_reports
      where workspace_id = $1 and environment_id = $2 order by computed_at desc, recorded_at desc, id desc limit 1`,
    [requireText("workspaceId", workspaceId), requireText("environmentId", environmentId)]
  );
  return rows.length ? toReport(rows[0]) : null;
}

export async function list(sql: Sql, workspaceId: string, environmentId: string, limit = 20): Promise<StoredDriftReport[]> {
  const rows = await sql.query<DriftRow>(
    `select ${COLUMNS} from platform.drift_reports
      where workspace_id = $1 and environment_id = $2 order by computed_at desc, recorded_at desc, id desc limit $3::bigint`,
    [requireText("workspaceId", workspaceId), requireText("environmentId", environmentId), clampLimit(limit, 20, 200)]
  );
  return rows.map(toReport);
}
