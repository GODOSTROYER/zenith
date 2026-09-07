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
import { ApiError, currentWorkspace, demoActor, ensureMember } from "@/lib/server/context";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { plannerMode, plannerModel, type PlannerMode } from "./config";
import type { Parsing } from "./llm";

// Reading a Navigator page must not eagerly compile its execution runtime.
// Every mutation still awaits the same process boot before doing any work.
async function ensureBoot() {
  const runtime = await import("@/lib/server/boot");
  await runtime.ensureBoot();
}

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
async function currentScope(): Promise<{ workspaceId: string; actor: Actor }> {
  const user = await getSessionUser();
  if (!user && isSupabaseConfigured())
    throw new ApiError("Sign in to use the Navigator.", 401, { fix: "Open /login, then retry." });
  // Resolve the selection independently of the project/run supplied by the
  // browser. Even a member of two workspaces acts only in the selected one.
  const workspace = await currentWorkspace();
  if (!workspace)
    throw new ApiError("You are not in a workspace.", 403, {
      fix: "Pick a workspace from the workspace menu, or create one at /onboarding.",
    });
  if (!user) return { workspaceId: workspace.id, actor: demoActor() };
  // Preserve normalization of an invited email's member id in the selected
  // workspace. Never use a caller-supplied project's workspace as this target.
  const outcome = ensureMember(user, workspace);
  if ("denied" in outcome)
    throw new ApiError(outcome.denied.message, 403, { fix: outcome.denied.fix });
  return { workspaceId: workspace.id, actor: { type: "user", id: outcome.member.id, name: outcome.member.name } };
}

type NavigatorScope = Awaited<ReturnType<typeof currentScope>>;

function requireProjectAccess(scope: NavigatorScope, projectId: string): void {
  const demo = scope.actor.id === "local" && !isSupabaseConfigured();
  const member = demo || db().members.some((m) => m.workspaceId === scope.workspaceId && m.id === scope.actor.id);
  const project = db().projects.some((p) => p.id === projectId && p.workspaceId === scope.workspaceId);
  if (!member || !project)
    throw new ApiError("Project was not found in the selected workspace.", 404, {
      fix: "Pick a project from the selected workspace overview, then retry.",
    });
}

function requireRunAccess(scope: NavigatorScope, runId: string): void {
  const run = db().navigatorRuns.find((candidate) => candidate.id === runId);
  if (run) {
    try {
      requireProjectAccess(scope, run.projectId);
      return;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
  }
  // Do not disclose a foreign run's status, goal, or owning project.
  throw new ApiError("Navigator run was not found in the selected workspace.", 404, {
    fix: "Open a project in the selected workspace and choose a run from its Navigator tab.",
  });
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
    const { createRun } = await import("./run");
    const scope = await currentScope();
    const authorize = () => requireProjectAccess(scope, projectId);
    authorize();
    return await createRun(projectId, goal, authorize);
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
    const { executeRun } = await import("./run");
    const scope = await currentScope();
    requireRunAccess(scope, runId);
    const run = await executeRun(runId, { stepApprovals, human: scope.actor });
    requireRunAccess(scope, runId); // a revoked caller cannot receive the completed run
    return { run };
  } catch (err) {
    return fail(err, "Reload the Navigator tab to see the run's current state before retrying.");
  }
}

/** Stop a run. A step already in flight finishes; nothing after it starts. */
export async function cancelRunAction(runId: string): Promise<NavigatorReply> {
  await ensureBoot();
  try {
    const { cancelRun } = await import("./run");
    const scope = await currentScope();
    requireRunAccess(scope, runId);
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
    // Same resolution the API layer uses — the dial belongs to the workspace
    // the person is actually looking at, not to whichever one sorted first.
    const scope = await currentScope();
    const { result } = await runAction(
      "workspace.setAutonomy",
      scope,
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
