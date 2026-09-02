/**
 * Environments: where a revision runs, and the policy that guards it.
 *
 * Defaults are visible, never silent: production environments require
 * approval unless you say otherwise, and the plan says so before you create
 * one.
 */
import { z } from "zod";
import { defineAction } from "@/lib/actions/core";
import { monthlyCostUsd } from "@/lib/cost/pricing";
import { db, q, save } from "@/lib/db/store";
import {
  EnvironmentClass,
  id,
  type CloudConnection,
  type Environment,
  type Project,
} from "@/lib/domain/types";
import { providerRegistry } from "@/lib/providers/types";
import { slugify, uniqueName } from "@/lib/importers/types";
import { requireEnvironment, requireProject, usd } from "./_shared";

/* ------------------------------- connections ------------------------------ */

/**
 * The always-there sandbox connection, created on demand. Costs nothing,
 * grants nothing. `persist: false` (plan mode) returns the record it *would*
 * create without writing it — planning never leaves phantom rows behind.
 */
export function ensureSandboxConnection(workspaceId: string, persist = true): CloudConnection {
  const existing = db().connections.find(
    (c) => c.workspaceId === workspaceId && c.provider === "sandbox"
  );
  if (existing) return existing;
  const conn: CloudConnection = {
    id: id(),
    workspaceId,
    provider: "sandbox",
    label: "Sandbox",
    region: "local",
    status: "healthy",
    grantedPermissions: ["No cloud access — the sandbox runs inside Orrery and simulates deployments."],
    createdAt: new Date().toISOString(),
  };
  if (persist) {
    db().connections.push(conn);
    save();
  }
  return conn;
}

/** Honest one-liner about what deploying through this connection actually does. */
export function connectionLabel(conn: CloudConnection): string {
  const adapter = providerRegistry().get(conn.provider);
  if (!adapter) return `${conn.provider} (${conn.region})`;
  return `${adapter.displayName} (${conn.region}) — ${adapter.availability}: ${adapter.tagline.replace(/\.$/, "")}`;
}

/* ------------------------------ env.create -------------------------------- */

export function baseDomainFor(project: Project, name: string, klass: EnvironmentClass): string {
  return klass === "production"
    ? `${project.slug}.orrery.app`
    : `${name}.${project.slug}.orrery.app`;
}

const CreateEnv = z.object({
  projectId: z.string().optional(),
  name: z.string().min(1).optional(),
  class: EnvironmentClass.optional(),
  connectionId: z.string().optional(),
  region: z.string().optional(),
  approvalRequired: z.boolean().optional(),
  budgetUsdMonthly: z.number().positive().optional(),
});
type CreateEnv = z.infer<typeof CreateEnv>;

/** Shared by env.create and project.create. Allocates the record; the caller stores it. */
export function buildEnvironment(
  project: Project,
  input: CreateEnv,
  workspaceId: string,
  persist = true
): { env: Environment; connection: CloudConnection } {
  const klass = input.class ?? "sandbox";
  const taken = q.environmentsOf(project.id).map((e) => e.name);
  const name = uniqueName(slugify(input.name ?? klass, klass), taken);
  const conn = input.connectionId
    ? q.connection(input.connectionId)
    : ensureSandboxConnection(workspaceId, persist);
  if (!conn)
    throw new Error(`Connection "${input.connectionId}" does not exist. Pick one in Settings → Connections, or leave it blank to use the sandbox.`);

  return {
    connection: conn,
    env: {
      id: id(),
      projectId: project.id,
      name,
      class: klass,
      connectionId: conn.id,
      region: input.region ?? conn.region,
      policies: {
        approvalRequired: input.approvalRequired ?? klass === "production",
        budgetUsdMonthly: input.budgetUsdMonthly,
        allowStatefulDeletion: false,
      },
      baseDomain: baseDomainFor(project, name, klass),
      createdAt: new Date().toISOString(),
    },
  };
}

export function envPlanDetails(project: Project, env: Environment, conn: CloudConnection): string[] {
  return [
    `Class "${env.class}" in ${env.region}.`,
    `Deploys through ${connectionLabel(conn)}.`,
    `Managed routes get hostnames under ${env.baseDomain}.`,
    env.policies.approvalRequired
      ? `Approval required before anything is applied${env.class === "production" ? " — the default for production environments" : ""}. Change it in Settings → Environments.`
      : "Deploys apply as soon as they are started. Turn on approval in Settings → Environments if you want a gate.",
    env.policies.budgetUsdMonthly
      ? `Budget ${usd(env.policies.budgetUsdMonthly)}/month; plans that exceed it are flagged before you deploy.`
      : "No budget set. Set one with env.setBudget to get warned before a plan gets expensive.",
    `Creating an environment costs nothing on its own — the current system would cost ${usd(monthlyCostUsd(project.workingManifest))}/month once deployed (estimate).`,
  ];
}

