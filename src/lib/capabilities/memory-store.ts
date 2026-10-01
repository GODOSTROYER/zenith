/**
 * `MemoryBrokerStore` — an in-memory `BrokerStore` for tests and local
 * development, faithful to the semantics of the platform control store's
 * repositories (`controlplane/db/repos/*`):
 *
 *  - **Tenancy.** Every read and write is keyed by workspace; a wrong-tenant id
 *    is a `null` / `not_found`, indistinguishable from a missing one.
 *  - **Digests are computed here** from the proposal, never accepted.
 *  - **Idempotency** is reserved in the same critical section as the insert.
 *  - **Conditional transitions.** `cancelOperation`, `expireOperation` and
 *    `completeOperation` move an operation only from the statuses they name; of
 *    two racing writers exactly one gets a row back. `running` is reachable only
 *    through `claimForExecution`; `awaiting_approval → approved` only through
 *    `recordApproval`. Terminal is terminal.
 *  - **Ledger events** are appended in the same critical section as the change,
 *    with the same types and data shapes the platform store's services append.
 *  - **Approvals are single-use.** `claimForExecution` consumes each valid
 *    approval exactly once, atomically with the move to `running`.
 *  - **Grants are single-use.** `consumeGrant` is true exactly once.
 *  - **Optimistic concurrency** on environment and workspace-policy settings.
 *
 * Every public method is `async` but performs its whole check-and-write
 * without an intervening `await`, so under the single-threaded event loop each
 * is atomic exactly as the SQL transaction it stands for. Stored values are
 * cloned on the way in and out, so a caller can never mutate stored state.
 *
 * NOT for production: state lives in this process, dies with it, and is not
 * shared between instances. `platformBroker()` selects it only when
 * `ZENITH_PLATFORM_BROKER_MEMORY=1`.
 */
import { digest } from "@/lib/controlplane/digest";
import {
  type ApprovalRecord,
  type EvidenceRecord,
  type ApprovalRequirement,
  type OperationRecord,
  type OperationStatus,
  type PlatformEvent,
  type PlatformEventType,
  type PolicyDecisionRecord,
  type Principal,
} from "@/lib/controlplane/types";
import type { AutonomyLevel } from "@/lib/policy";
import { BrokerError, notFound } from "./errors";
import {
  systemClock,
  type BrokerStore,
  type Clock,
  type CreateOperationResult,
  type EnvironmentSettings,
  type GrantRecord,
  type ListEventsRequest,
  type NewDecision,
  type NewEvent,
  type NewOperation,
  type OperationFilters,
  type OperationPage,
  type PageRequest,
  type RecordApprovalRequest,
  type RecordApprovalResult,
  type CompleteRequest,
  type ClaimRequest,
  type WorkspacePolicySettings,
} from "./ports";
import { findSecret } from "./secret-guard";

const ROLE_RANK = { viewer: 0, editor: 1, admin: 2 } as const;
const DIGEST = /^[0-9a-f]{64}$/;
const EVENT_TYPE_SHAPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_EVENT_BYTES = 64 * 1024;

const PRE_EXECUTION: readonly OperationStatus[] = ["proposed", "awaiting_approval", "approved", "queued"];
const clone = <T>(value: T): T => structuredClone(value);
const opKey = (workspaceId: string, id: string): string => `${workspaceId}\u0000${id}`;

interface StoredOperation {
  seq: number;
  record: OperationRecord;
  leaseHolder?: string;
  leaseUntilMs?: number;
}

interface StoredApproval {
  record: ApprovalRecord;
  approverId: string;
}

interface Lease {
  fenceToken: number;
  expiresAtMs: number;
  released: boolean;
}

export class MemoryBrokerStore implements BrokerStore {
  private seq = 0;
  private eventSeq = 0;
  private counter = 0;
  private readonly operations = new Map<string, StoredOperation>();
  private readonly decisions = new Map<string, PolicyDecisionRecord>();
  private readonly approvals: StoredApproval[] = [];
  private readonly grants = new Map<string, GrantRecord>();
  private readonly environments = new Map<string, EnvironmentSettings>();
  private readonly policies = new Map<string, WorkspacePolicySettings>();
  private readonly events: PlatformEvent[] = [];
  private readonly idempotency = new Map<string, { requestHash: string; operationId: string; expiresAtMs: number }>();
  private readonly leases = new Map<string, Lease>();
  private leaseCounter = 0;

