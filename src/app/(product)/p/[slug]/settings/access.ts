/**
 * What each control on this screen is allowed to do, before it is pressed.
 *
 * Every mutation is still enforced server-side by `runAction`, and every plan
 * carries the same answer in `ActionPlan.blocked` — that is what disables the
 * confirm button inside the dialog. This map is the half that has to be true
 * one step earlier: the control that OPENS the dialog must already say no, so
 * a viewer never walks through a preview of something they cannot run.
 *
 * There is no route that serves the registry's `requiredRole` to the browser,
 * so this mirrors src/lib/actions/defs/*. Keep them in step.
 */
import type { Role } from "@/lib/actions/core";

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

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
};

/**
 * Why this control is not the caller's to use, or undefined when it is.
 * `undefined` role = bootstrap has not answered yet; `null` = signed out.
 */
export function gate(role: Role | null | undefined, actionId: string): string | undefined {
  const needed = NEEDS[actionId] ?? "admin";
  if (role === undefined) return "Still loading your role in this workspace.";
  if (role === null) return "Sign in to change anything in this workspace.";
  if (RANK[role] >= RANK[needed]) return undefined;
  return `This needs the ${needed} role and you are ${role} in this workspace. A workspace admin can raise your role under Members on this page.`;
}
