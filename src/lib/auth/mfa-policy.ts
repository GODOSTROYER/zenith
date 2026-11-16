/** Current workspace state from the platform store. The privileged minimum cannot be disabled. */
import { ApiError } from "@/lib/server/errors";
import { platformDb } from "@/lib/controlplane/db/open";

export interface WorkspaceMfaControl {
  privilegedActionsRequireAal2: true;
  requireForAllMutations: boolean;
  maxAgeSeconds: number | null;
}

export interface WorkspaceMfaSettings extends WorkspaceMfaControl {
  workspaceId: string;
  version: number;
  isDefault: boolean;
  updatedBy?: string;
  updatedAt?: string;
}

export const DEFAULT_MFA_CONTROL: WorkspaceMfaControl = Object.freeze({ privilegedActionsRequireAal2: true, requireForAllMutations: false, maxAgeSeconds: null });

export async function workspaceMfaControl(workspaceId?: string): Promise<WorkspaceMfaControl> {
  // Installation-level operator actions have no workspace policy to inherit.
  if (!workspaceId) return DEFAULT_MFA_CONTROL;
  try {
    const { getWorkspaceMfaControls } = await import("@/lib/controlplane/db/repos/workspace-mfa-controls");
    return await getWorkspaceMfaControls(await platformDb(), workspaceId);
  } catch {
    throw new ApiError("Workspace MFA controls could not be verified. Mutations are refused until the store is available.", 503);
  }
}
