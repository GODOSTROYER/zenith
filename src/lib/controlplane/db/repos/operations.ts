/**
 * The operations ledger: the canonical durable record of every capability
 * execution (`OperationRecord`, `controlplane/types.ts`).
 *
 * Every rule that matters is a database fact, not a convention:
 *  - **Tenancy**: every read/write names `workspace_id` in SQL. A wrong-tenant
 *    id is indistinguishable from a missing one (`null`/`operation_not_found`).
 *  - **Digests are computed here**, from the proposal, so no caller can store a
 *    `proposalDigest` that disagrees with the proposal it claims to describe.
 *  - **Idempotency** is reserved in the same transaction as the insert.
 *  - **Transitions are conditional UPDATEs** (`WHERE status = ANY(from)`): of two
 *    racing writers exactly one gets a row back; the other gets `null` and must
 *    treat that as "someone else moved it".
 *  - **Approval cannot be skipped.** `transition()` refuses to set `running`
 *    (only `claimForExecution` may — it verifies digest, expiry and consumes the
 *    approval) and refuses to set `approved` on an operation that requires
 *    approval (only `approvals.record` may). The database enforces the latter in
 *    the UPDATE's WHERE clause, not just in TypeScript.
 *  - **Terminal is terminal.** No edge leaves `succeeded`, `failed`,
 *    `uncertain`, `rejected`, `denied`, `cancelled`, `expired`.
 *  - **Nothing re-dispatches `uncertain`.** `markUncertainExpired` resolves
 *    running operations whose execution lease lapsed or whose environment lease
 *    was lost; it never queues anything.
 */
import { digest } from "@/lib/controlplane/digest";
import {
  TERMINAL_OPERATION_STATUSES,
  type OperationProposal,
  type OperationRecord,
  type OperationStatus,
  type Principal,
  type Sql,
} from "@/lib/controlplane/types";
import { ControlStoreError, optionalText, requireText } from "../errors";
import { assertNoSecretValues } from "../secrets";
import { boundedMs, clampLimit, decodeCursor, encodeCursor, json, jsonOrNull, newId, opt, requireDigest, textArray } from "../sql";
import { consumeApprovals, countUnconsumedApprovals, requiredApprovalCount } from "./approval-core";
import { reserve } from "./idempotency";
import { assertFence } from "./leases";

/* --------------------------------- rows ------------------------------------ */

export interface OperationRow {
  seq: number;
  id: string;
  workspace_id: string;
  project_id: string | null;
  environment_id: string | null;
  resource_id: string | null;
  capability: string;
  principal: Principal;
  status: OperationStatus;
  proposal: OperationProposal;
  proposal_digest: string;
  input_digest: string;
  plan_digest: string | null;
  policy_decision_id: string | null;
  approval_required: boolean;
  idempotency_key: string | null;
  workflow_id: string | null;
  runner_job_id: string | null;
  lease_scope: string | null;
  fence_token: number | null;
  correlation_id: string;
  result: unknown;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  expires_at: string;
}

export const OPERATION_COLUMNS =
  "seq, id, workspace_id, project_id, environment_id, resource_id, capability, principal, status, proposal, proposal_digest, input_digest, plan_digest, policy_decision_id, approval_required, idempotency_key, workflow_id, runner_job_id, lease_scope, fence_token, correlation_id, result, error, created_at, updated_at, started_at, finished_at, expires_at";

export function toOperation(row: OperationRow): OperationRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: opt(row.project_id),
    environmentId: opt(row.environment_id),
    resourceId: opt(row.resource_id),
    capability: row.capability,
    principal: row.principal,
    status: row.status,
    proposal: row.proposal,
    proposalDigest: row.proposal_digest,
    inputDigest: row.input_digest,
    planDigest: opt(row.plan_digest),
    policyDecisionId: opt(row.policy_decision_id),
    approvalRequired: row.approval_required,
    idempotencyKey: opt(row.idempotency_key),
    workflowId: opt(row.workflow_id),
    runnerJobId: opt(row.runner_job_id),
    leaseScope: opt(row.lease_scope),
    fenceToken: opt(row.fence_token),
    correlationId: row.correlation_id,
    result: opt(row.result),
    error: opt(row.error),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: opt(row.started_at),
    finishedAt: opt(row.finished_at),
    expiresAt: row.expires_at,
  };
}

