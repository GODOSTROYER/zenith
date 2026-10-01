/**
 * The scenario runner: turns a `ScenarioDefinition` into a dry run or a real run.
 *
 * DRY RUN (`describeScenario`): prints the exact planned actions of every step,
 * evaluates the prerequisites that need no network (environment variables,
 * files, tools) and, only when asked, the ones that need the Zenith control
 * plane. It never evaluates a `cloud` prerequisite and never calls `run`. Every
 * pass criterion is recorded as skipped ("dry run"), so the evidence of a dry
 * run cannot be mistaken for a result.
 *
 * REAL RUN (`runScenario`): checks the dependencies and prerequisites, then runs
 * the steps in order, each timed and recorded. Before a step that changes
 * something the runner asks the live session whether that is allowed (billable
 * confirmation, and for scenarios that create resources an accepted cost
 * estimate). A failing step stops the scenario; later steps are recorded as
 * skipped. Finally every pass criterion nobody recorded is recorded as SKIPPED:
 * a criterion is passed only when a step said so, never by the absence of a
 * failure.
 */
import type { LiveConfig } from "./config";
import type { EvidenceRecorder } from "./evidence";
import type { ControlPlaneClient } from "./clients/control-plane";
import { LiveSafetyError } from "./safety";
import type { PlanContext, PrerequisiteContext, PrerequisiteKind, ScenarioContext, ScenarioDefinition, ScenarioId } from "./types";

export interface PrerequisiteReport {
  id: string;
  description: string;
  kind: PrerequisiteKind;
  /** `not_checked` when the dry run may not evaluate it */
  status: "ok" | "failed" | "not_checked";
  detail?: string;
}

export interface DryRunReport {
  id: ScenarioId;
  title: string;
  prerequisites: PrerequisiteReport[];
  steps: { id: string; title: string; effect: string; actions: string[] }[];
  /** the dependencies that must run first, and whether they are in this run */
  dependencies: { id: ScenarioId; inRun: boolean }[];
  blockedOn: readonly string[];
  /** true when every prerequisite that could be checked passed and nothing blocks the run */
  ready: boolean;
  text: string;
}

export interface DryRunInput {
  plan: PlanContext;
  env: Readonly<Record<string, string | undefined>>;
  config: LiveConfig;
  /** scenarios of this run that come before `def` */
  earlier: readonly ScenarioId[];
  /** scenarios in this run, in order (to show dependency coverage) */
  inRun: readonly ScenarioId[];
  controlPlane?: ControlPlaneClient;
  /** evaluate `control-plane` prerequisites (they call the Zenith API, never a cloud) */
  checkControlPlane?: boolean;
}

const EFFECT_TEXT: Record<string, string> = { none: "local", read: "reads", mutate: "CHANGES STATE" };

async function evaluate(def: ScenarioDefinition, pctx: PrerequisiteContext, allowed: (kind: PrerequisiteKind) => boolean): Promise<PrerequisiteReport[]> {
  const out: PrerequisiteReport[] = [];
  for (const p of def.prerequisites) {
    const base = { id: p.id, description: p.description, kind: p.kind };
    if (!allowed(p.kind)) {
      out.push({ ...base, status: "not_checked", detail: p.kind === "cloud" ? "needs a cloud call; not made in a dry run" : "needs the control plane; pass --check-control-plane to evaluate it" });
      continue;
    }
    try {
      const r = await p.check(pctx);
      out.push({ ...base, status: r.ok ? "ok" : "failed", ...(r.detail ? { detail: r.detail } : {}) });
    } catch (err) {
      out.push({ ...base, status: "failed", detail: `the check itself failed (${err instanceof Error ? err.name : "error"})` });
    }
  }
  return out;
}

export async function describeScenario(def: ScenarioDefinition, input: DryRunInput, evidence?: EvidenceRecorder): Promise<DryRunReport> {
  const prerequisites = await evaluate(def, { config: input.config, env: input.env, earlier: input.earlier, controlPlane: input.controlPlane }, (kind) => kind === "offline" || (kind === "control-plane" && input.checkControlPlane === true));
  const steps = def.steps.map((s) => ({ id: s.id, title: s.title, effect: s.effect, actions: s.plan(input.plan) }));
  const dependencies = def.dependsOn.map((id) => ({ id, inRun: input.inRun.includes(id) && input.inRun.indexOf(id) < input.inRun.indexOf(def.id) }));
  const missingDeps = dependencies.filter((d) => !d.inRun);
  const failedPre = prerequisites.filter((p) => p.status === "failed");
  const ready = failedPre.length === 0 && missingDeps.length === 0 && def.blockedOn.length === 0;

  const lines: string[] = [`Scenario ${def.id}: ${def.title}`, `  ${def.summary}`, `  Needs: cloud=${def.needs.cloud}, control plane=${def.needs.controlPlane ? "yes" : "no"}, Temporal=${def.needs.temporal ? "yes" : "no"}. ${def.mutates ? "Changes state: needs --confirm-billable." : "Changes nothing."} ${def.runsLocally ? "Runs locally." : ""}`.trimEnd(), `  Cost: ${def.costNote}`];
  if (dependencies.length > 0) lines.push(`  Runs after: ${dependencies.map((d) => `${d.id}${d.inRun ? "" : " (NOT in this run)"}`).join(", ")}`);
  lines.push("  Prerequisites:");
  for (const p of prerequisites) lines.push(`    [${p.status === "ok" ? "ok" : p.status === "failed" ? "FAIL" : "not checked"}] ${p.description}${p.detail ? ` (${p.detail})` : ""}`);
  lines.push("  Planned actions:");
  steps.forEach((s, i) => {
    lines.push(`    ${i + 1}. ${s.title} [${EFFECT_TEXT[s.effect] ?? s.effect}]`);
    for (const a of s.actions) lines.push(`         - ${a}`);
  });
  lines.push("  Passes when:");
  for (const c of def.passCriteria) lines.push(`    - ${c.id}: ${c.text}`);
  lines.push("  Cannot prove:");
  for (const c of def.cannotProve) lines.push(`    - ${c}`);
  if (def.blockedOn.length > 0) {
    lines.push("  Blocked on (cannot run for real yet):");
    for (const b of def.blockedOn) lines.push(`    - ${b}`);
  }
  lines.push(`  Ready to run: ${ready ? "yes" : "NO"}`);

  if (evidence) for (const c of def.passCriteria) evidence.skip(def.id, c.id, c.text, "dry run: nothing was executed");
  return { id: def.id, title: def.title, prerequisites, steps, dependencies, blockedOn: def.blockedOn, ready, text: lines.join("\n") };
}

