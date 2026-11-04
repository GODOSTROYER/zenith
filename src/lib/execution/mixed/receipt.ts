/**
 * The durable child receipt (PROD-MIX-02). A receipt is a digest-bound statement
 * that one child operation reached a terminal outcome under the semantics that
 * were approved for it. It carries digests and a status string, never outputs.
 * Identity is derived from content, so recording the same outcome twice (a crashed
 * and retried activity) is the same receipt, and a different outcome for the same
 * child is a conflict the database refuses.
 */
import { digest } from "@/lib/controlplane/digest";
import { MIXED_RECEIPT_FORMAT, type ChildReceipt, type ChildTerminalOutcome } from "./types";

export interface ReceiptFields {
  workspaceId: string;
  parentPlanId: string;
  partitionId: string;
  ordinal: number;
  childOperationId: string;
  outcome: ChildTerminalOutcome;
  childStatus: string;
  executableSemanticsDigest?: string;
  planDigest?: string;
  outputsDigest?: string;
}

export function receiptDigestOf(fields: ReceiptFields): string {
  return digest({ format: MIXED_RECEIPT_FORMAT, ...fields });
}

export function buildReceipt(fields: ReceiptFields, recordedAt: string): ChildReceipt {
  const receiptDigest = receiptDigestOf(fields);
  return {
    format: MIXED_RECEIPT_FORMAT, receiptId: `mrc_${receiptDigest.slice(0, 32)}`, workspaceId: fields.workspaceId, parentPlanId: fields.parentPlanId,
    partitionId: fields.partitionId, ordinal: fields.ordinal, childOperationId: fields.childOperationId, outcome: fields.outcome, childStatus: fields.childStatus,
    ...(fields.executableSemanticsDigest ? { executableSemanticsDigest: fields.executableSemanticsDigest } : {}),
    ...(fields.planDigest ? { planDigest: fields.planDigest } : {}),
    ...(fields.outputsDigest ? { outputsDigest: fields.outputsDigest } : {}),
    receiptDigest, recordedAt,
  };
}

/** Map a child operation's terminal platform status to a receipt outcome. Anything not terminal is `undefined`. */
export function outcomeOfOperationStatus(status: string): ChildTerminalOutcome | undefined {
  switch (status) {
    case "succeeded": return "succeeded";
    case "failed": case "denied": case "rejected": case "expired": return "failed";
    case "uncertain": return "uncertain";
    case "cancelled": return "cancelled";
    default: return undefined;
  }
}
