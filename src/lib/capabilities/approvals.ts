/**
 * Approvals: human, digest-bound, expiring, single-use (ADR-0007).
 *
 * What makes an approval valid here, in the order it is checked:
 *
 *  1. The decider is a member of the workspace (a non-member gets `not_found`,
 *     the same answer as a foreign operation id).
 *  2. The decider is a plain HUMAN `user` principal AND presents a
 *     `BrowserSessionProof` for that same user. A model, an integration, the
 *     Navigator, a runner or a machine can never approve or reject — typed
 *     `approver_not_human`, and the attempt is written to the audit log.
 *  3. Role: at least the decision's `approval.minRole`; a viewer never decides.
 *  4. The operation is `awaiting_approval` and not expired.
 *  5. The digest the approver reviewed equals the operation's proposal digest.
 *  6. Separation of duties: when required, approver ≠ the requesting human
 *     (`principal.onBehalfOf ?? principal.id`).
 *  7. One decision per approver per operation. A second approval by the same
 *     user is refused (`duplicate_decision`) and counts once.
 *  8. `count > 1` needs N DISTINCT approvers; the operation becomes `approved`
 *     only when the Nth lands.
 *
 * Steps 3–8 are enforced again by the store (`recordApproval` is the only path
 * to `approved`), so the database, not this function, is the last word.
 *
 * Approving also re-evaluates the proposal against CURRENT policy, roles and
 * autonomy. If policy now denies it, or now asks for a stricter approval than
 * the one the proposal was created under, the approval is refused
 * (`policy_denied` / `reapproval_required`) rather than recorded against a
 * requirement the approver was not shown. The approval records the policy
 * bundle version in force; execution re-validates again.
 *
 * REVOKING an approval before execution cancels the whole proposal: the
 * approval row cannot be un-written (history is append-only), and a proposal
 * whose approval was withdrawn must not remain approvable in a weaker form. A
 * fresh proposal is needed.
 */
import type { ApprovalRequirement, OperationRecord, Principal } from "@/lib/controlplane/types";
import { BrokerError, isBrokerError, notFound } from "./errors";
import { requireHumanSession } from "./internal";
import { ROLE_RANK, type BrokerDeps } from "./ports";
import { reevaluate } from "./reevaluate";
import { scrubSecrets } from "./secret-guard";
import type { BrowserSessionProof, OperationView } from "./types";
import { operationView } from "./views";

export interface DecideInput {
  workspaceId: string;
  operationId: string;
  /** the digest the approver reviewed */
  proposalDigest: string;
  approver: Principal;
  session: BrowserSessionProof;
  reason?: string;
}

export interface ApprovalOutcome {
  operation: OperationView;
  approval: {
    id: string;
    decision: "approve" | "reject";
    approverId: string;
    approverRole: "viewer" | "editor" | "admin";
    policyVersion: string;
    createdAt: string;
    expiresAt: string;
  };
  /** distinct approvals recorded and how many the policy requires */
  approvals: { have: number; need: number };
  /** true when this decision moved the operation (approved or rejected) */
  finalized: boolean;
}

/** Is `current` a stronger requirement than `stored`? (more approvers, a higher role, or a newly required second person) */
export function isStricter(current: ApprovalRequirement, stored: ApprovalRequirement | undefined): boolean {
  if (!stored) return true;
  return current.count > stored.count || ROLE_RANK[current.minRole] > ROLE_RANK[stored.minRole] || (current.separationOfDuties && !stored.separationOfDuties);
}

const REFUSAL_CODES = new Set(["approver_not_human", "browser_session_required", "approver_role_insufficient", "separation_of_duties", "duplicate_decision", "digest_mismatch", "invalid_state", "operation_expired", "policy_denied", "reapproval_required"]);

/** Write the refusal to the audit log (best effort: a failed audit write never turns a refusal into an allow) and return the error for throwing. */
async function audited(
  deps: BrokerDeps,
  error: unknown,
  ctx: { workspaceId: string; operationId: string; actor: Principal; attempted: string; op?: { projectId?: string; environmentId?: string; resourceId?: string; correlationId: string } }
): Promise<unknown> {
  if (!isBrokerError(error) || !REFUSAL_CODES.has(error.code)) return error;
  try {
    await deps.store.appendEvent({
      type: "policy.evaluated",
      workspaceId: ctx.workspaceId,
      projectId: ctx.op?.projectId,
      environmentId: ctx.op?.environmentId,
      resourceId: ctx.op?.resourceId,
      operationId: ctx.operationId,
      correlationId: ctx.op?.correlationId ?? `refused_${ctx.operationId}`,
      actor: ctx.actor,
      data: { kind: "approval_refused", attempted: ctx.attempted, code: error.code, principalKind: ctx.actor.kind },
    });
  } catch {
    /* the refusal stands whether or not the audit row landed */
  }
  return error;
}

