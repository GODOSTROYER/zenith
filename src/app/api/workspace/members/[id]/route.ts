/**
 * Member role changes and removal. Admin only, and the last admin is
 * protected in both directions — a workspace with no admin is a workspace
 * where seven actions are unreachable for everybody.
 *
 *   PATCH  /api/workspace/members/:id  body { role } → { member: Member }
 *   DELETE /api/workspace/members/:id                → { removed: Member }
 */
import { z } from "zod";
import { db, save } from "@/lib/db/store";
import type { Member } from "@/lib/domain/types";
import { ApiError, isLastAdmin, requireWorkspace, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

const Body = z.object({ role: z.enum(["admin", "editor", "viewer"]) });

function find(memberId: string, workspaceId: string): Member {
  const member = db().members.find((m) => m.id === memberId && m.workspaceId === workspaceId);
  if (!member)
    throw new ApiError(`Member "${memberId}" was not found in this workspace.`, 404, {
      fix: "List the members with GET /api/bootstrap, which returns `members`.",
    });
  return member;
}

export const PATCH = route<{ id: string }>({ workspaceRole: "admin" }, async (req, { id }) => {
  const ws = requireWorkspace();
  const member = find(id, ws.id);

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    throw new ApiError("That role is not valid.", 400, {
      fix: 'Send { "role": "admin" | "editor" | "viewer" }.',
    });
  const { role } = parsed.data;

  if (role !== "admin" && isLastAdmin(member))
    throw new ApiError(`${member.name} is the last admin of ${ws.name}.`, 409, {
      fix: `Make someone else an admin first (PATCH /api/workspace/members/:id with role "admin"), then change ${member.name}.`,
    });

  if (member.role !== role) {
    member.role = role;
    save();
  }
  return { member };
});

export const DELETE = route<{ id: string }>({ workspaceRole: "admin" }, async (_req, { id }) => {
  const ws = requireWorkspace();
  const member = find(id, ws.id);

  if (isLastAdmin(member))
    throw new ApiError(`${member.name} is the last admin of ${ws.name}.`, 409, {
      fix: `Make someone else an admin first (PATCH /api/workspace/members/:id with role "admin"), then remove ${member.name}.`,
    });

  const members = db().members;
  members.splice(members.indexOf(member), 1);
  save();
  // Removal does not end an already-issued session; the member is refused on
  // their next bootstrap. See docs/LIMITATIONS.md (U11).
  return { removed: member };
});
