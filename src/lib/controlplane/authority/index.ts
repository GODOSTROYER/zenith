/**
 * Operation authority record (PROD-DUR-02).
 *
 * Authority: the `platform.operations` row decides what an operation IS; the
 * database-maintained `platform.operation_authority` row gives it one monotonic
 * `version` that moves on every authority-relevant change. A writer that read
 * version N may commit only if the version is still N (`casTransition`): the
 * compare and the write are one database transaction, so neither a process-local
 * lock nor an earlier read is ever treated as cross-worker atomicity.
 *
 * Projection: `projectOperation` derives the user-facing phase from the
 * authority record, the retained workflow-start intent and the durable intents.
 * It is read-only. Product-store copies (deployment status, `workflowStartedAt`)
 * are projections of this answer, never inputs to a decision.
 *
 * Tenancy: every statement names `workspace_id`. This module deliberately lives
 * outside `db/repos` so it joins no unreviewed cross-tenant surface.
 */
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import { transition, type OperationPatch } from "@/lib/controlplane/db/repos/operations";
import { emitForOperation } from "@/lib/controlplane/events";
import type { OperationRecord, OperationStatus, PlatformEventType, Sql } from "@/lib/controlplane/types";

export interface OperationAuthority {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly version: number;
  readonly status: OperationStatus;
  readonly approvalRound: number;
  readonly planDigest: string | null;
  readonly workflowId: string | null;
  readonly fenceToken: number | null;
  readonly updatedAt: string;
}

interface AuthorityRow {
  workspace_id: string; operation_id: string; version: string | number; status: OperationStatus;
  approval_round: number; plan_digest: string | null; workflow_id: string | null;
  fence_token: string | number | null; updated_at: string;
}

const toAuthority = (row: AuthorityRow): OperationAuthority => Object.freeze({
  workspaceId: row.workspace_id, operationId: row.operation_id, version: Number(row.version), status: row.status,
  approvalRound: row.approval_round, planDigest: row.plan_digest, workflowId: row.workflow_id,
  fenceToken: row.fence_token === null ? null : Number(row.fence_token), updatedAt: String(row.updated_at),
});

/** The authority record of one operation of this workspace, or null. A foreign id is indistinguishable from a missing one. */
export async function readAuthority(sql: Sql, workspaceId: string, operationId: string): Promise<OperationAuthority | null> {
  const rows = await sql.query<AuthorityRow>(
    "select workspace_id, operation_id, version, status, approval_round, plan_digest, workflow_id, fence_token, updated_at from platform.operation_authority where workspace_id=$1 and operation_id=$2",
    [workspaceId, operationId]);
  return rows[0] ? toAuthority(rows[0]) : null;
}

export class AuthorityConflictError extends ControlStoreError {
  constructor(readonly expectedVersion: number, readonly currentVersion: number | null) {
    super("conflict", "The operation changed since it was read; re-read its authority record and decide again.", { expectedVersion, currentVersion });
  }
}

export interface CasTransitionInput {
  workspaceId: string;
  operationId: string;
  /** The `version` of the authority record the caller's decision was based on. */
  expectedVersion: number;
  from: readonly OperationStatus[];
  to: Exclude<OperationStatus, "running">;
  patch?: OperationPatch;
  fence?: { scope: string; fenceToken: number };
  /** Audit event appended in the same transaction when the transition commits. */
  event?: { type: PlatformEventType; data?: Record<string, unknown> };
}

export type CasTransitionResult =
  | { ok: true; operation: OperationRecord; authority: OperationAuthority }
  | { ok: false; reason: "version_conflict" | "state_conflict"; authority: OperationAuthority | null };

/**
 * Versioned compare-and-set over the operation state machine. The authority row
 * is locked first, the version compared, then the ordinary conditional
 * `transition` (all of its approval, lease and terminal-state rules) runs in the
 * same transaction. Exactly one of two racing writers holding the same version
 * commits; the other receives `version_conflict` and has changed nothing.
 */
