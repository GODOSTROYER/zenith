/**
 * Mixed parent plans, immutable child subplans, durable child receipts and the
 * stable-address registry (PROD-MIX-01 / PROD-MIX-02; migration 40).
 *
 * Tenancy: every statement names `workspace_id`, and a foreign workspace, an
 * unknown plan and an unknown child are indistinguishable (`null`/`not_found`).
 * The database triggers are the authority on legal transitions; these functions
 * only add the cross-table checks a trigger cannot see (the parent operation and
 * the child operation really are this workspace's operations for these
 * environments, with exactly the approved input).
 *
 * The parent APPROVAL is never stored or decided here. `attachParentOperation`
 * proves the parent operation's immutable proposal input equals the plan's
 * proposal input; the approval itself stays the operation's own, human-recorded,
 * policy-checked and digest-bound approval.
 */
import type { Sql } from "@/lib/controlplane/types";
import { digest } from "@/lib/controlplane/digest";
import { assertParentPlanIntegrity, proposalMatchesPlan } from "@/lib/execution/mixed/parent-plan";
import { buildReceipt, type ReceiptFields } from "@/lib/execution/mixed/receipt";
import {
  MIXED_PARENT_CAPABILITY,
  type ChildExecution, type ChildReceipt, type ChildState, type ChildTerminalOutcome, type MixedParentPlan, type ParentStatus, type StableAddressEntry,
} from "@/lib/execution/mixed/types";
import { ControlStoreError } from "../errors";
import { json, requireDigest } from "../sql";

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const PARTITION = /^[A-Za-z0-9_.:/-]{1,200}$/;
function id(name: string, value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new ControlStoreError("invalid_input", `${name} is malformed.`, { field: name });
  return value;
}
function partition(value: unknown): string {
  if (typeof value !== "string" || !PARTITION.test(value)) throw new ControlStoreError("invalid_input", "partitionId is malformed.", { field: "partitionId" });
  return value;
}
const notFound = (): never => { throw new ControlStoreError("not_found", "The mixed plan or child was not found."); };
const parsed = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));

export interface StoredMixedPlan {
  plan: MixedParentPlan;
  status: ParentStatus;
  parentOperationId?: string;
  version: number;
  createdBy: string;
  createdAt: string;
}

interface PlanRow { plan: unknown; status: ParentStatus; parent_operation_id: string | null; version: number; created_by: string; created_at: unknown }
function toStored(row: PlanRow): StoredMixedPlan {
  return {
    plan: parsed<MixedParentPlan>(row.plan), status: row.status, ...(row.parent_operation_id ? { parentOperationId: row.parent_operation_id } : {}),
    version: Number(row.version), createdBy: row.created_by, createdAt: iso(row.created_at),
  };
}

export async function getPlan(sql: Sql, workspaceId: string, planId: string): Promise<StoredMixedPlan | null> {
  const rows = await sql.query<PlanRow>(
    "select plan, status, parent_operation_id, version, created_by, created_at from platform.mixed_parent_plans where workspace_id = $1 and plan_id = $2",
    [id("workspaceId", workspaceId), id("planId", planId)]);
  return rows[0] ? toStored(rows[0]) : null;
}

export async function getPlanByParentOperation(sql: Sql, workspaceId: string, operationId: string): Promise<StoredMixedPlan | null> {
  const rows = await sql.query<PlanRow>(
    "select plan, status, parent_operation_id, version, created_by, created_at from platform.mixed_parent_plans where workspace_id = $1 and parent_operation_id = $2",
    [id("workspaceId", workspaceId), id("operationId", operationId)]);
  return rows[0] ? toStored(rows[0]) : null;
}

export async function listPlansForEnvironment(sql: Sql, workspaceId: string, environmentId: string, limit = 20): Promise<StoredMixedPlan[]> {
  const rows = await sql.query<PlanRow>(
    `select plan, status, parent_operation_id, version, created_by, created_at from platform.mixed_parent_plans
      where workspace_id = $1 and parent_environment_id = $2 order by created_at desc limit $3`,
    [id("workspaceId", workspaceId), id("environmentId", environmentId), Math.max(1, Math.min(100, Math.trunc(limit)))]);
  return rows.map(toStored);
}

