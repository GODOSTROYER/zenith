/**
 * Execution-ledger services: conditional tenant-scoped writes and their audit
 * events commit together. Null means no change (including idempotent repeats).
 * Suspending/cancelling/denying revokes earlier grants in that same transaction.
 * Cancellation records a requested stop; it makes no claim that cloud changes
 * were rolled back or that an in-flight external call was undone.
 */
import type { OperationRecord, Principal, Sql } from "@/lib/controlplane/types";
import * as execution from "@/lib/controlplane/db/repos/operations-execution";
import { transition } from "@/lib/controlplane/db/repos/operations";
import { revokeForOperation } from "@/lib/controlplane/db/repos/grants";
import { get as getPolicyDecision } from "@/lib/controlplane/db/repos/policy-decisions";
import { emitForOperation } from "@/lib/controlplane/events";

export type ExecutionWriteInput = execution.ExecutionWriteInput;
type Input = ExecutionWriteInput & { actor?: Principal };

export async function suspendForApproval(db: Sql, input: Input): Promise<OperationRecord | null> {
  return db.tx(async (tx) => {
    const op = await execution.suspendForApproval(tx, input);
    if (!op) return null;
    await revokeForOperation(tx, input.workspaceId, input.id);
    await emitForOperation(tx, op, "operation.prepared", { actor: input.actor, data: { kind: "approval_gate", status: op.status, planDigest: op.planDigest, policyDecisionId: op.policyDecisionId, message: "Execution suspended for a fresh human approval." } });
    return op;
  });
}

export async function setPlanDigest(db: Sql, input: Input & { planDigest: string }): Promise<OperationRecord | null> {
  return db.tx(async (tx) => {
    const op = await execution.setPlanDigest(tx, input);
    if (!op) return null;
    await emitForOperation(tx, op, "operation.prepared", { actor: input.actor, data: { kind: "plan_digest", planDigest: op.planDigest } });
    return op;
  });
}

export async function setPolicyDecision(db: Sql, input: Input & { decisionId: string }): Promise<OperationRecord | null> {
  return db.tx(async (tx) => {
    const op = await execution.setPolicyDecision(tx, input);
    if (!op) return null;
    const decision = await getPolicyDecision(tx, input.workspaceId, input.decisionId);
    await emitForOperation(tx, op, "policy.evaluated", { actor: input.actor, data: { kind: "execution_policy_linked", policyDecisionId: op.policyDecisionId, outcome: decision?.outcome, policyVersion: decision?.policyVersion } });
    return op;
  });
}

/** Trusted execution stop. User-facing pre-execution cancellation remains `cancelOperation`. */
export async function cancelRunningOperation(db: Sql, input: Input & { reason?: string }): Promise<OperationRecord | null> {
  return db.tx(async (tx) => {
    const op = await transition(tx, { workspaceId: input.workspaceId, id: input.id, from: ["running"], to: "cancelled", patch: { error: input.reason }, fence: input.fence });
    if (!op) return null;
    await revokeForOperation(tx, input.workspaceId, input.id);
    await emitForOperation(tx, op, "operation.cancelled", { actor: input.actor, data: input.reason ? { reason: input.reason.slice(0, 500) } : {} });
    return op;
  });
}

/** Clean additive approved → denied edge, tied to the exact persisted denial. */
export async function denyOperation(db: Sql, input: Input & { decisionId: string }): Promise<OperationRecord | null> {
  return db.tx(async (tx) => {
    const op = await execution.deny(tx, input);
    if (!op) return null;
    await revokeForOperation(tx, input.workspaceId, input.id);
    await emitForOperation(tx, op, "operation.denied", { actor: input.actor, data: { policyDecisionId: op.policyDecisionId } });
    return op;
  });
}
