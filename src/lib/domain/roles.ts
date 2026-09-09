/**
 * The one workspace-role rank table.
 *
 * Role gating is decided in two places for every control: the server, where
 * `runAction` refuses, and the browser, where the control has to say no BEFORE
 * it is pressed. Both need the same ordering, so it lives here — a module with
 * no imports, safe for client components, that `@/lib/actions/core` re-exports
 * for server callers.
 */

/** The caller's role in ONE workspace, lowest to highest. */
export type WorkspaceRole = "viewer" | "editor" | "admin";

/** Ordering only. Never persisted — the stored value is the role name. */
export const WORKSPACE_ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
};

/**
 * Does `have` reach `need`? An unknown role on either side — demo mode, a
 * bootstrap that has not answered yet, or a store with no members — reaches
 * everything, which is what the server does too; only a KNOWN too-low role
 * refuses, and the server is the authority in every case.
 */
export const roleReaches = (
  have: WorkspaceRole | null | undefined,
  need: WorkspaceRole | null | undefined
): boolean => !need || !have || WORKSPACE_ROLE_RANK[have] >= WORKSPACE_ROLE_RANK[need];

/**
 * One sentence when the caller's workspace role is below the role an action
 * demands — so a preview says it before the button is pressed, even when the
 * server did not set `blocked` (a plan blocked for some other reason first, or
 * one planned on someone else's behalf).
 *
 * `null` caller role means "not signed in / demo mode": nothing to compare.
 * `what` names the subject of the sentence; it defaults to "This".
 */
export function roleShortfall(
  required: WorkspaceRole | undefined,
  caller: WorkspaceRole | null | undefined,
  what = "This"
): string | undefined {
  if (!required || !caller) return undefined;
  if (roleReaches(caller, required)) return undefined;
  return (
    `${what} needs the ${required} role and you are ${caller} in this workspace. ` +
    `Ask a workspace admin to raise your role in Settings → Members, or have them run it.`
  );
}