/**
 * Persist the parent plan, its children and its address registry in one transaction. Idempotent: the plan id is a
 * function of its content, so the same plan is returned unchanged, and a row with this id but another digest is a conflict.
 */
export async function createPlan(sql: Sql, input: { plan: MixedParentPlan; createdBy: string }): Promise<{ stored: StoredMixedPlan; created: boolean }> {
  const plan = input.plan;
  assertParentPlanIntegrity(plan);
  const ws = id("workspaceId", plan.workspaceId);
  const planId = id("planId", plan.parentPlanId);
  const createdBy = id("createdBy", input.createdBy);
  return sql.tx(async (tx) => {
    const inserted = await tx.query<{ plan_id: string }>(
      `insert into platform.mixed_parent_plans (workspace_id, plan_id, project_id, parent_environment_id, format, graph_digest, manifest_digest,
         desired_digest, parent_digest, child_set_digest, plan, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text::jsonb,$12)
       on conflict (workspace_id, plan_id) do nothing returning plan_id`,
      [ws, planId, id("projectId", plan.projectId), id("environmentId", plan.parentEnvironmentId), plan.format, requireDigest("graphDigest", plan.graphDigest),
        requireDigest("manifestDigest", plan.manifestDigest), requireDigest("desiredDigest", plan.desiredDigest), requireDigest("parentDigest", plan.parentDigest),
        requireDigest("childSetDigest", plan.childSetDigest), json(plan), createdBy]);
    const existing = await getPlan(tx, ws, planId);
    if (!existing) return notFound();
    if (!inserted.length) {
      if (digest(existing.plan) !== digest(plan)) throw new ControlStoreError("conflict", "A different mixed plan already uses this id.", { planId });
      return { stored: existing, created: false };
    }
    for (const child of plan.children) {
      await tx.query(
        `insert into platform.mixed_child_plans (workspace_id, plan_id, partition_id, ordinal, child_environment_id, connection_id, provider, account_id, region,
           subplan_digest, effect_digest, semantics_digest, subplan)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::text::jsonb)`,
        [ws, planId, partition(child.partitionId), child.ordinal, id("childEnvironmentId", child.childEnvironmentId), id("connectionId", child.authority.connectionId),
          child.authority.provider, child.authority.accountId, child.authority.region, requireDigest("subplanDigest", child.subplanDigest),
          requireDigest("effectDigest", child.effectDigest), requireDigest("semanticsDigest", child.semanticsDigest), json(child)]);
    }
    for (const entry of plan.addresses) {
      await tx.query(
        `insert into platform.mixed_addresses (workspace_id, plan_id, stable_address, address, partition_id, spec_digest) values ($1,$2,$3,$4,$5,$6)`,
        [ws, planId, entry.stableAddress, entry.address, partition(entry.partitionId), requireDigest("specDigest", entry.specDigest)]);
    }
    return { stored: existing, created: true };
  });
}

/** The registry stored with the plan, for resume-time comparison with a fresh derivation. */
export async function getAddresses(sql: Sql, workspaceId: string, planId: string): Promise<StableAddressEntry[]> {
  const rows = await sql.query<{ stable_address: string; address: string; partition_id: string; spec_digest: string }>(
    "select stable_address, address, partition_id, spec_digest from platform.mixed_addresses where workspace_id = $1 and plan_id = $2 order by stable_address",
    [id("workspaceId", workspaceId), id("planId", planId)]);
  return rows.map((row) => ({ stableAddress: row.stable_address, address: row.address, partitionId: row.partition_id, specDigest: row.spec_digest }));
}

