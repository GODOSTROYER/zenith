/** Workspace access decisions shared by the HTTP routes and the two stores. */
import { withMutationGate } from "@/lib/actions/mutation-gate";
import { db, flushPendingAsync, isPostgres, save, appendAuditAsync } from "@/lib/db/store";
import { id, type Invite, type Member, type Workspace } from "@/lib/domain/types";
import type { SessionUser } from "@/lib/auth/session";
import { ApiError } from "@/lib/server/errors";
import { isLastAdmin, isLiveInvite, readInvites, workspaceOwnerId } from "@/lib/server/membership";
import { currentRequest } from "@/lib/server/request";
import { requireWorkspace } from "@/lib/server/workspace";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export type SharingOperation = "change-role" | "remove-member" | "leave" | "transfer" | "invite" | "revoke" | "resend" | "accept";
export interface SharingInput {
  operation: SharingOperation;
  workspaceId?: string;
  actorId: string;
  actorEmail: string;
  actorName: string;
  memberId?: string;
  role?: Member["role"];
  inviteId?: string;
  email?: string;
}
export interface SharingResult {
  workspace?: Workspace;
  member?: Member;
  removed?: Member;
  invite?: Invite;
}

/** Reject stale tabs before an operation acts on the newly selected workspace. */
export function sharingWorkspace(expectedWorkspaceId?: string): Workspace {
  const workspace = requireWorkspace();
  if (expectedWorkspaceId && expectedWorkspaceId !== workspace.id)
    throw new ApiError("Your active workspace changed in another tab.", 409, {
      fix: "Refresh this page and reopen Share for the workspace you want to manage.",
    });
  return workspace;
}

export function sharingActor(): Pick<SharingInput, "actorId" | "actorEmail" | "actorName"> {
  const user = currentRequest()?.user;
  if (user) return { actorId: user.id, actorEmail: user.email, actorName: user.name };
  if (!isSupabaseConfigured()) return { actorId: "local", actorEmail: "", actorName: "You" };
  throw new ApiError("Sign in to manage workspace access.", 401);
}

function permission(workspace: Workspace, actorId: string) {
  const member = db().members.find((row) => row.workspaceId === workspace.id && row.id === actorId);
  const demo = actorId === "local" && !isSupabaseConfigured();
  if (!member && !demo) throw new ApiError("You are not a member of this workspace.", 403);
  const isOwner = demo || workspaceOwnerId(workspace) === actorId;
  return { member, isOwner, role: member?.role ?? "admin" as Member["role"], canManageMembers: demo || member?.role === "admin" };
}

export function sharingDetails(workspace: Workspace, actorId: string) {
  const access = permission(workspace, actorId);
  return {
    workspace: { ...workspace, ownerId: workspaceOwnerId(workspace) },
    members: db().members.filter((member) => member.workspaceId === workspace.id),
    invites: access.canManageMembers ? readInvites().filter((invite) => invite.workspaceId === workspace.id) : [],
    role: access.role,
    isOwner: access.isOwner,
    canManageMembers: access.canManageMembers,
    canManageAdmins: access.isOwner,
  };
}

export async function pendingInvitations(user: SessionUser): Promise<(Invite & { workspaceName: string })[]> {
  if (isPostgres()) {
    const { pgPendingInvitations } = await import("@/lib/db/pg/workspace-sharing");
    return pgPendingInvitations(user);
  }
  return readInvites().filter((invite) => isLiveInvite(invite) && invite.email.toLowerCase() === user.email.toLowerCase())
    .flatMap((invite) => {
      const workspace = db().workspaces.find((row) => row.id === invite.workspaceId);
      return workspace ? [{ ...invite, workspaceName: workspace.name }] : [];
    });
}

