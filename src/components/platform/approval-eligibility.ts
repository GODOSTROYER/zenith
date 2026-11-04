/**
 * May this viewer approve or reject this proposal right now, and if not, why?
 *
 * Pure and client-safe. This is the UI's reading of the rules the approval
 * service enforces (ADR-0007): the service remains the authority and will still
 * refuse a decision this helper allowed, but the interface must never offer a
 * button that can only fail, and must say in a sentence why it is withheld.
 *
 * Checks run in a fixed order and the first that fails wins, so the reason shown
 * is stable:
 *   1. the operation is not waiting for a decision (any other status)
 *   2. the proposal has expired (or its expiry cannot be read: fail closed)
 *   3. the proposal changed after the viewer opened it (digest mismatch)
 *   4. policy did not say who may approve (no decision, or `require_approval`
 *      without an approval requirement): fail closed, never guess a default
 *   5. the viewer already decided on this exact proposal
 *   6. enough approvals are already recorded
 *   7. the viewer's role is below the minimum
 *   8. the viewer is the requester and policy demands a second person
 *
 * Approvals only count when they are for the operation's current digest, were
 * made under the policy version now in force, are unexpired, and come from a
 * role that meets the minimum. Reject uses the same gate: the control plane
 * records both decisions through the same service, so this UI cannot know of a
 * looser rule for rejecting and does not invent one.
 */
import type { ApprovalRecord, OperationRecord, PolicyDecisionRecord } from "@/lib/controlplane/types";
import { OPERATION_STATUS_SENTENCE, ROLE_RANK, type RoleName } from "./labels";
import { parseTime } from "./text";

export interface ApprovalViewer {
  /** the signed-in human's user id */
  id: string;
  /** the viewer's workspace role; "none" when not a member */
  role: RoleName;
  /**
   * The proposal digest the viewer was shown when they opened the page. If the
   * operation's digest has since moved, the viewer has not reviewed what would
   * be approved. Omit when the host cannot tell.
   */
  reviewedDigest?: string;
}

export type IneligibleReason =
  | "not_awaiting_approval"
  | "expired"
  | "digest_changed"
  | "policy_unavailable"
  | "already_decided"
  | "already_satisfied"
  | "role_too_low"
  | "is_requester";

export type ApprovalEligibility =
  | { eligible: true }
  | { eligible: false; reason: IneligibleReason; message: string };

export interface ApprovalProgress {
  /** how many distinct approvers policy asks for; undefined when policy did not say */
  required: number | undefined;
  /** distinct approvers whose approval currently counts */
  granted: number;
}

const toMs = (now: Date | string | number | undefined): number =>
  now === undefined ? Date.now() : typeof now === "number" ? now : new Date(now).getTime();

/** The human the operation runs on behalf of, which is who "the requester" means. */
export function requesterId(operation: Pick<OperationRecord, "principal">): string | undefined {
  const p = operation.principal;
  return p.kind === "user" ? p.id : p.onBehalfOf;
}

/** An approval counts toward this operation's requirement only if it is current. */
function countsTowardOperation(
  a: ApprovalRecord,
  operation: OperationRecord,
  decision: PolicyDecisionRecord | undefined,
  nowMs: number
): boolean {
  if (a.operationId !== operation.id) return false;
  if (a.decision !== "approve") return false;
  if (a.proposalDigest !== operation.proposalDigest) return false;
  if (decision && a.policyVersion !== decision.policyVersion) return false;
  const exp = parseTime(a.expiresAt);
  if (exp === undefined || exp <= nowMs) return false;
  const min = decision?.approval?.minRole;
  if (min && ROLE_RANK[a.approverRole] < ROLE_RANK[min]) return false;
  return true;
}

export function approvalProgress(
  operation: OperationRecord,
  decision: PolicyDecisionRecord | undefined,
  approvals: readonly ApprovalRecord[],
  now?: Date | string | number
): ApprovalProgress {
  const nowMs = toMs(now);
  const ids = new Set(
    approvals.filter((a) => countsTowardOperation(a, operation, decision, nowMs)).map((a) => a.approver.id)
  );
  return { required: decision?.approval?.count, granted: ids.size };
}

function no(reason: IneligibleReason, message: string): ApprovalEligibility {
  return { eligible: false, reason, message };
}

export function approvalEligibility(
  viewer: ApprovalViewer,
  operation: OperationRecord,
  decision: PolicyDecisionRecord | undefined,
  approvals: readonly ApprovalRecord[],
  now?: Date | string | number
): ApprovalEligibility {
  const nowMs = toMs(now);

  // 1. only a proposal that is waiting can be decided
  if (operation.status !== "awaiting_approval") {
    return no("not_awaiting_approval", `This change is not waiting for a decision. ${OPERATION_STATUS_SENTENCE[operation.status]}`);
  }

  // 2. expiry (an unreadable expiry fails closed)
  const expiresAt = parseTime(operation.expiresAt);
  if (expiresAt === undefined) {
    return no("expired", "Zenith cannot read when this proposal expires, so it will not take a decision on it. Ask for a new proposal.");
  }
  if (expiresAt <= nowMs) {
    return no("expired", "This proposal has expired. Ask for a new proposal to review.");
  }

  // 3. the viewer must be deciding on what they reviewed
  if (viewer.reviewedDigest !== undefined && viewer.reviewedDigest !== operation.proposalDigest) {
    return no("digest_changed", "This proposal changed after you opened it. Reload to review the new version before deciding.");
  }

  // 4. policy must have said who may approve
  if (!decision) {
    return no("policy_unavailable", "The policy decision for this proposal is not available, so Zenith cannot tell who may approve it.");
  }
  if (decision.outcome !== "require_approval") {
    return no(
      "policy_unavailable",
      decision.outcome === "deny"
        ? "Policy blocked this change, so it cannot be approved."
        : "Policy did not ask for an approval on this change."
    );
  }
  const requirement = decision.approval;
  if (!requirement) {
    return no("policy_unavailable", "The policy decision does not say who may approve this change, so Zenith will not offer a decision.");
  }

  // 5. one decision per person per proposal
  const mine = approvals.find(
    (a) =>
      a.operationId === operation.id &&
      a.proposalDigest === operation.proposalDigest &&
      a.approver.id === viewer.id &&
      (a.decision === "reject" || countsTowardOperation(a, operation, decision, nowMs))
  );
  if (mine) {
    return no(
      "already_decided",
      mine.decision === "approve" ? "You already approved this proposal." : "You already rejected this proposal."
    );
  }

  // 6. nothing left to decide
  const { granted } = approvalProgress(operation, decision, approvals, nowMs);
  if (granted >= requirement.count) {
    return no("already_satisfied", "Enough approvals are already recorded for this proposal. It is waiting to run.");
  }

  // 7. role
  if (ROLE_RANK[viewer.role] < ROLE_RANK[requirement.minRole]) {
    const have = viewer.role === "none" ? "are not a member of this workspace" : `have the ${viewer.role} role`;
    return no("role_too_low", `Approving this change needs the ${requirement.minRole} role or higher, and you ${have}.`);
  }

  // 8. separation of duties
  if (requirement.separationOfDuties && requesterId(operation) === viewer.id) {
    return no(
      "is_requester",
      operation.principal.kind === "user"
        ? "You requested this change, and policy needs a different person to approve it."
        : "This change was proposed on your behalf, and policy needs a different person to approve it."
    );
  }

  return { eligible: true };
}
