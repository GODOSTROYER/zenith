/**
 * Product teardown proposes immutable recorded evidence. Human approval starts
 * the workflow through a single-use broker claim; history receives only ids.
 * No live cloud or Temporal execution has been verified here.
 */
import type { ActionContext, ActionPlan, ActionResult } from "@/lib/actions/core";
import { principalFromAction } from "@/lib/capabilities/action-bridge";
import { loadDestroyPlan } from "@/lib/capabilities/destroy-plan";
import type { OperationView } from "@/lib/capabilities/types";
import { approvalRoundOf } from "@/lib/controlplane/db/repos/operation-review";
import type { Environment } from "@/lib/domain/types";
import { bridgeDeps } from "./deps";
import { executionRoute } from "./deploy";
import { bridgeFailure } from "./lifecycle";

const browserFix = "Teardown requires a person in the signed-in web app. Review the destroy plan there.";
async function review(ctx: ActionContext, env: Environment) {
  if (ctx.actor.type !== "user" || ctx.integration) throw new Error(browserFix);
  const deps = bridgeDeps();
  const session = await deps.teardownSession(ctx);
  if (!session || session.subject !== ctx.actor.id) throw new Error(browserFix);
  const route = await executionRoute(env);
  if (route.kind !== "workflow") throw new Error("Teardown requires a verified connection and a ready execution plane.");
  const broker = await deps.broker();
  const scope = { workspaceId: ctx.workspaceId, projectId: env.projectId, environmentId: env.id };
  const plans = await broker.deps.store.listOperations(ctx.workspaceId, { environmentId: env.id, capability: "infrastructure.plan" }, { limit: 50 });
  const op = plans.items.find((candidate) => candidate.planDigest && !["denied", "rejected", "failed", "uncertain", "cancelled", "expired"].includes(candidate.status));
  if (!op?.planDigest) throw new Error("No recorded destroy plan is available. Run a read-only destroy review first.");
  const ref = { operationId: op.id, planDigest: op.planDigest };
  const plan = await loadDestroyPlan(broker.deps, scope, ref);
  return { broker, scope, ref, plan, session };
}

export async function teardownPlan(ctx: ActionContext, env: Environment): Promise<ActionPlan> {
  const result: ActionPlan = { summary: `Tear down infrastructure in "${env.name}".`, details: [], costDeltaUsd: 0,
    risk: "high", warnings: ["Deleting stateful resources destroys their data."], requiresApproval: true };
  try {
    const { broker, scope, ref, plan, session } = await review(ctx, env);
    const facts = plan.facts;
    result.details = [`Plan digest: ${plan.planDigest}.`, `${facts.create} create, ${facts.update} update, ${facts.delete} delete, ${facts.replace} replace.`,
      `Stateful deletes (${facts.destroyedStatefulAddresses.length}): ${facts.destroyedStatefulAddresses.join(", ") || "none"}.`,
      `Retained (${plan.retained.length}): ${plan.retained.join(", ") || "none"}.`];
    const { decision } = await broker.check({ capability: "infrastructure.destroy", scope, input: { environmentId: env.id } }, principalFromAction(ctx), { via: "ui", destroyPlan: ref, session });
    if (decision.outcome === "deny") result.blocked = decision.reasons.map((r) => r.message).join(" ");
  } catch (error) {
    result.blocked = error instanceof Error && error.message === browserFix ? browserFix :
      "A current recorded destroy plan, verified connection, browser session and ready execution plane are required. Run a read-only destroy review first.";
  }
  return result;
}

export async function proposeTeardown(ctx: ActionContext, env: Environment): Promise<ActionResult> {
  if (ctx.actor.type !== "user" || ctx.integration) return { ok: false, summary: "Teardown refused.", error: browserFix };
  try {
    const { broker, scope, ref, session } = await review(ctx, env);
    const result = await broker.propose({ capability: "infrastructure.destroy", scope, input: { environmentId: env.id },
      idempotencyKey: `teardown:${env.id}:${ref.operationId}:${ref.planDigest}` }, principalFromAction(ctx), { via: "ui", destroyPlan: ref, session });
    return { ok: result.operation.status === "awaiting_approval", summary: "Teardown proposal recorded for human approval.",
      data: { operationId: result.operation.id, proposalDigest: result.operation.proposalDigest, planDigest: result.operation.proposal.planDigest,
        status: result.operation.status, approval: `/api/platform/v1/operations/${result.operation.id}` } };
  } catch (error) { return bridgeFailure(error); }
}

const starts = new Map<string, Promise<{ delivered: boolean; reason?: "unavailable" }>>();
/** Called only after the browser-only broker approval endpoint has finalized. */
export function startApprovedDestroy(op: OperationView): Promise<{ delivered: boolean; reason?: "unavailable" }> {
  const key = `${op.workspaceId}:${op.id}`;
  const existing = starts.get(key);
  if (existing) return existing;
  const run = start(op).finally(() => { if (starts.get(key) === run) starts.delete(key); });
  starts.set(key, run);
  return run;
}

async function start(op: OperationView): Promise<{ delivered: boolean; reason?: "unavailable" }> {
  if (op.capability !== "infrastructure.destroy" || !op.environmentId || !op.proposal.planDigest || approvalRoundOf(op) ||
      !["approved", "queued"].includes(op.status)) return { delivered: false, reason: "unavailable" };
  const deps = bridgeDeps();
  const broker = await deps.broker();
  let claimed = false, attempted = false;
  try {
    if (!deps.workflows.startDestroy) return { delivered: false, reason: "unavailable" };
    const stored = await broker.deps.store.getOperation(op.workspaceId, op.id);
    if (!stored || stored.capability !== "infrastructure.destroy" || stored.environmentId !== op.environmentId ||
        stored.proposalDigest !== op.proposalDigest || stored.proposal.planDigest !== op.proposal.planDigest) return { delivered: false, reason: "unavailable" };
    // PROD-OPS-02: a paused or over-quota dispatch is refused before the claim; the operation stays approved.
    await (await import("@/lib/ops/admission")).assertDispatchAdmitted({ workspaceId: op.workspaceId, kind: "destroy", operationId: op.id });
    await broker.beginExecution({ workspaceId: op.workspaceId, operationId: op.id, holder: `workflow:${op.id}`, audience: "worker", leaseMs: 5 * 60_000 });
    claimed = true;
    attempted = true;
    await deps.workflows.startDestroy({ operationId: op.id, workspaceId: op.workspaceId, environmentId: op.environmentId });
    return { delivered: true };
  } catch {
    if (claimed) {
      try {
        if (attempted) await broker.markUncertain({ workspaceId: op.workspaceId, operationId: op.id, reason: "Destroy workflow start could not be confirmed. Inspect the operation before proposing again." });
        else await broker.completeExecution({ workspaceId: op.workspaceId, operationId: op.id, outcome: "failed", error: "Destroy workflow did not start." });
      } catch { /* The operation's claim and reconcile remain authoritative. */ }
    }
    return { delivered: false, reason: "unavailable" };
  }
}
