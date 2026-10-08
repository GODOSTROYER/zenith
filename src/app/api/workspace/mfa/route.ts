import { randomUUID } from "node:crypto";
import { z } from "zod";
import { route, currentRequest } from "@/lib/server/request";
import { requireWorkspace } from "@/lib/server/workspace";
import { workspaceMfaControl } from "@/lib/auth/mfa-policy";
import { ApiError } from "@/lib/server/errors";
import { currentRequestId } from "@/lib/log";
import { ControlStoreError, platformDb } from "@/lib/controlplane/db";
import { putWorkspaceMfaControls } from "@/lib/controlplane/db/repos/workspace-mfa-controls";
export const dynamic = "force-dynamic";
export const GET = route({ workspaceRole: "viewer" }, async () => {
  const workspaceId = requireWorkspace().id;
  return { workspaceId, ...await workspaceMfaControl(workspaceId) };
});

const Body = z.object({
  workspaceId: z.string().min(1).max(200),
  requireForAllMutations: z.boolean(),
  maxAgeSeconds: z.number().int().min(60).max(86400).nullable(),
  expectedVersion: z.number().int().min(0).max(2147483646),
}).strict();

/** Changing enforcement is a human admin decision, protected by the common step-up hook. */
export const PUT = route({ workspaceRole: "admin" }, async (req) => {
  const workspaceId = requireWorkspace().id;
  const user = currentRequest()?.user;
  if (!user) throw new ApiError("Sign in to change workspace MFA controls.", 401);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new ApiError("Provide workspaceId, the MFA controls and the version you reviewed.", 400);
  if (parsed.data.workspaceId !== workspaceId) throw new ApiError("Your selected workspace changed. Reload and review its MFA controls.", 409);
  try {
    return await putWorkspaceMfaControls(await platformDb(), { ...parsed.data, actor: { kind: "user", id: user.id, name: user.name }, correlationId: currentRequestId() ?? randomUUID() });
  } catch (error) {
    if (error instanceof ControlStoreError && error.code === "conflict") throw new ApiError(error.message, 409);
    throw new ApiError("Workspace MFA controls could not be saved. Reload before retrying.", 503);
  }
});
