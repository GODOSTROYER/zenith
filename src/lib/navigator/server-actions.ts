"use server";
/**
 * The Navigator's write path. The GET routes under /api/navigator are read-only
 * (workstream D), so creating and running a plan happens here as server actions
 * — same process, same store, same audit log.
 *
 * Errors come back as data (`{ error, fix }`) so the UI can always name the fix
 * instead of exploding.
 */
import { runAction } from "@/lib/actions/core";
import { db } from "@/lib/db/store";
import type { AutonomyLevel, NavigatorRun } from "@/lib/domain/types";
import { ensureBoot } from "@/lib/server/boot";
import { createRun, executeRun } from "./run";

export interface NavigatorReply {
  run?: NavigatorRun;
  error?: string;
  fix?: string;
}

const fail = (err: unknown, fix: string): NavigatorReply => ({
  error: err instanceof Error ? err.message : String(err),
  fix,
});

/** Plan a goal. Planning never executes anything, at any autonomy level. */
export async function createRunAction(projectId: string, goal: string): Promise<NavigatorReply> {
  await ensureBoot();
  try {
    return { run: createRun(projectId, goal) };
  } catch (err) {
    return fail(err, "Check the goal and try again — planning changes nothing, so it is safe to retry.");
  }
}

/** Execute the approved steps of a run, in order. */
export async function executeRunAction(
  runId: string,
  stepApprovals: string[]
): Promise<NavigatorReply> {
  await ensureBoot();
  try {
    return { run: await executeRun(runId, { stepApprovals }) };
  } catch (err) {
    return fail(err, "Reload the Navigator tab to see the run's current state before retrying.");
  }
}

export interface AutonomyReply {
  level?: AutonomyLevel;
  summary?: string;
  error?: string;
  fix?: string;
}

/** Move the autonomy dial through the same audited action the API uses. */
export async function setAutonomyAction(level: AutonomyLevel): Promise<AutonomyReply> {
  await ensureBoot();
  try {
    const { result } = await runAction(
      "workspace.setAutonomy",
      {
        workspaceId: db().workspaces[0]?.id ?? "",
        actor: { type: "user", id: "local", name: "You" },
      },
      { level },
      { mode: "execute" }
    );
    if (!result?.ok)
      return {
        error: result?.summary ?? "The autonomy level did not change.",
        fix: result?.error ?? "Try again, or set it from Settings.",
      };
    return { level, summary: result.summary };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      fix: "Reload the page and try again.",
    };
  }
}