  constructor(private readonly clock: Clock = systemClock) {}

  private nowMs(): number {
    return this.clock.now().getTime();
  }
  private nowIso(): string {
    return this.clock.now().toISOString();
  }
  private nextId(prefix: string): string {
    return `${prefix}_mem${++this.counter}`;
  }

  /* ------------------------------- test helpers ------------------------------ */

  /** Acquire an environment-style lease and return its fence token (strictly increasing). */
  acquireLease(scope: string, ttlMs = 60_000): number {
    const fenceToken = ++this.leaseCounter;
    this.leases.set(scope, { fenceToken, expiresAtMs: this.nowMs() + ttlMs, released: false });
    return fenceToken;
  }

  releaseLease(scope: string): void {
    const lease = this.leases.get(scope);
    if (lease) lease.released = true;
  }

  /** Lifecycle status of a grant on the store's clock. */
  grantStatus(workspaceId: string, jti: string): "active" | "consumed" | "revoked" | "expired" | "unknown" {
    const grant = this.grants.get(`${workspaceId}\u0000${jti}`);
    if (!grant) return "unknown";
    if (grant.revokedAt) return "revoked";
    if (grant.consumedAt) return "consumed";
    if (Date.parse(grant.expiresAt) <= this.nowMs()) return "expired";
    return "active";
  }

  /** Every persisted event of one workspace (test inspection). */
  allEvents(workspaceId?: string): PlatformEvent[] {
    return clone(this.events.filter((e) => workspaceId === undefined || e.workspaceId === workspaceId));
  }

  private assertFence(scope: string, fenceToken: number): void {
    const lease = this.leases.get(scope);
    if (!lease || lease.released || lease.fenceToken !== fenceToken || lease.expiresAtMs <= this.nowMs()) {
      throw new BrokerError("lease_lost", "The environment lease is no longer held; the operation must stop and be reconciled.");
    }
  }

  /* -------------------------------- operations ------------------------------- */

  async createOperation(input: NewOperation): Promise<CreateOperationResult> {
    const { workspaceId, proposal, principal } = input;
    if (!workspaceId) throw new BrokerError("invalid_request", "workspaceId is required.");
    if (proposal.scope.workspaceId !== workspaceId) throw notFound(); // the platform store answers tenant_mismatch (404)
    if (!principal.id) throw new BrokerError("invalid_request", "principal.id is required.");
    if (!["allow", "deny", "require_approval"].includes(input.decision.outcome)) throw new BrokerError("invalid_request", "outcome must be allow, deny or require_approval.");
    const status = input.decision.outcome === "allow" ? "approved" : input.decision.outcome === "deny" ? "denied" : "awaiting_approval";
    const approvalRequired = input.decision.outcome === "require_approval";
    if (input.ttlMs < MIN_TTL_MS || input.ttlMs > MAX_TTL_MS) throw new BrokerError("invalid_request", "ttlMs must be between 1 minute and 7 days.");
    const secret = findSecret(proposal, "proposal");
    if (secret) throw new BrokerError("secret_material", `Refusing to store ${secret.what} at ${secret.path}.`);

    const now = this.nowMs();
    if (input.idempotencyKey) {
      const key = `${workspaceId}\u0000${input.idempotencyKey}`;
      const existing = this.idempotency.get(key);
      if (existing && existing.expiresAtMs > now) {
        if (existing.requestHash !== input.requestHash) throw new BrokerError("idempotency_conflict", "This idempotency key was already used for a different request.", "Send a new idempotency key for a new request, or resend the original request unchanged.");
        const stored = this.operations.get(opKey(workspaceId, existing.operationId));
        const decision = stored?.record.policyDecisionId ? this.decisions.get(stored.record.policyDecisionId) : undefined;
        if (!stored || !decision) throw new BrokerError("conflict", "The idempotency key is bound to an operation that no longer exists.");
        return { operation: clone(stored.record), decision: clone(decision), created: false };
      }
      this.idempotency.set(key, { requestHash: input.requestHash, operationId: input.id, expiresAtMs: now + IDEMPOTENCY_TTL_MS });
    }

    const nowIso = this.nowIso();
    const record: OperationRecord = {
      id: input.id,
      workspaceId,
      projectId: proposal.scope.projectId,
      environmentId: proposal.scope.environmentId,
      resourceId: proposal.scope.resourceId,
      capability: proposal.capability,
      principal: clone(principal),
      status,
      proposal: clone(proposal),
      proposalDigest: digest(proposal),
      inputDigest: digest(proposal.input ?? null),
      planDigest: proposal.planDigest,
      policyDecisionId: input.decisionId,
      approvalRequired,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      createdAt: nowIso,
      updatedAt: nowIso,
      finishedAt: status === "denied" ? nowIso : undefined,
      expiresAt: new Date(now + input.ttlMs).toISOString(),
    };
    const decision: PolicyDecisionRecord = {
      id: input.decisionId,
      workspaceId,
      operationId: input.id,
      policyVersion: input.decision.policyVersion,
      inputDigest: input.decision.inputDigest,
      outcome: input.decision.outcome,
      reasons: clone(input.decision.reasons),
      approval: input.decision.approval ? clone(input.decision.approval) : undefined,
      constraints: input.decision.constraints ? clone(input.decision.constraints) : undefined,
      evaluatedAt: nowIso,
    };
    this.operations.set(opKey(workspaceId, input.id), { seq: ++this.seq, record });
    this.decisions.set(decision.id, decision);
    // The same events the platform store's proposeOperation + recordPolicyOutcome append.
    this.emitFor(record, "operation.proposed", {
      actor: principal,
      data: { capability: record.capability, status: "proposed", proposalDigest: record.proposalDigest, risk: proposal.risk, summary: proposal.summary },
    });
    this.emitFor(record, "policy.evaluated", {
      data: { outcome: decision.outcome, policyVersion: decision.policyVersion, reasons: decision.reasons.map((r) => r.code) },
    });
    if (status === "approved") this.emitFor(record, "operation.approved", { data: { by: "policy" } });
    if (status === "denied") this.emitFor(record, "operation.denied", { data: { reasons: decision.reasons.map((r) => r.code) } });
    return { operation: clone(record), decision: clone(decision), created: true };
  }

