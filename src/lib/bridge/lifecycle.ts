/**
 * Workflow lifecycle controls. Broker grants are discarded, never projected.
 * Claim holder/TTL match ws-act (workflow:<operationId>, five minutes).
 * Temporal start is idempotent by operation id. A start timeout is uncertain,
 * not proof that nothing ran. The DB operation is authoritative for signals.
 */
import type { ActionContext, ActionPlan, ActionResult } from "@/lib/actions/core";
import { principalFromAction } from "@/lib/capabilities/action-bridge";
import { isBrokerError } from "@/lib/capabilities/errors";
import type { OperationView } from "@/lib/capabilities/types";
import { approvalRoundOf } from "@/lib/controlplane/db/repos/operation-review";
import { q, revisionManifestAsync, save } from "@/lib/db/store";
import type { Deployment } from "@/lib/domain/types";
import { bridgeDeps } from "@/lib/bridge/deps";
import { failDeployment, finishUnstartedDeployment, setProjectedStatus } from "@/lib/bridge/projection";

export function bridgeFailure(error: unknown): ActionResult {
  return { ok: false, summary: "The platform operation could not proceed.", error: isBrokerError(error) ? `${error.message}${error.fix ? ` Fix: ${error.fix}` : ""}` : "The platform service is unavailable. Restore it and retry from the web app." };
}

export function deploymentData(d: Deployment, op?: OperationView) {
  return {
    deploymentId: d.id, operationId: d.operationId, revisionId: d.revisionId, status: d.status,
    ...(op ? { proposalDigest: op.proposalDigest, operationStatus: op.status } : {}),
    approval: `/api/platform/v1/operations/${d.operationId}`,
  };
}

async function detailFor(ctx: ActionContext, d: Deployment) {
  const broker = await bridgeDeps().broker();
  const detail = await broker.getOperationDetail({ workspaceId: ctx.workspaceId, operationId: d.operationId!, principal: principalFromAction(ctx) });
  const op = detail.operation;
  const input = op.proposal.input as { revisionId?: unknown; deploymentId?: unknown } | null;
  if (op.projectId !== d.projectId || op.environmentId !== d.environmentId || input?.deploymentId !== d.id || input?.revisionId !== d.revisionId) throw new Error("Deployment operation mismatch.");
  return { broker, op };
}

// Same-process duplicate controls share one start. Broker claim CAS is the
// cross-process fence; another process's already_claimed never starts a workflow.
type G = typeof globalThis & { __zenithBridgeStarts?: Map<string, Promise<ActionResult>> };
export function beginWorkflow(ctx: ActionContext, d: Deployment): Promise<ActionResult> {
  const starts = (globalThis as G).__zenithBridgeStarts ??= new Map();
  const key = `${ctx.workspaceId}:${d.operationId}`;
  const existing = starts.get(key);
  if (existing) return existing;
  const run = start(ctx, d).finally(() => { if (starts.get(key) === run) starts.delete(key); });
  starts.set(key, run);
  return run;
}

async function start(ctx: ActionContext, d: Deployment): Promise<ActionResult> {
  if (d.workflowStartedAt) return { ok: true, summary: "Deployment is already underway.", data: deploymentData(d) };
  const deps = bridgeDeps();
  let claimed = false;
  let startAttempted = false;
  let broker: Awaited<ReturnType<typeof deps.broker>> | undefined;
  try {
    const env = q.environment(d.environmentId);
    const manifest = await revisionManifestAsync(d.revisionId);
    if (!env || !manifest || !d.operationId) throw new Error("Missing deployment context.");
    ({ broker } = await detailFor(ctx, d));
    // Never return, log or save the compact grant.
    await broker.beginExecution({ workspaceId: ctx.workspaceId, operationId: d.operationId, holder: `workflow:${d.operationId}`, audience: "worker", leaseMs: 5 * 60_000 });
    claimed = true;
    startAttempted = true;
    await deps.workflows.startDeploy({
      operationId: d.operationId, workspaceId: ctx.workspaceId, projectId: d.projectId,
      environmentId: d.environmentId, revisionId: d.revisionId, deploymentId: d.id,
      connectionId: env.connectionId, preApproved: true,
      build: manifest.services.some((s) => s.ownership === "managed" && s.source.type === "git"),
    });
    d.workflowStartedAt = new Date().toISOString();
    // A fast worker may have already projected progress: do not overwrite it.
    save(d.projectId);
    return { ok: true, summary: "Deployment workflow started; the worker will project progress here.", data: deploymentData(d) };
  } catch (error) {
    if (isBrokerError(error) && error.code === "already_claimed") return bridgeFailure(error);
    const timeout = startAttempted && error instanceof Error && error.name === "TemporalUnavailableError" && /timed out$/.test(error.message);
    const message = timeout
      ? "Workflow start timed out; whether it started is unknown. The operation is uncertain; inspect it before proposing another change."
      : startAttempted ? "Workflow startup failed; no confirmed workflow start was recorded. Check Temporal and the execution worker." : bridgeFailure(error).error!;
    if (claimed && broker) {
      try {
        if (timeout) await broker.markUncertain({ workspaceId: ctx.workspaceId, operationId: d.operationId!, reason: message });
        else await broker.completeExecution({ workspaceId: ctx.workspaceId, operationId: d.operationId!, outcome: "failed", error: message });
      } catch {
        // Do not hide a failed ledger settlement or claim certainty.
        failDeployment(d, `${message} Ledger settlement also failed; inspect the platform operation (its claim will expire).`);
        return { ok: false, summary: "Workflow startup could not be confirmed.", error: d.error, data: deploymentData(d) };
      }
    }
    failDeployment(d, message);
    return { ok: false, summary: "Workflow startup could not proceed.", error: message, data: deploymentData(d) };
  }
}

