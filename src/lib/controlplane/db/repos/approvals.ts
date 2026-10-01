/**
 * Human, digest-bound, single-use, expiring approvals.
 *
 * `record` is the ONLY path by which an operation that requires approval
 * becomes `approved`, and it does everything in one transaction:
 *
 *   lock the operation → check the approver is a human user → check the digest
 *   the approver reviewed equals the stored proposal digest → check role,
 *   separation of duties and duplicate decisions → insert the approval →
 *   transition `awaiting_approval` → `approved` (when enough distinct approvers
 *   have approved) or `rejected` (immediately, on any reject).
 *
 * Invariants enforced here rather than trusted from callers:
 *  - Only `principal.kind === "user"` may decide. An integration, navigator,
 *    system, runner or machine principal — even one with `onBehalfOf` naming a
 *    human — is refused (`approver_not_human`); a model can never approve.
 *  - The digest must match the operation's proposal digest exactly; an approval
 *    of a different (or earlier) proposal is refused (`digest_mismatch`).
 *  - A viewer cannot decide (`approver_role_insufficient`); the policy
 *    decision's `minRole` and `separationOfDuties` are enforced when the
 *    operation has one (`separation_of_duties`).
 *  - One decision per approver per approval round (`duplicate_decision`).
 *  - An approval expires (at most when the operation does) and is consumed
 *    exactly once by `operations.claimForExecution`.
 */
import type { ApprovalRecord, ApprovalRequirement, Principal, Sql, OperationRecord, OperationStatus } from "@/lib/controlplane/types";
import { ControlStoreError, requireText } from "../errors";
import { assertNoSecretValues } from "../secrets";
import { boundedMs, json, newId, opt, requireDigest } from "../sql";
import { consumeApprovals, type ConsumeApprovalsInput } from "./approval-core";
import { OPERATION_COLUMNS, toOperation, type OperationRow } from "./operations";

export { consumeApprovals, requiredApprovalCount } from "./approval-core";

interface ApprovalRow {
  id: string;
  operation_id: string;
  workspace_id: string;
  proposal_digest: string;
  decision: "approve" | "reject";
  approver: Principal;
  approver_role: "viewer" | "editor" | "admin";
  reason: string | null;
  policy_version: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

const APPROVAL_COLUMNS =
  "id, operation_id, workspace_id, proposal_digest, decision, approver, approver_role, reason, policy_version, created_at, expires_at, consumed_at";

const toApproval = (row: ApprovalRow): ApprovalRecord => ({
  id: row.id,
  operationId: row.operation_id,
  workspaceId: row.workspace_id,
  proposalDigest: row.proposal_digest,
  decision: row.decision,
  approver: row.approver,
  approverRole: row.approver_role,
  reason: opt(row.reason),
  policyVersion: row.policy_version,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  consumedAt: opt(row.consumed_at),
});

const ROLE_RANK = { viewer: 0, editor: 1, admin: 2 } as const;

export interface RecordApprovalInput {
  workspaceId: string;
  operationId: string;
  /** who is deciding — must be `kind: "user"` */
  approver: Principal;
  approverRole: "viewer" | "editor" | "admin";
  decision: "approve" | "reject";
  /** the digest the approver actually reviewed */
  proposalDigest: string;
  /** the policy bundle digest in force; a changed bundle invalidates the approval at claim time */
  policyVersion: string;
  reason?: string;
  /** approval validity, capped at the operation's own expiry (default 1 h) */
  ttlMs?: number;
}

export interface RecordApprovalResult {
  approval: ApprovalRecord;
  /** the operation after the decision (`approved`, `rejected`, or still `awaiting_approval` for a partial multi-approver set) */
  operation: OperationRecord;
  /** distinct approvals recorded so far, and how many the policy requires */
  approvals: { have: number; need: number };
}

export async function record(sql: Sql, input: RecordApprovalInput): Promise<RecordApprovalResult> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const operationId = requireText("operationId", input.operationId);
  const { approver } = input;
  if (approver.kind !== "user" || approver.onBehalfOf !== undefined || approver.integrationId !== undefined)
    throw new ControlStoreError(
      "approver_not_human",
      "Only a human user can approve or reject an operation. Agents, integrations, runners and system principals never can.",
      { approverKind: approver.kind }
    );
  const approverId = requireText("approver.id", approver.id);
  const proposalDigest = requireDigest("proposalDigest", input.proposalDigest);
  const policyVersion = requireText("policyVersion", input.policyVersion, 128);
  if (input.decision !== "approve" && input.decision !== "reject")
    throw new ControlStoreError("invalid_input", "decision must be approve or reject.");
  if (!(input.approverRole in ROLE_RANK)) throw new ControlStoreError("invalid_input", "approverRole must be viewer, editor or admin.");
  if (input.approverRole === "viewer")
    throw new ControlStoreError("approver_role_insufficient", "A viewer cannot approve or reject operations.", { role: input.approverRole });
  if (input.reason !== undefined) {
    if (input.reason.length > 2000) throw new ControlStoreError("invalid_input", "reason is too long (max 2000 characters).");
    assertNoSecretValues(input.reason, "reason");
  }
  const ttl = boundedMs("ttlMs", input.ttlMs ?? 60 * 60 * 1000, 1000, 7 * 24 * 60 * 60 * 1000);

