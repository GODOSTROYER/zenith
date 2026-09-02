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
      `Export the Terraform from Source → Export (or Settings → Export) and run it with your own tooling, or point ${env.name} at a Sandbox connection to watch the full flow.`
    );
  return (
    `${provider.displayName} is a Planned provider: Orrery cannot plan, apply or export for it yet. ` +
    `Point ${env.name} at a Sandbox connection to deploy now, or at AWS to export runnable Terraform.`
  );
}

/**
 * The connection's own health, which `availability` says nothing about: a
 * LocalStack adapter is "available" whether or not Docker is running. Deploying
 * through a dead connection used to write a revision and a deployment record,
 * then die at the first step.
 */
function connectionBlock(env: Environment): string | undefined {
  const conn = q.connection(env.connectionId);
  if (!conn)
    return (
      `${env.name} is not pointed at a cloud connection, so there is nothing to deploy through. ` +
      `Pick one for ${env.name} in Settings → Environments, or connect a cloud in Settings → Connections first.`
    );
  if (conn.status === "disconnected")
    return (
      `${conn.label} is disconnected, so ${env.name} cannot be deployed to. ` +
      `Start the service behind it (LocalStack needs Docker running), re-run the check in Settings → Connections, or point ${env.name} at a healthy connection.`
    );
  return undefined;
}

/**
 * Everything that makes `deploy.apply` refuse, decided once and rendered as
 * `plan.blocked` so no surface has to infer it from warning prose.
 */
function deployBlock(env: Environment, project: Project): string | undefined {
  const reasons = [
    providerBlock(env),
    connectionBlock(env),
    ...blockingIssues(project.workingManifest),
  ].filter((r): r is string => Boolean(r));
  return reasons.length ? reasons.join(" ") : undefined;
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
    `This plan puts ${env.name} at ${usd(cs.projectedMonthlyUsd)}/month, over its ${usd(budget)} budget (estimates). Resize something, or raise the budget in Settings → Environments.`,
  ];
}

function blockingIssues(m: Manifest): string[] {
  return validateManifest(m)
    .filter((i) => i.level === "error")
    .map((i) => `${i.message}${i.fix ? ` ${i.fix}` : ""}`);
}

function deployPlan(env: Environment, project: Project): ActionPlan {
  const cs = changesetFor(env, project);
  const blocked = deployBlock(env, project);
  const warnings = validateManifest(project.workingManifest)
    .filter((i) => i.level === "warning")
    .map((i) => `${i.message}${i.fix ? ` ${i.fix}` : ""}`);

  return {
    summary: blocked
      ? `${project.name} cannot be deployed to ${env.name} — ${tally(cs)} is what would change, but this deploy would be refused.`
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
    // Warnings are advisory only. Anything that stops the deploy is in
    // `blocked`, so a surface disables its button instead of parsing prose.
    warnings: [...cs.warnings, ...budgetWarnings(env, cs), ...warnings],
    requiresApproval: env.policies.approvalRequired,
    blocked,
    /**
     * Both deploy.plan (read-only) and deploy.apply render through here, and
     * the button a user presses is deploy.apply. Say so, so a viewer sees a
     * disabled Deploy with a reason instead of a refusal after the click.
     */
    requiredRole: "editor",
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
    const providerRefusal = providerBlock(env) ?? connectionBlock(env);
    if (providerRefusal)
      return {
        ok: false,
        summary: `${env.name} cannot be deployed to right now.`,
        error: providerRefusal,
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
      actorId: ctx.actor.id,
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
      warnings: [],
      requiresApproval: false,
      blocked:
        d.status === "awaiting_approval"
          ? undefined
          : `This deployment is ${d.status}, not awaiting approval, so there is nothing to approve. Start a new deployment from the Changes drawer instead.`,
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
    const finished = ["succeeded", "failed", "cancelled", "rolled_back"].includes(d.status);
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
      blocked: finished
        ? `This deployment already finished as ${d.status}; there is nothing to cancel. Deploy again to change the environment, or roll back to undo it.`
        : undefined,
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
        warnings: [],
        requiresApproval: false,
        blocked:
          `${env.name} has no earlier revision to roll back to. ` +
          `Deploy at least one more revision, or pick a specific revision on the Revisions page.`,
      };
    const cs = diffManifests(current?.manifest ?? emptyManifest(), target.manifest);
    const blocked = providerBlock(env) ?? connectionBlock(env);
    return {
      summary: blocked
        ? `${env.name} cannot be rolled back — this deploy would be refused.`
        : `Roll ${env.name} back to revision ${target.number}${current ? ` (from ${current.number})` : ""}.`,
      details: [
        ...(blocked ? [blocked] : []),
        ...cs.items.map((i) => i.explanation),
        `Projected monthly cost after rollback: ${usd(cs.projectedMonthlyUsd)} (estimate).`,
        "Rollback runs as a normal deployment, with its own steps and logs.",
        env.policies.approvalRequired
          ? `${env.name} requires approval, and a rollback is a deployment: it will wait at "awaiting approval" until an admin approves it.`
          : `${env.name} applies without an approval step, so this starts immediately.`,
      ],
      costDeltaUsd: cs.totalCostDeltaUsd,
      risk: "high",
      warnings: [
        ...cs.warnings,
        "Rollback restores the system definition, not data written since the last deploy.",
      ],
      requiresApproval: env.policies.approvalRequired,
      blocked,
    };
  },
  async execute(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const blocked = providerBlock(env) ?? connectionBlock(env);
    if (blocked)
      return { ok: false, summary: `${env.name} cannot be rolled back.`, error: blocked };
    const engine = await getEngine();
    const d = await engine.rollback(env.id, input.toRevisionId, {
      id: ctx.actor.id,
      name: ctx.actor.name,
    });
    const target = q.revision(d.revisionId);
    return {
      ok: true,
      summary:
        d.status === "awaiting_approval"
          ? `Rollback to revision ${target?.number ?? "?"} is waiting for approval on ${env.name}.`
          : `Rolling ${env.name} back to revision ${target?.number ?? "?"}.`,
      data: { deploymentId: d.id, status: d.status, revisionId: d.revisionId },
    };
  },
});
