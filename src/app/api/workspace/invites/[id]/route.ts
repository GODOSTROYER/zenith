import { route } from "@/lib/server/context";
import { mutateSharing, sharingActor, sharingWorkspace } from "@/lib/server/workspace-sharing";

export const dynamic = "force-dynamic";
export const DELETE = route<{ id: string }>({ workspaceRole: "admin" }, async (req, { id }) => {
  const workspace = sharingWorkspace(req.nextUrl.searchParams.get("workspaceId") ?? undefined);
  const { invite } = await mutateSharing({ operation: "revoke", ...sharingActor(), workspaceId: workspace.id, inviteId: id });
  return { revoked: invite };
});