  async getOperation(workspaceId: string, id: string): Promise<OperationRecord | null> {
    const stored = this.operations.get(opKey(workspaceId, id));
    return stored ? clone(stored.record) : null;
  }

  /** The development memory ledger has no execution evidence store. */
  async getPlanEvidence(): Promise<EvidenceRecord | null> { return null; }

  async denyOperation(input: Parameters<BrokerStore["denyOperation"]>[0]): Promise<OperationRecord | null> {
    const stored = this.operations.get(opKey(input.workspaceId, input.id));
    const decision = this.decisions.get(input.decisionId);
    if (!stored || stored.record.status !== "approved" || !decision || decision.workspaceId !== input.workspaceId || decision.outcome !== "deny" ||
        (decision.operationId && decision.operationId !== input.id)) return null;
    const op = stored.record;
    op.status = "denied";
    op.policyDecisionId = decision.id;
    op.updatedAt = this.nowIso();
    op.finishedAt = op.updatedAt;
    stored.leaseHolder = undefined;
    stored.leaseUntilMs = undefined;
    this.revokeLiveGrants(input.workspaceId, op.id);
    this.emitFor(op, "operation.denied", { actor: input.actor, data: { policyDecisionId: decision.id } });
    return clone(op);
  }

  async listOperations(workspaceId: string, filters: OperationFilters = {}, page: PageRequest = {}): Promise<OperationPage> {
    const limit = Math.max(1, Math.min(500, Math.trunc(page.limit ?? 50)));
    const statuses = filters.status === undefined ? undefined : Array.isArray(filters.status) ? filters.status : [filters.status];
    let after: number | undefined;
    if (page.cursor !== undefined) {
      const decoded = /^seq:(\d+)$/.exec(Buffer.from(page.cursor, "base64url").toString("utf8"));
      if (!decoded) throw new BrokerError("invalid_request", "The page cursor is not valid.");
      after = Number(decoded[1]);
    }
    const rows = [...this.operations.values()]
      .filter((s) => s.record.workspaceId === workspaceId)
      .filter((s) => (statuses ? statuses.includes(s.record.status) : true))
      .filter((s) => (filters.projectId ? s.record.projectId === filters.projectId : true))
      .filter((s) => (filters.environmentId ? s.record.environmentId === filters.environmentId : true))
      .filter((s) => (filters.resourceId ? s.record.resourceId === filters.resourceId : true))
      .filter((s) => (filters.capability ? s.record.capability === filters.capability : true))
      .filter((s) => (filters.principalId ? s.record.principal.id === filters.principalId : true))
      .filter((s) => (after !== undefined ? s.seq < after : true))
      .sort((a, b) => b.seq - a.seq);
    const items = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? Buffer.from(`seq:${items[items.length - 1].seq}`).toString("base64url") : undefined;
    return { items: items.map((s) => clone(s.record)), nextCursor };
  }

