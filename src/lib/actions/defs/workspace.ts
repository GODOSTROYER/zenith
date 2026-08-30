/**
 * Workspace settings. The autonomy dial is the one that matters: runAction
 * enforces it on every navigator-initiated execute, so this action is the
 * only place the level is written.
 */
import { z } from "zod";
import { defineAction } from "@/lib/actions/core";
import { db, save } from "@/lib/db/store";
import { AutonomyLevel } from "@/lib/domain/types";

export const AUTONOMY_MEANING: Record<z.infer<typeof AutonomyLevel>, string> = {
  observe: "Level 1 — Observe: the Navigator explains and suggests. It never plans or executes.",
  plan: "Level 2 — Plan: the Navigator writes plans you can read and run yourself. It never executes.",
  approve: "Level 3 — Approve: the Navigator executes each step only after you approve it.",
  bounded: "Level 4 — Bounded: the Navigator executes low-risk steps by itself; anything medium or high risk waits for you.",
  autonomous: "Level 5 — Autonomous: the Navigator executes its plan inside the environment, budget and risk limits you set.",
};

export const autonomyOf = (): z.infer<typeof AutonomyLevel> => {
  const raw = db().settings.autonomy;
  const parsed = AutonomyLevel.safeParse(raw);
  return parsed.success ? parsed.data : "approve";
};

const SetAutonomy = z.object({ level: AutonomyLevel });
type SetAutonomy = z.infer<typeof SetAutonomy>;

defineAction<SetAutonomy>({
  id: "workspace.setAutonomy",
  title: "Set autonomy level",
  category: "navigator",
  risk: "medium",
  requiredRole: "admin",
  mutates: true,
  input: SetAutonomy,
  plan(_ctx, input) {
    const current = autonomyOf();
    const raising = AutonomyLevel.options.indexOf(input.level) > AutonomyLevel.options.indexOf(current);
    return {
      summary: current === input.level
        ? `Autonomy is already set to ${input.level}.`
        : `Change Navigator autonomy from ${current} to ${input.level}.`,
      details: [
        AUTONOMY_MEANING[input.level],
        "Every Navigator step is audited, whatever the level.",
        "Deployments still obey each environment's approval policy — autonomy never overrides it.",
      ],
      costDeltaUsd: 0,
      risk: raising ? "medium" : "low",
      warnings: raising && (input.level === "bounded" || input.level === "autonomous")
        ? [`At ${input.level}, the Navigator can change your system without asking first. Environment approval policies and budgets are the remaining guard rails — check them before raising this.`]
        : [],
      requiresApproval: false,
    };
  },
  execute(_ctx, input) {
    db().settings.autonomy = input.level;
    save();
    return {
      ok: true,
      summary: `Navigator autonomy set to ${input.level}. ${AUTONOMY_MEANING[input.level]}`,
      data: { level: input.level },
    };
  },
});