  return sql.tx(async (tx) => {
    const locked = await tx.query<{ status: OperationStatus; proposal_digest: string; principal: Principal; policy_decision_id: string | null; approval_round: number; is_expired: boolean }>(
      `select status, proposal_digest, principal, policy_decision_id, approval_round, (expires_at <= clock_timestamp()) as is_expired
         from platform.operations where workspace_id = $1 and id = $2 for update`,
      [workspaceId, operationId]
    );
    if (locked.length === 0) throw new ControlStoreError("operation_not_found", "Operation not found.", { id: operationId });
    const op = locked[0];
    if (op.status !== "awaiting_approval")
      throw new ControlStoreError("invalid_state", `Operation is ${op.status}; only an operation awaiting approval can be approved or rejected.`, { id: operationId, status: op.status });
    if (op.is_expired) throw new ControlStoreError("operation_expired", "The operation expired before it was reviewed.", { id: operationId });
    if (op.proposal_digest !== proposalDigest)
      throw new ControlStoreError("digest_mismatch", "The digest you reviewed does not match the operation's current proposal. Reload and review the exact proposal.", { id: operationId });

    let requirement: ApprovalRequirement | null = null;
    if (op.policy_decision_id) {
      const decisions = await tx.query<{ approval: ApprovalRequirement | null }>(
        "select approval from platform.policy_decisions where workspace_id = $1 and id = $2",
        [workspaceId, op.policy_decision_id]
      );
      requirement = decisions[0]?.approval ?? null;
    }
    const need = requirement && Number.isInteger(requirement.count) && requirement.count >= 1 ? requirement.count : 1;
    if (requirement && ROLE_RANK[input.approverRole] < ROLE_RANK[requirement.minRole])
      throw new ControlStoreError("approver_role_insufficient", `This operation needs an approver with at least the ${requirement.minRole} role.`, { need: requirement.minRole, role: input.approverRole });
    const requester = op.principal.onBehalfOf ?? op.principal.id;
    if (requirement?.separationOfDuties && approverId === requester)
      throw new ControlStoreError("separation_of_duties", "The requester cannot approve their own operation; a different approver is required.", { id: operationId });

    const inserted = await tx.query<ApprovalRow>(
      `insert into platform.approvals (id, operation_id, workspace_id, proposal_digest, decision, approver, approver_id,
                                       approver_role, reason, policy_version, approval_round, expires_at)
       select $1, o.id, o.workspace_id, $4, $5, $6::text::jsonb, $7, $8, $9, $10,
              o.approval_round,
              least(o.expires_at, clock_timestamp() + ($11::bigint * interval '1 millisecond'))
         from platform.operations o where o.workspace_id = $2 and o.id = $3
       on conflict (operation_id, approval_round, approver_id) do nothing
       returning ${APPROVAL_COLUMNS}`,
      [newId("apr"), workspaceId, operationId, proposalDigest, input.decision, json(approver), approverId, input.approverRole, input.reason ?? null, policyVersion, ttl]
    );
    if (inserted.length === 0)
      throw new ControlStoreError("duplicate_decision", "This approver has already decided in this approval round.", { id: operationId });
    const approval = toApproval(inserted[0]);

    let have = 0;
    let moved: OperationRecord | null;
    if (input.decision === "reject") {
      moved = await moveOperation(tx, workspaceId, operationId, "rejected");
    } else {
      const counted = await tx.query<{ n: number }>(
        `select count(*)::int as n from platform.approvals
          where workspace_id = $1 and operation_id = $2 and decision = 'approve' and proposal_digest = $3
            and approval_round = $4::integer and consumed_at is null and expires_at > clock_timestamp()
            and policy_version = $5`,
        [workspaceId, operationId, proposalDigest, op.approval_round, policyVersion]
      );
      have = counted[0]?.n ?? 0;
      moved = have >= need ? await moveOperation(tx, workspaceId, operationId, "approved") : await currentOperation(tx, workspaceId, operationId);
    }
    if (!moved) throw new ControlStoreError("invalid_state", "Operation changed while the decision was being recorded.", { id: operationId });
    return { approval, operation: moved, approvals: { have, need } };
  });
}

