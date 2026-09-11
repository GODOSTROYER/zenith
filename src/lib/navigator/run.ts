/**
 * Navigator runs: persistence + the sequential executor.
 *
 * The executor has no privileges of its own. Every step goes through
 * `runAction` as the navigator actor, so workspace autonomy, environment
 * approval policy and the audit log all apply exactly as they do to a click
 * in the UI. If a step is denied, the run says which rule denied it.
 */
import {
  actionRegistry,
  roleOf,
  runAction,
  type ActionContext,
  type ActionResult,
  type Role,
} from "@/lib/actions/core";
import { registerAllActions } from "@/lib/actions/defs";
import { monthlyCostUsd } from "@/lib/cost/pricing";
import { db, q, save } from "@/lib/db/store";
import { env } from "@/lib/env";
import { fmtUsd } from "@/lib/format";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import {
  AutonomyLevel,
  id,
  type Actor,
  type Deployment,
  type NavigatorRun,
  type NavigatorStep,
} from "@/lib/domain/types";
import { normalizeGoal, type Parsing } from "./llm";
import { parseGoal } from "./planner";
import { isExecutable, planBlock } from "./shared";
import { verifyRun } from "./verification";

const NAVIGATOR: Actor = { type: "navigator", id: "navigator", name: "Navigator" };

/** A goal is a sentence, not a payload: it reaches the model and the store. */
const GOAL_MAX = 2000;
/** Runs kept per project. The store re-stringifies the whole DB on every save. */
const RUNS_PER_PROJECT = 200;

const autonomy = (): AutonomyLevel => {
  const parsed = AutonomyLevel.safeParse(db().settings.autonomy);
  return parsed.success ? parsed.data : "approve";
};

export const findRun = (runId: string): NavigatorRun | undefined =>
  db().navigatorRuns.find((r) => r.id === runId);

/* --------------------------------- create --------------------------------- */

/** Plan a goal and persist it. Nothing executes here — planning is free. */
export async function createRun(
  projectId: string,
  goal: string,
  /** Server actions recheck access after the model yields, before persistence. */
  authorize?: () => void
): Promise<{ run: NavigatorRun; parsing: Parsing }> {
  registerAllActions();
  // Observe is the one notch whose promise is about planning, not executing:
  // "never plans". Enforce it here, where the plan would be persisted, rather
  // than only dimming the button.
  const blocked = planBlock(autonomy());
  if (blocked) throw new Error(blocked);
  const project = db().projects.find((candidate) => candidate.id === projectId);
  if (!project)
    throw new Error(
      `Project "${projectId}" does not exist. Pick one from the workspace overview.`
    );
  const trimmed = goal.trim();
  if (!trimmed)
    throw new Error("Tell the Navigator what you want first — the goal was empty.");
  if (trimmed.length > GOAL_MAX)
    throw new Error(
      `That goal is ${trimmed.length} characters and the limit is ${GOAL_MAX}. Shorten it to the outcome you want, and split anything left over into a second run.`
    );

  const environments = q.environmentsOf(project.id);
  const findings = db().findings.filter((f) => f.projectId === project.id);
  // With an ANTHROPIC_API_KEY configured, a language model translates the
  // freeform goal into the canonical grammar. The typed planner below remains
  // the only planning authority either way.
  authorize?.();
  const { text, ...parsing } = await normalizeGoal(trimmed, project, environments);
  authorize?.();
  const steps = parseGoal(text, project, environments, findings);

  const run: NavigatorRun = {
    id: id(),
    projectId: project.id,
    goal: trimmed,
    status: "awaiting_approval",
    steps,
    createdAt: new Date().toISOString(),
  };
  db().navigatorRuns.push(run);
  prune(project.id);
  save();
  return { run, parsing };
}

/** Keep the newest RUNS_PER_PROJECT runs of a project; drop the rest. */
function prune(projectId: string): void {
  const all = db().navigatorRuns;
  const mine = all.filter((r) => r.projectId === projectId);
  if (mine.length <= RUNS_PER_PROJECT) return;
  const keep = new Set(
    [...mine]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, RUNS_PER_PROJECT)
      .map((r) => r.id)
  );
  for (let i = all.length - 1; i >= 0; i--)
    if (all[i].projectId === projectId && !keep.has(all[i].id)) all.splice(i, 1);
}