interface ChildRow { partition_id: string; ordinal: number; state: ChildState; child_operation_id: string | null; executable_semantics_digest: string | null; version: number }
const toExecution = (row: ChildRow): ChildExecution => ({
  partitionId: row.partition_id, ordinal: Number(row.ordinal), state: row.state, version: Number(row.version),
  ...(row.child_operation_id ? { childOperationId: row.child_operation_id } : {}),
  ...(row.executable_semantics_digest ? { executableSemanticsDigest: row.executable_semantics_digest } : {}),
});

export async function listChildren(sql: Sql, workspaceId: string, planId: string): Promise<ChildExecution[]> {
  const rows = await sql.query<ChildRow>(
    `select partition_id, ordinal, state, child_operation_id, executable_semantics_digest, version
       from platform.mixed_child_plans where workspace_id = $1 and plan_id = $2 order by ordinal`,
    [id("workspaceId", workspaceId), id("planId", planId)]);
  return rows.map(toExecution);
}

/** The parent operation is the plan's approval vehicle: it must carry exactly the plan's proposal input. Write-once. */
export async function attachParentOperation(sql: Sql, input: { workspaceId: string; planId: string; operationId: string }): Promise<StoredMixedPlan> {
  const ws = id("workspaceId", input.workspaceId), planId = id("planId", input.planId), operationId = id("operationId", input.operationId);
  return sql.tx(async (tx) => {
    const stored = await getPlan(tx, ws, planId);
    if (!stored) return notFound();
    if (stored.parentOperationId === operationId) return stored;
    if (stored.parentOperationId) throw new ControlStoreError("conflict", "This plan already has its parent operation.");
    const ops = await tx.query<{ capability: string; environment_id: string | null; status: string; proposal: unknown }>(
      "select capability, environment_id, status, proposal from platform.operations where workspace_id = $1 and id = $2 for update",
      [ws, operationId]);
    const op = ops[0];
    if (!op) return notFound();
    const proposal = parsed<{ input?: unknown }>(op.proposal);
    if (op.capability !== MIXED_PARENT_CAPABILITY || op.environment_id !== stored.plan.parentEnvironmentId || !proposalMatchesPlan(proposal.input, stored.plan)) {
      throw new ControlStoreError("digest_mismatch", "The operation is not the exact proposal of this mixed plan.");
    }
    if (!["proposed", "awaiting_approval", "approved", "queued"].includes(op.status)) throw new ControlStoreError("invalid_state", "The parent operation can no longer be started.", { status: op.status });
    const used = await tx.query("select 1 as x from platform.mixed_child_plans where workspace_id = $1 and child_operation_id = $2", [ws, operationId]);
    if (used.length) throw new ControlStoreError("conflict", "The operation already serves a child.");
    const updated = await tx.query<PlanRow>(
      `update platform.mixed_parent_plans set parent_operation_id = $3, version = version + 1
        where workspace_id = $1 and plan_id = $2 and parent_operation_id is null
        returning plan, status, parent_operation_id, version, created_by, created_at`,
      [ws, planId, operationId]);
    if (!updated[0]) throw new ControlStoreError("conflict", "The parent operation was bound concurrently.");
    return toStored(updated[0]);
  });
}

/**
 * Bind a child operation to its partition (pending -> adopted, write-once). SQL-level checks only: the operation is this
 * workspace's, targets the child environment, is not terminal and is not the parent. The graph subset proof is
 * `verifyChildGraph` in the service, which runs before this.
 */
