/**
 * Operations service: the repository operations, each committed TOGETHER with
 * the event that describes it, in one transaction — so the ledger row and its
 * audit event can never disagree, and a crash between them cannot happen.
 *
 * Every function takes the top-level store (or any `Sql`; inside an open
 * transaction it joins it as a savepoint) and is database-only, so it is safe
 * to retry on a serialization failure.
 *
 * Lifecycle helpers (see `OperationStatus`, `controlplane/types.ts`):
 *   proposeOperation → [policy: recordPolicyOutcome] → approvals.decide
 *   → claimOperation → completeOperation | (crash) reconcileOperations
 */
import type { OperationRecord, PolicyDecisionRecord, Principal, Sql } from "@/lib/controlplane/types";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import { append } from "@/lib/controlplane/db/repos/events";
import {
  claimForExecution,
  create,
  expireOverdue,
  markUncertainExpired,
  transition,
  type ClaimInput,
  type CreateOperationInput,
  type CreateOperationResult,
} from "@/lib/controlplane/db/repos/operations";
import { insert as insertPolicyDecision, type InsertPolicyDecisionInput } from "@/lib/controlplane/db/repos/policy-decisions";
import { revokeForOperation } from "@/lib/controlplane/db/repos/grants";
import { emitForOperation } from "@/lib/controlplane/events";

export {
  ALLOWED_TRANSITIONS,
  claimForExecution,
  create,
  get,
  getForSystem,
  heartbeat,
  list,
  markUncertainExpired,
  transition,
} from "@/lib/controlplane/db/repos/operations";
export { suspendForApproval, setPlanDigest, setPolicyDecision, cancelRunningOperation, denyOperation } from "./execution";
export type { ExecutionWriteInput } from "./execution";
export type {
  ClaimInput,
  CreateOperationInput,
  CreateOperationResult,
  OperationFilters,
  OperationPage,
  OperationPatch,
  TransitionInput,
} from "@/lib/controlplane/db/repos/operations";

/**
 * Create an operation and append `operation.proposed` — once. An idempotent
 * replay (same key, same request) returns the original operation and appends
 * nothing.
 */
export async function proposeOperation(db: Sql, input: CreateOperationInput & { actor?: Principal }): Promise<CreateOperationResult> {
  return db.tx(async (tx) => {
    const result = await create(tx, input);
    if (result.created) {
      const op = result.operation;
      await emitForOperation(tx, op, "operation.proposed", {
        actor: input.actor ?? op.principal,
        data: { capability: op.capability, status: op.status, proposalDigest: op.proposalDigest, risk: op.proposal.risk, summary: op.proposal.summary },
      });
      if (op.status === "denied") await emitForOperation(tx, op, "operation.denied", { actor: input.actor ?? op.principal });
    }
    return result;
  });
}

/**
 * Record a policy decision and move the operation out of `proposed` according to
 * its outcome: `allow` → `approved` (no approval needed), `require_approval` →
 * `awaiting_approval` (approval required, counted from the decision), `deny` →
 * `denied`. One transaction; null when the operation was not `proposed`
 * (someone else moved it — the decision is then not recorded either).
 */
export async function recordPolicyOutcome(
  db: Sql,
  input: { workspaceId: string; operationId: string; decision: Omit<InsertPolicyDecisionInput, "workspaceId" | "operationId"> }
): Promise<{ decision: PolicyDecisionRecord; operation: OperationRecord } | null> {
  return db.tx(async (tx) => {
    const decision = await insertPolicyDecision(tx, { ...input.decision, workspaceId: input.workspaceId, operationId: input.operationId });
    const to = decision.outcome === "allow" ? "approved" : decision.outcome === "deny" ? "denied" : "awaiting_approval";
    const operation = await transition(tx, {
      workspaceId: input.workspaceId,
      id: input.operationId,
      from: ["proposed"],
      to,
      patch: { policyDecisionId: decision.id, approvalRequired: decision.outcome === "require_approval" },
    });
    if (!operation) throw new PolicyOutcomeSkipped();
    await emitForOperation(tx, operation, "policy.evaluated", {
      data: { outcome: decision.outcome, policyVersion: decision.policyVersion, reasons: decision.reasons.map((r) => r.code) },
    });
    if (to === "approved") await emitForOperation(tx, operation, "operation.approved", { data: { by: "policy" } });
    if (to === "denied") await emitForOperation(tx, operation, "operation.denied", { data: { reasons: decision.reasons.map((r) => r.code) } });
    return { decision, operation };
  }).catch((err: unknown) => {
    if (err instanceof PolicyOutcomeSkipped) return null;
    throw err;
  });
}

class PolicyOutcomeSkipped extends Error {}

/**
 * Claim an operation for execution (approved/queued → running) and append
 * `operation.started`. All checks and the approval consumption are in
 * `claimForExecution`; a failed check throws and nothing is written.
 */
