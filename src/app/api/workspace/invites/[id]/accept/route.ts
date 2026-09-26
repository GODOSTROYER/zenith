import { requireAccountUser } from "@/lib/server/account";
import { WORKSPACE_COOKIE, json, route } from "@/lib/server/context";
import { mutateSharing, sharingActor } from "@/lib/server/workspace-sharing";

export const dynamic = "force-dynamic";
export const POST = route<{ id: string }>(async (_req, { id }) => {
  requireAccountUser();
  const result = await mutateSharing({ operation: "accept", ...sharingActor(), inviteId: id });
  const response = json({ workspace: result.workspace, member: result.member });
  if (result.workspace) response.cookies.set(WORKSPACE_COOKIE, result.workspace.id, {
    httpOnly: true, sameSite: "lax", path: "/", maxAge: 365 * 24 * 60 * 60,
    secure: process.env.NODE_ENV === "production",
  });
  return response;
});
