/**
 * Per-environment opt-in for scheduled economic optimization (PROD-COST-03).
 *
 * Off by default: a missing row is "disabled" and reading never writes one.
 * Writers pass `expectedVersion` (0 = "I expect no row yet"); an environment
 * already owned by another workspace is refused (`tenant_mismatch`). The caller
 * (a human, browser-session service) decides who may flip it; this is storage.
 */
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError, requireText } from "../errors";

export interface OptimizerSettings {
  workspaceId: string;
  environmentId: string;
  enabled: boolean;
  /** 0 when no row exists */
  version: number;
  updatedBy?: string;
  updatedAt?: string;
  isDefault: boolean;
}

interface Row {
  workspace_id: string;
  environment_id: string;
  enabled: boolean;
  version: number;
  updated_by: string;
  updated_at: string;
}
const COLUMNS = "workspace_id, environment_id, enabled, version, updated_by, updated_at";
const toSettings = (r: Row): OptimizerSettings => ({ workspaceId: r.workspace_id, environmentId: r.environment_id, enabled: r.enabled, version: r.version, updatedBy: r.updated_by, updatedAt: r.updated_at, isDefault: false });

export async function getOptimizerSettings(sql: Sql, workspaceId: string, environmentId: string): Promise<OptimizerSettings> {
  const ws = requireText("workspaceId", workspaceId);
  const env = requireText("environmentId", environmentId);
  const rows = await sql.query<Row>(`select ${COLUMNS} from platform.optimizer_settings where workspace_id = $1 and environment_id = $2`, [ws, env]);
  return rows.length ? toSettings(rows[0]) : { workspaceId: ws, environmentId: env, enabled: false, version: 0, isDefault: true };
}

export interface PutOptimizerSettingsInput {
  workspaceId: string;
  environmentId: string;
  enabled: boolean;
  updatedBy: string;
  expectedVersion?: number;
}

export async function putOptimizerSettings(sql: Sql, input: PutOptimizerSettingsInput): Promise<OptimizerSettings> {
  const ws = requireText("workspaceId", input.workspaceId);
  const env = requireText("environmentId", input.environmentId);
  if (typeof input.enabled !== "boolean") throw new ControlStoreError("invalid_input", "enabled must be a boolean.", { field: "enabled" });
  const rows = await sql.query<Row>(
    `insert into platform.optimizer_settings as s (environment_id, workspace_id, enabled, version, updated_by)
     values ($1, $2, $3, 1, $4)
     on conflict (environment_id) do update
       set enabled = excluded.enabled, version = s.version + 1, updated_by = excluded.updated_by, updated_at = clock_timestamp()
     where s.workspace_id = excluded.workspace_id and ($5::int is null or s.version = $5::int)
     returning ${COLUMNS}`,
    [env, ws, input.enabled, requireText("updatedBy", input.updatedBy), input.expectedVersion ?? null]
  );
  if (rows.length) return toSettings(rows[0]);
  const existing = await sql.query<{ workspace_id: string; version: number }>("select workspace_id, version from platform.optimizer_settings where environment_id = $1", [env]);
  if (existing.length && existing[0].workspace_id !== ws) throw new ControlStoreError("tenant_mismatch", "Environment not found in this workspace.", { environmentId: env });
  throw new ControlStoreError("conflict", "Optimizer settings changed since you read them; reload and retry.", { environmentId: env, currentVersion: existing[0]?.version ?? 0 });
}

/** Opted-in environments, deterministic order, bounded. */
export async function listOptedInEnvironments(sql: Sql, limit = 25): Promise<{ workspaceId: string; environmentId: string }[]> {
  const n = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const rows = await sql.query<{ workspace_id: string; environment_id: string }>(
    "select workspace_id, environment_id from platform.optimizer_settings where enabled order by workspace_id, environment_id limit $1",
    [n]
  );
  return rows.map((r) => ({ workspaceId: r.workspace_id, environmentId: r.environment_id }));
}
