/**
 * Deployment actions. `deploy.plan` is read-only and returns the Changeset the
 * Changes drawer renders; `deploy.apply` snapshots a Revision and hands it to
 * the engine. Approval, cancel and rollback are thin, honest wrappers over the
 * engine's state machine.
 */
import { z } from "zod";
import { defineAction, type ActionPlan } from "@/lib/actions/core";
import { db, q, save } from "@/lib/db/store";
import { diffManifests, validateManifest } from "@/lib/domain/graph";
import {
  emptyManifest,
  id,
  type Changeset,
  type Environment,
  type Manifest,
  type Project,
  type Revision,
} from "@/lib/domain/types";
import { providerRegistry } from "@/lib/providers/types";
import { getEngine } from "./_engine";
import { clone, maxRisk, requireEnvironment, requireProject, usd } from "./_shared";

/* ---------------------------- provider honesty ---------------------------- */

/**
 * What this environment's provider can really do, decided BEFORE anything is
 * written. Previously the AWS adapter refused inside executeStep and the
 * planned stubs threw out of planSteps — by then a revision was snapshotted and
 * a deployment record existed, which is a lie about what happened.
 */
function providerBlock(env: Environment): string | undefined {
  const providerId = q.connection(env.connectionId)?.provider ?? "sandbox";
  const provider = providerRegistry().get(providerId);
  // Not registered yet (engine not booted): the engine still refuses honestly.
  if (!provider || provider.availability === "available") return undefined;
  if (provider.availability === "preview")
    return (
      `${provider.displayName} is a Preview provider: Orrery plans this deployment and exports runnable Terraform for it, but it never applies changes to your account. ` +
      `Export the Terraform from Environment → Export and run it with your own tooling, or point ${env.name} at a Sandbox connection to watch the full flow.`
    );
  return (
    `${provider.displayName} is a Planned provider: Orrery cannot plan, apply or export for it yet. ` +
    `Point ${env.name} at a Sandbox connection to deploy now, or at AWS to export runnable Terraform.`
  );
}

/** The manifest currently live in an environment (empty if never deployed). */
export function deployedManifest(env: Environment): Manifest {
  const rev = env.deployedRevisionId ? q.revision(env.deployedRevisionId) : undefined;
  return rev ? rev.manifest : emptyManifest();
}

export function changesetFor(env: Environment, project: Project): Changeset {
  return diffManifests(deployedManifest(env), project.workingManifest);
}

