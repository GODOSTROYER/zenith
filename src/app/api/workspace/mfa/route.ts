import { route } from "@/lib/server/request";
import { requireWorkspace } from "@/lib/server/workspace";
import { workspaceMfaControl } from "@/lib/auth/mfa-policy";
export const dynamic = "force-dynamic";
export const GET = route({ workspaceRole: "viewer" }, async () => {
  const workspaceId = requireWorkspace().id;
  return { workspaceId, ...workspaceMfaControl(workspaceId) };
});
