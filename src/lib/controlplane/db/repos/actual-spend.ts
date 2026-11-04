/**
 * Persisted provider-reported actual spend (`ActualSpend`, `cost/kinds.ts`).
 *
 * Always provider-reported spend, never an estimate: the stored document must be
 * `kind: "actual_spend"` and carry the SHA-256 of the provider response. A row
 * is immutable. Re-reading the same period gives a new row only when the
 * provider response bytes differ (the unique key includes the response hash),
 * so repeated identical reads are idempotent and revisions are kept.
 */
import type { Sql } from "@/lib/controlplane/types";
import { assertActualSpend, CostKindError, type ActualSpend } from "@/lib/cost/kinds";
import { ControlStoreError, requireText } from "../errors";
import { clampLimit, json, newId } from "../sql";

export interface StoredActualSpend {
  id: string;
  workspaceId: string;
  projectId?: string;
  environmentId?: string;
  snapshot: ActualSpend;
  recordedBy: string;
  recordedAt: string;
}

interface Row {
  id: string;
  workspace_id: string;
  project_id: string | null;
  environment_id: string | null;
  snapshot: ActualSpend;
  recorded_by: string;
  recorded_at: string;
}

const COLUMNS = "id, workspace_id, project_id, environment_id, snapshot, recorded_by, recorded_at";

const toStored = (r: Row): StoredActualSpend => ({
  id: r.id,
  workspaceId: r.workspace_id,
  ...(r.project_id ? { projectId: r.project_id } : {}),
  ...(r.environment_id ? { environmentId: r.environment_id } : {}),
  snapshot: r.snapshot,
  recordedBy: r.recorded_by,
  recordedAt: r.recorded_at,
});

export async function insertActualSpend(
  sql: Sql,
  input: { workspaceId: string; projectId?: string; environmentId?: string; snapshot: ActualSpend; recordedBy: string; id?: string },
): Promise<StoredActualSpend> {
  try {
    assertActualSpend(input.snapshot);
  } catch (error) {
    if (error instanceof CostKindError) throw new ControlStoreError("invalid_input", `Only provider-reported actual spend may be stored here: ${error.message}`);
    throw error;
  }
  const s = input.snapshot;
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const params = [
    input.id ?? newId("spend"),
    workspaceId,
    input.projectId ?? null,
    input.environmentId ?? null,
    s.provider,
    requireText("scope", s.scope, 300),
    s.periodStart,
    s.periodEnd,
    String(s.totalUsd),
    s.finalization,
    s.source.responseSha256,
    json(s),
    s.source.retrievedAt,
    requireText("recordedBy", input.recordedBy),
  ];
  const rows = await sql.query<Row>(
    `insert into platform.actual_spend_snapshots
       (id, workspace_id, project_id, environment_id, provider, scope, period_start, period_end, total_usd, finalization, response_sha256, snapshot, retrieved_at, recorded_by)
     values ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9::numeric, $10, $11, $12::text::jsonb, $13::timestamptz, $14)
     on conflict (workspace_id, provider, scope, period_start, period_end, response_sha256) do nothing
     returning ${COLUMNS}`,
    params,
  );
  if (rows.length) return toStored(rows[0]!);
  const existing = await sql.query<Row>(
    `select ${COLUMNS} from platform.actual_spend_snapshots
      where workspace_id = $1 and provider = $2 and scope = $3 and period_start = $4::date and period_end = $5::date and response_sha256 = $6`,
    [workspaceId, s.provider, s.scope, s.periodStart, s.periodEnd, s.source.responseSha256],
  );
  return toStored(existing[0]!);
}

/** Newest period first, then newest read. Workspace-scoped; filter by environment and/or provider. */
export async function listActualSpend(
  sql: Sql,
  workspaceId: string,
  filter: { environmentId?: string; provider?: string; limit?: number } = {},
): Promise<StoredActualSpend[]> {
  const rows = await sql.query<Row>(
    `select ${COLUMNS} from platform.actual_spend_snapshots
      where workspace_id = $1 and ($2::text is null or environment_id = $2::text) and ($3::text is null or provider = $3::text)
      order by period_start desc, retrieved_at desc, id limit $4::bigint`,
    [requireText("workspaceId", workspaceId), filter.environmentId ?? null, filter.provider ?? null, clampLimit(filter.limit, 12, 100)],
  );
  return rows.map(toStored);
}
