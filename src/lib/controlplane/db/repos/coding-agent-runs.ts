/**
 * Durable state of bounded coding-agent runs (PROD-MACH-06).
 *
 * Every function names the workspace and filters on it: a run id from another
 * tenant is `null` / `not_found`, the same as a missing one. Writes are
 * compare-and-set on `version`, and only a `running` row accepts progress, so
 * two processes cannot interleave checkpoints of one run. A row is created
 * `running`; `completed` and `cancelled` are terminal; `budget_exhausted` and
 * `failed` can be claimed back to `running` by `claimResume` (with raised
 * limits), exactly once per resume. A `running` row untouched for ten minutes
 * is a crashed worker and can be claimed the same way.
 */
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError, requireText } from "../errors";

export interface CodingAgentRunRow {
  id: string;
  workspaceId: string;
  projectId?: string;
  environmentId?: string;
  createdBy: string;
  status: "running" | "completed" | "budget_exhausted" | "failed" | "cancelled";
  stopReason?: unknown;
  model: string;
  task: string;
  source: unknown;
  limits: unknown;
  usage: unknown;
  checkpoint: unknown;
  result?: unknown;
  proposalOperationId?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string; workspace_id: string; project_id: string | null; environment_id: string | null; created_by: string; status: CodingAgentRunRow["status"];
  stop_reason: string | null; model: string; task: string; source: unknown; limits: unknown; usage: unknown; checkpoint: unknown; result: unknown | null;
  proposal_operation_id: string | null; version: number; created_at: string; updated_at: string;
}
const COLUMNS = "id, workspace_id, project_id, environment_id, created_by, status, stop_reason, model, task, source, limits, usage, checkpoint, result, proposal_operation_id, version, created_at, updated_at";
const parseJson = (v: unknown): unknown => (typeof v === "string" ? JSON.parse(v) : v);
const toRow = (r: Row): CodingAgentRunRow => ({
  id: r.id, workspaceId: r.workspace_id, ...(r.project_id ? { projectId: r.project_id } : {}), ...(r.environment_id ? { environmentId: r.environment_id } : {}),
  createdBy: r.created_by, status: r.status, ...(r.stop_reason ? { stopReason: parseJson(r.stop_reason) } : {}), model: r.model, task: r.task,
  source: parseJson(r.source), limits: parseJson(r.limits), usage: parseJson(r.usage), checkpoint: parseJson(r.checkpoint),
  ...(r.result !== null && r.result !== undefined ? { result: parseJson(r.result) } : {}), ...(r.proposal_operation_id ? { proposalOperationId: r.proposal_operation_id } : {}),
  version: Number(r.version), createdAt: String(r.created_at), updatedAt: String(r.updated_at),
});
const json = (v: unknown): string => JSON.stringify(v);

export interface CreateRunInput {
  id: string;
  workspaceId: string;
  projectId?: string;
  environmentId?: string;
  createdBy: string;
  model: string;
  task: string;
  source: unknown;
  limits: unknown;
  usage: unknown;
  checkpoint: unknown;
}

export async function createRun(sql: Sql, input: CreateRunInput): Promise<CodingAgentRunRow> {
  const rows = await sql.query<Row>(
    `insert into platform.coding_agent_runs (id, workspace_id, project_id, environment_id, created_by, status, model, task, source, limits, usage, checkpoint)
     values ($1,$2,$3,$4,$5,'running',$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb) returning ${COLUMNS}`,
    [requireText("id", input.id), requireText("workspaceId", input.workspaceId), input.projectId ?? null, input.environmentId ?? null, requireText("createdBy", input.createdBy),
      requireText("model", input.model), input.task, json(input.source), json(input.limits), json(input.usage), json(input.checkpoint)]
  );
  return toRow(rows[0]);
}

export async function getRun(sql: Sql, workspaceId: string, id: string): Promise<CodingAgentRunRow | null> {
  const rows = await sql.query<Row>(`select ${COLUMNS} from platform.coding_agent_runs where workspace_id = $1 and id = $2`, [requireText("workspaceId", workspaceId), requireText("id", id)]);
  return rows.length ? toRow(rows[0]) : null;
}