/* ------------------------------ state machine ------------------------------ */

/**
 * Legal edges. `running` is reachable only through `claimForExecution`;
 * `approved` from `awaiting_approval` only through `approvals.record`; both are
 * enforced below. Terminal statuses have no outgoing edge.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<OperationStatus, readonly OperationStatus[]>> = {
  proposed: ["awaiting_approval", "approved", "denied", "cancelled", "expired"],
  awaiting_approval: ["approved", "rejected", "cancelled", "expired"],
  approved: ["queued", "running", "cancelled", "expired"],
  queued: ["running", "cancelled", "expired"],
  running: ["succeeded", "failed", "uncertain"],
  rejected: [],
  denied: [],
  succeeded: [],
  failed: [],
  uncertain: [],
  cancelled: [],
  expired: [],
};

const isTerminal = (status: OperationStatus): boolean => TERMINAL_OPERATION_STATUSES.includes(status);

/* --------------------------------- create ---------------------------------- */

export const DEFAULT_OPERATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface CreateOperationInput {
  workspaceId: string;
  principal: Principal;
  proposal: OperationProposal;
  /** initial status; the policy decision usually decides it (default `proposed`) */
  status?: "proposed" | "awaiting_approval" | "approved" | "denied";
  approvalRequired?: boolean;
  policyDecisionId?: string;
  correlationId?: string;
  workflowId?: string;
  /** how long the proposal (and any approval of it) stays valid; default 24 h, 1 min – 7 days */
  ttlMs?: number;
  /** supply to make the create idempotent (per workspace) */
  idempotencyKey?: string;
  /** default: digest of { capability, scope, input, principal id } */
  requestHash?: string;
  /** default: `op_<uuid>` */
  id?: string;
}

export interface CreateOperationResult {
  operation: OperationRecord;
  /** false when an earlier request with the same idempotency key + hash already created it */
  created: boolean;
}

export async function create(sql: Sql, input: CreateOperationInput): Promise<CreateOperationResult> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const { proposal, principal } = input;
  if (proposal.scope.workspaceId !== workspaceId)
    throw new ControlStoreError("tenant_mismatch", "The proposal's scope names a different workspace than the operation.", { field: "scope.workspaceId" });
  requireText("principal.id", principal.id);
  const capability = requireText("capability", proposal.capability, 128);
  const status = input.status ?? "proposed";
  const approvalRequired = input.approvalRequired ?? status === "awaiting_approval";
  if (status === "approved" && approvalRequired)
    throw new ControlStoreError("invalid_state", "An operation that requires approval cannot be created already approved.");
  assertNoSecretValues(proposal, "proposal");

  const proposalDigest = digest(proposal);
  const inputDigest = digest(proposal.input ?? null);
  const id = input.id ?? newId("op");
  const correlationId = input.correlationId ?? newId("corr");
  const ttl = boundedMs("ttlMs", input.ttlMs ?? DEFAULT_OPERATION_TTL_MS, 60_000, 7 * 24 * 60 * 60 * 1000);
  const idempotencyKey = optionalText("idempotencyKey", input.idempotencyKey, 200);

  return sql.tx(async (tx) => {
    if (idempotencyKey) {
      const reservation = await reserve(tx, {
        workspaceId,
        key: idempotencyKey,
        requestHash: input.requestHash ?? digest({ capability, scope: proposal.scope, input: proposal.input ?? null, principal: principal.id }),
        operationId: id,
      });
      if (reservation.state === "replay") {
        const existing = reservation.operationId ? await get(tx, workspaceId, reservation.operationId) : null;
        if (!existing) throw new ControlStoreError("conflict", "The idempotency key is bound to an operation that no longer exists.", { key: idempotencyKey });
        return { operation: existing, created: false };
      }
    }
    const rows = await tx.query<OperationRow>(
      `insert into platform.operations (
         id, workspace_id, project_id, environment_id, resource_id, capability, principal, status,
         proposal, proposal_digest, input_digest, plan_digest, policy_decision_id, approval_required,
         idempotency_key, workflow_id, correlation_id, expires_at, finished_at)
       values ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8::text, $9::text::jsonb, $10, $11, $12, $13, $14::boolean, $15, $16, $17,
         clock_timestamp() + ($18::bigint * interval '1 millisecond'),
         case when $8::text = 'denied' then clock_timestamp() else null end)
       returning ${OPERATION_COLUMNS}`,
      [
        id,
        workspaceId,
        proposal.scope.projectId ?? null,
        proposal.scope.environmentId ?? null,
        proposal.scope.resourceId ?? null,
        capability,
        json(principal),
        status,
        json(proposal),
        proposalDigest,
        inputDigest,
        proposal.planDigest ?? null,
        input.policyDecisionId ?? null,
        approvalRequired,
        idempotencyKey ?? null,
        input.workflowId ?? null,
        correlationId,
        ttl,
      ]
    );
    return { operation: toOperation(rows[0]), created: true };
  });
}

