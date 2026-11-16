/**
 * Reading and cancelling operations on behalf of a principal.
 *
 * Every function starts the same way: the principal must be a member of the
 * workspace (else `not_found`, the answer a foreign id gets), and an
 * integration credential restricted to some projects or environments sees only
 * those — an operation outside its grant is `not_found` too. Lookups are
 * workspace-scoped in the store, so an id from another tenant is `null`.
 */
import type { OperationRecord, Principal } from "@/lib/controlplane/types";
import { approvalRoundOf, operationPlanReview, type ApprovalRoundMetadata, type OperationPlanReview } from "@/lib/controlplane/db/repos/operation-review";
import { BrokerError, notFound } from "./errors";
import { memberAccess, requesterOf } from "./internal";
import { ROLE_RANK, type BrokerDeps, type OperationFilters, type ResolvedAccess } from "./ports";
import { scrubSecrets } from "./secret-guard";
import type { DecisionView, OperationView } from "./types";
import { decisionView, operationView } from "./views";
import type { BrokerProposal } from "./types";

const visible = (access: ResolvedAccess, op: OperationRecord): boolean =>
  (!access.allowedProjectIds || (op.projectId !== undefined && access.allowedProjectIds.includes(op.projectId))) &&
  (!access.allowedEnvironmentIds || (op.environmentId !== undefined && access.allowedEnvironmentIds.includes(op.environmentId)));

export interface OperationDetail {
  operation: OperationView & Partial<ApprovalRoundMetadata>;
  /** The decision linked to the current approval round. */
  decision?: DecisionView;
  /** Original planning evidence; absent means unavailable, never an empty plan. */
  planReview?: Pick<OperationPlanReview, "planDigest" | "view" | "cost" | "semantics"> & { decision?: DecisionView };
  approvals: {
    id: string;
    decision: "approve" | "reject";
    approverId: string;
    approverName: string;
    approverRole: string;
    reason?: string;
    policyVersion: string;
    createdAt: string;
    expiresAt: string;
    consumed: boolean;
    approvalRound: number;
  }[];
}

export async function getOperationDetail(deps: BrokerDeps, input: { workspaceId: string; operationId: string; principal: Principal }): Promise<OperationDetail> {
  const access = await memberAccess(deps, input.principal, input.workspaceId);
  const op = await deps.store.getOperation(input.workspaceId, input.operationId);
  if (!op || !visible(access, op)) throw notFound();
  const decision = op.policyDecisionId ? await deps.store.getPolicyDecision(input.workspaceId, op.policyDecisionId) : null;
  const approvals = await deps.store.listApprovals(input.workspaceId, op.id);
  const review = operationPlanReview(op);
  const policy = decision ? decisionView(decision, { risk: (op.proposal as BrokerProposal).risk }) : undefined;
  return {
    operation: { ...operationView(op), approvalRound: approvalRoundOf(op) },
    ...(policy ? { decision: policy } : {}),
    ...(review ? { planReview: { planDigest: review.planDigest, view: review.view, cost: review.cost, ...(review.semantics ? { semantics: review.semantics } : {}), ...(policy ? { decision: policy } : {}) } } : {}),
    approvals: approvals.map((a) => ({
      id: a.id,
      decision: a.decision,
      approverId: a.approver.id,
      approverName: a.approver.name,
      approverRole: a.approverRole,
      ...(a.reason ? { reason: scrubSecrets(a.reason) } : {}),
      policyVersion: a.policyVersion,
      createdAt: a.createdAt,
      expiresAt: a.expiresAt,
      consumed: a.consumedAt !== undefined,
      approvalRound: approvalRoundOf(a),
    })),
  };
}

export async function listOperations(
  deps: BrokerDeps,
  input: { workspaceId: string; principal: Principal; filters?: OperationFilters; limit?: number; cursor?: string }
): Promise<{ items: OperationView[]; nextCursor?: string }> {
  const access = await memberAccess(deps, input.principal, input.workspaceId);
  const page = await deps.store.listOperations(input.workspaceId, input.filters, { limit: input.limit, cursor: input.cursor });
  return { items: page.items.filter((op) => visible(access, op)).map(operationView), nextCursor: page.nextCursor };
}

export interface EventView {
  seq: number;
  id: string;
  ts: string;
  type: string;
  operationId?: string;
  correlationId: string;
  actor?: { kind: string; id: string; name: string };
  data: Record<string, unknown>;
}

export async function listOperationEvents(
  deps: BrokerDeps,
  input: { workspaceId: string; operationId: string; principal: Principal; afterSeq?: number; limit?: number }
): Promise<{ items: EventView[] }> {
  const access = await memberAccess(deps, input.principal, input.workspaceId);
  const op = await deps.store.getOperation(input.workspaceId, input.operationId);
  if (!op || !visible(access, op)) throw notFound();
  const events = await deps.store.listEvents(input.workspaceId, { operationId: op.id, afterSeq: input.afterSeq, limit: input.limit });
  return {
    items: events.map((e) => ({
      seq: e.seq,
      id: e.id,
      ts: e.ts,
      type: e.type,
      operationId: e.operationId,
      correlationId: e.correlationId,
      ...(e.actor ? { actor: { kind: e.actor.kind, id: e.actor.id, name: e.actor.name } } : {}),
      data: scrubSecrets(e.data),
    })),
  };
}

/**
 * Cancel an operation before execution starts (proposed | awaiting_approval |
 * approved | queued). Allowed for the principal that proposed it, for the human
 * an agent proposed it for, and for any editor or admin. A viewer who did not
 * propose it, and an integration that did not propose it, cannot. A running
 * operation is the executor's to stop, not the broker's.
 */
export async function cancelOperation(deps: BrokerDeps, input: { workspaceId: string; operationId: string; principal: Principal; reason?: string }): Promise<OperationView> {
  const { workspaceId, principal } = input;
  const access = await memberAccess(deps, principal, workspaceId);
  const op = await deps.store.getOperation(workspaceId, input.operationId);
  if (!op || !visible(access, op)) throw notFound();

  const isRequester = op.principal.kind === principal.kind && op.principal.id === principal.id;
  const isRequestersHuman = principal.kind === "user" && requesterOf(op.principal) === principal.id;
  const isStaff = principal.kind === "user" && ROLE_RANK[access.role] >= ROLE_RANK.editor;
  if (!isRequester && !isRequestersHuman && !isStaff) {
    throw new BrokerError("role_insufficient", "Only the requester, or an editor or admin, can cancel this operation.", "Ask one of them.");
  }
  const reason = scrubSecrets((input.reason ?? "").replace(/\s+/g, " ").slice(0, 300));
  const moved = await deps.store.cancelOperation({
    workspaceId,
    id: op.id,
    reason: `Cancelled by ${principal.kind} ${principal.id}${reason ? `: ${reason}` : ""}.`,
    actor: principal,
  });
  if (!moved) {
    throw new BrokerError("invalid_state", `This operation is ${op.status}; only an operation that has not started can be cancelled.`, undefined, { status: op.status });
  }
  return operationView(moved);
}
