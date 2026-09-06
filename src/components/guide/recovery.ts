import type { Bootstrap } from "@/components/shell/shell-context";
import { guideStorageKey } from "./progress";

export interface StarterRecovery {
  workspaceId: string;
  userId: string;
  providerId: string;
  connectionId?: string;
  projectId?: string;
  format?: "dockerfile" | "terraform";
  uncertain?: boolean;
}
export function recoveryKey(boot: Bootstrap, providerId: string) {
  const key = guideStorageKey(boot);
  return key ? `${key}:creation:${encodeURIComponent(providerId)}` : undefined;
}
export function restoreRecovery(raw: string | null, boot: Bootstrap, providerId: string): StarterRecovery | undefined {
  if (!raw || !boot.user) return;
  try {
    const r = JSON.parse(raw) as StarterRecovery;
    if (r.workspaceId !== boot.workspace.id || r.userId !== boot.user.id || r.providerId !== providerId) return;
    const connection = boot.connections.find((c) => c.id === r.connectionId && c.workspaceId === boot.workspace.id && c.provider === providerId);
    const project = boot.projects.find((p) => p.id === r.projectId && p.workspaceId === boot.workspace.id);
    // Project recovery is only valid when its actual environment uses this provider.
    const environment = boot.environments.find((e) => e.projectId === project?.id && e.connectionId === connection?.id);
    return { workspaceId: boot.workspace.id, userId: boot.user.id, providerId, connectionId: connection?.id,
      projectId: environment ? project?.id : undefined,
      format: r.format === "dockerfile" || r.format === "terraform" ? r.format : undefined,
      uncertain: r.uncertain === true || !!r.projectId && !environment,
    };
  } catch { return; }
}