  async cancelOperation(input: { workspaceId: string; id: string; reason?: string; actor?: Principal }): Promise<OperationRecord | null> {
    const stored = this.operations.get(opKey(input.workspaceId, input.id));
    if (!stored || !PRE_EXECUTION.includes(stored.record.status)) return null;
    const op = stored.record;
    op.status = "cancelled";
    op.updatedAt = this.nowIso();
    op.finishedAt = op.updatedAt;
    if (input.reason !== undefined) op.error = input.reason.slice(0, 4000);
    this.revokeLiveGrants(input.workspaceId, op.id);
    this.emitFor(op, "operation.cancelled", { actor: input.actor, data: input.reason ? { reason: input.reason.slice(0, 500) } : {} });
    return clone(op);
  }

  async expireOperation(input: { workspaceId: string; id: string }): Promise<OperationRecord | null> {
    const stored = this.operations.get(opKey(input.workspaceId, input.id));
    if (!stored || !PRE_EXECUTION.includes(stored.record.status) || Date.parse(stored.record.expiresAt) > this.nowMs()) return null;
    const op = stored.record;
    op.status = "expired";
    op.updatedAt = this.nowIso();
    op.finishedAt = op.updatedAt;
    this.revokeLiveGrants(input.workspaceId, op.id);
    this.emitFor(op, "operation.cancelled", { data: { reason: "expired" } });
    return clone(op);
  }

  async completeOperation(input: CompleteRequest): Promise<OperationRecord | null> {
    if (input.outcome !== "succeeded" && input.outcome !== "failed" && input.outcome !== "uncertain") throw new BrokerError("invalid_request", "outcome must be succeeded, failed or uncertain.");
    if (input.result !== undefined) {
      const secret = findSecret(input.result, "result");
      if (secret) throw new BrokerError("secret_material", `Refusing to store ${secret.what} at ${secret.path}.`);
    }
    if (input.error !== undefined && input.error.length > 4000) throw new BrokerError("invalid_request", "error is too long (max 4000 characters).");
    if (input.fence) this.assertFence(input.fence.scope, input.fence.fenceToken);
    const stored = this.operations.get(opKey(input.workspaceId, input.id));
    if (!stored || stored.record.status !== "running") return null;
    const op = stored.record;
    if (input.fence && !(op.leaseScope === input.fence.scope && op.fenceToken === input.fence.fenceToken)) return null;
    op.status = input.outcome;
    op.updatedAt = this.nowIso();
    op.finishedAt = op.updatedAt;
    if (input.result !== undefined) op.result = clone(input.result);
    if (input.error !== undefined) op.error = input.error;
    stored.leaseHolder = undefined;
    stored.leaseUntilMs = undefined;
    this.emitFor(op, input.outcome === "succeeded" ? "operation.succeeded" : input.outcome === "failed" ? "operation.failed" : "operation.uncertain", {
      actor: input.actor,
      data: input.error ? { error: input.error.slice(0, 500) } : {},
    });
    return clone(op);
  }

  private revokeLiveGrants(workspaceId: string, operationId: string): void {
    for (const grant of this.grants.values()) {
      if (grant.workspaceId === workspaceId && grant.operationId === operationId && !grant.revokedAt && !grant.consumedAt) grant.revokedAt = this.nowIso();
    }
  }

  /** Append a ledger event about an operation, like the platform store's emitForOperation. */
  private emitFor(op: OperationRecord, type: PlatformEventType, extra: { actor?: Principal; data?: Record<string, unknown> } = {}): void {
    this.appendEventSync({
      type,
      workspaceId: op.workspaceId,
      projectId: op.projectId,
      environmentId: op.environmentId,
      resourceId: op.resourceId,
      operationId: op.id,
      correlationId: op.correlationId,
      actor: extra.actor,
      data: extra.data ?? {},
    });
  }

