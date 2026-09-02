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
import type { Bootstrap } from "@/components/shell/shell-context";

type Role = NonNullable<Bootstrap["role"]>;

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

/** Unresolved role counts as allowed: only a known-too-low role disables. */
export function roleAllows(boot: Bootstrap | undefined, required: Role): boolean {
  const role = boot?.role;
  return !role || RANK[role] >= RANK[required];
}

/** The sentence a disabled control shows. Names who can grant the role. */
export function roleReason(boot: Bootstrap | undefined, required: Role, what: string): string {
  return `${what} needs the ${required} role and you are ${boot?.role ?? "not an admin"} in this workspace. Ask a workspace admin to raise your role in Settings → Members.`;
}
