import { z } from "zod";
import { ApiError, route } from "@/lib/server/context";
import { mutateSharing, sharingActor, sharingWorkspace } from "@/lib/server/workspace-sharing";

export const dynamic = "force-dynamic";
const Body = z.object({ memberId: z.string().min(1), workspaceId: z.string().optional() });
export const POST = route({ workspaceRole: "admin" }, async (req) => {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) throw new ApiError("Choose an existing member to own this workspace.", 400);
  const workspace = sharingWorkspace(parsed.data.workspaceId);
  return mutateSharing({ operation: "transfer", ...sharingActor(), workspaceId: workspace.id, memberId: parsed.data.memberId });
});