  async claimForExecution(input: ClaimRequest): Promise<OperationRecord> {
    if (!DIGEST.test(input.expectedDigest)) throw new BrokerError("invalid_request", "expectedDigest must be a sha256 hex digest.");
    if (!input.holder) throw new BrokerError("invalid_request", "holder is required.");
    const leaseMs = input.leaseMs ?? 60_000;
    if (leaseMs < 1000 || leaseMs > 24 * 60 * 60 * 1000) throw new BrokerError("invalid_request", "leaseMs is out of range.");

    const stored = this.operations.get(opKey(input.workspaceId, input.id));
    if (!stored) throw notFound();
    const op = stored.record;
    if (op.status !== "approved" && op.status !== "queued") {
      throw new BrokerError("invalid_state", `Operation is ${op.status}; only an approved or queued operation can be claimed for execution.`, undefined, { status: op.status });
    }
    if (op.proposalDigest !== input.expectedDigest) throw new BrokerError("digest_mismatch", "The digest to execute does not match the reviewed proposal digest.");
    if (Date.parse(op.expiresAt) <= this.nowMs()) throw new BrokerError("operation_expired", "The operation expired before it could be executed.");
    if (input.lease) this.assertFence(input.lease.scope, input.lease.fenceToken);

    if (op.approvalRequired) {
      const required = this.requiredApprovals(input.workspaceId, op.policyDecisionId);
      const valid = this.validApprovals(input.workspaceId, op.id, input.expectedDigest, input.expectedPolicyVersion);
      if (valid.length < required) {
        const others = input.expectedPolicyVersion ? this.validApprovals(input.workspaceId, op.id, input.expectedDigest).length : 0;
        if (others > 0) throw new BrokerError("reapproval_required", "The approval was granted under a different policy bundle; the operation must be re-approved.");
        throw new BrokerError("approval_required", "No unconsumed, unexpired approval covers this operation.", undefined, { required, available: valid.length });
      }
      const consumedAt = this.nowIso();
      for (const approval of valid) approval.record.consumedAt = consumedAt;
    }

    op.status = "running";
    op.startedAt = this.nowIso();
    op.updatedAt = op.startedAt;
    op.leaseScope = input.lease?.scope;
    op.fenceToken = input.lease?.fenceToken;
    stored.leaseHolder = input.holder;
    stored.leaseUntilMs = this.nowMs() + leaseMs;
    this.emitFor(op, "operation.started", { data: { holder: input.holder, leaseScope: op.leaseScope, fenceToken: op.fenceToken } });
    return clone(op);
  }

  private requiredApprovals(workspaceId: string, decisionId: string | undefined): number {
    if (!decisionId) return 1;
    const count = this.decisions.get(decisionId)?.workspaceId === workspaceId ? this.decisions.get(decisionId)?.approval?.count : undefined;
    return typeof count === "number" && Number.isInteger(count) && count >= 1 ? count : 1;
  }

  private validApprovals(workspaceId: string, operationId: string, proposalDigest: string, policyVersion?: string): StoredApproval[] {
    const now = this.nowMs();
    return this.approvals.filter(
      (a) =>
        a.record.workspaceId === workspaceId &&
        a.record.operationId === operationId &&
        a.record.decision === "approve" &&
        a.record.proposalDigest === proposalDigest &&
        !a.record.consumedAt &&
        Date.parse(a.record.expiresAt) > now &&
        (policyVersion === undefined || a.record.policyVersion === policyVersion)
    );
  }

  /* --------------------------------- decisions -------------------------------- */

  async recordPolicyDecision(input: NewDecision & { workspaceId: string; operationId: string; id?: string }): Promise<PolicyDecisionRecord> {
    if (!this.operations.has(opKey(input.workspaceId, input.operationId))) throw notFound();
    if (!["allow", "deny", "require_approval"].includes(input.outcome)) throw new BrokerError("invalid_request", "outcome must be allow, deny or require_approval.");
    const secret = findSecret({ reasons: input.reasons, constraints: input.constraints }, "decision");
    if (secret) throw new BrokerError("secret_material", `Refusing to store ${secret.what} at ${secret.path}.`);
    const record: PolicyDecisionRecord = {
      id: input.id ?? this.nextId("pol"),
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      policyVersion: input.policyVersion,
      inputDigest: input.inputDigest,
      outcome: input.outcome,
      reasons: clone(input.reasons),
      approval: input.approval ? clone(input.approval) : undefined,
      constraints: input.constraints ? clone(input.constraints) : undefined,
      evaluatedAt: this.nowIso(),
    };
    this.decisions.set(record.id, record);
    return clone(record);
  }

