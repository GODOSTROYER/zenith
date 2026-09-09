"use client";
/**
 * Role gating for the two approval controls. `deploy.approve` is admin while
 * `deploy.apply` is editor, so an editor could start a production deploy and
 * then not be allowed to clear it — the button has to say that before it is
 * pressed, not after.
 *
 * `boot.role` is the caller's own role from `GET /api/bootstrap`, which is the
 * same `roleOf()` the action executor enforces.
 */
import { requiredRoleOf, useShell, type Bootstrap } from "@/components/shell/shell-context";
import { roleReaches } from "@/lib/domain/roles";

type Role = NonNullable<Bootstrap["role"]>;

/**
 * Which role an action actually needs, from the registry the (product) layout
 * handed the shell — the same `requiredRole` `runAction` enforces, rather than
 * a literal repeated at each control. `fallback` covers the first paint, and
 * the server refuses either way.
 */
export function useRequiredRole(actionId: string, fallback: Role): Role {
  return requiredRoleOf(useShell().catalog, actionId, fallback);
}

/** Unresolved role counts as allowed: only a known-too-low role disables. */
export function roleAllows(boot: Bootstrap | undefined, required: Role): boolean {
  return roleReaches(boot?.role, required);
}

/** The sentence a disabled control shows. Names who can grant the role. */
export function roleReason(boot: Bootstrap | undefined, required: Role, what: string): string {
  return `${what} needs the ${required} role and you are ${boot?.role ?? "not an admin"} in this workspace. Ask a workspace admin to raise your role in Settings → Members.`;
}
