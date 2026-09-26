import { z } from "zod";
import { ApiError, json, route } from "@/lib/server/context";
import { invitationUrl, mutateSharing, sharingActor, sharingDetails, sharingWorkspace } from "@/lib/server/workspace-sharing";

export const dynamic = "force-dynamic";
const Body = z.object({ email: z.string().trim().toLowerCase().email().max(320), role: z.enum(["admin", "editor", "viewer"]), workspaceId: z.string().optional() });

export const GET = route({ workspaceRole: "admin" }, async (req) => {
  const workspace = sharingWorkspace(req.nextUrl.searchParams.get("workspaceId") ?? undefined);
  return { invites: sharingDetails(workspace, sharingActor().actorId).invites };
});

export const POST = route({ workspaceRole: "admin" }, async (req) => {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) throw new ApiError("Enter a valid email and choose admin, editor, or viewer.", 400);
  const workspace = sharingWorkspace(parsed.data.workspaceId);
  const { invite } = await mutateSharing({ operation: "invite", ...sharingActor(), workspaceId: workspace.id, email: parsed.data.email, role: parsed.data.role });
  if (!invite) throw new ApiError("The invitation could not be created.", 500);
  return json({ invite, inviteUrl: invitationUrl(invite) }, 201);
});