  async getPolicyDecision(workspaceId: string, id: string): Promise<PolicyDecisionRecord | null> {
    const found = this.decisions.get(id);
    return found && found.workspaceId === workspaceId ? clone(found) : null;
  }

  /* --------------------------------- approvals -------------------------------- */

  async recordApproval(input: RecordApprovalRequest): Promise<RecordApprovalResult> {
    const { approver } = input;
    if (approver.kind !== "user" || approver.onBehalfOf !== undefined || approver.integrationId !== undefined) {
      throw new BrokerError("approver_not_human", "Only a human user can approve or reject an operation. Agents, integrations, runners and system principals never can.", undefined, { approverKind: approver.kind });
    }
    if (!approver.id) throw new BrokerError("invalid_request", "approver.id is required.");
    if (!DIGEST.test(input.proposalDigest)) throw new BrokerError("invalid_request", "proposalDigest must be a sha256 hex digest.");
    if (!input.policyVersion || input.policyVersion.length > 128) throw new BrokerError("invalid_request", "policyVersion is required.");
    if (input.decision !== "approve" && input.decision !== "reject") throw new BrokerError("invalid_request", "decision must be approve or reject.");
    if (!(input.approverRole in ROLE_RANK)) throw new BrokerError("invalid_request", "approverRole must be viewer, editor or admin.");
    if (input.approverRole === "viewer") throw new BrokerError("approver_role_insufficient", "A viewer cannot approve or reject operations.");
    if (input.reason !== undefined) {
      if (input.reason.length > 2000) throw new BrokerError("invalid_request", "reason is too long (max 2000 characters).");
      const secret = findSecret(input.reason, "reason");
      if (secret) throw new BrokerError("secret_material", `Refusing to store ${secret.what} in the reason.`);
    }
    const ttlMs = input.ttlMs ?? 60 * 60 * 1000;
    if (ttlMs < 1000 || ttlMs > MAX_TTL_MS) throw new BrokerError("invalid_request", "ttlMs is out of range.");

    const stored = this.operations.get(opKey(input.workspaceId, input.operationId));
    if (!stored) throw notFound();
    const op = stored.record;
    if (op.status !== "awaiting_approval") {
      throw new BrokerError("invalid_state", `Operation is ${op.status}; only an operation awaiting approval can be approved or rejected.`, undefined, { status: op.status });
    }
    if (Date.parse(op.expiresAt) <= this.nowMs()) throw new BrokerError("operation_expired", "The operation expired before it was reviewed.");
    if (op.proposalDigest !== input.proposalDigest) {
      throw new BrokerError("digest_mismatch", "The digest you reviewed does not match the operation's current proposal. Reload and review the exact proposal.");
    }

    const decision = op.policyDecisionId ? this.decisions.get(op.policyDecisionId) : undefined;
    const requirement: ApprovalRequirement | undefined = decision && decision.workspaceId === input.workspaceId ? decision.approval : undefined;
    const need = requirement && Number.isInteger(requirement.count) && requirement.count >= 1 ? requirement.count : 1;
    if (requirement && ROLE_RANK[input.approverRole] < ROLE_RANK[requirement.minRole]) {
      throw new BrokerError("approver_role_insufficient", `This operation needs an approver with at least the ${requirement.minRole} role.`, undefined, { need: requirement.minRole, role: input.approverRole });
    }
    const requester = op.principal.onBehalfOf ?? op.principal.id;
    if (requirement?.separationOfDuties && approver.id === requester) {
      throw new BrokerError("separation_of_duties", "The requester cannot approve their own operation; a different approver is required.");
    }
    if (this.approvals.some((a) => a.record.operationId === op.id && a.record.workspaceId === input.workspaceId && a.approverId === approver.id)) {
      throw new BrokerError("duplicate_decision", "This approver has already decided on this operation.");
    }

    const nowIso = this.nowIso();
    const record: ApprovalRecord = {
      id: this.nextId("apr"),
      operationId: op.id,
      workspaceId: input.workspaceId,
      proposalDigest: input.proposalDigest,
      decision: input.decision,
      approver: clone(approver),
      approverRole: input.approverRole,
      reason: input.reason,
      policyVersion: input.policyVersion,
      createdAt: nowIso,
      expiresAt: new Date(Math.min(Date.parse(op.expiresAt), this.nowMs() + ttlMs)).toISOString(),
    };
    this.approvals.push({ record, approverId: approver.id });

    let have = 0;
    if (input.decision === "reject") {
      this.moveAwaiting(stored, "rejected");
    } else {
      have = this.approvals.filter(
        (a) => a.record.workspaceId === input.workspaceId && a.record.operationId === op.id && a.record.decision === "approve" && a.record.proposalDigest === input.proposalDigest
      ).length;
      if (have >= need) this.moveAwaiting(stored, "approved");
    }
    const after: OperationStatus = stored.record.status;
    if (after === "approved" || after === "rejected") {
      this.emitFor(op, after === "approved" ? "operation.approved" : "operation.rejected", {
        actor: approver,
        data: { approvalId: record.id, approverRole: input.approverRole, approvals: { have, need }, proposalDigest: input.proposalDigest, policyVersion: input.policyVersion },
      });
    }
    return { approval: clone(record), operation: clone(op), approvals: { have, need } };
  }