/* ---------------------------- deployment awaiting --------------------------- */

const TERMINAL = new Set(["succeeded", "failed", "rolled_back", "cancelled"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Follow a deployment the run started until it settles (or needs a human). */
async function awaitDeployment(deploymentId: string): Promise<Deployment | undefined> {
  const budgetMs = env().ZENITH_FAST ? 15_000 : 60_000;
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const d = q.deployment(deploymentId);
    if (!d) return undefined;
    if (TERMINAL.has(d.status) || d.status === "awaiting_approval") return d;
    if (Date.now() > deadline) return d;
    await sleep(250);
  }
}

function deploymentOutcome(d: Deployment): { ok: boolean; summary: string } {
  const urls = d.outputs.filter((o) => o.kind === "url").map((o) => o.label);
  switch (d.status) {
    case "succeeded":
      return {
        ok: true,
        summary: `Deployment succeeded — ${d.changeSummary}.${urls.length ? ` Live: ${urls.join(", ")}.` : ""}`,
      };
    case "awaiting_approval":
      return {
        ok: true,
        summary:
          "The deployment is waiting for a human to approve it, which is this environment's policy. Approve it on the Deploys page and it will apply.",
      };
    case "failed":
      return {
        ok: false,
        summary: `Deployment failed: ${d.error ?? d.steps.find((s) => s.status === "failed")?.error ?? "no provider detail was recorded"}. Open Deploys for the full step log, then fix the cause and deploy again.`,
      };
    case "cancelled":
      return { ok: false, summary: "The deployment was cancelled before it finished." };
    default:
      return {
        ok: true,
        summary: `Deployment is still ${d.status} — it is running longer than this run waited. Follow it on the Deploys page.`,
      };
  }
}

/* -------------------------------- executor -------------------------------- */

export interface ExecuteOptions {
  /** ids of the steps the human explicitly approved */
  stepApprovals?: string[];
  /**
   * The signed-in human who pressed Run. Autonomy is the Navigator's ceiling;
   * this person's workspace role is the floor.
   */
  human?: Actor;
}

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

/**
 * Every step runs as the Navigator actor, so `runAction`'s own role check
 * never sees a human — without this a viewer could execute `deploy.apply`
 * through the agent that they cannot execute from the System Map.
 */
function roleBlock(steps: NavigatorStep[], human: Actor, workspaceId: string): string | undefined {
  if (human.type !== "user") return undefined;
  const demo = human.id === "local" && !isSupabaseConfigured();
  if (!demo && !db().members.some((member) => member.workspaceId === workspaceId && member.id === human.id))
    return `You are no longer a member of this workspace. Ask a workspace admin to invite you from Settings → Members before running the Navigator again.`;
  // The run belongs to a project, and the project owns the workspace answer.
  const role = roleOf(human, workspaceId);
  const registry = actionRegistry();
  for (const step of steps) {
    const action = registry.get(step.actionId);
    if (action && RANK[role] < RANK[action.requiredRole])
      return `Step ${step.seq} — ${step.title} — needs the ${action.requiredRole} role and you are ${role} in this workspace. The Navigator runs with your permissions, not its own. Ask a workspace admin to give ${human.name} the ${action.requiredRole} role in Settings → Members, or leave that step unapproved and run the rest.`;
  }
  return undefined;
}

/**
 * Stop a run before its next step. The executor checks between steps, so a
 * step already in flight finishes and is recorded honestly.
 */
export function cancelRun(runId: string): NavigatorRun {
  const run = findRun(runId);
  if (!run)
    throw new Error(
      `Navigator run "${runId}" was not found. Open the project's Navigator tab to see the runs that exist.`
    );
  if (run.status !== "executing" && run.status !== "awaiting_approval")
    throw new Error(
      `This run is already ${run.status}, so there is nothing to cancel. Start a new run from the Navigator tab.`
    );
  const executing = run.status === "executing";
  run.status = "cancelled";
  // While it is executing the executor owns the tail (summary, endedAt, and
  // skipping what never ran) — it sees this status before its next step.
  if (!executing) {
    for (const s of run.steps) if (s.status === "proposed") s.status = "skipped";
    run.summary = [run.summary, "Cancelled before any of the remaining steps ran."]
      .filter(Boolean)
      .join(" ");
    run.endedAt = new Date().toISOString();
  }
  save();
  return run;
}

/**
 * Runs approved steps in order, stopping at the first failure. Steps that
 * still need approval are left `proposed` and the run pauses instead of
 * silently skipping them.
 */
export async function executeRun(
  runId: string,
  { stepApprovals = [], human }: ExecuteOptions = {}
): Promise<NavigatorRun> {
  registerAllActions();
  const run = findRun(runId);
  if (!run)
    throw new Error(`Navigator run "${runId}" was not found. Start a new one from the Navigator tab.`);
  if (run.status === "executing")
    throw new Error("This run is already executing. Wait for it to finish before running it again.");
  if (run.status === "cancelled")
    throw new Error(
      "This run was cancelled, so it cannot be resumed. Start a new run from the Navigator tab to pick the goal back up."
    );

  const project = db().projects.find((candidate) => candidate.id === run.projectId);
  if (!project)
    throw new Error(`Project "${run.projectId}" no longer exists, so this run cannot be executed.`);

  const approved = new Set(stepApprovals);
  /** Re-read: `cancelRun` writes the status from another request mid-loop. */
  const cancelRequested = (): boolean => findRun(runId)?.status === "cancelled";

  // The human's role is checked before anything moves, so a refused run
  // changes nothing at all — not even its own status.
  if (human) {
    const blocked = roleBlock(
      run.steps.filter(
        (s) =>
          isExecutable(s.actionId) &&
          s.status !== "done" &&
          (!s.needsApproval || approved.has(s.id))
      ),
      human,
      project.workspaceId
    );
    if (blocked) throw new Error(blocked);
  }

  const level = autonomy();
  const ctx: ActionContext = {
    // The project the run belongs to owns the answer: the Navigator acts in the
    // workspace the human was in when they planned it, not the first one here.
    workspaceId: project.workspaceId,
    projectId: project.id,
    actor: NAVIGATOR,
    autonomy: level,
  };

  const costBefore = monthlyCostUsd(project.workingManifest);
  const done: string[] = [];
  let pending = 0;
  let deployed = false;
  let failure: NavigatorStep | undefined;

  run.status = "executing";
  run.verification = undefined;
  run.verificationNote = undefined;
  run.verificationPending = false;
  save();

  for (const step of run.steps) {
    // Cancellation is co-operative: another request writes the status onto
    // this same record, and we stop here rather than at the next await.
    if (cancelRequested()) break;
    if (!isExecutable(step.actionId)) {
      step.status = "skipped";
      continue;
    }
    if (step.status === "done") continue;
    if (step.needsApproval && !approved.has(step.id)) {
      step.status = "proposed";
      pending += 1;
      continue;
    }

    // A previous step may have awaited a provider while an admin removed or
    // demoted the human. Read membership again; never bootstrap it here.
    const blocked = human && roleBlock([step], human, project.workspaceId);
    if (blocked) {
      step.status = "failed";
      step.error = blocked;
      step.resultSummary = "Permission changed before this step could start.";
      failure = step;
      save();
      break;
    }

    step.status = "running";
    step.error = undefined;
    save();

    let result: ActionResult;
    try {
      const out = await runAction(step.actionId, ctx, step.input, {
        mode: "execute",
        idempotencyKey: `${run.id}:${step.seq}`,
      });
      result = out.result ?? { ok: false, summary: "The action returned nothing.", error: "empty_result" };

      // deploy.apply hands off to the engine — follow it to a real outcome.
      const data = result.data as { deploymentId?: string } | undefined;
      if (result.ok && step.actionId === "deploy.apply" && data?.deploymentId) {
        step.deploymentId = data.deploymentId;
        const deployment = await awaitDeployment(data.deploymentId);
        if (deployment) {
          const outcome = deploymentOutcome(deployment);
          result = {
            ok: outcome.ok,
            summary: outcome.summary,
            data: { ...(result.data as object), status: deployment.status },
            error: outcome.ok ? undefined : outcome.summary,
          };
        }
      }
    } catch (err) {
      result = {
        ok: false,
        summary: `${step.title} failed.`,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (result.ok) {
      step.status = "done";
      step.resultSummary = result.summary;
      // manifest edits all end with the same nudge; the run says it once, at the end
      done.push(result.summary.replace(/\s*Deploy to apply it\.\s*$/, ""));
      if (step.actionId === "deploy.apply") deployed = true;
    } else {
      step.status = "failed";
      step.resultSummary = result.summary;
      step.error =
        result.error === "autonomy_denied"
          ? `${result.summary} Raise the autonomy dial, or run this step yourself from the System Map.`
          : (result.error ?? result.summary);
      failure = step;
      save();
      break;
    }
    save();
  }

  if (!cancelRequested() && !failure && pending === 0 && run.steps.every((step) => step.status === "done")) {
    run.verificationPending = true;
    save();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const checked = await Promise.race([
        verifyRun(run),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Provider checks timed out. The completed steps remain recorded; verification is unavailable.")), 12_000);
        }),
      ]);
      if (!cancelRequested()) {
        run.verification = checked.verification;
        run.verificationNote = checked.note;
      }
    } catch (error) {
      if (!cancelRequested()) run.verificationNote = error instanceof Error ? error.message : "Provider verification is unavailable.";
    } finally {
      clearTimeout(timeout);
      run.verificationPending = false;
    }
  }
  const cancelled = cancelRequested();

  // Anything after a failure (or a cancel) never ran; say so rather than
  // leaving it "proposed".
  if (failure)
    for (const s of run.steps)
      if (s.seq > failure.seq && s.status === "proposed") s.status = "skipped";
  if (cancelled) for (const s of run.steps) if (s.status === "proposed") s.status = "skipped";

  const costAfter = monthlyCostUsd(db().projects.find((candidate) => candidate.id === run.projectId)!.workingManifest);
  run.summary = summarize(run, { done, pending, failure, deployed, costBefore, costAfter });
  if (cancelled)
    run.summary = `${run.summary} You cancelled the run — the steps that had not started were skipped.`;
  run.status = cancelled ? "cancelled" : failure ? "failed" : pending > 0 ? "awaiting_approval" : "done";
  if (run.status !== "awaiting_approval") run.endedAt = new Date().toISOString();
  save();
  return run;
}

