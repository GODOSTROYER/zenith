/** Tenant-scoped MFA settings; every successful CAS and its audit event commit together. */
import type { Principal, Sql } from "@/lib/controlplane/types";
import { DEFAULT_MFA_CONTROL, type WorkspaceMfaSettings } from "@/lib/auth/mfa-policy";
import { ControlStoreError, requireText } from "../errors";
import { append } from "./events";

interface Row {
  workspace_id: string;
  require_for_all_mutations: boolean;
  max_age_seconds: number | null;
  version: number;
  updated_by: string;
  updated_at: string;
}
const COLUMNS = "workspace_id, require_for_all_mutations, max_age_seconds, version, updated_by, updated_at";
const settings = (row: Row): WorkspaceMfaSettings => ({
  workspaceId: row.workspace_id, privilegedActionsRequireAal2: true,
  requireForAllMutations: row.require_for_all_mutations, maxAgeSeconds: row.max_age_seconds,
  version: row.version, isDefault: false, updatedBy: row.updated_by, updatedAt: row.updated_at,
});

export async function getWorkspaceMfaControls(sql: Sql, workspaceId: string): Promise<WorkspaceMfaSettings> {
  const ws = requireText("workspaceId", workspaceId);
  const rows = await sql.query<Row>(`select ${COLUMNS} from platform.workspace_mfa_controls where workspace_id = $1`, [ws]);
  return rows.length ? settings(rows[0]) : { ...DEFAULT_MFA_CONTROL, workspaceId: ws, version: 0, isDefault: true };
}

export interface PutWorkspaceMfaControlsInput {
  workspaceId: string;
  requireForAllMutations: boolean;
  maxAgeSeconds: number | null;
  expectedVersion: number;
  actor: Principal;
  correlationId: string;
}

export async function putWorkspaceMfaControls(sql: Sql, input: PutWorkspaceMfaControlsInput): Promise<WorkspaceMfaSettings> {
  const ws = requireText("workspaceId", input.workspaceId);
  if (typeof input.requireForAllMutations !== "boolean" || (input.maxAgeSeconds !== null && (!Number.isInteger(input.maxAgeSeconds) || input.maxAgeSeconds < 60 || input.maxAgeSeconds > 86400)))
    throw new ControlStoreError("invalid_input", "MFA controls need a boolean and a null or 60..86400 second verification lifetime.");
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0 || input.expectedVersion > 2147483646)
    throw new ControlStoreError("invalid_input", "expectedVersion must be a non-negative settings version.");
  if (input.actor?.kind !== "user") throw new ControlStoreError("invalid_input", "Only a human can change workspace MFA controls.");
  const actor: Principal = { kind: "user", id: requireText("actor.id", input.actor.id), name: requireText("actor.name", input.actor.name) };
  const correlationId = requireText("correlationId", input.correlationId);
  return sql.tx(async (tx) => {
    const before = await getWorkspaceMfaControls(tx, ws);
    if (before.version !== input.expectedVersion) throw new ControlStoreError("conflict", "Workspace MFA controls changed. Reload, review and try again.");
    const rows = input.expectedVersion === 0
      ? await tx.query<Row>(`insert into platform.workspace_mfa_controls (${COLUMNS}) values ($1, $2, $3, 1, $4, clock_timestamp()) on conflict (workspace_id) do nothing returning ${COLUMNS}`, [ws, input.requireForAllMutations, input.maxAgeSeconds, actor.id])
      : await tx.query<Row>(`update platform.workspace_mfa_controls set require_for_all_mutations = $2, max_age_seconds = $3, version = version + 1, updated_by = $4, updated_at = clock_timestamp() where workspace_id = $1 and version = $5 returning ${COLUMNS}`, [ws, input.requireForAllMutations, input.maxAgeSeconds, actor.id, input.expectedVersion]);
    if (!rows.length) throw new ControlStoreError("conflict", "Workspace MFA controls changed. Reload, review and try again.");
    const after = settings(rows[0]);
    await append(tx, { type: "workspace.mfa_controls_changed", workspaceId: ws, correlationId, actor,
      data: { before: { requireForAllMutations: before.requireForAllMutations, maxAgeSeconds: before.maxAgeSeconds, version: before.version },
        after: { requireForAllMutations: after.requireForAllMutations, maxAgeSeconds: after.maxAgeSeconds, version: after.version }, privilegedActionsRequireAal2: true } });
    return after;
  });
}
