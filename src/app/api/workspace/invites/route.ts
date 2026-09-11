/**
 * Workspace invites — the gate on joining. `ensureMember` will not admit a
 * signed-in stranger without one (see src/lib/server/context.ts), so this is
 * how a second person gets into a workspace. Admin only, both ways.
 *
 *   GET  /api/workspace/invites            → { invites: Invite[] }
 *   POST /api/workspace/invites            → 201 { invite: Invite }
 *        body { email: string, role: "admin" | "editor" | "viewer" }
 */
import { z } from "zod";
import { db } from "@/lib/db/store";
import { id, type Invite } from "@/lib/domain/types";
import {
  ApiError,
  json,
  readInvites,
  requireWorkspace,
  route,
  writeInvites,
} from "@/lib/server/context";

export const dynamic = "force-dynamic";

const Body = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(["admin", "editor", "viewer"]),
});

export const GET = route({ workspaceRole: "admin" }, async () => {
  const ws = requireWorkspace();
  return { invites: readInvites().filter((i) => i.workspaceId === ws.id) };
});

export const POST = route({ workspaceRole: "admin" }, async (req, _params, { actor }) => {
  const ws = requireWorkspace();

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    throw new ApiError("That invite is not valid.", 400, {
      fix: 'Send { "email": "person@example.com", "role": "admin" | "editor" | "viewer" }.',
    });
  const { email, role } = parsed.data;

  const member = db().members.find(
    (m) => m.workspaceId === ws.id && m.email.toLowerCase() === email
  );
  if (member)
    throw new ApiError(`${email} is already a member of ${ws.name}.`, 409, {
      fix: `Change their role with PATCH /api/workspace/members/${member.id} instead.`,
    });

  const invites = readInvites();
  const open = invites.find(
    (i) => i.workspaceId === ws.id && i.email === email && !i.acceptedAt
  );
  if (open)
    throw new ApiError(`${email} already has an open invite as ${open.role}.`, 409, {
      fix: `Revoke it with DELETE /api/workspace/invites/${open.id}, then invite them again with the role you want.`,
    });

  const invite: Invite = {
    id: id(),
    workspaceId: ws.id,
    email,
    role,
    createdBy: actor.id,
    createdAt: new Date().toISOString(),
  };
  writeInvites([...invites, invite]);
  return json({ invite }, 201);
});
