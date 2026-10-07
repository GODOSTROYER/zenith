/** Host-managed workspace controls. The privileged minimum cannot be disabled. */
import { ApiError } from "@/lib/server/errors";

export interface WorkspaceMfaControl {
  privilegedActionsRequireAal2: true;
  requireForAllMutations: boolean;
  maxAgeSeconds: number | null;
}

export function workspaceMfaControl(workspaceId?: string): WorkspaceMfaControl {
  const base: WorkspaceMfaControl = { privilegedActionsRequireAal2: true, requireForAllMutations: false, maxAgeSeconds: null };
  const raw = process.env.ZENITH_MFA_WORKSPACE_CONTROLS;
  if (!raw) return base;
  try {
    const controls: unknown = JSON.parse(raw);
    if (!controls || typeof controls !== "object" || Array.isArray(controls)) throw new Error();
    for (const [id, value] of Object.entries(controls)) {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      const row = value as Record<string, unknown>;
      if (Object.keys(row).some((key) => !["requireForAllMutations", "maxAgeSeconds"].includes(key))) throw new Error();
      if (row.requireForAllMutations !== undefined && typeof row.requireForAllMutations !== "boolean") throw new Error();
      if (row.maxAgeSeconds !== undefined && (!Number.isInteger(row.maxAgeSeconds) || (row.maxAgeSeconds as number) < 60 || (row.maxAgeSeconds as number) > 86400)) throw new Error();
    }
    const row = (controls as Record<string, { requireForAllMutations?: boolean; maxAgeSeconds?: number }>)[workspaceId ?? ""];
    return { ...base, requireForAllMutations: row?.requireForAllMutations ?? false, maxAgeSeconds: row?.maxAgeSeconds ?? null };
  } catch {
    throw new ApiError("Workspace MFA controls are invalid. Mutations are refused until they are repaired.", 503);
  }
}
