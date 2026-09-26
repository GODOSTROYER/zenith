import { route } from "@/lib/server/context";
import { sharingActor, sharingDetails, sharingWorkspace } from "@/lib/server/workspace-sharing";

export const dynamic = "force-dynamic";
export const GET = route({ workspaceRole: "viewer" }, async (req) =>
  sharingDetails(sharingWorkspace(req.nextUrl.searchParams.get("workspaceId") ?? undefined), sharingActor().actorId));
