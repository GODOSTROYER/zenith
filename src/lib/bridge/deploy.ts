/**
 * Real-provider routing and proposals. Only linked, verified connections on a
 * ready execution plane use workflows. Payloads carry ids, never manifests or
 * grants. Legacy Preview connections stay probe-free. No live AWS validation
 * has been performed by this bridge; readiness is prerequisite evidence only.
 */
import type { ActionContext, ActionPlan, ActionResult } from "@/lib/actions/core";
import { principalFromAction } from "@/lib/capabilities/action-bridge";
import { db, q, save } from "@/lib/db/store";
import { id, type Changeset, type CloudConnection, type Deployment, type Environment, type Revision } from "@/lib/domain/types";
import { bridgeDeps } from "@/lib/bridge/deps";
import { isRealProvider, type ExecutionReadiness, type RealProvider } from "@/lib/bridge/readiness";
import { plannedWorkflowSteps } from "@/lib/bridge/steps";
import { failDeployment, setProjectedStatus } from "@/lib/bridge/projection";
import { beginWorkflow, bridgeFailure, deploymentData } from "@/lib/bridge/lifecycle";

export type ExecutionRoute =
  | { kind: "engine" }
  | { kind: "unlinked" }
  | { kind: "not_ready"; readiness: ExecutionReadiness }
  | { kind: "unverified" }
  | { kind: "workflow"; provider: RealProvider; readiness: ExecutionReadiness; connection: CloudConnection };

export async function executionRoute(env: Environment): Promise<ExecutionRoute> {
  const conn = q.connection(env.connectionId);
  const provider = conn?.provider ?? "sandbox";
  if (!isRealProvider(provider)) return { kind: "engine" };
  const workspaceId = q.project(env.projectId)?.workspaceId;
  if (!conn?.platformConnectionId || conn.workspaceId !== workspaceId) return { kind: "unlinked" };
  const deps = bridgeDeps();
  let readiness: ExecutionReadiness;
  try {
    readiness = await deps.readiness(provider);
  } catch {
    readiness = { provider, ready: false, checkedAt: new Date().toISOString(), checks: [{ id: "readiness", ok: false, detail: "Readiness could not be checked.", fix: "Restore the execution-plane readiness service and run the plan again." }] };
  }
  if (!readiness.ready) return { kind: "not_ready", readiness };
  try {
    const platform = await deps.platformConnection(conn.workspaceId, conn.platformConnectionId);
    if (platform?.status !== "verified") return { kind: "unverified" };
  } catch {
    return { kind: "unverified" };
  }
  return { kind: "workflow", provider, readiness, connection: conn };
}

export const viaAction = (ctx: ActionContext): "ui" | "navigator" | "mcp" => ctx.integration ? "mcp" : ctx.actor.type === "navigator" ? "navigator" : "ui";
const scopeFor = (ctx: ActionContext, env: Environment) => ({ workspaceId: ctx.workspaceId, projectId: env.projectId, environmentId: env.id });

/** Dry-run broker verdict: no proposal, revision, deployment or audit write. */
export async function addWorkflowCheck(ctx: ActionContext, env: Environment, plan: ActionPlan, capability: "deployment.deploy" | "deployment.rollback" = "deployment.deploy"): Promise<ActionPlan> {
  try {
    const broker = await bridgeDeps().broker();
    const { decision } = await broker.check({ capability, scope: scopeFor(ctx, env), input: {} }, principalFromAction(ctx), { via: viaAction(ctx) });
    const reasons = decision.reasons.map((r) => r.message).join(" ");
    plan.details.push(`Platform policy: ${decision.outcome}. ${reasons}`);
    if (decision.approval) plan.details.push(`Platform approval requires ${decision.approval.count} distinct ${decision.approval.minRole}(s); requester separation: ${decision.approval.separationOfDuties ? "required" : "not required"}.`);
    if (decision.outcome === "deny") plan.blocked = [plan.blocked, reasons || "Platform policy denies this deployment."].filter(Boolean).join(" ");
    if (decision.outcome === "require_approval") plan.requiresApproval = true;
  } catch (error) {
    const failure = bridgeFailure(error);
    plan.blocked = [plan.blocked, failure.error].filter(Boolean).join(" ");
    plan.details.push(failure.error!);
  }
  return plan;
}

interface StartInput {
  ctx: ActionContext;
  env: Environment;
  revision: Revision;
  changeset: Changeset;
  changeSummary: string;
}

async function proposeDeployment(input: StartInput, capability: "deployment.deploy" | "deployment.rollback"): Promise<ActionResult> {
  const { ctx, env, revision, changeset, changeSummary } = input;
  const deploymentId = id();
  try {
    const broker = await bridgeDeps().broker();
    const result = await broker.propose({
      capability, scope: scopeFor(ctx, env), input: { revisionId: revision.id, deploymentId },
      idempotencyKey: `bridge-deploy-${deploymentId}`,
    }, principalFromAction(ctx), { via: viaAction(ctx), cost: { deltaUsdMonthly: changeset.totalCostDeltaUsd, projectedUsdMonthly: changeset.projectedMonthlyUsd } });
    const d: Deployment = {
      id: deploymentId, projectId: env.projectId, environmentId: env.id, revisionId: revision.id,
      previousRevisionId: env.deployedRevisionId, executor: "workflow", operationId: result.operation.id,
      status: "planning", steps: plannedWorkflowSteps(), outputs: [], changeSummary,
      estCostDeltaUsd: changeset.totalCostDeltaUsd, actor: ctx.actor, createdAt: new Date().toISOString(),
    };
    db().deployments.push(d);
    save(env.projectId);
    setProjectedStatus(d, "planning");
    if (result.decision.outcome === "deny" || result.operation.status === "denied") {
      const error = result.decision.reasons.map((r) => r.message).join(" ") || "Platform policy denied this deployment.";
      failDeployment(d, error);
      return { ok: false, summary: "Platform policy refused the deployment.", error, data: deploymentData(d, result.operation) };
    }
    if (result.operation.status === "awaiting_approval" || env.policies.approvalRequired) {
      setProjectedStatus(d, "awaiting_approval");
      return { ok: true, summary: `Revision ${revision.number} is waiting for approval on ${env.name}.`, data: deploymentData(d, result.operation) };
    }
    return beginWorkflow(ctx, d);
  } catch (error) {
    return bridgeFailure(error);
  }
}

export const startWorkflowDeployment = (input: StartInput): Promise<ActionResult> => proposeDeployment(input, "deployment.deploy");
export const startWorkflowRollback = (input: Omit<StartInput, "changeSummary">): Promise<ActionResult> => proposeDeployment({ ...input, changeSummary: `Roll back to r${input.revision.number}` }, "deployment.rollback");
