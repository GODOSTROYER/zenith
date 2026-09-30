/**
 * The two approval primitives the operations repository needs at claim time,
 * kept below both `operations.ts` and `approvals.ts` so neither imports the
 * other. Everything else about approvals lives in `approvals.ts`.
 */
import type { ApprovalRequirement, Sql } from "@/lib/controlplane/types";

/**
 * How many distinct human approvals an operation needs: the `count` of the
 * policy decision's approval requirement, else 1.
 */
export async function requiredApprovalCount(sql: Sql, workspaceId: string, policyDecisionId: string | null): Promise<number> {
  if (!policyDecisionId) return 1;
  const rows = await sql.query<{ approval: ApprovalRequirement | null }>(
    "select approval from platform.policy_decisions where workspace_id = $1 and id = $2",
    [workspaceId, policyDecisionId]
  );
  const count = rows[0]?.approval?.count;
  return typeof count === "number" && Number.isInteger(count) && count >= 1 ? count : 1;
}

export interface ConsumeApprovalsInput {
  workspaceId: string;
  operationId: string;
  /** only approvals of exactly this digest count */
  proposalDigest: string;
  /** when set, only approvals granted under this policy bundle count */
  expectedPolicyVersion?: string;
}

/**
 * Mark every valid, unconsumed `approve` row for the operation as consumed, in
 * one UPDATE, and return them. Single-use: a second call returns an empty list
 * because `consumed_at IS NULL` no longer matches. Valid means: same workspace,
 * same operation, same digest, not expired, (optionally) same policy version.
 */
export async function consumeApprovals(sql: Sql, input: ConsumeApprovalsInput): Promise<{ id: string; approverId: string }[]> {
  const rows = await sql.query<{ id: string; approver_id: string }>(
    `update platform.approvals set consumed_at = clock_timestamp()
      where workspace_id = $1 and operation_id = $2 and decision = 'approve'
        and proposal_digest = $3 and consumed_at is null and expires_at > clock_timestamp()
        and ($4::text is null or policy_version = $4::text)
      returning id, approver_id`,
    [input.workspaceId, input.operationId, input.proposalDigest, input.expectedPolicyVersion ?? null]
  );
  return rows.map((r) => ({ id: r.id, approverId: r.approver_id }));
}

/** Valid unconsumed approvals ignoring policy version — distinguishes "none" from "wrong policy bundle". */
export async function countUnconsumedApprovals(sql: Sql, input: Omit<ConsumeApprovalsInput, "expectedPolicyVersion">): Promise<number> {
  const rows = await sql.query<{ n: number }>(
    `select count(*)::int as n from platform.approvals
      where workspace_id = $1 and operation_id = $2 and decision = 'approve'
        and proposal_digest = $3 and consumed_at is null and expires_at > clock_timestamp()`,
    [input.workspaceId, input.operationId, input.proposalDigest]
  );
  return rows[0]?.n ?? 0;
}
