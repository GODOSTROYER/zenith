/**
 * Client-safe Navigator vocabulary.
 *
 * The planner and the executor pull in the action registry (and therefore the
 * store, and therefore `node:fs`), so anything the browser needs to know about
 * a run lives here instead.
 */
import type { AutonomyLevel } from "@/lib/domain/types";
import type { Risk } from "@/lib/actions/core";

/* ------------------------------ pseudo actions ----------------------------- */

/** Read-only analysis of the latest failure. Executed by the Navigator itself. */
export const INVESTIGATE = "_investigate";
/** A step whose subject could not be resolved. Never executable. */
export const BLOCKED = "_blocked";
/** A fragment of the goal the planner did not understand. Never executable. */
export const CLARIFY = "_clarify";

/** True for steps that can actually run (registered actions + investigate). */
export const isExecutable = (actionId: string): boolean =>
  actionId === INVESTIGATE || !actionId.startsWith("_");

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
