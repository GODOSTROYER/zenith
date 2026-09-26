import { z } from "zod";
import { ApiError, route } from "@/lib/server/context";
import { mutateSharing, sharingActor, sharingWorkspace } from "@/lib/server/workspace-sharing";

export const dynamic = "force-dynamic";
const Body = z.object({ role: z.enum(["admin", "editor", "viewer"]), workspaceId: z.string().optional() });

export const PATCH = route<{ id: string }>({ workspaceRole: "admin" }, async (req, { id }) => {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) throw new ApiError("Choose admin, editor, or viewer.", 400);
  const workspace = sharingWorkspace(parsed.data.workspaceId);
  const { member } = await mutateSharing({ operation: "change-role", ...sharingActor(), workspaceId: workspace.id, memberId: id, role: parsed.data.role });
  return { member };
});

export const DELETE = route<{ id: string }>({ workspaceRole: "admin" }, async (req, { id }) => {
  const workspace = sharingWorkspace(req.nextUrl.searchParams.get("workspaceId") ?? undefined);
  const { removed } = await mutateSharing({ operation: "remove-member", ...sharingActor(), workspaceId: workspace.id, memberId: id });
  return { removed };
});