function tally(cs: Changeset): string {
  const n = (op: string) => cs.items.filter((i) => i.op === op).length;
  const parts = [
    n("create") && `${n("create")} added`,
    n("update") && `${n("update")} changed`,
    n("delete") && `${n("delete")} removed`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "no changes";
}

function budgetWarnings(env: Environment, cs: Changeset): string[] {
  const budget = env.policies.budgetUsdMonthly;
  if (!budget || cs.projectedMonthlyUsd <= budget) return [];
  return [
    `This plan puts ${env.name} at ${usd(cs.projectedMonthlyUsd)}/month, over its ${usd(budget)} budget (estimates). Resize something, or raise the budget in Settings → Policies.`,
  ];
}

function blockingIssues(m: Manifest): string[] {
  return validateManifest(m)
    .filter((i) => i.level === "error")
    .map((i) => `${i.message}${i.fix ? ` ${i.fix}` : ""}`);
}

function deployPlan(env: Environment, project: Project): ActionPlan {
  const cs = changesetFor(env, project);
  const blocked = providerBlock(env);
  const errors = blockingIssues(project.workingManifest);
  const warnings = validateManifest(project.workingManifest)
    .filter((i) => i.level === "warning")
    .map((i) => `${i.message}${i.fix ? ` ${i.fix}` : ""}`);

  return {
    summary: blocked
      ? `${project.name} cannot be deployed to ${env.name} — ${tally(cs)} is what would change, but this provider cannot apply it.`
      : `Deploy ${project.name} to ${env.name} — ${tally(cs)}.`,
    details: [
      ...(blocked ? [blocked] : []),
      ...cs.items.map((i) => i.explanation),
      `Projected monthly cost after this deploy: ${usd(cs.projectedMonthlyUsd)} (estimate).`,
      env.policies.approvalRequired
        ? `${env.name} requires approval: the deployment will wait at "awaiting approval" until someone approves it.`
        : `${env.name} applies without an approval step.`,
    ],
    costDeltaUsd: cs.totalCostDeltaUsd,
    risk: maxRisk(cs.items.map((i) => i.risk)),
    warnings: [
      ...(blocked ? [`Blocks the deploy: ${blocked}`] : []),
      ...errors.map((e) => `Blocks the deploy: ${e}`),
      ...cs.warnings,
      ...budgetWarnings(env, cs),
      ...warnings,
    ],
    requiresApproval: env.policies.approvalRequired,
  };
}

/* -------------------------------- deploy.plan ------------------------------ */

const PlanInput = z.object({
  projectId: z.string().optional(),
  environmentId: z.string().optional(),
});
type PlanInput = z.infer<typeof PlanInput>;

defineAction<PlanInput>({
  id: "deploy.plan",
  title: "Plan deployment",
  category: "deploy",
  risk: "low",
  requiredRole: "viewer",
  mutates: false,
  input: PlanInput,
  plan(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    return deployPlan(env, requireProject(ctx, input.projectId ?? env.projectId));
  },
  execute(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const project = requireProject(ctx, input.projectId ?? env.projectId);
    const changeset = changesetFor(env, project);
    return {
      ok: true,
      summary: `${tally(changeset)} between ${project.name}'s working copy and ${env.name}.`,
      data: { changeset, environmentId: env.id, blocking: blockingIssues(project.workingManifest) },
    };
  },
});

/* ------------------------------- deploy.apply ------------------------------ */

const ApplyInput = z.object({
  projectId: z.string().optional(),
  environmentId: z.string().optional(),
  message: z.string().optional(),
});
type ApplyInput = z.infer<typeof ApplyInput>;

defineAction<ApplyInput>({
  id: "deploy.apply",
  title: "Deploy",
  category: "deploy",
  risk: "high",
  requiredRole: "editor",
  mutates: true,
  input: ApplyInput,
  plan(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    return deployPlan(env, requireProject(ctx, input.projectId ?? env.projectId));
  },
  async execute(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const project = requireProject(ctx, input.projectId ?? env.projectId);
    const working = project.workingManifest;

    // Refuse before a revision is snapshotted or a deployment record exists.
    const blocked = providerBlock(env);
    if (blocked)
      return {
        ok: false,
        summary: `${env.name} cannot be deployed to by its provider.`,
        error: blocked,
      };

    const errors = blockingIssues(working);
    if (errors.length)
      return {
        ok: false,
        summary: `${project.name} cannot be deployed yet — ${errors.length} problem(s) to fix first.`,
        error: errors.join(" "),
      };
    if (working.services.length === 0 && working.resources.length === 0)
      return {
        ok: false,
        summary: "There is nothing to deploy.",
        error: "The system is empty. Add a service or a resource first, or apply a blueprint.",
      };

    const changeset = changesetFor(env, project);
    if (changeset.items.length === 0 && env.deployedRevisionId)
      return {
        ok: false,
        summary: `${env.name} already runs this exact system.`,
        error: "Nothing has changed since the last deploy. Edit the system, or restart a service with ops.restartService.",
      };

    const number = q.revisionsOf(project.id).reduce((max, r) => Math.max(max, r.number), 0) + 1;
    const changeSummary = tally(changeset);
    const revision: Revision = {
      id: id(),
      projectId: project.id,
      number,
      manifest: clone(working),
      message: input.message?.trim() || `${changeSummary} (${env.name})`,
      author: ctx.actor,
      createdAt: new Date().toISOString(),
    };
    db().revisions.push(revision);
    save();

    const engine = await getEngine();
    const deployment = await engine.start({
      projectId: project.id,
      environmentId: env.id,
      revisionId: revision.id,
      changeSummary,
      estCostDeltaUsd: changeset.totalCostDeltaUsd,
      actorName: ctx.actor.name,
      actorType: ctx.actor.type === "navigator" ? "navigator" : "user",
      approved: !env.policies.approvalRequired,
    });

    return {
      ok: true,
      summary:
        deployment.status === "awaiting_approval"
          ? `Revision ${number} is waiting for approval on ${env.name} (${changeSummary}).`
          : `Deploying revision ${number} to ${env.name} (${changeSummary}).`,
      data: {
        deploymentId: deployment.id,
        status: deployment.status,
        revisionId: revision.id,
        revisionNumber: number,
        changeset,
      },
    };
  },
});

/* ------------------- approve / cancel / rollback (engine) ------------------ */

const DeploymentRef = z.object({ deploymentId: z.string().min(1) });
type DeploymentRef = z.infer<typeof DeploymentRef>;

function requireDeployment(deploymentId: string) {
  const d = q.deployment(deploymentId);
  if (!d)
    throw new Error(`Deployment "${deploymentId}" was not found. Pick one from the Deploys page.`);
  return d;
}

defineAction<DeploymentRef>({
  id: "deploy.approve",
  title: "Approve deployment",
  category: "deploy",
  risk: "high",
  requiredRole: "admin",
  mutates: true,
  input: DeploymentRef,
  plan(_ctx, input) {
    const d = requireDeployment(input.deploymentId);
    const env = q.environment(d.environmentId);
    return {
      summary: `Approve and apply this deployment to ${env?.name ?? "its environment"}.`,
      details: [d.changeSummary, `${d.steps.length} step(s) will run.`, "This starts changing the environment immediately."],
      costDeltaUsd: d.estCostDeltaUsd,
      risk: "high",
      warnings: d.status === "awaiting_approval" ? [] : [`This deployment is ${d.status}, not awaiting approval.`],
      requiresApproval: false,
    };
  },
  async execute(_ctx, input) {
    const engine = await getEngine();
    const d = await engine.approve(input.deploymentId);
    return { ok: true, summary: `Approved. Applying ${d.changeSummary}.`, data: { deploymentId: d.id, status: d.status } };
  },
});

defineAction<DeploymentRef>({
  id: "deploy.cancel",
  title: "Cancel deployment",
  category: "deploy",
  risk: "medium",
  requiredRole: "editor",
  mutates: true,
  input: DeploymentRef,
  plan(_ctx, input) {
    const d = requireDeployment(input.deploymentId);
    const done = d.steps.filter((s) => s.status === "done").length;
    return {
      summary: "Cancel this deployment.",
      details: [
        `${done} of ${d.steps.length} step(s) already finished; remaining steps are skipped.`,
        done > 0
          ? "Work already applied stays applied — cancelling stops the deployment, it does not undo it. Use rollback for that."
          : "Nothing has been applied yet, so the environment is untouched.",
      ],
      costDeltaUsd: 0,
      risk: done > 0 ? "medium" : "low",
      warnings: done > 0 ? ["The environment is left part-way between two revisions. Roll back or deploy again to make it consistent."] : [],
      requiresApproval: false,
    };
  },
  async execute(_ctx, input) {
    const engine = await getEngine();
    const d = await engine.cancel(input.deploymentId);
    return { ok: true, summary: `Deployment cancelled after ${d.steps.filter((s) => s.status === "done").length} completed step(s).`, data: { deploymentId: d.id, status: d.status } };
  },
});

const RollbackInput = z.object({
  environmentId: z.string().optional(),
  toRevisionId: z.string().optional(),
});
type RollbackInput = z.infer<typeof RollbackInput>;

defineAction<RollbackInput>({
  id: "deploy.rollback",
  title: "Roll back",
  category: "deploy",
  risk: "high",
  requiredRole: "editor",
  mutates: true,
  input: RollbackInput,
  plan(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const targetId = input.toRevisionId ?? q.deploymentsOf(env.id)[0]?.previousRevisionId;
    const target = targetId ? q.revision(targetId) : undefined;
    const current = env.deployedRevisionId ? q.revision(env.deployedRevisionId) : undefined;
    if (!target)
      return {
        summary: `${env.name} has no earlier revision to roll back to.`,
        details: ["Deploy at least one more revision, or pick a specific revision on the Revisions page."],
        costDeltaUsd: 0,
        risk: "low",
        warnings: ["Nothing to roll back to."],
        requiresApproval: false,
      };
    const cs = diffManifests(current?.manifest ?? emptyManifest(), target.manifest);
    const blocked = providerBlock(env);
    return {
      summary: blocked
        ? `${env.name} cannot be rolled back — this provider cannot apply changes.`
        : `Roll ${env.name} back to revision ${target.number}${current ? ` (from ${current.number})` : ""}.`,
      details: [
        ...(blocked ? [blocked] : []),
        ...cs.items.map((i) => i.explanation),
        `Projected monthly cost after rollback: ${usd(cs.projectedMonthlyUsd)} (estimate).`,
        "Rollback runs as a normal deployment, with its own steps and logs.",
      ],
      costDeltaUsd: cs.totalCostDeltaUsd,
      risk: "high",
      warnings: [
        ...(blocked ? [`Blocks the rollback: ${blocked}`] : []),
        ...cs.warnings,
        "Rollback restores the system definition, not data written since the last deploy.",
      ],
      requiresApproval: env.policies.approvalRequired,
    };
  },
  async execute(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const blocked = providerBlock(env);
    if (blocked)
      return { ok: false, summary: `${env.name} cannot be rolled back.`, error: blocked };
    const engine = await getEngine();
    const d = await engine.rollback(env.id, input.toRevisionId, ctx.actor.name);
    const target = q.revision(d.revisionId);
    return {
      ok: true,
      summary: `Rolling ${env.name} back to revision ${target?.number ?? "?"}.`,
      data: { deploymentId: d.id, status: d.status, revisionId: d.revisionId },
    };
  },
});