export async function listRuns(sql: Sql, workspaceId: string, limit = 25): Promise<CodingAgentRunRow[]> {
  const n = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const rows = await sql.query<Row>(`select ${COLUMNS} from platform.coding_agent_runs where workspace_id = $1 order by created_at desc, id limit $2`, [requireText("workspaceId", workspaceId), n]);
  return rows.map(toRow);
}

export interface SaveRunInput {
  workspaceId: string;
  id: string;
  expectedVersion: number;
  status: CodingAgentRunRow["status"];
  stopReason?: unknown;
  limits: unknown;
  usage: unknown;
  checkpoint: unknown;
  result?: unknown;
  proposalOperationId?: string;
}

/** Progress write: only a `running` row at the expected version moves. A terminal status is set by the same call. */
export async function saveRun(sql: Sql, input: SaveRunInput): Promise<CodingAgentRunRow> {
  const ws = requireText("workspaceId", input.workspaceId);
  const rows = await sql.query<Row>(
    `update platform.coding_agent_runs set status = $4, stop_reason = $5, limits = $6::jsonb, usage = $7::jsonb, checkpoint = $8::jsonb,
       result = coalesce($9::jsonb, result), proposal_operation_id = coalesce($10, proposal_operation_id), version = version + 1, updated_at = clock_timestamp()
     where workspace_id = $1 and id = $2 and version = $3 and status = 'running' returning ${COLUMNS}`,
    [ws, requireText("id", input.id), input.expectedVersion, input.status, input.stopReason === undefined ? null : json(input.stopReason), json(input.limits), json(input.usage), json(input.checkpoint),
      input.result === undefined ? null : json(input.result), input.proposalOperationId ?? null]
  );
  if (rows.length) return toRow(rows[0]);
  const existing = await getRun(sql, ws, input.id);
  if (!existing) throw new ControlStoreError("not_found", "Run not found.", { id: input.id });
  throw new ControlStoreError("conflict", "The run changed or is not running.", { id: input.id, status: existing.status, currentVersion: existing.version });
}

/** Terminal bookkeeping on a finished run (result, proposal link) without reopening it. Only fills fields that are still empty. */
export async function attachOutcome(sql: Sql, input: { workspaceId: string; id: string; result?: unknown; proposalOperationId?: string }): Promise<CodingAgentRunRow> {
  const ws = requireText("workspaceId", input.workspaceId);
  const rows = await sql.query<Row>(
    `update platform.coding_agent_runs set result = coalesce(result, $3::jsonb), proposal_operation_id = coalesce(proposal_operation_id, $4), version = version + 1, updated_at = clock_timestamp()
     where workspace_id = $1 and id = $2 and status <> 'running' returning ${COLUMNS}`,
    [ws, requireText("id", input.id), input.result === undefined ? null : json(input.result), input.proposalOperationId ?? null]
  );
  if (rows.length) return toRow(rows[0]);
  throw new ControlStoreError("not_found", "Run not found or still running.", { id: input.id });
}

/** Claim a stopped run for resumption with (possibly raised) limits. Exactly one caller wins. */
export async function claimResume(sql: Sql, input: { workspaceId: string; id: string; limits: unknown }): Promise<CodingAgentRunRow> {
  const ws = requireText("workspaceId", input.workspaceId);
  const rows = await sql.query<Row>(
    `update platform.coding_agent_runs set status = 'running', stop_reason = null, limits = $3::jsonb, version = version + 1, updated_at = clock_timestamp()
     where workspace_id = $1 and id = $2 and (status in ('budget_exhausted','failed') or (status = 'running' and updated_at < clock_timestamp() - interval '10 minutes')) returning ${COLUMNS}`,
    [ws, requireText("id", input.id), json(input.limits)]
  );
  if (rows.length) return toRow(rows[0]);
  const existing = await getRun(sql, ws, input.id);
  if (!existing) throw new ControlStoreError("not_found", "Run not found.", { id: input.id });
  throw new ControlStoreError("invalid_state", "Only a stopped run (budget, error or a crashed worker) can be resumed.", { id: input.id, status: existing.status });
}