export async function adoptChild(sql: Sql, input: { workspaceId: string; planId: string; partitionId: string; operationId: string }): Promise<ChildExecution> {
  const ws = id("workspaceId", input.workspaceId), planId = id("planId", input.planId), partitionId = partition(input.partitionId), operationId = id("operationId", input.operationId);
  return sql.tx(async (tx) => {
    const rows = await tx.query<ChildRow & { child_environment_id: string }>(
      `select partition_id, ordinal, state, child_operation_id, executable_semantics_digest, version, child_environment_id
         from platform.mixed_child_plans where workspace_id = $1 and plan_id = $2 and partition_id = $3 for update`, [ws, planId, partitionId]);
    const child = rows[0];
    if (!child) return notFound();
    if (child.state === "adopted" && child.child_operation_id === operationId) return toExecution(child);
    if (child.state !== "pending") throw new ControlStoreError("invalid_state", "This child already has an operation or is finished.", { state: child.state });
    const ops = await tx.query<{ environment_id: string | null; status: string; capability: string }>(
      "select environment_id, status, capability from platform.operations where workspace_id = $1 and id = $2 for update", [ws, operationId]);
    const op = ops[0];
    if (!op) return notFound();
    if (op.environment_id !== child.child_environment_id) throw new ControlStoreError("digest_mismatch", "The operation targets a different environment than this child.");
    if (!["deployment.deploy", "infrastructure.apply"].includes(op.capability)) throw new ControlStoreError("invalid_input", "Only a deploy or apply operation can serve a child.");
    if (!["proposed", "awaiting_approval", "approved", "queued"].includes(op.status)) throw new ControlStoreError("invalid_state", "The operation can no longer be started.", { status: op.status });
    const asParent = await tx.query("select 1 as x from platform.mixed_parent_plans where workspace_id = $1 and parent_operation_id = $2", [ws, operationId]);
    if (asParent.length) throw new ControlStoreError("conflict", "The operation is already a parent approval.");
    const updated = await tx.query<ChildRow>(
      `update platform.mixed_child_plans set child_operation_id = $4, state = 'adopted', version = version + 1
        where workspace_id = $1 and plan_id = $2 and partition_id = $3 and state = 'pending'
        returning partition_id, ordinal, state, child_operation_id, executable_semantics_digest, version`, [ws, planId, partitionId, operationId]);
    if (!updated[0]) throw new ControlStoreError("conflict", "The child changed concurrently.");
    return toExecution(updated[0]);
  });
}

/** adopted -> started, compare-and-set on the version the caller read. */
export async function markChildStarted(sql: Sql, input: { workspaceId: string; planId: string; partitionId: string; operationId: string }): Promise<ChildExecution> {
  const ws = id("workspaceId", input.workspaceId), planId = id("planId", input.planId), partitionId = partition(input.partitionId), operationId = id("operationId", input.operationId);
  const updated = await sql.query<ChildRow>(
    `update platform.mixed_child_plans set state = 'started', version = version + 1
      where workspace_id = $1 and plan_id = $2 and partition_id = $3 and state = 'adopted' and child_operation_id = $4
      returning partition_id, ordinal, state, child_operation_id, executable_semantics_digest, version`, [ws, planId, partitionId, operationId]);
  if (updated[0]) return toExecution(updated[0]);
  const current = (await listChildren(sql, ws, planId)).find((child) => child.partitionId === partitionId);
  if (current?.state === "started" && current.childOperationId === operationId) return current;
  return current ? ((): never => { throw new ControlStoreError("invalid_state", "The child is not adopted under this operation.", { state: current.state }); })() : notFound();
}

/** Capture the child's DUR-B reviewed semantics digest, write-once. A different digest later is refused by the trigger. */
export async function recordExecutableSemantics(sql: Sql, input: { workspaceId: string; planId: string; partitionId: string; executableSemanticsDigest: string }): Promise<ChildExecution> {
  const ws = id("workspaceId", input.workspaceId), planId = id("planId", input.planId), partitionId = partition(input.partitionId);
  const value = requireDigest("executableSemanticsDigest", input.executableSemanticsDigest);
  const updated = await sql.query<ChildRow>(
    `update platform.mixed_child_plans set executable_semantics_digest = $4, version = version + 1
      where workspace_id = $1 and plan_id = $2 and partition_id = $3 and executable_semantics_digest is null
      returning partition_id, ordinal, state, child_operation_id, executable_semantics_digest, version`, [ws, planId, partitionId, value]);
  if (updated[0]) return toExecution(updated[0]);
  const current = (await listChildren(sql, ws, planId)).find((child) => child.partitionId === partitionId);
  if (!current) return notFound();
  if (current.executableSemanticsDigest !== value) throw new ControlStoreError("digest_mismatch", "The child's reviewed semantics changed after they were recorded.");
  return current;
}