/** Approve/reject transition owned by this module: the only writer of `awaiting_approval → approved`. */
async function moveOperation(sql: Sql, workspaceId: string, id: string, to: "approved" | "rejected"): Promise<OperationRecord | null> {
  const rows = await sql.query<OperationRow>(
    `update platform.operations
        set status = $3::text, updated_at = clock_timestamp(),
            finished_at = case when $3::text = 'rejected' then clock_timestamp() else finished_at end
      where workspace_id = $1 and id = $2 and status = 'awaiting_approval' and expires_at > clock_timestamp()
      returning ${OPERATION_COLUMNS}`,
    [workspaceId, id, to]
  );
  return rows.length ? toOperation(rows[0]) : null;
}

async function currentOperation(sql: Sql, workspaceId: string, id: string): Promise<OperationRecord | null> {
  const rows = await sql.query<OperationRow>(
    `select ${OPERATION_COLUMNS} from platform.operations where workspace_id = $1 and id = $2`,
    [workspaceId, id]
  );
  return rows.length ? toOperation(rows[0]) : null;
}

/** Every recorded decision for one operation, oldest first. Workspace-scoped in SQL. */
export async function listForOperation(sql: Sql, workspaceId: string, operationId: string): Promise<ApprovalRecord[]> {
  const rows = await sql.query<ApprovalRow>(
    `select ${APPROVAL_COLUMNS} from platform.approvals
      where workspace_id = $1 and operation_id = $2 order by created_at, id`,
    [requireText("workspaceId", workspaceId), requireText("operationId", operationId)]
  );
  return rows.map(toApproval);
}

/**
 * Consume the valid approvals of an operation on their own (outside
 * `claimForExecution`). Returns the consumed approval ids; an empty list when
 * none is available — in particular on every call after the first.
 */
export async function consume(sql: Sql, input: ConsumeApprovalsInput): Promise<string[]> {
  const consumed = await consumeApprovals(sql, {
    workspaceId: requireText("workspaceId", input.workspaceId),
    operationId: requireText("operationId", input.operationId),
    proposalDigest: requireDigest("proposalDigest", input.proposalDigest),
    expectedPolicyVersion: input.expectedPolicyVersion,
  });
  return consumed.map((c) => c.id);
}
