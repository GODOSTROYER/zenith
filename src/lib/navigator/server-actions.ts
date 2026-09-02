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
import { getSessionUser } from "@/lib/auth/session";
import { db } from "@/lib/db/store";
import type { Actor, AutonomyLevel, NavigatorRun } from "@/lib/domain/types";
import { ensureBoot } from "@/lib/server/boot";
import { ApiError, demoActor, ensureMember } from "@/lib/server/context";
import { plannerMode, plannerModel, type Parsing, type PlannerMode } from "./llm";
import { cancelRun, createRun, executeRun } from "./run";

export interface NavigatorReply {
  run?: NavigatorRun;
  /** how this goal was actually read — the UI labels the run from this */
  parsing?: Parsing;
  error?: string;
  fix?: string;
}

/**
 * The signed-in user, or the local demo user when auth is not configured.
 * Never a hardcoded id: role enforcement treats "local" as admin, so asserting
 * it would let a signed-in viewer move the autonomy dial.
 */
async function currentActor(): Promise<Actor> {
  const user = await getSessionUser();
  if (!user) return demoActor();
  const outcome = ensureMember(user);
  if ("denied" in outcome)
    throw new ApiError(outcome.denied.message, 403, { fix: outcome.denied.fix });
  return { type: "user", id: outcome.member.id, name: outcome.member.name };
}

/** A refusal already names its own fix; the caller's is only the fallback. */
const fail = (err: unknown, fix: string): NavigatorReply => ({
  error: err instanceof Error ? err.message : String(err),
  fix: (err instanceof ApiError && err.fix) || fix,
});

/** Plan a goal. Planning never executes anything, at any autonomy level. */
export async function createRunAction(projectId: string, goal: string): Promise<NavigatorReply> {
  await ensureBoot();
  try {
    await currentActor(); // a non-member cannot spend the workspace's planning budget
    return await createRun(projectId, goal);
  } catch (err) {
    return fail(err, "Check the goal and try again — planning changes nothing, so it is safe to retry.");
  }
}

/**
 * Execute the approved steps of a run, in order. The signed-in human is
 * resolved first: autonomy is the Navigator's ceiling, their role is the floor.
 */
export async function executeRunAction(
  runId: string,
  stepApprovals: string[]
): Promise<NavigatorReply> {
  await ensureBoot();
  try {
    const human = await currentActor();
    return { run: await executeRun(runId, { stepApprovals, human }) };
  } catch (err) {
    return fail(err, "Reload the Navigator tab to see the run's current state before retrying.");
  }
}

/** Stop a run. A step already in flight finishes; nothing after it starts. */
export async function cancelRunAction(runId: string): Promise<NavigatorReply> {
  await ensureBoot();
  try {
    await currentActor(); // membership check — cancelling is a workspace act
    return { run: cancelRun(runId) };
  } catch (err) {
    return fail(err, "Reload the Navigator tab to see the run's current state.");
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
        actor: await currentActor(),
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

export interface PlannerInfo {
  mode: PlannerMode;
  /** the model that would run — env keys never reach the browser, this does */
  model: string;
}

/** What the Navigator header may honestly claim about language parsing. */
export async function plannerInfoAction(): Promise<PlannerInfo> {
  return { mode: plannerMode(), model: plannerModel() };
}
