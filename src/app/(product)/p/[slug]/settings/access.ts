/**
 * What each control on this screen is allowed to do, before it is pressed.
 *
 * Every mutation is still enforced server-side by `runAction`, and every plan
 * carries the same answer in `ActionPlan.blocked` — that is what disables the
 * confirm button inside the dialog. This map is the half that has to be true
 * one step earlier: the control that OPENS the dialog must already say no, so
 * a viewer never walks through a preview of something they cannot run.
 *
 * The required role now comes from the registry itself: the (product) layout is
 * a server component, so it reads `listActions()` and hands the slim catalog to
 * the shell context. `useGate()` reads it from there, which is the same answer
 * `runAction` enforces and cannot drift from it.
 */
import type { Role } from "@/lib/actions/core";
import { requiredRoleOf, useShell } from "@/components/shell/shell-context";

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

/**
 * Fallback only, for the moment before the catalog arrives (or an id that is
 * not in it). It mirrors src/lib/actions/defs/*; the registry is the authority
 * and `useGate()` prefers it, so this only has to be roughly right, never
 * exactly in step.
 */
export const NEEDS: Record<string, Role> = {
  "workspace.rename": "admin",
  "env.create": "editor",
  "env.clone": "editor",
  "env.update": "admin",
  "env.delete": "admin",
  "env.setBudget": "admin",
  "env.setConnection": "admin",
  "env.updatePolicies": "admin",
  "connection.check": "editor",
  "connection.create": "admin",
  "connection.disconnect": "admin",
  "project.delete": "admin",
  "system.rotateSecret": "editor",
};

/**
 * Why this control is not the caller's to use, or undefined when it is.
 * `undefined` role = bootstrap has not answered yet; `null` = signed out.
 */
export function gate(
  role: Role | null | undefined,
  actionId: string,
  needed: Role = NEEDS[actionId] ?? "admin"
): string | undefined {
  if (role === undefined) return "Still loading your role in this workspace.";
  if (role === null) return "Sign in to change anything in this workspace.";
  if (RANK[role] >= RANK[needed]) return undefined;
  return `This needs the ${needed} role and you are ${role} in this workspace. A workspace admin can raise your role under Members on this page.`;
}

/** `gate`, bound to the action registry the layout handed the shell. */
export function useGate(): (role: Role | null | undefined, actionId: string) => string | undefined {
  const { catalog } = useShell();
  return (role, actionId) =>
    gate(role, actionId, requiredRoleOf(catalog, actionId, NEEDS[actionId] ?? "admin"));
}
