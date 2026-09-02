/**
 * Workspace settings. The autonomy dial is the one that matters: runAction
 * enforces it on every navigator-initiated execute, so this action is the
 * only place the level is written.
 */
import { z } from "zod";
import { defineAction, type ActionContext } from "@/lib/actions/core";
import { db, q, save } from "@/lib/db/store";
import { AutonomyLevel, type Workspace } from "@/lib/domain/types";

/**
 * The long form, for plan details and the result summary. The dial's short
 * form is `AUTONOMY_MEANING` in `@/lib/navigator/shared` — different audience,
 * different sentence, deliberately not shared.
 */
const AUTONOMY_PLAN_LINE: Record<z.infer<typeof AutonomyLevel>, string> = {
  observe: "Level 1 — Observe: the Navigator explains and suggests. It never plans or executes.",
  plan: "Level 2 — Plan: the Navigator writes plans you can read and run yourself. It never executes.",
  approve: "Level 3 — Approve: the Navigator executes each step only after you approve it.",
  bounded: "Level 4 — Bounded: the Navigator executes low-risk steps by itself; anything medium or high risk waits for you.",
  autonomous: "Level 5 — Autonomous: the Navigator executes its plan inside the environment, budget and risk limits you set.",
};

const autonomyOf = (): z.infer<typeof AutonomyLevel> => {
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
        AUTONOMY_PLAN_LINE[input.level],
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
      summary: `Navigator autonomy set to ${input.level}. ${AUTONOMY_PLAN_LINE[input.level]}`,
      data: { level: input.level },
    };
  },
});

/* ----------------------------- workspace.rename ---------------------------- */

const Rename = z.object({
  name: z
    .string()
    .trim()
    .min(2, "a workspace name needs at least 2 characters")
    .max(60, "keep the workspace name under 60 characters"),
});
type Rename = z.infer<typeof Rename>;

function workspaceOf(ctx: ActionContext): Workspace {
  const ws = q.workspace(ctx.workspaceId);
  if (!ws)
    throw new Error(
      `Workspace "${ctx.workspaceId}" was not found. Reload the page — the workspace may have been re-seeded.`
    );
  return ws;
}

defineAction<Rename>({
  id: "workspace.rename",
  title: "Rename workspace",
  category: "project",
  risk: "low",
  requiredRole: "admin",
  mutates: true,
  input: Rename,
  plan(ctx, input) {
    const ws = workspaceOf(ctx);
    const same = ws.name === input.name;
    return {
      summary: same
        ? `This workspace is already called “${input.name}”.`
        : `Rename the workspace “${ws.name}” to “${input.name}”.`,
      details: [
        `The URL slug stays “${ws.slug}”, so every link and bookmark keeps working.`,
        "The name is what the top bar shows; projects, environments and connections are untouched.",
        "Audit history is keyed to the workspace id, so nothing already written is rewritten.",
      ],
      costDeltaUsd: 0,
      risk: "low",
      warnings: same ? ["Nothing would change — the name is already this."] : [],
      requiresApproval: false,
    };
  },
  execute(ctx, input) {
    const ws = workspaceOf(ctx);
    const before = ws.name;
    if (before === input.name)
      return {
        ok: true,
        summary: `The workspace is already called “${input.name}”. Nothing changed.`,
        data: { workspaceId: ws.id, name: ws.name },
      };
    ws.name = input.name;
    save();
    return {
      ok: true,
      summary: `Workspace renamed from “${before}” to “${ws.name}”. The slug is still ${ws.slug}.`,
      data: { workspaceId: ws.id, name: ws.name, previousName: before },
    };
  },
});
