/**
 * Client-safe Navigator vocabulary.
 *
 * The planner and the executor pull in the action registry (and therefore the
 * store, and therefore `node:fs`), so anything the browser needs to know about
 * a run lives here instead.
 */
import type { AutonomyLevel, Member, NavigatorStep } from "@/lib/domain/types";
import type { Risk } from "@/lib/actions/core";
import { roleReaches } from "@/lib/domain/roles";

/* ------------------------------ pseudo actions ----------------------------- */

/**
 * Read-only analysis of the latest failure. A registered action like any
 * other — the planner names it here so the approval rules can recognise it.
 */
export const INVESTIGATE = "ops.investigate";
/** A step whose subject could not be resolved. Never executable. */
export const BLOCKED = "_blocked";
/** A fragment of the goal the planner did not understand. Never executable. */
export const CLARIFY = "_clarify";

/** True for steps that call a registered action; the `_` ids never can. */
export const isExecutable = (actionId: string): boolean => !actionId.startsWith("_");

/* ------------------------------- autonomy dial ----------------------------- */

export const AUTONOMY_LEVELS: AutonomyLevel[] = [
  "observe",
  "plan",
  "approve",
  "bounded",
  "autonomous",
];

/** One honest line per notch. These match core.ts enforcement exactly. */
export const AUTONOMY_MEANING: Record<AutonomyLevel, string> = {
  observe: "Explains and suggests. Never plans, never executes.",
  plan: "Prepares plans you can read and run yourself. Never executes.",
  approve: "Executes each step, but only after you approve it.",
  bounded: "Executes low-risk steps automatically, asks for the rest.",
  autonomous: "Executes its whole plan inside your policies and budgets.",
};

/**
 * Why a step cannot run at the current autonomy level — the exact rule
 * `runAction` will apply, said out loud before the user clicks anything.
 * Returns undefined when the step is permitted.
 */
export function autonomyBlock(level: AutonomyLevel, risk: Risk): string | undefined {
  if (level === "observe")
    return "Autonomy is set to observe — the Navigator explains and suggests, and never executes. Raise it to approve to run this.";
  if (level === "plan")
    return "Autonomy is set to plan — the Navigator prepares but never executes. Raise it to approve to run this.";
  if (level === "bounded" && risk !== "low")
    return `Bounded autonomy executes low-risk steps only, and this one is ${risk} risk. Raise autonomy to autonomous, or make the change yourself from the System Map.`;
  return undefined;
}

/** Nothing at all can run at these levels. */
export const canExecuteAtAll = (level: AutonomyLevel): boolean =>
  level !== "observe" && level !== "plan";

/**
 * Why the Navigator may not turn a goal into a plan. Observe is the one notch
 * whose promise is about planning rather than executing — "never plans" — so
 * `createRun` refuses there and the command bar says this before you type.
 */
export function planBlock(level: AutonomyLevel): string | undefined {
  return level === "observe"
    ? "Autonomy is set to observe — the Navigator explains and suggests, and never plans. Raise the dial to plan and it will turn goals into steps you can read (it still executes nothing at that level)."
    : undefined;
}

/* --------------------------------- roles ---------------------------------- */

export type WorkspaceRole = Member["role"];

export const hasRole = (role: WorkspaceRole, needed: WorkspaceRole): boolean =>
  roleReaches(role, needed);

/**
 * Why this person's workspace role forbids running this plan — the same rule
 * `executeRun` applies against the registry, said before the click instead of
 * after it. `requiredRole` is recorded on the step at plan time; a step
 * without one is left to the server, which is the authority either way.
 */
export function roleBlock(
  steps: NavigatorStep[],
  role: WorkspaceRole | null | undefined
): string | undefined {
  if (!role) return undefined;
  for (const step of steps) {
    if (!step.requiredRole || hasRole(role, step.requiredRole)) continue;
    return `Step ${step.seq} — ${step.title} — needs the ${step.requiredRole} role and you are ${role} in this workspace. The Navigator runs with your permissions, not its own: ask an admin for the ${step.requiredRole} role, or leave that step unapproved and run the rest.`;
  }
  return undefined;
}