function summarize(
  run: NavigatorRun,
  x: {
    done: string[];
    pending: number;
    failure?: NavigatorStep;
    deployed: boolean;
    costBefore: number;
    costAfter: number;
  }
): string {
  const parts: string[] = [];
  const delta = x.costAfter - x.costBefore;

  if (x.failure) {
    parts.push(
      `Stopped at step ${x.failure.seq} — ${x.failure.title}. ${x.failure.error ?? "No detail was recorded."}`
    );
    parts.push(
      x.done.length
        ? `${x.done.length} earlier step(s) did complete and are still applied; nothing was rolled back automatically.`
        : "Nothing was changed."
    );
  } else if (x.done.length === 0) {
    parts.push(
      x.pending > 0
        ? `Nothing ran: ${x.pending} step(s) are still waiting for your approval.`
        : "Nothing to run — this plan has no executable steps."
    );
  } else {
    if (x.done.length > 1) parts.push(`Completed ${x.done.length} steps for "${run.goal}".`);
    parts.push(...x.done);
    if (x.pending > 0) parts.push(`${x.pending} step(s) are still waiting for your approval.`);
    if (!x.deployed && run.steps.some((s) => s.actionId.startsWith("system.") && s.status === "done"))
      parts.push("These edits are in the working copy — deploy to apply them to an environment.");
  }

  if (Math.abs(delta) >= 0.005)
    parts.push(
      `Estimated monthly cost of the working system: ${fmtUsd(x.costBefore)} → ${fmtUsd(x.costAfter)} (${fmtUsd(delta, { sign: true })}/mo).`
    );

  return parts.join(" ");
}
