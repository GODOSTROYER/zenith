/**
 * Operation reads: `zenith_get_operation` and `zenith_get_operation_events`.
 *
 * The broker's own lookups scope by workspace and by the integration's project
 * and environment grant, so a foreign or invisible operation id is the uniform
 * `not_found`. Once the operation's scope is known, `authorizeRead` makes the
 * policy decision for reading it (`events.read` at the operation's environment)
 * before any of it is returned.
 *
 * Operation text — the requester's reason, the proposal's details, an
 * executor's result and error, approver names and reasons, event payloads — is
 * untrusted and returned under `untrusted_data`. Statuses, digests, ids and
 * timestamps are Zenith's own and go in `data`.
 */
import type { OperationDetail } from "@/lib/capabilities/operations";
import type { OperationView } from "@/lib/capabilities/types";
import { authorizeReadOrThrow, type ToolContext } from "../context";
import type { ToolOutput } from "../envelope";
import { assertInGrant } from "../principal";
import type { GetOperationArgs, GetOperationEventsArgs } from "../schemas";

/** Guidance for the model, authored by Zenith, keyed by status. Never derived from untrusted text. */
export function nextStepFor(op: Pick<OperationView, "status" | "id" | "proposalDigest">, approvalUrl: string): string {
  switch (op.status) {
    case "awaiting_approval":
      return `A person must approve this exact proposal in the Zenith web app: ${approvalUrl}. A yes in chat is not an approval. Poll zenith_get_operation; execute only when status is approved.`;
    case "approved":
      return "Approved and not yet running. Call zenith_execute_approved_operation with the operationId and the exact proposalDigest to start it.";
    case "queued":
      return "The operation is queued. Call zenith_execute_approved_operation with its operationId and exact proposalDigest to claim and start it, or poll for the worker's progress.";
    case "running":
      return "The operation is claimed. Poll zenith_get_operation and zenith_get_operation_events. If a start response was lost, the same execute call can confirm only its retained durable intent. An unrecorded claim is refused; a recorded transport attempt is never sent again.";
    case "succeeded":
      return "The workflow finished successfully. That is not proof the system is healthy: check logs and metrics.";
    case "uncertain":
      return "Zenith cannot prove what happened. Do not retry blindly: investigate the environment, and let a person decide.";
    case "failed":
      return "It failed; read the events for why. A retry is a NEW proposal that needs its own approval.";
    case "denied":
    case "rejected":
    case "cancelled":
    case "expired":
      return `This operation is ${op.status} and can no longer run. Propose again if the change is still wanted.`;
    default:
      return "Poll zenith_get_operation for the current status.";
  }
}

async function loadAuthorized(ctx: ToolContext, workspaceId: string, operationId: string): Promise<OperationDetail> {
  assertInGrant(ctx.principal, { workspaceId });
  const detail = await ctx.broker.getOperationDetail({ workspaceId, operationId, principal: ctx.principal.principal });
  const op = detail.operation;
  assertInGrant(ctx.principal, op);
  await authorizeReadOrThrow(
    ctx,
    op.environmentId ? "events.read" : "topology.read",
    { workspaceId, ...(op.projectId ? { projectId: op.projectId } : {}), ...(op.environmentId ? { environmentId: op.environmentId } : {}) }
  );
  return detail;
}