defineAction<CreateEnv>({
  id: "env.create",
  title: "Create environment",
  category: "environment",
  risk: "low",
  requiredRole: "editor",
  mutates: true,
  input: CreateEnv,
  plan(ctx, input) {
    const project = requireProject(ctx, input.projectId);
    const { env, connection } = buildEnvironment(project, input, ctx.workspaceId, false);
    return {
      summary: `Create the "${env.name}" environment for ${project.name}.`,
      details: envPlanDetails(project, env, connection),
      costDeltaUsd: 0,
      risk: "low",
      warnings: [],
      requiresApproval: false,
    };
  },
  execute(ctx, input) {
    const project = requireProject(ctx, input.projectId);
    const { env } = buildEnvironment(project, input, ctx.workspaceId);
    db().environments.push(env);
    save();
    return {
      ok: true,
      summary: `Created environment "${env.name}" (${env.class}). Nothing is deployed to it yet.`,
      data: { environmentId: env.id, name: env.name, baseDomain: env.baseDomain },
    };
  },
});

/* --------------------------- env.updatePolicies --------------------------- */

const UpdatePolicies = z.object({
  environmentId: z.string().optional(),
  approvalRequired: z.boolean().optional(),
  allowStatefulDeletion: z.boolean().optional(),
});
type UpdatePolicies = z.infer<typeof UpdatePolicies>;

function policyChanges(env: Environment, input: UpdatePolicies): { details: string[]; warnings: string[] } {
  const details: string[] = [];
  const warnings: string[] = [];
  if (input.approvalRequired !== undefined && input.approvalRequired !== env.policies.approvalRequired) {
    details.push(
      input.approvalRequired
        ? `Deploys to ${env.name} will wait for a human to approve them.`
        : `Deploys to ${env.name} will apply immediately, with no approval step.`
    );
    if (!input.approvalRequired && env.class === "production")
      warnings.push(`${env.name} is a production environment. Without approval, any deploy applies straight away.`);
  }
  if (input.allowStatefulDeletion !== undefined && input.allowStatefulDeletion !== env.policies.allowStatefulDeletion) {
    details.push(
      input.allowStatefulDeletion
        ? `Plans that destroy databases, caches, queues or buckets in ${env.name} will be allowed to run.`
        : `Plans that destroy stateful resources in ${env.name} will be blocked.`
    );
    if (input.allowStatefulDeletion)
      warnings.push("Deleting a stateful resource destroys its data. Rollback restores the manifest, not the data.");
  }
  if (details.length === 0) details.push("No policy values changed.");
  return { details, warnings };
}

defineAction<UpdatePolicies>({
  id: "env.updatePolicies",
  title: "Update environment policies",
  category: "environment",
  risk: "medium",
  requiredRole: "admin",
  mutates: true,
  input: UpdatePolicies,
  plan(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const { details, warnings } = policyChanges(env, input);
    return {
      summary: `Update deployment policy for "${env.name}".`,
      details,
      costDeltaUsd: 0,
      risk: "medium",
      warnings,
      requiresApproval: false,
    };
  },
  execute(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const { details } = policyChanges(env, input);
    if (input.approvalRequired !== undefined) env.policies.approvalRequired = input.approvalRequired;
    if (input.allowStatefulDeletion !== undefined) env.policies.allowStatefulDeletion = input.allowStatefulDeletion;
    save();
    return { ok: true, summary: `Policies updated for "${env.name}". ${details[0]}`, data: { environmentId: env.id, policies: env.policies } };
  },
});

/* ------------------------------ env.setBudget ----------------------------- */

const SetBudget = z.object({
  environmentId: z.string().optional(),
  /** null clears the budget */
  budgetUsdMonthly: z.number().positive().nullable(),
});
type SetBudget = z.infer<typeof SetBudget>;

function budgetDetails(env: Environment, projectMonthly: number, budget: number | null): { details: string[]; warnings: string[] } {
  if (budget === null)
    return {
      details: [`Removes the budget on ${env.name}. Plans will no longer be checked against a limit.`],
      warnings: [],
    };
  const details = [
    `Sets a ${usd(budget)}/month budget on ${env.name}.`,
    `The current system is estimated at ${usd(projectMonthly)}/month, ${projectMonthly > budget ? "over" : "under"} that.`,
    "Budgets warn before a deploy; they never stop a running system or delete anything.",
  ];
  const warnings = projectMonthly > budget
    ? [`The system already costs more than this budget (${usd(projectMonthly)} vs ${usd(budget)}). Every plan will be flagged until you resize or raise the budget.`]
    : [];
  return { details, warnings };
}

defineAction<SetBudget>({
  id: "env.setBudget",
  title: "Set budget",
  category: "environment",
  risk: "low",
  requiredRole: "admin",
  mutates: true,
  input: SetBudget,
  plan(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const project = requireProject(ctx, env.projectId);
    const { details, warnings } = budgetDetails(env, monthlyCostUsd(project.workingManifest), input.budgetUsdMonthly);
    return {
      summary: input.budgetUsdMonthly === null ? `Remove the budget on "${env.name}".` : `Set a ${usd(input.budgetUsdMonthly)}/month budget on "${env.name}".`,
      details,
      costDeltaUsd: 0,
      risk: "low",
      warnings,
      requiresApproval: false,
    };
  },
  execute(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    env.policies.budgetUsdMonthly = input.budgetUsdMonthly ?? undefined;
    save();
    return {
      ok: true,
      summary:
        input.budgetUsdMonthly === null
          ? `Budget removed from "${env.name}".`
          : `Budget for "${env.name}" set to ${usd(input.budgetUsdMonthly)}/month (estimates, checked at plan time).`,
      data: { environmentId: env.id, budgetUsdMonthly: env.policies.budgetUsdMonthly ?? null },
    };
  },
});
