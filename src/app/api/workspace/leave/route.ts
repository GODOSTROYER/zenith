import { z } from "zod";
import { ApiError, WORKSPACE_COOKIE, json, route } from "@/lib/server/context";
import { mutateSharing, sharingActor, sharingWorkspace } from "@/lib/server/workspace-sharing";

export const dynamic = "force-dynamic";
const Body = z.object({ workspaceId: z.string().optional() });
export const POST = route({ workspaceRole: "viewer" }, async (req) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new ApiError("The workspace selection is not valid.", 400);
  const workspace = sharingWorkspace(parsed.data.workspaceId);
  await mutateSharing({ operation: "leave", ...sharingActor(), workspaceId: workspace.id });
  const response = json({ left: workspace });
  response.cookies.delete(WORKSPACE_COOKIE);
  return response;
});
