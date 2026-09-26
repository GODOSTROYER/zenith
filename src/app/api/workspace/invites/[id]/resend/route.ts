import { z } from "zod";
import { ApiError, route } from "@/lib/server/context";
import { invitationUrl, mutateSharing, sharingActor, sharingWorkspace } from "@/lib/server/workspace-sharing";

export const dynamic = "force-dynamic";
const Body = z.object({ workspaceId: z.string().optional() });
export const POST = route<{ id: string }>({ workspaceRole: "admin" }, async (req, { id }) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new ApiError("The workspace selection is not valid.", 400);
  const workspace = sharingWorkspace(parsed.data.workspaceId);
  const { invite } = await mutateSharing({ operation: "resend", ...sharingActor(), workspaceId: workspace.id, inviteId: id });
  if (!invite) throw new ApiError("The invitation could not be renewed.", 500);
  return { invite, inviteUrl: invitationUrl(invite) };
});