export async function casTransition(sql: Sql, input: CasTransitionInput): Promise<CasTransitionResult> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new ControlStoreError("invalid_input", "expectedVersion must be a positive integer.");
  return sql.tx(async (tx) => {
    const locked = await tx.query<AuthorityRow>(
      "select workspace_id, operation_id, version, status, approval_round, plan_digest, workflow_id, fence_token, updated_at from platform.operation_authority where workspace_id=$1 and operation_id=$2 for update",
      [input.workspaceId, input.operationId]);
    const current = locked[0] ? toAuthority(locked[0]) : null;
    if (!current || current.version !== input.expectedVersion) return { ok: false, reason: "version_conflict", authority: current } as const;
    const operation = await transition(tx, { workspaceId: input.workspaceId, id: input.operationId, from: input.from, to: input.to, patch: input.patch, fence: input.fence });
    if (!operation) return { ok: false, reason: "state_conflict", authority: current } as const;
    if (input.event) await emitForOperation(tx, operation, input.event.type, { data: input.event.data });
    const after = await readAuthority(tx, input.workspaceId, input.operationId);
    return { ok: true, operation, authority: after! } as const;
  });
}

/* -------------------------------- projection ------------------------------- */

/**
 * What a surface may tell a person about an operation's delivery. Derived, never
 * stored: a lost worker, a lost Temporal acknowledgement or a lost signal each
 * produce a named phase rather than a guess.
 */
export type OperationPhase =
  | "pending_decision" | "ready_to_start" | "start_recorded" | "start_attempted_unconfirmed"
  | "running" | "completed" | "failed" | "cancelled" | "uncertain" | "closed_without_effect";

export interface IntentSummary {
  readonly id: string;
  readonly kind: "workflow_signal" | "workflow_start";
  readonly idempotencyKey: string;
  readonly state: "pending" | "delivered" | "dead";
  readonly outcome: string | null;
  readonly attempts: number;
}

export interface OperationProjection {
  readonly source: "operation_authority";
  readonly authorityVersion: number;
  readonly status: OperationStatus;
  readonly approvalRound: number;
  readonly phase: OperationPhase;
  readonly workflowId: string | null;
  readonly startIntent: null | { phase: "prepared" | "attempted" | "acknowledged"; runId: string | null; observedStartAt: string | null };
  readonly intents: readonly IntentSummary[];
  /** true when an effect that left (or may have left) the database is not yet confirmed; surfaces must say "inspect", never "failed". */
  readonly unconfirmed: boolean;
  readonly cancelRequested: boolean;
}

export function derivePhase(a: OperationAuthority, start: OperationProjection["startIntent"]): OperationPhase {
  switch (a.status) {
    case "succeeded": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "uncertain": return "uncertain";
    case "rejected": case "denied": case "expired": return "closed_without_effect";
    case "proposed": case "awaiting_approval": return "pending_decision";
    case "approved": case "queued": return start ? (start.phase === "acknowledged" ? "running" : "start_recorded") : "ready_to_start";
    case "running":
      if (!start) return "ready_to_start";
      if (start.phase === "acknowledged") return "running";
      return start.phase === "attempted" ? "start_attempted_unconfirmed" : "start_recorded";
  }
}

export async function projectOperation(sql: Sql, workspaceId: string, operationId: string): Promise<OperationProjection | null> {
  const authority = await readAuthority(sql, workspaceId, operationId);
  if (!authority) return null;
  const starts = await sql.query<{ phase: "prepared" | "attempted" | "acknowledged"; run_id: string | null; observed_start_at: string | null }>(
    "select phase, run_id, observed_start_at from platform.workflow_start_intents where workspace_id=$1 and operation_id=$2", [workspaceId, operationId]);
  const startIntent = starts[0] ? { phase: starts[0].phase, runId: starts[0].run_id, observedStartAt: starts[0].observed_start_at ? new Date(starts[0].observed_start_at).toISOString() : null } : null;
  const rows = await sql.query<{ id: string; kind: IntentSummary["kind"]; idempotency_key: string; state: IntentSummary["state"]; outcome: string | null; attempts: number }>(
    "select id, kind, idempotency_key, state, outcome, attempts from platform.durable_intents where workspace_id=$1 and operation_id=$2 order by created_at, id limit 50", [workspaceId, operationId]);
  const intents = rows.map((r) => Object.freeze({ id: r.id, kind: r.kind, idempotencyKey: r.idempotency_key, state: r.state, outcome: r.outcome, attempts: r.attempts }));
  const phase = derivePhase(authority, startIntent);
  const cancel = intents.find((i) => i.kind === "workflow_signal" && i.idempotencyKey.startsWith("cancel:"));
  return Object.freeze({
    source: "operation_authority" as const, authorityVersion: authority.version, status: authority.status, approvalRound: authority.approvalRound,
    phase, workflowId: authority.workflowId, startIntent, intents,
    unconfirmed: phase === "start_attempted_unconfirmed" || intents.some((i) => i.state === "dead" && i.outcome !== "superseded"),
    cancelRequested: cancel !== undefined,
  });
}