/* ---------------------------------- reads ---------------------------------- */

export async function get(sql: Sql, workspaceId: string, id: string): Promise<OperationRecord | null> {
  const rows = await sql.query<OperationRow>(
    `select ${OPERATION_COLUMNS} from platform.operations where workspace_id = $1 and id = $2`,
    [requireText("workspaceId", workspaceId), requireText("id", id)]
  );
  return rows.length ? toOperation(rows[0]) : null;
}

export interface OperationFilters {
  status?: OperationStatus | readonly OperationStatus[];
  projectId?: string;
  environmentId?: string;
  resourceId?: string;
  capability?: string;
  correlationId?: string;
  /** the requesting principal's id */
  principalId?: string;
}

export interface Page {
  limit?: number;
  /** opaque; from a previous page's `nextCursor` */
  cursor?: string;
}

export interface OperationPage {
  items: OperationRecord[];
  nextCursor?: string;
}

/** Newest first. Bounded (default 50, max 500). Always filtered by workspace in SQL. */
export async function list(sql: Sql, workspaceId: string, filters: OperationFilters = {}, page: Page = {}): Promise<OperationPage> {
  const limit = clampLimit(page.limit);
  const params: unknown[] = [requireText("workspaceId", workspaceId)];
  const where: string[] = ["workspace_id = $1"];
  const add = (clause: (n: number) => string, value: unknown): void => {
    params.push(value);
    where.push(clause(params.length));
  };
  if (filters.status !== undefined) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    add((n) => `status = any($${n}::text[])`, textArray(statuses as readonly string[]));
  }
  if (filters.projectId) add((n) => `project_id = $${n}`, filters.projectId);
  if (filters.environmentId) add((n) => `environment_id = $${n}`, filters.environmentId);
  if (filters.resourceId) add((n) => `resource_id = $${n}`, filters.resourceId);
  if (filters.capability) add((n) => `capability = $${n}`, filters.capability);
  if (filters.correlationId) add((n) => `correlation_id = $${n}`, filters.correlationId);
  if (filters.principalId) add((n) => `principal ->> 'id' = $${n}`, filters.principalId);
  const after = decodeCursor(page.cursor);
  if (after !== undefined) add((n) => `seq < $${n}::bigint`, after);
  params.push(limit + 1);
  const rows = await sql.query<OperationRow>(
    `select ${OPERATION_COLUMNS} from platform.operations
      where ${where.join(" and ")} order by seq desc limit $${params.length}::bigint`,
    params
  );
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  return { items: items.map(toOperation), nextCursor: hasMore ? encodeCursor(items[items.length - 1].seq) : undefined };
}