/** All file-store decisions and writes occur inside the single-writer gate. */
export async function mutateSharing(input: SharingInput): Promise<SharingResult> {
  return withMutationGate(async () => {
    if (isPostgres()) {
      const { pgSharingMutation } = await import("@/lib/db/pg/workspace-sharing");
      return pgSharingMutation(input);
    }
    const data = db();
    const invite = input.inviteId ? readInvites().find((row) => row.id === input.inviteId) : undefined;
    const workspaceId = input.operation === "accept" ? invite?.workspaceId : input.workspaceId;
    const workspace = data.workspaces.find((row) => row.id === workspaceId);
    if (!workspace) throw new ApiError("This workspace or invitation is no longer available.", 404);
    const now = new Date().toISOString();
    let result: SharingResult;

    if (input.operation === "accept") {
      if (!invite || invite.email.toLowerCase() !== input.actorEmail.toLowerCase())
        throw new ApiError("This invitation is not addressed to your signed-in email.", 404);
      const existing = data.members.find((row) => row.workspaceId === workspace.id && row.id === input.actorId);
      if (invite.acceptedAt && existing) return { workspace, member: existing, invite };
      if (!isLiveInvite(invite)) throw new ApiError("This invitation has expired, was revoked, or was already used.", 410, {
        fix: "Ask a workspace admin for a new invitation.",
      });
      if (!input.actorEmail || !input.actorId || input.actorId === "local")
        throw new ApiError("Sign in to accept this invitation.", 401);
      const member = existing ?? {
        id: input.actorId, workspaceId: workspace.id, email: input.actorEmail,
        name: input.actorName, role: invite.role,
      };
      // An invitation never rewrites a membership granted since it was issued.
      if (!existing) data.members.push(member);
      invite.acceptedAt = now;
      result = { workspace, member, invite };
    } else {
      const access = permission(workspace, input.actorId);
      if (input.operation !== "leave" && !access.canManageMembers)
        throw new ApiError("Managing workspace access requires an admin.", 403);
      // Freeze the legacy owner before changing the ordering or roles of admins.
      const ownerId = workspaceOwnerId(workspace);
      const member = data.members.find((row) => row.workspaceId === workspace.id && row.id === (input.operation === "leave" ? input.actorId : input.memberId));
      if (["change-role", "remove-member", "leave", "transfer"].includes(input.operation)) {
        if (!member) throw new ApiError("That member was not found in this workspace.", 404);
        if (input.operation === "transfer") {
          if (!access.isOwner) throw new ApiError("Only the workspace owner can transfer ownership.", 403);
          if (!member.email || ["you@local", "you@kepler.dev"].includes(member.email.trim().toLowerCase()))
            throw new ApiError("Ownership requires a real workspace member.", 400);
          const deletions = data.settings.pendingAccountDeletions;
          if (Array.isArray(deletions) && deletions.some((entry: unknown) =>
            typeof entry === "object" && entry !== null &&
            (entry as { user?: { id?: string } }).user?.id === member.id))
            throw new ApiError("That member is deleting their account. Choose another owner.", 409);
          if (member.id === ownerId) return { workspace, member };
          member.role = "admin";
          workspace.ownerId = member.id;
          result = { workspace, member };
        } else {
          if (member.id === ownerId && (input.operation !== "change-role" || input.role !== "admin"))
            throw new ApiError("Transfer workspace ownership before removing or demoting the owner.", 409);
          if (input.operation !== "leave" && !access.isOwner && (member.role === "admin" || input.role === "admin"))
            throw new ApiError("Only the workspace owner can grant or change admin access.", 403);
          if (isLastAdmin(member) && (input.operation !== "change-role" || input.role !== "admin"))
            throw new ApiError("The workspace must retain an admin.", 409);
          if (input.operation === "change-role") {
            if (!input.role) throw new ApiError("Choose a member role.", 400);
            member.role = input.role;
            result = { workspace, member };
          } else {
            data.members.splice(data.members.indexOf(member), 1);
            // Old pending offers must not immediately restore a removed member.
            for (const offer of readInvites())
              if (offer.workspaceId === workspace.id && offer.email.toLowerCase() === member.email.toLowerCase() && isLiveInvite(offer)) offer.revokedAt = now;
            result = { workspace, removed: member };
          }
        }
      } else if (input.operation === "invite") {
        const email = input.email?.trim().toLowerCase();
        if (!email || !input.role) throw new ApiError("An email and role are required.", 400);
        if (input.role === "admin" && !access.isOwner)
          throw new ApiError("Only the workspace owner can invite an admin.", 403);
        if (data.members.some((row) => row.workspaceId === workspace.id && row.email.toLowerCase() === email))
          throw new ApiError("That email is already a workspace member.", 409);
        if (readInvites().some((row) => row.workspaceId === workspace.id && row.email.toLowerCase() === email && isLiveInvite(row)))
          throw new ApiError("That email already has a pending invitation.", 409, { fix: "Copy or renew the existing invitation, or revoke it first." });
        const created: Invite = { id: id(), workspaceId: workspace.id, email, role: input.role,
          createdBy: input.actorId, createdAt: now, expiresAt: new Date(Date.now() + INVITE_LIFETIME_MS).toISOString() };
        data.settings.invites = [...readInvites(), created];
        result = { workspace, invite: created };
      } else {
        if (!invite || invite.workspaceId !== workspace.id) throw new ApiError("That invitation was not found in this workspace.", 404);
        if (invite.role === "admin" && !access.isOwner)
          throw new ApiError("Only the workspace owner can manage admin invitations.", 403);
        if (invite.acceptedAt) throw new ApiError("That invitation was accepted. Manage the member instead.", 409);
        if (input.operation === "revoke") {
          invite.revokedAt ??= now;
        } else if (input.operation === "resend") {
          if (invite.revokedAt) throw new ApiError("That invitation was revoked. Create a new invitation.", 409);
          if (data.members.some((row) => row.workspaceId === workspace.id && row.email.toLowerCase() === invite.email.toLowerCase()))
            throw new ApiError("That person is already a member.", 409);
          if (readInvites().some((row) => row !== invite && row.workspaceId === workspace.id && row.email.toLowerCase() === invite.email.toLowerCase() && isLiveInvite(row)))
            throw new ApiError("A newer invitation already exists for this email.", 409);
          invite.expiresAt = new Date(Date.now() + INVITE_LIFETIME_MS).toISOString();
        } else throw new ApiError("Unknown workspace access operation.", 400);
        result = { workspace, invite };
      }
      if (!workspace.ownerId && ownerId) workspace.ownerId = ownerId;
    }

    save();
    await flushPendingAsync();
    await appendAuditAsync({
      id: id(), ts: now, workspaceId: workspace.id,
      actor: { type: "user", id: input.actorId, name: input.actorName },
      actionId: `workspace.${input.operation}`, input: { memberId: input.memberId, inviteId: result.invite?.id, role: input.role },
      result: "ok", summary: `${input.actorName} updated workspace access (${input.operation}).`,
    });
    return result;
  });
}

export const invitationUrl = (invite: Invite): string => `/invite?invite=${encodeURIComponent(invite.id)}`;
