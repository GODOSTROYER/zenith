/**
 * Persisted cost estimates (`CostEstimate`, `placement/types.ts`).
 *
 * Always an estimate, never an invoice: the stored document is exactly the
 * `CostEstimate` value (which carries `kind: "estimate"`, the price-catalog
 * version, the included and excluded costs and the assumptions), and
 * `monthlyUsd` is a plain double kept in its own column only so it can be
 * sorted and summed in SQL for display.
 */
import type { Sql } from "@/lib/controlplane/types";
import type { CostEstimate } from "@/lib/placement/types";
import { ControlStoreError, requireText } from "../errors";
import { clampLimit, json, newId } from "../sql";

export interface StoredCostEstimate {
  id: string;
  workspaceId: string;
  projectId?: string;
  environmentId?: string;
  operationId?: string;
  catalogVersion: string;
  monthlyUsd: number;
  estimate: CostEstimate;
  computedAt: string;
}

interface CostRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  environment_id: string | null;
  operation_id: string | null;
  catalog_version: string;
  monthly_usd: number;
  estimate: CostEstimate;
  computed_at: string;
}

const COLUMNS = "id, workspace_id, project_id, environment_id, operation_id, catalog_version, monthly_usd, estimate, computed_at";

const toStored = (row: CostRow): StoredCostEstimate => ({
  id: row.id,
  workspaceId: row.workspace_id,
  projectId: row.project_id ?? undefined,
  environmentId: row.environment_id ?? undefined,
  operationId: row.operation_id ?? undefined,
  catalogVersion: row.catalog_version,
  monthlyUsd: row.monthly_usd,
  estimate: row.estimate,
  computedAt: row.computed_at,
});

export async function insert(
  sql: Sql,
  input: { workspaceId: string; projectId?: string; environmentId?: string; operationId?: string; estimate: CostEstimate; id?: string }
): Promise<StoredCostEstimate> {
  const { estimate } = input;
  if (estimate.kind !== "estimate") throw new ControlStoreError("invalid_input", "Only an estimate may be stored here; this store never records an invoice as a cost.");
  if (!Number.isFinite(estimate.monthlyUsd)) throw new ControlStoreError("invalid_input", "monthlyUsd must be a finite number.");
  const rows = await sql.query<CostRow>(
    `insert into platform.cost_estimates (id, workspace_id, project_id, environment_id, operation_id, catalog_version, monthly_usd, estimate, computed_at)
     values ($1, $2, $3, $4, $5, $6, $7::double precision, $8::text::jsonb, $9::timestamptz)
     returning ${COLUMNS}`,
    [
      input.id ?? newId("cost"),
      requireText("workspaceId", input.workspaceId),
      input.projectId ?? null,
      input.environmentId ?? null,
      input.operationId ?? null,
      requireText("catalogVersion", estimate.catalogVersion, 128),
      estimate.monthlyUsd,
      json(estimate),
      estimate.computedAt,
    ]
  );
  return toStored(rows[0]);
}

export async function get(sql: Sql, workspaceId: string, id: string): Promise<StoredCostEstimate | null> {
  const rows = await sql.query<CostRow>(
    `select ${COLUMNS} from platform.cost_estimates where workspace_id = $1 and id = $2`,
    [requireText("workspaceId", workspaceId), requireText("id", id)]
  );
  return rows.length ? toStored(rows[0]) : null;
}

/** Newest first. Filter by environment and/or operation. */
export async function list(
  sql: Sql,
  workspaceId: string,
  filter: { environmentId?: string; operationId?: string; limit?: number } = {}
): Promise<StoredCostEstimate[]> {
  const rows = await sql.query<CostRow>(
    `select ${COLUMNS} from platform.cost_estimates
      where workspace_id = $1 and ($2::text is null or environment_id = $2::text) and ($3::text is null or operation_id = $3::text)
      order by computed_at desc, id limit $4::bigint`,
    [requireText("workspaceId", workspaceId), filter.environmentId ?? null, filter.operationId ?? null, clampLimit(filter.limit, 50, 500)]
  );
  return rows.map(toStored);
}