/* ------------------------------- transitions -------------------------------- */

export interface OperationPatch {
  /** may only be set while leaving `proposed` */
  policyDecisionId?: string;
  /** may only be raised (false to true), and only while leaving `proposed` */
  approvalRequired?: boolean;
  workflowId?: string;
  runnerJobId?: string;
  /** set once: an existing plan digest is never replaced */
  planDigest?: string;
  result?: unknown;
  error?: string;
}

export interface TransitionInput {
  workspaceId: string;
  id: string;
  from: readonly OperationStatus[];
  to: OperationStatus;
  patch?: OperationPatch;
  /**
   * The environment-lease fence of the writer. When given, the lease is asserted
   * live in the same transaction (`LeaseLostError` otherwise) and the row's
   * recorded fence must equal it, so a writer that lost the lease — or never
   * held the one the operation was claimed under — changes nothing.
   */
  fence?: { scope: string; fenceToken: number };
}

/**
 * Conditional status change. Returns the updated row, or `null` when the
 * operation is missing, belongs to another workspace, is not in one of the
 * `from` statuses (someone else moved it), or is expired and `to` is not a
 * terminal status.
 */
export async function transition(sql: Sql, input: TransitionInput): Promise<OperationRecord | null> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const id = requireText("id", input.id);
  if (input.from.length === 0) throw new ControlStoreError("invalid_input", "transition needs at least one `from` status.");
  for (const f of input.from)
    if (!ALLOWED_TRANSITIONS[f].includes(input.to))
      throw new ControlStoreError("invalid_state", `Illegal operation transition ${f} to ${input.to}.`, { from: f, to: input.to });
  if (input.to === "running")
    throw new ControlStoreError("invalid_state", "An operation becomes running only through claimForExecution (it verifies the digest and consumes the approval).");
  if (input.to === "approved" && input.from.includes("awaiting_approval"))
    throw new ControlStoreError("invalid_state", "An operation awaiting approval is approved only by approvals.record.");
  const patch = input.patch ?? {};
  if ((patch.policyDecisionId !== undefined || patch.approvalRequired !== undefined) && input.from.some((f) => f !== "proposed"))
    throw new ControlStoreError("invalid_input", "policyDecisionId and approvalRequired may only be set while leaving `proposed`.");
  if (patch.result !== undefined) assertNoSecretValues(patch.result, "result");
  if (patch.error !== undefined && patch.error.length > 4000) throw new ControlStoreError("invalid_input", "error is too long (max 4000 characters).");
  if (patch.planDigest !== undefined) requireDigest("planDigest", patch.planDigest);

  const run = async (tx: Sql): Promise<OperationRecord | null> => {
    if (input.fence) await assertFence(tx, input.fence.scope, input.fence.fenceToken);
    const terminal = isTerminal(input.to);
    const rows = await tx.query<OperationRow>(
      `update platform.operations set
         status             = $4::text,
         updated_at         = clock_timestamp(),
         policy_decision_id = coalesce($5::text, policy_decision_id),
         workflow_id        = coalesce($6::text, workflow_id),
         runner_job_id      = coalesce($7::text, runner_job_id),
         plan_digest        = coalesce(plan_digest, $8::text),
         result             = coalesce($9::text::jsonb, result),
         error              = coalesce($10::text, error),
         approval_required  = approval_required or $11::boolean,
         finished_at        = case when $12::boolean then clock_timestamp() else finished_at end,
         lease_holder       = case when $12::boolean then null else lease_holder end,
         lease_until        = case when $12::boolean then null else lease_until end
       where workspace_id = $1 and id = $2
         and status = any($3::text[])
         and ($4::text <> 'approved' or approval_required = false)
         and ($12::boolean or expires_at > clock_timestamp())
         and ($13::text is null or (lease_scope = $13::text and fence_token = $14::bigint))
       returning ${OPERATION_COLUMNS}`,
      [
        workspaceId,
        id,
        textArray(input.from as readonly string[]),
        input.to,
        patch.policyDecisionId ?? null,
        patch.workflowId ?? null,
        patch.runnerJobId ?? null,
        patch.planDigest ?? null,
        jsonOrNull(patch.result),
        patch.error ?? null,
        patch.approvalRequired ?? false,
        terminal,
        input.fence?.scope ?? null,
        input.fence?.fenceToken ?? null,
      ]
    );
    return rows.length ? toOperation(rows[0]) : null;
  };
  return input.fence ? sql.tx(run) : run(sql);
}

