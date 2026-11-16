/**
 * Environment autonomy settings and workspace policy parameters.
 *
 * **Defaults.** The store has no notion of an environment class, so a missing
 * row is not "production" or "sandbox" — it is the conservative store-level
 * default: `autonomyLevel = 1` (see `AutonomyLevel` in `policy/types.ts`; the
 * capability broker decides what each level permits and may impose a lower
 * ceiling by environment class), no per-environment policy overrides, and
 * `version = 0` / `isDefault = true` so a caller can tell "never configured"
 * from "configured to 1". Reading never writes a default row.
 *
 * **Optimistic concurrency.** Writers pass `expectedVersion` (the version they
 * read; `0` = "I expect no row yet"). A stale writer gets `conflict` and must
 * re-read; nobody silently overwrites a newer setting. Omitting it is an
 * unconditional write, for bootstrap and admin repair only.
 *
 * **Tenancy.** `environment_id` is the primary key, so a write naming an
 * environment that already belongs to another workspace is refused
 * (`tenant_mismatch`) rather than taking it over.
 */
import type { Sql } from "@/lib/controlplane/types";
import type { AutonomyLevel } from "@/lib/policy/types";
import { ControlStoreError, requireText } from "../errors";
import { assertNoSecretValues } from "../secrets";
import { json } from "../sql";

/** Store default when an environment has no settings row. */
export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = 1;

export interface EnvironmentSettings {
  environmentId: string;
  workspaceId: string;
  autonomyLevel: AutonomyLevel;
  /** per-environment overrides of workspace policy parameters (validated by the policy layer) */
  policyParams: Record<string, unknown>;
  /** 0 when no row exists */
  version: number;
  updatedBy?: string;
  updatedAt?: string;
  /** true when no row exists and these are the store defaults */
  isDefault: boolean;
}

interface EnvRow {
  environment_id: string;
  workspace_id: string;
  autonomy_level: number;
  policy_params: Record<string, unknown>;
  version: number;
  updated_by: string;
  updated_at: string;
}

const ENV_COLUMNS = "environment_id, workspace_id, autonomy_level, policy_params, version, updated_by, updated_at";

const toEnv = (row: EnvRow): EnvironmentSettings => ({
  environmentId: row.environment_id,
  workspaceId: row.workspace_id,
  autonomyLevel: row.autonomy_level as AutonomyLevel,
  policyParams: row.policy_params,
  version: row.version,
  updatedBy: row.updated_by,
  updatedAt: row.updated_at,
  isDefault: false,
});

export async function getEnvironmentSettings(sql: Sql, workspaceId: string, environmentId: string): Promise<EnvironmentSettings> {
  const ws = requireText("workspaceId", workspaceId);
  const env = requireText("environmentId", environmentId);
  const rows = await sql.query<EnvRow>(
    `select ${ENV_COLUMNS} from platform.environment_settings where workspace_id = $1 and environment_id = $2`,
    [ws, env]
  );
  if (rows.length) return toEnv(rows[0]);
  return { environmentId: env, workspaceId: ws, autonomyLevel: DEFAULT_AUTONOMY_LEVEL, policyParams: {}, version: 0, isDefault: true };
}

export interface PutEnvironmentSettingsInput {
  workspaceId: string;
  environmentId: string;
  autonomyLevel: AutonomyLevel;
  policyParams?: Record<string, unknown>;
  updatedBy: string;
  expectedVersion?: number;
}

export async function putEnvironmentSettings(sql: Sql, input: PutEnvironmentSettingsInput): Promise<EnvironmentSettings> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const environmentId = requireText("environmentId", input.environmentId);
  if (!Number.isInteger(input.autonomyLevel) || input.autonomyLevel < 0 || input.autonomyLevel > 5)
    throw new ControlStoreError("invalid_input", "autonomyLevel must be an integer from 0 to 5.", { field: "autonomyLevel" });
  assertNoSecretValues(input.policyParams, "policyParams");
  const rows = await sql.query<EnvRow>(
    `insert into platform.environment_settings as s (environment_id, workspace_id, autonomy_level, policy_params, version, updated_by)
     values ($1, $2, $3::smallint, $4::text::jsonb, 1, $5)
     on conflict (environment_id) do update
       set autonomy_level = excluded.autonomy_level,
           policy_params  = excluded.policy_params,
           version        = s.version + 1,
           updated_by     = excluded.updated_by,
           updated_at     = clock_timestamp()
     where s.workspace_id = excluded.workspace_id
       and ($6::int is null or s.version = $6::int)
     returning ${ENV_COLUMNS}`,
    [environmentId, workspaceId, input.autonomyLevel, json(input.policyParams ?? {}), requireText("updatedBy", input.updatedBy), input.expectedVersion ?? null]
  );
  if (rows.length) return toEnv(rows[0]);
  const existing = await sql.query<{ workspace_id: string; version: number }>(
    "select workspace_id, version from platform.environment_settings where environment_id = $1",
    [environmentId]
  );
  if (existing.length && existing[0].workspace_id !== workspaceId)
    throw new ControlStoreError("tenant_mismatch", "Environment not found in this workspace.", { environmentId });
  throw new ControlStoreError("conflict", "Environment settings changed since you read them; reload and retry.", {
    environmentId,
    currentVersion: existing[0]?.version ?? 0,
  });
}

/* ---------------------------- workspace policy ------------------------------ */

export interface WorkspacePolicyRow {
  workspaceId: string;
  /** validated by the policy layer (`WorkspacePolicyParams`); `{}` when never set */
  params: Record<string, unknown>;
  /** 0 when no row exists */
  version: number;
  updatedBy?: string;
  updatedAt?: string;
  isDefault: boolean;
}

interface PolicyRow {
  workspace_id: string;
  params: Record<string, unknown>;
  version: number;
  updated_by: string;
  updated_at: string;
}

export async function getWorkspacePolicy(sql: Sql, workspaceId: string): Promise<WorkspacePolicyRow> {
  const ws = requireText("workspaceId", workspaceId);
  const rows = await sql.query<PolicyRow>(
    "select workspace_id, params, version, updated_by, updated_at from platform.workspace_policy where workspace_id = $1",
    [ws]
  );
  if (!rows.length) return { workspaceId: ws, params: {}, version: 0, isDefault: true };
  const row = rows[0];
  return { workspaceId: ws, params: row.params, version: row.version, updatedBy: row.updated_by, updatedAt: row.updated_at, isDefault: false };
}

export async function putWorkspacePolicy(
  sql: Sql,
  input: { workspaceId: string; params: Record<string, unknown>; updatedBy: string; expectedVersion?: number }
): Promise<WorkspacePolicyRow> {
  const ws = requireText("workspaceId", input.workspaceId);
  assertNoSecretValues(input.params, "params");
  const rows = await sql.query<PolicyRow>(
    `insert into platform.workspace_policy as p (workspace_id, params, version, updated_by)
     values ($1, $2::text::jsonb, 1, $3)
     on conflict (workspace_id) do update
       set params = excluded.params, version = p.version + 1, updated_by = excluded.updated_by, updated_at = clock_timestamp()
     where $4::int is null or p.version = $4::int
     returning workspace_id, params, version, updated_by, updated_at`,
    [ws, json(input.params), requireText("updatedBy", input.updatedBy), input.expectedVersion ?? null]
  );
  if (!rows.length) throw new ControlStoreError("conflict", "Workspace policy changed since you read it; reload and retry.", { workspaceId: ws });
  const row = rows[0];
  return { workspaceId: ws, params: row.params, version: row.version, updatedBy: row.updated_by, updatedAt: row.updated_at, isDefault: false };
}