  private moveAwaiting(stored: StoredOperation, to: "approved" | "rejected"): void {
    const op = stored.record;
    op.status = to;
    op.updatedAt = this.nowIso();
    if (to === "rejected") op.finishedAt = op.updatedAt;
  }

  async listApprovals(workspaceId: string, operationId: string): Promise<ApprovalRecord[]> {
    return clone(this.approvals.filter((a) => a.record.workspaceId === workspaceId && a.record.operationId === operationId).map((a) => a.record));
  }

  /* ----------------------------------- grants --------------------------------- */

  async insertGrant(input: Omit<GrantRecord, "consumedAt" | "revokedAt">): Promise<GrantRecord> {
    const issued = Date.parse(input.issuedAt);
    const expires = Date.parse(input.expiresAt);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) throw new BrokerError("invalid_request", "A grant must expire after it is issued.");
    if (expires - issued > 60 * 60 * 1000) throw new BrokerError("invalid_request", "A capability grant may live at most one hour.");
    if (!this.operations.has(opKey(input.workspaceId, input.operationId))) throw notFound();
    const key = `${input.workspaceId}\u0000${input.jti}`;
    if (this.grants.has(key)) throw new BrokerError("conflict", "A grant with this id already exists.");
    const record: GrantRecord = { ...input };
    this.grants.set(key, record);
    return clone(record);
  }

  async consumeGrant(input: { workspaceId: string; jti: string; audience?: string }): Promise<boolean> {
    const grant = this.grants.get(`${input.workspaceId}\u0000${input.jti}`);
    if (!grant || grant.consumedAt || grant.revokedAt) return false;
    if (Date.parse(grant.expiresAt) <= this.nowMs()) return false;
    if (input.audience !== undefined && grant.audience !== input.audience) return false;
    grant.consumedAt = this.nowIso();
    return true;
  }

  async revokeGrantsForOperation(workspaceId: string, operationId: string): Promise<number> {
    let n = 0;
    for (const grant of this.grants.values()) {
      if (grant.workspaceId === workspaceId && grant.operationId === operationId && !grant.revokedAt && !grant.consumedAt) {
        grant.revokedAt = this.nowIso();
        n++;
      }
    }
    return n;
  }

  /* ---------------------------------- settings -------------------------------- */

  async getEnvironmentSettings(workspaceId: string, environmentId: string): Promise<EnvironmentSettings> {
    const found = this.environments.get(environmentId);
    if (found && found.workspaceId === workspaceId) return clone(found);
    return { environmentId, workspaceId, autonomyLevel: 1, version: 0, isDefault: true };
  }

  async putEnvironmentAutonomy(input: { workspaceId: string; environmentId: string; autonomyLevel: AutonomyLevel; updatedBy: string; expectedVersion?: number }): Promise<EnvironmentSettings> {
    if (!Number.isInteger(input.autonomyLevel) || input.autonomyLevel < 0 || input.autonomyLevel > 5) throw new BrokerError("invalid_request", "autonomyLevel must be an integer from 0 to 5.");
    const existing = this.environments.get(input.environmentId);
    if (existing && existing.workspaceId !== input.workspaceId) throw notFound();
    const currentVersion = existing?.version ?? 0;
    if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
      throw new BrokerError("conflict", "Environment settings changed since you read them; reload and retry.", undefined, { currentVersion });
    }
    const next: EnvironmentSettings = {
      environmentId: input.environmentId,
      workspaceId: input.workspaceId,
      autonomyLevel: input.autonomyLevel,
      version: currentVersion + 1,
      updatedBy: input.updatedBy,
      updatedAt: this.nowIso(),
      isDefault: false,
    };
    this.environments.set(input.environmentId, next);
    return clone(next);
  }

  async getWorkspacePolicy(workspaceId: string): Promise<WorkspacePolicySettings> {
    const found = this.policies.get(workspaceId);
    return found ? clone(found) : { workspaceId, params: {}, version: 0, isDefault: true };
  }

  async putWorkspacePolicy(input: { workspaceId: string; params: Record<string, unknown>; updatedBy: string; expectedVersion?: number }): Promise<WorkspacePolicySettings> {
    const secret = findSecret(input.params, "params");
    if (secret) throw new BrokerError("secret_material", `Refusing to store ${secret.what} at ${secret.path}.`);
    const existing = this.policies.get(input.workspaceId);
    const currentVersion = existing?.version ?? 0;
    if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
      throw new BrokerError("conflict", "Workspace policy changed since you read it; reload and retry.", undefined, { currentVersion });
    }
    const next: WorkspacePolicySettings = {
      workspaceId: input.workspaceId,
      params: clone(input.params),
      version: currentVersion + 1,
      updatedBy: input.updatedBy,
      updatedAt: this.nowIso(),
      isDefault: false,
    };
    this.policies.set(input.workspaceId, next);
    return clone(next);
  }

  /* ----------------------------------- events --------------------------------- */

  private appendEventSync(input: NewEvent): number {
    if (!EVENT_TYPE_SHAPE.test(input.type)) throw new BrokerError("invalid_request", "event type must look like `operation.started`.");
    if (!input.workspaceId || !input.correlationId) throw new BrokerError("invalid_request", "workspaceId and correlationId are required.");
    if (JSON.stringify(input.data ?? {}).length > MAX_EVENT_BYTES) throw new BrokerError("invalid_request", "event data is too large (max 64 KiB).");
    const secret = findSecret(input.data, "data");
    if (secret) throw new BrokerError("secret_material", `Refusing to store ${secret.what} at ${secret.path}.`);
    if (input.id) {
      const existing = this.events.find((e) => e.id === input.id);
      if (existing) {
        if (existing.workspaceId !== input.workspaceId) throw new BrokerError("conflict", "An event with this id already exists.");
        return existing.seq;
      }
    }
    const event: PlatformEvent = {
      seq: ++this.eventSeq,
      id: input.id ?? this.nextId("evt"),
      ts: this.nowIso(),
      type: input.type,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      resourceId: input.resourceId,
      operationId: input.operationId,
      correlationId: input.correlationId,
      causationId: input.causationId,
      actor: input.actor ? clone(input.actor) : undefined,
      data: clone(input.data ?? {}),
    };
    this.events.push(event);
    return event.seq;
  }

  async appendEvent(input: NewEvent): Promise<number> {
    return this.appendEventSync(input);
  }

  async listEvents(workspaceId: string, filter: ListEventsRequest = {}): Promise<PlatformEvent[]> {
    const limit = Math.max(1, Math.min(1000, Math.trunc(filter.limit ?? 100)));
    if (filter.afterSeq !== undefined && (!Number.isSafeInteger(filter.afterSeq) || filter.afterSeq < 0)) {
      throw new BrokerError("invalid_request", "afterSeq must be a non-negative integer.");
    }
    return clone(
      this.events
        .filter((e) => e.workspaceId === workspaceId)
        .filter((e) => (filter.operationId ? e.operationId === filter.operationId : true))
        .filter((e) => (filter.environmentId ? e.environmentId === filter.environmentId : true))
        .filter((e) => (filter.type ? e.type === filter.type : true))
        .filter((e) => (filter.afterSeq !== undefined ? e.seq > filter.afterSeq : true))
        .slice(0, limit)
    );
  }
}