/* -------------------------------- real run -------------------------------- */

export interface ScenarioOutcome {
  id: ScenarioId;
  status: "completed" | "failed" | "blocked";
  /** why it is blocked or which step failed */
  reason?: string;
}

function skipAll(def: ScenarioDefinition, ctx: ScenarioContext, reason: string, fromStep = 0): void {
  def.steps.slice(fromStep).forEach((s) => ctx.evidence.skipStep(def.id, s.id, s.title, reason));
  for (const c of def.passCriteria) if (!ctx.evidence.hasCheck(def.id, c.id)) ctx.evidence.skip(def.id, c.id, c.text, reason);
}

export async function runScenario(def: ScenarioDefinition, ctx: ScenarioContext, env: Readonly<Record<string, string | undefined>>, earlier: readonly ScenarioId[]): Promise<ScenarioOutcome> {
  // Dependencies: each must have completed earlier in this run.
  for (const dep of def.dependsOn) {
    if (!earlier.includes(dep) || ctx.state.get(`completed:${dep}`) !== true) {
      const reason = `Scenario ${dep} must complete first in the same run; it ${earlier.includes(dep) ? "did not complete" : "is not part of this run"}.`;
      skipAll(def, ctx, reason);
      return { id: def.id, status: "blocked", reason };
    }
  }
  const pre = await evaluate(def, { config: ctx.config, env, earlier, controlPlane: ctx.controlPlane }, () => true);
  const failedPre = pre.find((p) => p.status === "failed");
  if (failedPre) {
    const reason = `Prerequisite not met: ${failedPre.description}${failedPre.detail ? ` (${failedPre.detail})` : ""}.`;
    skipAll(def, ctx, reason);
    return { id: def.id, status: "blocked", reason };
  }

  let failure: { index: number; message: string } | undefined;
  for (let i = 0; i < def.steps.length; i++) {
    const step = def.steps[i]!;
    try {
      ctx.log(`[${def.id}] ${step.title}`);
      await ctx.evidence.runStep(def.id, step.id, step.title, async () => {
        // Inside the recorded step, so a refusal shows up as this step failing.
        if (step.effect === "mutate" && ctx.session) ctx.session.assertMutationAllowed(`${def.id}/${step.id} (${step.title})`, { needsCost: def.createsResources });
        if (step.effect === "mutate" && !ctx.session && !ctx.confirmBillable) throw new LiveSafetyError("confirm_required", "Non-AWS mutations also require --confirm-billable.");
        return step.run(ctx);
      });
    } catch (err) {
      failure = { index: i, message: (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 400) };
      break;
    }
  }

  if (failure) {
    const failed = def.steps[failure.index]!;
    // A failed step is a failed check: the verdict must not read "incomplete" for a run that broke.
    ctx.evidence.fail(def.id, `step:${failed.id}`, `Step "${failed.title}" completed`, failure.message);
    skipAll(def, ctx, `Step "${failed.title}" failed, so this was not checked`, failure.index + 1);
    return { id: def.id, status: "failed", reason: failure.message };
  }

  // A criterion is passed only when a step said so.
  for (const c of def.passCriteria) {
    if (!ctx.evidence.hasCheck(def.id, c.id)) ctx.evidence.skip(def.id, c.id, c.text, "no step recorded a result for this criterion");
  }
  const checks = ctx.evidence.checksFor(def.id);
  const failedCheck = checks.some((c) => c.status === "failed");
  const allPassed = checks.every((c) => c.status === "passed");
  if (allPassed) ctx.state.set(`completed:${def.id}`, true);
  return {
    id: def.id,
    status: allPassed ? "completed" : "failed",
    ...(allPassed ? {} : { reason: failedCheck ? "a pass criterion failed" : "a pass criterion was not verified" }),
  };
}