/* --------------------------- claim for execution ---------------------------- */

export interface ClaimInput {
  workspaceId: string;
  id: string;
  /** the digest the executor was told to run; must equal the stored proposal digest */
  expectedDigest: string;
  /** the worker/process claiming it (recorded as the execution lease holder) */
  holder: string;
  /** execution heartbeat window (default 60 s); renew with `heartbeat` */
  leaseMs?: number;
  /** the environment lease this execution runs under; asserted live in the same transaction */
  lease?: { scope: string; fenceToken: number };
  /** when given, the approval(s) must have been granted under exactly this policy bundle */
  expectedPolicyVersion?: string;
}

/**
 * The single-use gate to execution. In ONE transaction: lock the operation,
 * require `approved` (or `queued`), require the stored digest to equal
 * `expectedDigest`, require it not expired, assert the environment lease (when
 * given), consume the approval(s) if approval was required — each approval row
 * exactly once — and set `running` with the execution lease.
 *
 * Any failed check throws a typed `ControlStoreError` and changes nothing (the
 * approval stays unconsumed). Of two concurrent claimants, the second finds the
 * operation `running` and gets `invalid_state`.
 */
export async function claimForExecution(sql: Sql, input: ClaimInput): Promise<OperationRecord> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const id = requireText("id", input.id);
  const expectedDigest = requireDigest("expectedDigest", input.expectedDigest);
  const holder = requireText("holder", input.holder);
  const leaseMs = boundedMs("leaseMs", input.leaseMs ?? 60_000, 1000, 24 * 60 * 60 * 1000);

  return sql.tx(async (tx) => {
    const locked = await tx.query<OperationRow & { is_expired: boolean }>(
      `select ${OPERATION_COLUMNS}, (expires_at <= clock_timestamp()) as is_expired
         from platform.operations where workspace_id = $1 and id = $2 for update`,
      [workspaceId, id]
    );
    if (locked.length === 0) throw new ControlStoreError("operation_not_found", "Operation not found.", { id });
    const op = locked[0];
    if (op.status !== "approved" && op.status !== "queued")
      throw new ControlStoreError("invalid_state", `Operation is ${op.status}; only an approved or queued operation can be claimed for execution.`, { id, status: op.status });
    if (op.proposal_digest !== expectedDigest)
      throw new ControlStoreError("digest_mismatch", "The digest to execute does not match the reviewed proposal digest.", { id });
    if (op.is_expired) throw new ControlStoreError("operation_expired", "The operation expired before it could be executed.", { id });
    if (input.lease) await assertFence(tx, input.lease.scope, input.lease.fenceToken);

    if (op.approval_required) {
      const required = await requiredApprovalCount(tx, workspaceId, op.policy_decision_id);
      const consumed = await consumeApprovals(tx, {
        workspaceId,
        operationId: id,
        proposalDigest: expectedDigest,
        expectedPolicyVersion: input.expectedPolicyVersion,
      });
      if (consumed.length < required) {
        // A wrong policy bundle is a different remedy (re-approve) from no approval at all.
        const others = input.expectedPolicyVersion ? await countUnconsumedApprovals(tx, { workspaceId, operationId: id, proposalDigest: expectedDigest }) : 0;
        if (others > 0)
          throw new ControlStoreError("policy_changed", "The approval was granted under a different policy bundle; the operation must be re-approved.", { id, required });
        throw new ControlStoreError("approval_required", "No unconsumed, unexpired approval covers this operation.", { id, required, available: consumed.length });
      }
    }

    const rows = await tx.query<OperationRow>(
      `update platform.operations set
         status = 'running', started_at = clock_timestamp(), updated_at = clock_timestamp(),
         lease_holder = $3, lease_until = clock_timestamp() + ($4::bigint * interval '1 millisecond'),
         lease_scope = $5::text, fence_token = $6::bigint
       where workspace_id = $1 and id = $2 and status in ('approved','queued')
       returning ${OPERATION_COLUMNS}`,
      [workspaceId, id, holder, leaseMs, input.lease?.scope ?? null, input.lease?.fenceToken ?? null]
    );
    if (rows.length === 0) throw new ControlStoreError("invalid_state", "Operation changed while being claimed.", { id });
    return toOperation(rows[0]);
  });
}