/**
 * Record the durable terminal receipt and move the child to its terminal state in one transaction. Content-addressed and
 * idempotent: the same outcome again returns the stored receipt; a different outcome for a settled child is a conflict.
 */
export async function recordReceipt(sql: Sql, input: ReceiptFields): Promise<ChildReceipt> {
  const ws = id("workspaceId", input.workspaceId), planId = id("planId", input.parentPlanId), partitionId = partition(input.partitionId);
  id("childOperationId", input.childOperationId);
  for (const [name, value] of [["executableSemanticsDigest", input.executableSemanticsDigest], ["planDigest", input.planDigest], ["outputsDigest", input.outputsDigest]] as const) {
    if (value !== undefined) requireDigest(name, value);
  }
  return sql.tx(async (tx) => {
    const children = await tx.query<ChildRow>(
      `select partition_id, ordinal, state, child_operation_id, executable_semantics_digest, version from platform.mixed_child_plans
        where workspace_id = $1 and plan_id = $2 and partition_id = $3 for update`, [ws, planId, partitionId]);
    const child = children[0];
    if (!child) return notFound();
    if (input.executableSemanticsDigest !== undefined && child.executable_semantics_digest !== null && input.executableSemanticsDigest !== child.executable_semantics_digest) {
      throw new ControlStoreError("digest_mismatch", "The receipt's reviewed semantics differ from the ones recorded for this child.");
    }
    const semantics = input.executableSemanticsDigest ?? child.executable_semantics_digest ?? undefined;
    const fields: ReceiptFields = { ...input, ordinal: Number(child.ordinal), ...(semantics !== undefined ? { executableSemanticsDigest: semantics } : {}) };
    const receipt = buildReceipt(fields, new Date().toISOString());
    const existing = await getReceipt(tx, ws, planId, partitionId);
    if (existing) {
      if (existing.receiptDigest !== receipt.receiptDigest) throw new ControlStoreError("conflict", "This child already has a different receipt.");
      return existing;
    }
    if (child.state !== "started" || child.child_operation_id !== input.childOperationId) throw new ControlStoreError("invalid_state", "Only a started child can receive a receipt.", { state: child.state });
    await tx.query(
      `insert into platform.mixed_child_receipts (workspace_id, plan_id, partition_id, receipt_id, ordinal, child_operation_id, outcome, child_status,
         executable_semantics_digest, plan_digest, outputs_digest, receipt_digest)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [ws, planId, partitionId, receipt.receiptId, receipt.ordinal, receipt.childOperationId, receipt.outcome, receipt.childStatus.slice(0, 64),
        receipt.executableSemanticsDigest ?? null, receipt.planDigest ?? null, receipt.outputsDigest ?? null, receipt.receiptDigest]);
    await tx.query(
      `update platform.mixed_child_plans set state = $4, version = version + 1,
         executable_semantics_digest = coalesce(executable_semantics_digest, $5)
        where workspace_id = $1 and plan_id = $2 and partition_id = $3 and state = 'started'`,
      [ws, planId, partitionId, receipt.outcome, receipt.executableSemanticsDigest ?? null]);
    return (await getReceipt(tx, ws, planId, partitionId))!;
  });
}

interface ReceiptRow {
  receipt_id: string; ordinal: number; child_operation_id: string; outcome: ChildTerminalOutcome; child_status: string;
  executable_semantics_digest: string | null; plan_digest: string | null; outputs_digest: string | null; receipt_digest: string; recorded_at: unknown; partition_id: string;
}
const toReceipt = (ws: string, planId: string, row: ReceiptRow): ChildReceipt => ({
  format: "zenith.mixed-child-receipt.v1", receiptId: row.receipt_id, workspaceId: ws, parentPlanId: planId, partitionId: row.partition_id, ordinal: Number(row.ordinal),
  childOperationId: row.child_operation_id, outcome: row.outcome, childStatus: row.child_status,
  ...(row.executable_semantics_digest ? { executableSemanticsDigest: row.executable_semantics_digest } : {}),
  ...(row.plan_digest ? { planDigest: row.plan_digest } : {}), ...(row.outputs_digest ? { outputsDigest: row.outputs_digest } : {}),
  receiptDigest: row.receipt_digest, recordedAt: iso(row.recorded_at),
});
const RECEIPT_COLUMNS = "receipt_id, ordinal, child_operation_id, outcome, child_status, executable_semantics_digest, plan_digest, outputs_digest, receipt_digest, recorded_at, partition_id";

export async function getReceipt(sql: Sql, workspaceId: string, planId: string, partitionId: string): Promise<ChildReceipt | null> {
  const rows = await sql.query<ReceiptRow>(
    `select ${RECEIPT_COLUMNS} from platform.mixed_child_receipts where workspace_id = $1 and plan_id = $2 and partition_id = $3`,
    [id("workspaceId", workspaceId), id("planId", planId), partition(partitionId)]);
  return rows[0] ? toReceipt(workspaceId, planId, rows[0]) : null;
}

export async function listReceipts(sql: Sql, workspaceId: string, planId: string): Promise<ChildReceipt[]> {
  const rows = await sql.query<ReceiptRow>(
    `select ${RECEIPT_COLUMNS} from platform.mixed_child_receipts where workspace_id = $1 and plan_id = $2 order by ordinal`,
    [id("workspaceId", workspaceId), id("planId", planId)]);
  return rows.map((row) => toReceipt(workspaceId, planId, row));
}

/** A child that will never start (a dependency did not succeed, or the parent stopped). Terminal; never a deletion or a compensation. */
export async function blockChild(sql: Sql, input: { workspaceId: string; planId: string; partitionId: string; reason: string }): Promise<ChildExecution> {
  const ws = id("workspaceId", input.workspaceId), planId = id("planId", input.planId), partitionId = partition(input.partitionId);
  const updated = await sql.query<ChildRow>(
    `update platform.mixed_child_plans set state = 'blocked', state_reason = $4, version = version + 1
      where workspace_id = $1 and plan_id = $2 and partition_id = $3 and state in ('pending','adopted')
      returning partition_id, ordinal, state, child_operation_id, executable_semantics_digest, version`,
    [ws, planId, partitionId, input.reason.slice(0, 500)]);
  if (updated[0]) return toExecution(updated[0]);
  const current = (await listChildren(sql, ws, planId)).find((child) => child.partitionId === partitionId);
  if (!current) return notFound();
  if (current.state === "blocked") return current;
  throw new ControlStoreError("invalid_state", "Only a child that has not started can be blocked.", { state: current.state });
}

/** Forward-only parent status compare-and-set. */
export async function setParentStatus(sql: Sql, input: { workspaceId: string; planId: string; from: ParentStatus; to: ParentStatus }): Promise<StoredMixedPlan> {
  const ws = id("workspaceId", input.workspaceId), planId = id("planId", input.planId);
  const updated = await sql.query<PlanRow>(
    `update platform.mixed_parent_plans set status = $4, version = version + 1
      where workspace_id = $1 and plan_id = $2 and status = $3
      returning plan, status, parent_operation_id, version, created_by, created_at`, [ws, planId, input.from, input.to]);
  if (updated[0]) return toStored(updated[0]);
  const current = await getPlan(sql, ws, planId);
  if (!current) return notFound();
  if (current.status === input.to) return current;
  throw new ControlStoreError("invalid_state", "The mixed plan is not in the expected state.", { status: current.status });
}


export interface MixedOperationFacts {
  id: string;
  capability: string;
  environmentId?: string;
  projectId?: string;
  status: string;
  approvalRequired: boolean;
  approvalRound: number;
  proposalDigest: string;
  planDigest?: string;
  input: unknown;
  /** Recorded human approvals (user principals) of exactly this proposal digest and round; consumed ones count, expired unconsumed ones do not. */
  humanApprovals: number;
  rejections: number;
  /** The lease holder string while running; evidence for who claimed it, never authority. */
  leaseHolder?: string;
}

/** What the parent/child services need to know about one operation of this workspace, in one read. */
export async function readOperationFacts(sql: Sql, workspaceId: string, operationId: string): Promise<MixedOperationFacts | null> {
  const ws = id("workspaceId", workspaceId), op = id("operationId", operationId);
  const rows = await sql.query<{
    id: string; capability: string; environment_id: string | null; project_id: string | null; status: string; approval_required: boolean; approval_round: number;
    proposal_digest: string; plan_digest: string | null; proposal: unknown; lease_holder: string | null; approvals: number | string; rejections: number | string;
  }>(
    `select o.id, o.capability, o.environment_id, o.project_id, o.status, o.approval_required, o.approval_round, o.proposal_digest, o.plan_digest, o.proposal, o.lease_holder,
       (select count(*) from platform.approvals a where a.workspace_id = o.workspace_id and a.operation_id = o.id and a.approval_round = o.approval_round
          and a.proposal_digest = o.proposal_digest and a.decision = 'approve' and a.approver->>'kind' = 'user'
          and (a.consumed_at is not null or a.expires_at > clock_timestamp())) as approvals,
       (select count(*) from platform.approvals a where a.workspace_id = o.workspace_id and a.operation_id = o.id and a.approval_round = o.approval_round
          and a.proposal_digest = o.proposal_digest and a.decision = 'reject') as rejections
     from platform.operations o where o.workspace_id = $1 and o.id = $2`, [ws, op]);
  const row = rows[0];
  if (!row) return null;
  const proposal = parsed<{ input?: unknown }>(row.proposal);
  return {
    id: row.id, capability: row.capability, status: row.status, approvalRequired: row.approval_required, approvalRound: Number(row.approval_round),
    proposalDigest: row.proposal_digest, input: proposal.input, humanApprovals: Number(row.approvals), rejections: Number(row.rejections),
    ...(row.environment_id ? { environmentId: row.environment_id } : {}), ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.plan_digest ? { planDigest: row.plan_digest } : {}), ...(row.lease_holder ? { leaseHolder: row.lease_holder } : {}),
  };
}

/* ----------------------- run orchestration join (MIX-03/04) ----------------------- */

/** Latest expiry of a live human approval of the parent operation: the run's own deadline for starting new children. */
export async function readParentApprovalExpiry(sql: Sql, workspaceId: string, parentOperationId: string): Promise<string | null> {
  const ws = id("workspaceId", workspaceId), op = id("operationId", parentOperationId);
  const rows = await sql.query<{ expires_at: string | Date | null }>(
    `select max(a.expires_at) as expires_at from platform.approvals a join platform.operations o on o.workspace_id = a.workspace_id and o.id = a.operation_id
      where a.workspace_id = $1 and a.operation_id = $2 and a.proposal_digest = o.proposal_digest and a.decision = 'approve' and a.approver->>'kind' = 'user'`, [ws, op]);
  const value = rows[0]?.expires_at;
  return value ? new Date(value).toISOString() : null;
}

export interface ReviewOperationRef { operationId: string; status: string }

/** The review operation (if any) that asks a person to approve exactly this new parent digest for this parent run. */
export async function findReviewOperation(sql: Sql, workspaceId: string, parentOperationId: string, requiredParentDigest: string): Promise<ReviewOperationRef | null> {
  const ws = id("workspaceId", workspaceId), op = id("parentOperationId", parentOperationId);
  if (!/^[a-f0-9]{64}$/.test(requiredParentDigest)) throw new ControlStoreError("invalid_input", "requiredParentDigest must be a sha256 hex digest.", { field: "requiredParentDigest" });
  const rows = await sql.query<{ id: string; status: string }>(
    `select o.id, o.status from platform.operations o
      where o.workspace_id = $1 and o.capability = 'deployment.deploy' and o.proposal->'input'->>'mixedParentReviewOf' = $2 and o.proposal->'input'->>'requiredParentDigest' = $3
      order by o.seq desc limit 1`, [ws, op, requiredParentDigest]);
  return rows[0] ? { operationId: rows[0].id, status: rows[0].status } : null;
}

/**
 * Verify one approval id is a live, human, non-rejected approval of a review operation of THIS parent run, bound to the
 * operation's own proposal digest; returns the exact parent digest that approval covers, or null. A policy allow, an agent
 * approval, a rejected, expired or foreign approval all return null.
 */
export async function readReviewApprovalDigest(sql: Sql, workspaceId: string, parentOperationId: string, approvalId: string): Promise<string | null> {
  const ws = id("workspaceId", workspaceId), op = id("parentOperationId", parentOperationId);
  if (typeof approvalId !== "string" || approvalId.length < 1 || approvalId.length > 200) return null;
  const rows = await sql.query<{ required: string | null }>(
    `select o.proposal->'input'->>'requiredParentDigest' as required
       from platform.approvals a join platform.operations o on o.workspace_id = a.workspace_id and o.id = a.operation_id
      where a.workspace_id = $1 and a.id = $3 and o.capability = 'deployment.deploy' and o.proposal->'input'->>'mixedParentReviewOf' = $2
        and a.proposal_digest = o.proposal_digest and a.decision = 'approve' and a.approver->>'kind' = 'user'
        and a.approver->>'onBehalfOf' is null and a.approver->>'integrationId' is null and a.expires_at > clock_timestamp()
        and not exists (select 1 from platform.approvals r where r.workspace_id = o.workspace_id and r.operation_id = o.id and r.decision = 'reject')`, [ws, op, approvalId]);
  const required = rows[0]?.required;
  return required && /^[a-f0-9]{64}$/.test(required) ? required : null;
}

/** The human approval id of a review operation, when one exists (the same predicate as `readReviewApprovalDigest`). */
export async function findReviewApprovalId(sql: Sql, workspaceId: string, reviewOperationId: string): Promise<string | null> {
  const ws = id("workspaceId", workspaceId), op = id("operationId", reviewOperationId);
  const rows = await sql.query<{ id: string }>(
    `select a.id from platform.approvals a join platform.operations o on o.workspace_id = a.workspace_id and o.id = a.operation_id
      where a.workspace_id = $1 and a.operation_id = $2 and a.proposal_digest = o.proposal_digest and a.decision = 'approve' and a.approver->>'kind' = 'user'
        and a.approver->>'onBehalfOf' is null and a.approver->>'integrationId' is null and a.expires_at > clock_timestamp()
        and not exists (select 1 from platform.approvals r where r.workspace_id = o.workspace_id and r.operation_id = o.id and r.decision = 'reject')
      order by a.created_at desc limit 1`, [ws, op]);
  return rows[0]?.id ?? null;
}

/** The most recent review operation of this parent run that has not been decided yet (still waiting for a person). */
export async function findOpenReviewOperation(sql: Sql, workspaceId: string, parentOperationId: string): Promise<ReviewOperationRef | null> {
  const ws = id("workspaceId", workspaceId), op = id("parentOperationId", parentOperationId);
  const rows = await sql.query<{ id: string; status: string }>(
    `select o.id, o.status from platform.operations o
      where o.workspace_id = $1 and o.capability = 'deployment.deploy' and o.proposal->'input'->>'mixedParentReviewOf' = $2 and o.status in ('proposed','awaiting_approval','approved')
      order by o.seq desc limit 1`, [ws, op]);
  return rows[0] ? { operationId: rows[0].id, status: rows[0].status } : null;
}
