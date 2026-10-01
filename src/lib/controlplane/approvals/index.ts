/**
 * Approvals service: `decide` records a human decision and appends the matching
 * event in the same transaction. The rules (human-only, digest-bound, role,
 * separation of duties, single decision per approver per round, expiry, single-use
 * consumption at claim time) live in `db/repos/approvals.ts`; this is only the
 * event-emitting wrapper other subsystems import.
 */
import type { Sql } from "@/lib/controlplane/types";
import { record, listForOperation, consume, type RecordApprovalInput, type RecordApprovalResult } from "@/lib/controlplane/db/repos/approvals";
import { emitForOperation } from "@/lib/controlplane/events";

export { record, listForOperation, consume };
export type { RecordApprovalInput, RecordApprovalResult };

/**
 * Record an approve/reject decision and append `operation.approved` /
 * `operation.rejected` when the decision moved the operation. A partial
 * multi-approver set (approved by one of two required) appends nothing yet.
 */
export async function decide(db: Sql, input: RecordApprovalInput): Promise<RecordApprovalResult> {
  return db.tx(async (tx) => {
    const result = await record(tx, input);
    const status = result.operation.status;
    if (status === "approved" || status === "rejected") {
      await emitForOperation(tx, result.operation, status === "approved" ? "operation.approved" : "operation.rejected", {
        actor: input.approver,
        data: {
          approvalId: result.approval.id,
          approverRole: input.approverRole,
          approvals: result.approvals,
          proposalDigest: input.proposalDigest,
          policyVersion: input.policyVersion,
          ...(input.reason ? { reason: input.reason.slice(0, 500) } : {}),
        },
      });
    }
    return result;
  });
}
