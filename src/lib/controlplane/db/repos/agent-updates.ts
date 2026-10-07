/** Durable human update intent. Migration is deliberately owned by the integrator. */
import { z } from "zod";
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError, PlatformDbError } from "../errors";
import { requireText } from "../errors";

export const UpdateIntent = z.object({
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
  hold: z.boolean(),
  // SHA-256 of the exact signed release envelope at the locally configured URL.
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict().refine((v) => !v.hold || v.manifestSha256 === null, "A hold cannot also request an update.");

export type UpdateInput = z.infer<typeof UpdateIntent>;
export type UpdateKind = "runner" | "machine";
export interface UpdateControl {
  revision: number;
  hold: boolean;
  manifestSha256: string | null;
  requestedBy: string | null;
  updatedAt: string | null;
}
interface Row {
  revision: number;
  hold: boolean;
  manifest_sha256: string | null;
  requested_by: string;
  updated_at: string;
}
const view = (r: Row): UpdateControl => ({ revision: r.revision, hold: r.hold, manifestSha256: r.manifest_sha256, requestedBy: r.requested_by, updatedAt: r.updated_at });

async function storage<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    const code = error instanceof PlatformDbError ? error.sqlstate : (error as { code?: string })?.code;
    if (code === "42P01" || code === "42703") throw new ControlStoreError("schema_behind", "Durable agent update storage is unavailable; integrate the MACH-04 schema before enabling control-plane updates.");
    throw error;
  }
}

export async function getUpdateControl(sql: Sql, workspaceId: string, kind: UpdateKind, agentId: string): Promise<UpdateControl> {
  return storage(async () => {
    const rows = await sql.query<Row>(
      "select revision, hold, manifest_sha256, requested_by, updated_at from platform.agent_update_controls where workspace_id = $1 and kind = $2 and agent_id = $3",
      [requireText("workspaceId", workspaceId), kind, requireText("agentId", agentId)]);
    return rows.length ? view(rows[0]) : { revision: 0, hold: false, manifestSha256: null, requestedBy: null, updatedAt: null };
  });
}

export async function putUpdateControl(sql: Sql, workspaceId: string, kind: UpdateKind, agentId: string, actorId: string, input: UpdateInput): Promise<UpdateControl> {
  const parsed = UpdateIntent.safeParse(input);
  if (!parsed.success) throw new ControlStoreError("invalid_input", "Send expectedRevision, hold and manifestSha256; a held agent cannot be updated.");
  const ws = requireText("workspaceId", workspaceId), id = requireText("agentId", agentId), actor = requireText("actorId", actorId);
  return storage(() => sql.tx(async (tx) => {
    // Serializes the first insert too, and rechecks revocation in the same transaction.
    // Two fixed statements keep tenancy explicit; no caller-controlled SQL identifiers.
    const agents = await tx.query<{ status: string }>(kind === "runner"
      ? "select status from platform.runners where workspace_id = $1 and id = $2 for update"
      : "select status from platform.machines where workspace_id = $1 and id = $2 for update", [ws, id]);
    if (!agents.length) throw new ControlStoreError("not_found", "Agent not found in this workspace.");
    if (agents[0].status !== "active") throw new ControlStoreError("invalid_state", "A revoked agent cannot receive update commands.");
    const current = await getUpdateControl(tx, ws, kind, id);
    if (current.revision !== parsed.data.expectedRevision) throw new ControlStoreError("conflict", "Update control changed; reload and review the new revision.");
    const rows = await tx.query<Row>(
      `insert into platform.agent_update_controls (workspace_id, kind, agent_id, revision, hold, manifest_sha256, requested_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (workspace_id, kind, agent_id) do update
       set revision = excluded.revision, hold = excluded.hold, manifest_sha256 = excluded.manifest_sha256,
           requested_by = excluded.requested_by, updated_at = clock_timestamp()
       returning revision, hold, manifest_sha256, requested_by, updated_at`,
      [ws, kind, id, current.revision + 1, parsed.data.hold, parsed.data.manifestSha256, actor]);
    return view(rows[0]);
  }));
}