async function decide(deps: BrokerDeps, input: DecideInput, decision: "approve" | "reject"): Promise<ApprovalOutcome> {
  const { workspaceId, operationId, approver } = input;
  const attempted = decision;

  const access = await deps.roles.resolve(approver, workspaceId);
  if (access.role === "none") throw notFound();

  let op: OperationRecord | null = null;

  try {
    requireHumanSession(approver, input.session, "approve or reject an operation");
    if (access.role === "viewer") throw new BrokerError("approver_role_insufficient", "A viewer cannot approve or reject operations.", "Ask an editor or admin.");

    op = await deps.store.getOperation(workspaceId, operationId);
    if (!op) throw notFound();
    if (op.status !== "awaiting_approval") {
      throw new BrokerError("invalid_state", `This operation is ${op.status}; only an operation awaiting approval can be approved or rejected.`, undefined, { status: op.status });
    }
    if (Date.parse(op.expiresAt) <= deps.clock.now().getTime()) {
      await deps.store.expireOperation({ workspaceId, id: op.id });
      throw new BrokerError("operation_expired", "The operation expired before it was reviewed.", "Propose it again.");
    }
    if (op.proposalDigest !== input.proposalDigest) {
      throw new BrokerError("digest_mismatch", "The digest you reviewed does not match the operation's current proposal.", "Reload the operation and review the exact proposal.");
    }
    const stored = op.policyDecisionId ? await deps.store.getPolicyDecision(workspaceId, op.policyDecisionId) : null;
    if (!stored?.approval) {
      throw new BrokerError("invalid_state", "This operation has no recorded approval requirement, so it cannot be approved.");
    }

    let policyVersion: string;
    if (decision === "approve") {
      const re = await reevaluate(deps, op);
      if (re.gone) {
        throw new BrokerError("policy_denied", "The requester no longer has access, or the target no longer exists.", "Reject this proposal and propose again if it is still wanted.");
      }
      const current = re.evaluation.decision;
      if (current.outcome === "deny") {
        throw new BrokerError("policy_denied", "Policy no longer allows this proposal.", "Reject it and propose again if it is still wanted.", { reasons: current.reasons.map((r) => r.code).slice(0, 20) });
      }
      if (current.outcome === "require_approval" && current.approval && isStricter(current.approval, stored.approval)) {
        throw new BrokerError("reapproval_required", "Policy changed after this was proposed and now needs a stricter approval than the one this proposal was created under.", "Reject it and propose again.", {
          now: current.approval,
        });
      }
      policyVersion = re.evaluation.evaluated.policyVersion;
    } else {
      policyVersion = stored.policyVersion;
    }

    const recorded = await deps.store.recordApproval({
      workspaceId,
      operationId,
      approver,
      approverRole: access.role,
      decision,
      proposalDigest: input.proposalDigest,
      policyVersion,
      reason: input.reason === undefined ? undefined : input.reason.slice(0, 2000),
    });

    const finalized = recorded.operation.status !== "awaiting_approval";
    // The store appended operation.approved / operation.rejected with the decision. A partial
    // multi-approver set changes no status, so the broker records that it happened.
    if (!finalized) {
      await deps.store.appendEvent({
        workspaceId,
        projectId: op.projectId,
        environmentId: op.environmentId,
        resourceId: op.resourceId,
        operationId,
        correlationId: op.correlationId,
        actor: approver,
        type: "policy.evaluated",
        data: { kind: "approval_recorded", approvals: recorded.approvals, policyVersion, approvalId: recorded.approval.id },
      });
    }
    return {
      operation: operationView(recorded.operation),
      approval: {
        id: recorded.approval.id,
        decision,
        approverId: approver.id,
        approverRole: recorded.approval.approverRole,
        policyVersion: recorded.approval.policyVersion,
        createdAt: recorded.approval.createdAt,
        expiresAt: recorded.approval.expiresAt,
      },
      approvals: recorded.approvals,
      finalized,
    };
  } catch (error) {
    throw await audited(deps, error, { workspaceId, operationId, actor: approver, attempted, op: op ?? undefined });
  }
}

export const approve = (deps: BrokerDeps, input: DecideInput): Promise<ApprovalOutcome> => decide(deps, input, "approve");
export const reject = (deps: BrokerDeps, input: DecideInput): Promise<ApprovalOutcome> => decide(deps, input, "reject");

/**
 * Withdraw approval before execution. Allowed for an approver of the operation
 * or an admin. Cancels the operation (awaiting_approval | approved → cancelled)
 * and revokes any grant already issued for it; a claimed (running) operation
 * cannot be revoked here — that is the executor's cancellation.
 */
export async function revokeApproval(
  deps: BrokerDeps,
  input: { workspaceId: string; operationId: string; actor: Principal; session: BrowserSessionProof; reason?: string }
): Promise<{ operation: OperationView }> {
  const { workspaceId, operationId, actor } = input;
  const access = await deps.roles.resolve(actor, workspaceId);
  if (access.role === "none") throw notFound();
  try {
    requireHumanSession(actor, input.session, "revoke an approval");
  } catch (error) {
    throw await audited(deps, error, { workspaceId, operationId, actor, attempted: "revoke" });
  }
  const op = await deps.store.getOperation(workspaceId, operationId);
  if (!op) throw notFound();
  const approvals = await deps.store.listApprovals(workspaceId, operationId);
  const isApprover = approvals.some((a) => a.decision === "approve" && a.approver.id === actor.id);
  if (!isApprover && ROLE_RANK[access.role] < ROLE_RANK.admin) {
    throw await audited(deps, new BrokerError("role_insufficient", "Only an approver of this operation, or an admin, can withdraw approval.", "Ask one of them."), {
      workspaceId,
      operationId,
      actor,
      attempted: "revoke",
      op,
    });
  }
  const reason = scrubSecrets((input.reason ?? "").replace(/\s+/g, " ").slice(0, 300));
  const moved = await deps.store.cancelOperation({
    workspaceId,
    id: operationId,
    reason: `Approval revoked by ${actor.id}${reason ? `: ${reason}` : ""}. Propose again if the change is still wanted.`,
    actor,
  });
  if (!moved) {
    throw new BrokerError("invalid_state", `This operation is ${op.status}; approval can be withdrawn only before execution starts.`, undefined, { status: op.status });
  }
  return { operation: operationView(moved) };
}

