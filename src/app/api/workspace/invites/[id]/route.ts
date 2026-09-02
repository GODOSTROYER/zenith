/**
 * Revoke an invite before it is accepted.
 *
 *   DELETE /api/workspace/invites/:id → { revoked: Invite }
 */
import { ApiError, readInvites, requireAdmin, requireWorkspace, route, writeInvites } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const DELETE = route<{ id: string }>(async (req, { id }) => {
  await requireAdmin(req);
  const ws = requireWorkspace();
  const invites = readInvites();
  const invite = invites.find((i) => i.id === id && i.workspaceId === ws.id);
  if (!invite)
    throw new ApiError(`Invite "${id}" was not found.`, 404, {
      fix: "List the open invites with GET /api/workspace/invites.",
    });
  if (invite.acceptedAt)
    throw new ApiError(`${invite.email} already accepted that invite and is a member.`, 409, {
      fix: "Remove the member with DELETE /api/workspace/members/:id instead.",
    });
  writeInvites(invites.filter((i) => i !== invite));
  return { revoked: invite };
});