/** Extend a running operation's execution lease. False when it is no longer running under `holder` (or the lease already lapsed). */
export async function heartbeat(sql: Sql, input: { workspaceId: string; id: string; holder: string; leaseMs?: number }): Promise<boolean> {
  const leaseMs = boundedMs("leaseMs", input.leaseMs ?? 60_000, 1000, 24 * 60 * 60 * 1000);
  const rows = await sql.query<{ id: string }>(
    `update platform.operations
        set lease_until = clock_timestamp() + ($4::bigint * interval '1 millisecond'), updated_at = clock_timestamp()
      where workspace_id = $1 and id = $2 and status = 'running' and lease_holder = $3 and lease_until > clock_timestamp()
      returning id`,
    [requireText("workspaceId", input.workspaceId), requireText("id", input.id), requireText("holder", input.holder), leaseMs]
  );
  return rows.length > 0;
}

/* ------------------------------ reconciliation ------------------------------ */

/**
 * Resolve running operations whose execution lease lapsed, or whose recorded
 * environment lease is gone (expired, released or taken over): outcome unknown,
 * so `uncertain` — terminal for automation, never re-dispatched. Cross-tenant by
 * design (a system reconciler); every returned record carries its workspace.
 */
export async function markUncertainExpired(sql: Sql, limit = 100): Promise<OperationRecord[]> {
  const rows = await sql.query<OperationRow>(
    `update platform.operations set
       status = 'uncertain', finished_at = clock_timestamp(), updated_at = clock_timestamp(),
       error = coalesce(error, 'The executor stopped reporting (execution or environment lease lost); whether the change was applied is unknown.'),
       lease_holder = null, lease_until = null
     where id in (
       select o.id from platform.operations o
        where o.status = 'running'
          and (o.lease_until is null or o.lease_until <= clock_timestamp()
               or (o.lease_scope is not null and not exists (
                     select 1 from platform.leases l
                      where l.scope = o.lease_scope and l.fence_token = o.fence_token
                        and l.expires_at > clock_timestamp() and l.released_at is null)))
        order by o.seq
        limit $1::bigint
        for update skip locked)
     returning ${OPERATION_COLUMNS}`,
    [clampLimit(limit, 100, 1000)]
  );
  return rows.map(toOperation);
}

/** Expire proposals nobody acted on in time (pre-execution statuses past `expires_at`). */
export async function expireOverdue(sql: Sql, limit = 100): Promise<OperationRecord[]> {
  const rows = await sql.query<OperationRow>(
    `update platform.operations set status = 'expired', finished_at = clock_timestamp(), updated_at = clock_timestamp()
     where id in (
       select id from platform.operations
        where status in ('proposed','awaiting_approval','approved','queued') and expires_at <= clock_timestamp()
        order by expires_at limit $1::bigint for update skip locked)
     returning ${OPERATION_COLUMNS}`,
    [clampLimit(limit, 100, 1000)]
  );
  return rows.map(toOperation);
}