const browserFix = "Workflow approval requires a browser session. Use the web app to review the platform operation; bearer tokens, integrations and Navigator cannot approve it.";
export async function workflowApprovalPlan(ctx: ActionContext, d: Deployment): Promise<ActionPlan> {
  const plan: ActionPlan = { summary: "Approve the platform operation and apply this deployment.", details: ["Approval is routed through the platform operation; approve starts a real change in the customer's cloud.", d.changeSummary], costDeltaUsd: d.estCostDeltaUsd, risk: "high", warnings: [], requiresApproval: false };
  if (ctx.actor.type !== "user" || ctx.integration || !(await bridgeDeps().browserSession(ctx))) plan.blocked = browserFix;
  let awaiting = d.status === "awaiting_approval";
  try {
    const { op } = await detailFor(ctx, d);
    plan.details.push(`Operation: ${op.id}. Proposal digest: ${op.proposalDigest}. Review: /api/platform/v1/operations/${op.id}`);
    if (d.workflowStartedAt && op.approvalRound && op.status === "awaiting_approval") {
      awaiting = true;
      plan.details.push(`Review and approve the concrete plan at /platform/operations/${op.id}. Plan digest: ${op.planDigest ?? "unavailable"}.`);
    }
  } catch (error) { plan.blocked = bridgeFailure(error).error; }
  if (!awaiting) plan.blocked = `This deployment is ${d.status}; only a deployment awaiting approval can be approved.`;
  return plan;
}

export async function approveWorkflowDeployment(ctx: ActionContext, d: Deployment, reviewedPlanDigest?: string): Promise<ActionResult> {
  if (ctx.actor.type !== "user" || ctx.integration) return { ok: false, summary: "Approval refused.", error: browserFix };
  const session = await bridgeDeps().browserSession(ctx);
  if (!session) return { ok: false, summary: "Approval refused.", error: browserFix };
  try {
    const { broker, op: initial } = await detailFor(ctx, d);
    let op = initial;
    if (op.status === "running" && d.workflowStartedAt) return { ok: true, summary: "Deployment is already underway.", data: deploymentData(d, op) };
    const planGate = d.workflowStartedAt && op.approvalRound && ["awaiting_approval", "approved", "queued"].includes(op.status);
    if (d.status !== "awaiting_approval" && !planGate) return { ok: false, summary: "Approval refused.", error: `This deployment is ${d.status}; only a deployment awaiting approval can be approved.` };
    if (op.status === "awaiting_approval") {
      const approved = await broker.approve({ workspaceId: ctx.workspaceId, operationId: op.id, proposalDigest: op.proposalDigest, planDigest: reviewedPlanDigest, approver: { kind: "user", id: ctx.actor.id, name: ctx.actor.name }, session });
      op = approved.operation;
      if (!approved.finalized) return { ok: true, summary: `Approval recorded (${approved.approvals.have}/${approved.approvals.need}); waiting for other approvers.`, data: deploymentData(d, op) };
    }
    if (op.status !== "approved" && op.status !== "queued") return { ok: false, summary: "Approval refused.", error: `The platform operation is ${op.status}; review it in the web app.` };
    if (!d.workflowStartedAt) {
      setProjectedStatus(d, "planning");
      return beginWorkflow(ctx, d);
    }
    const result = await bridgeDeps().workflows.signalApproval(op.id);
    return { ok: result.delivered, summary: result.delivered ? "Approval recorded and delivered to the workflow." : "Approval recorded, but no active workflow was found. Inspect the platform operation.", data: { ...deploymentData(d, op), ...result } };
  } catch (error) { return bridgeFailure(error); }
}

/** Signalling only wakes the workflow; a failed delivery does not undo the decision. */
export async function deliverPlanApproval(op: OperationView): Promise<{ delivered: boolean; reason?: "not_found" | "unavailable" } | undefined> {
  if (!op.planDigest || !approvalRoundOf(op) || !["approved", "rejected"].includes(op.status)) return undefined;
  try { return await bridgeDeps().workflows.signalApproval(op.id); }
  catch { return { delivered: false, reason: "unavailable" }; }
}

export async function cancelWorkflowDeployment(ctx: ActionContext, d: Deployment): Promise<ActionResult> {
  if (["succeeded", "failed", "cancelled", "rolled_back"].includes(d.status)) return { ok: false, summary: "Cancellation refused.", error: `This deployment is ${d.status}; it cannot be cancelled.` };
  try {
    const { broker, op } = await detailFor(ctx, d);
    if (!d.workflowStartedAt && ["awaiting_approval", "approved", "queued", "proposed"].includes(op.status)) {
      await broker.cancelOperation({ workspaceId: ctx.workspaceId, operationId: op.id, principal: principalFromAction(ctx), reason: "Cancelled from deployment controls." });
      finishUnstartedDeployment(d, "cancelled");
      return { ok: true, summary: "Deployment cancelled before workflow startup.", data: deploymentData(d) };
    }
    if (op.status === "running" || (d.workflowStartedAt && ["awaiting_approval", "approved", "queued"].includes(op.status))) {
      const result = await bridgeDeps().workflows.cancelOperation(op.id);
      return { ok: result.delivered, summary: result.delivered ? "Cancellation requested; the worker will project the final outcome." : "No active workflow was found; cancellation is unconfirmed. Inspect the platform operation.", data: { ...deploymentData(d, op), ...result } };
    }
    return { ok: false, summary: "Cancellation refused.", error: `The platform operation is ${op.status}; it cannot be cancelled here.` };
  } catch (error) { return bridgeFailure(error); }
}
