import { randomUUID } from "node:crypto";
import type { Invite, Member, Workspace } from "@/lib/domain/types";
import { ApiError } from "@/lib/server/errors";
import {
  currentSnapshot,
  flushPostgres,
  loadSnapshot,
  pgClient,
  UNPRIMED_SNAPSHOT_ERROR,
  type Snapshot,
} from "../postgres-store";
import { adapterFor, type PgRow, storeError } from "./registry";

export interface PgSharingInput {
  operation: "change-role" | "remove-member" | "leave" | "transfer" | "invite" | "revoke" | "resend" | "accept";
  workspaceId?: string;
  actorId: string;
  actorEmail: string;
  actorName: string;
  memberId?: string;
  role?: Member["role"];
  inviteId?: string;
  email?: string;
}

export interface PgSharingResult {
  workspace?: Workspace;
  member?: Member;
  removed?: Member;
  invite?: Invite;
}

/** Mutate under the database workspace lock and then rebase the request graph. */
export async function pgSharingMutation(input: PgSharingInput): Promise<PgSharingResult> {
  let snapshot: Snapshot | undefined;
  try {
    snapshot = currentSnapshot();
  } catch (error) {
    // Invitation acceptance also runs before the first workspace exists in a
    // request's scope. An unprimed graph is optional here, never a file fallback.
    if (!(error instanceof Error) || error.message !== UNPRIMED_SNAPSHOT_ERROR) throw error;
  }
  if (snapshot) await flushPostgres();

  const client = pgClient();
  const { data, error } = await client.rpc("zenith_workspace_sharing", {
    p_operation: input.operation,
    p_workspace_id: input.workspaceId ?? null,
    p_actor_id: input.actorId,
    p_actor_email: input.actorEmail,
    p_actor_name: input.actorName,
    p_member_id: input.memberId ?? null,
    p_role: input.role ?? null,
    p_invite_id: input.inviteId ?? null,
    p_email: input.email ?? null,
    p_new_invite_id: input.operation === "invite" ? `inv_${randomUUID()}` : null,
  });
  if (error) {
    const status = /^PT(400|403|404|409|410)$/.exec(error.code ?? "")?.[1];
    if (status) throw new ApiError(error.message, Number(status));
    if (error.code === "23505") throw new ApiError("A pending invitation already exists for this email.", 409);
    throw storeError("workspace sharing", "mutate", `${error.message}; apply migration 0008_workspace_ownership.sql`);
  }

  if (snapshot) {
    const refreshed = await loadSnapshot(client, { id: input.actorId, email: input.actorEmail });
    // Keep the AsyncLocalStorage reference, replace its graph AND baselines.
    // A subsequent save cannot resurrect a removed member or undo a transfer.
    Object.assign(snapshot, refreshed);
  }

  const rows = (data ?? {}) as Partial<Record<keyof PgSharingResult, PgRow>>;
  return {
    ...(rows.workspace ? { workspace: adapterFor("workspaces").hydrate(rows.workspace) as Workspace } : {}),
    ...(rows.member ? { member: adapterFor("members").hydrate(rows.member) as Member } : {}),
    ...(rows.removed ? { removed: adapterFor("members").hydrate(rows.removed) as Member } : {}),
    ...(rows.invite ? { invite: adapterFor("invites").hydrate(rows.invite) as Invite } : {}),
  };
}

/** Offers are visible by verified address, without loading their tenant data. */
export async function pgPendingInvitations(
  user: { id: string; email: string }
): Promise<Array<Invite & { workspaceName: string }>> {
  const email = user.email.trim().toLowerCase();
  if (!email) return [];
  const client = pgClient();
  const now = new Date().toISOString();
  const { data, error } = await client.from("invites").select("*")
    .eq("email", email).is("accepted_at", null).is("revoked_at", null)
    .gt("expires_at", now).order("created_at", { ascending: false });
  if (error) throw storeError("invites", "read", error.message);
  const rows = ((data ?? []) as PgRow[]).filter((row) =>
    String(row.email).toLowerCase() === email && !row.accepted_at && !row.revoked_at &&
    typeof row.expires_at === "string" && Date.parse(row.expires_at) > Date.parse(now)
  );
  if (!rows.length) return [];
  const { data: workspaces, error: workspaceError } = await client.from("workspaces")
    .select("id,name").in("id", [...new Set(rows.map((row) => String(row.workspace_id)))]);
  if (workspaceError) throw storeError("workspaces", "read", workspaceError.message);
  const names = new Map((workspaces ?? []).map((row: { id: string; name: string }) => [row.id, row.name]));
  return rows.flatMap((row) => {
    const workspaceName = names.get(String(row.workspace_id));
    return workspaceName ? [{ ...adapterFor("invites").hydrate(row) as Invite, workspaceName }] : [];
  });
}