export async function getOperation(args: GetOperationArgs, ctx: ToolContext): Promise<ToolOutput> {
  const detail = await loadAuthorized(ctx, args.workspaceId, args.operationId);
  const op = detail.operation;
  const approvalUrl = `${ctx.ports.origin()}/platform/operations/${encodeURIComponent(op.id)}`;

  const unavailable: { source: string; reason: string }[] = [];
  let progress: { status: string; steps: { step: string; status: string; startedAt?: string; endedAt?: string }[] } | undefined;
  let progressDetails: { step: string; detail: string }[] = [];
  if (op.status === "running" || op.status === "queued") {
    try {
      const p = await ctx.ports.workflows.progress(op.id);
      if (p) {
        progress = { status: p.status, steps: p.steps.map((s) => ({ step: s.step, status: s.status, ...(s.startedAt ? { startedAt: s.startedAt } : {}), ...(s.endedAt ? { endedAt: s.endedAt } : {}) })) };
        progressDetails = p.steps.filter((s) => s.detail).map((s) => ({ step: s.step, detail: s.detail as string }));
      } else unavailable.push({ source: "workflow-progress", reason: "No workflow progress is available for this operation. Its ledger status does not prove that a workflow started." });
    } catch {
      unavailable.push({ source: "workflow-progress", reason: "The workflow engine did not answer a progress query. The operation record above is still authoritative." });
    }
  }

  return {
    data: {
      operation: {
        id: op.id,
        capability: op.capability,
        status: op.status,
        workspaceId: op.workspaceId,
        ...(op.projectId ? { projectId: op.projectId } : {}),
        ...(op.environmentId ? { environmentId: op.environmentId } : {}),
        ...(op.resourceId ? { resourceId: op.resourceId } : {}),
        proposalDigest: op.proposalDigest,
        ...(op.planDigest ? { planDigest: op.planDigest } : {}),
        ...(Number.isSafeInteger(op.approvalRound) && op.approvalRound !== undefined && op.approvalRound >= 0 ? { approvalRound: op.approvalRound } : {}),
        approvalRequired: op.approvalRequired,
        risk: op.proposal.risk,
        ...(op.proposal.costDeltaUsd !== undefined ? { costDeltaUsd: op.proposal.costDeltaUsd } : {}),
        principal: { kind: op.principal.kind, id: op.principal.id, ...(op.principal.onBehalfOf ? { onBehalfOf: op.principal.onBehalfOf } : {}) },
        createdAt: op.createdAt,
        updatedAt: op.updatedAt,
        ...(op.startedAt ? { startedAt: op.startedAt } : {}),
        ...(op.finishedAt ? { finishedAt: op.finishedAt } : {}),
        expiresAt: op.expiresAt,
      },
      ...(detail.decision
        ? {
            decision: {
              outcome: detail.decision.outcome,
              reasons: detail.decision.reasons.map((r) => ({ code: r.code, message: r.message })),
              ...(detail.decision.approval ? { approval: detail.decision.approval } : {}),
              policyVersion: detail.decision.policyVersion,
              risk: detail.decision.risk,
            },
          }
        : {}),
      approvals: detail.approvals.map((a) => ({
        id: a.id,
        decision: a.decision,
        approverId: a.approverId,
        approverRole: a.approverRole,
        createdAt: a.createdAt,
        expiresAt: a.expiresAt,
        consumed: a.consumed,
      })),
      ...(progress ? { progress } : {}),
      ...(op.status === "awaiting_approval" ? { approvalUrl } : {}),
      nextStep: nextStepFor(op, approvalUrl),
    },
    untrusted: {
      proposal: { summary: op.proposal.summary, details: op.proposal.details, input: op.proposal.input },
      ...(op.result !== undefined ? { result: op.result } : {}),
      ...(op.error !== undefined ? { error: op.error } : {}),
      approvals: detail.approvals.map((a) => ({ id: a.id, approverName: a.approverName, ...(a.reason ? { reason: a.reason } : {}) })),
      ...(progressDetails.length > 0 ? { progress: progressDetails } : {}),
    },
    simulated: false,
    unavailable,
  };
}

export async function getOperationEvents(args: GetOperationEventsArgs, ctx: ToolContext): Promise<ToolOutput> {
  await loadAuthorized(ctx, args.workspaceId, args.operationId);
  const limit = args.limit ?? 100;
  const page = await ctx.broker.listOperationEvents({
    workspaceId: args.workspaceId,
    operationId: args.operationId,
    principal: ctx.principal.principal,
    ...(args.afterSeq !== undefined ? { afterSeq: args.afterSeq } : {}),
    limit,
  });
  const events = page.items;
  const last = events.at(-1);
  return {
    data: {
      operationId: args.operationId,
      count: events.length,
      limit,
      ...(last ? { nextAfterSeq: last.seq } : {}),
      events: events.map((e) => ({ seq: e.seq, id: e.id, ts: e.ts, type: e.type, correlationId: e.correlationId })),
    },
    untrusted: { events: events.map((e) => ({ seq: e.seq, ...(e.actor ? { actor: e.actor } : {}), data: e.data })) },
    truncated: events.length >= limit,
    notes: events.length >= limit ? ["There may be more events: call again with afterSeq set to nextAfterSeq."] : [],
  };
}