export async function claimOperation(db: Sql, input: ClaimInput & { actor?: Principal }): Promise<OperationRecord> {
  return db.tx(async (tx) => {
    const op = await claimForExecution(tx, input);
    await emitForOperation(tx, op, "operation.started", {
      actor: input.actor,
      data: { holder: input.holder, leaseScope: op.leaseScope, fenceToken: op.fenceToken },
    });
    return op;
  });
}

/**
 * Finish a running operation as `succeeded` or `failed`, fenced by the
 * environment lease it was claimed under, and append the event. Returns null
 * when the operation is no longer running (the reconciler already made it
 * `uncertain`, or it was finished): the caller must NOT report success.
 * Throws `LeaseLostError` when the lease is gone.
 */
export async function completeOperation(
  db: Sql,
  input: {
    workspaceId: string;
    id: string;
    outcome: "succeeded" | "failed";
    result?: unknown;
    error?: string;
    fence?: { scope: string; fenceToken: number };
    actor?: Principal;
  }
): Promise<OperationRecord | null> {
  return db.tx(async (tx) => {
    const op = await transition(tx, {
      workspaceId: input.workspaceId,
      id: input.id,
      from: ["running"],
      to: input.outcome,
      patch: { result: input.result, error: input.error },
      fence: input.fence,
    });
    if (!op) return null;
    await emitForOperation(tx, op, input.outcome === "succeeded" ? "operation.succeeded" : "operation.failed", {
      actor: input.actor,
      data: input.error ? { error: input.error.slice(0, 500) } : {},
    });
    return op;
  });
}

/**
 * Cancel an operation that has not started (`proposed`, `awaiting_approval`,
 * `approved`, `queued`), revoke its live grants and append the event. Null when
 * it is missing, of another workspace, or already running/terminal — a running
 * operation cannot be "cancelled", only stopped and reconciled. An expected
 * status narrows the transition atomically; a moved operation keeps its grants
 * and event history untouched.
 */
export async function cancelOperation(
  db: Sql,
  input: { workspaceId: string; id: string; reason?: string; actor?: Principal; expectedStatus?: "awaiting_approval"; requireUndecidedApprovalRound?: boolean }
): Promise<OperationRecord | null> {
  if (input.requireUndecidedApprovalRound && input.expectedStatus!=="awaiting_approval") throw new ControlStoreError("invalid_input","Undecided-round cancellation requires awaiting_approval.");
  return db.tx(async (tx) => {
    if (input.requireUndecidedApprovalRound) {
      const rows=await tx.query<{approval_round:number;status:string}>("select approval_round,status from platform.operations where workspace_id=$1 and id=$2 for update",[input.workspaceId,input.id]);
      if (rows[0]?.status!=="awaiting_approval") return null;
      const decisions=await tx.query("select id from platform.approvals where workspace_id=$1 and operation_id=$2 and approval_round=$3",[input.workspaceId,input.id,rows[0].approval_round]);
      if (decisions.length) return null;
    }
    const op = await transition(tx, {
      workspaceId: input.workspaceId,
      id: input.id,
      from: input.expectedStatus ? [input.expectedStatus] : ["proposed", "awaiting_approval", "approved", "queued"],
      to: "cancelled",
      patch: { error: input.reason },
    });
    if (!op) return null;
    await revokeForOperation(tx, input.workspaceId, input.id);
    await emitForOperation(tx, op, "operation.cancelled", { actor: input.actor, data: input.reason ? { reason: input.reason.slice(0, 500) } : {} });
    return op;
  });
}

export interface ReconcileResult {
  uncertain: OperationRecord[];
  expired: OperationRecord[];
}

/**
 * The reconciler pass (run it on a timer, from any process — it is idempotent
 * and uses `SKIP LOCKED`): running operations whose lease lapsed become
 * `uncertain` (never re-dispatched), overdue pre-execution operations become
 * `expired`, and the live grants of each are revoked. Events are appended in the
 * same transaction.
 */
export async function reconcileOperations(db: Sql, opts: { limit?: number } = {}): Promise<ReconcileResult> {
  return db.tx(async (tx) => {
    const uncertain = await markUncertainExpired(tx, opts.limit);
    for (const op of uncertain) {
      await revokeForOperation(tx, op.workspaceId, op.id);
      await emitForOperation(tx, op, "operation.uncertain", {
        data: { reason: "executor lease lost", leaseScope: op.leaseScope, fenceToken: op.fenceToken },
      });
    }
    const expired = await expireOverdue(tx, opts.limit);
    for (const op of expired) {
      await revokeForOperation(tx, op.workspaceId, op.id);
      await emitForOperation(tx, op, "operation.cancelled", { data: { reason: "expired" } });
    }
    return { uncertain, expired };
  });
}

/** Append a free-form control-plane event (re-exported for callers that only import this module). */
export { append as appendEvent };

/** Guard used by services that must not act on a missing operation. */
export function requireOperation<T>(value: T | null, id: string): T {
  if (value === null) throw new ControlStoreError("operation_not_found", "Operation not found.", { id });
  return value;
}
