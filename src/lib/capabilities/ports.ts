/**
 * The broker's ports: the narrow seams between the capability broker and
 * everything it does not own.
 *
 *   BrokerStore    operations ledger, decisions, approvals, grants, settings, events
 *   ScopeResolver  workspace → project → environment → resource chain + facts
 *   RoleResolver   the principal's workspace role and integration scopes
 *   GrantSigner    capability grant claims → compact EdDSA JWS
 *   Clock          injected time (nothing in the broker reads `Date.now()`)
 *
 * Each port is the SMALLEST surface the broker needs. Production adapters
 * (the platform control store `src/lib/controlplane/db/repos/*`, the product
 * store, the credential broker's signer) implement them; `MemoryBrokerStore`
 * implements `BrokerStore` for tests and development with the same semantics.
 *
 * Every `BrokerStore` method that reads or writes tenant data takes the
 * `workspaceId` and MUST filter on it (in SQL, for a database adapter). A
 * wrong-tenant id is indistinguishable from a missing one: `null`, or a
 * `BrokerError("not_found")` where a value is required. Failures are
 * `BrokerError`s using the store-facing codes in `errors.ts`.
 */
import type {
  ApprovalRecord,
  ApprovalRequirement,
  CapabilityGrantClaims,
  OperationProposal,
  OperationRecord,
  OperationStatus,
  PlatformEvent,
  PlatformEventType,
  PolicyDecisionRecord,
  PolicyOutcome,
  PolicyReason,
  Principal,
  Scope,
} from "@/lib/controlplane/types";
import type { AutonomyLevel, EnvironmentClass, PolicyEngine, PolicyInput } from "@/lib/policy";

/* ---------------------------------- time ---------------------------------- */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/* ------------------------------- role / scope ------------------------------ */

export type WorkspaceRoleOrNone = "viewer" | "editor" | "admin" | "none";

export const ROLE_RANK: Readonly<Record<WorkspaceRoleOrNone, number>> = { none: -1, viewer: 0, editor: 1, admin: 2 };

export interface ResolvedAccess {
  /** the principal's role in the workspace; "none" when not a member */
  role: WorkspaceRoleOrNone;
  /** integration credential scopes (`read`, `plan`, `logs`, `write`, `publish`), when the principal is an integration */
  integrationScopes?: string[];
  /** integration credential's project restriction; absent = not restricted */
  allowedProjectIds?: string[];
  /** integration credential's environment restriction; absent = not restricted */
  allowedEnvironmentIds?: string[];
}

export interface RoleResolver {
  /**
   * The principal's CURRENT access in `workspaceId`. Re-asked at every decision
   * and again at execution, never cached across them: a removed member or a
   * revoked credential must stop working on the next call.
   */
  resolve(principal: Principal, workspaceId: string): Promise<ResolvedAccess>;
}

export interface ResolvedScope {
  /** the full chain, every id verified to belong to `scope.workspaceId` */
  scope: Scope;
  environment?: { id: string; class: EnvironmentClass; provider: string; region: string };
  resource?: NonNullable<PolicyInput["resource"]>;
}

export interface ScopeResolver {
  /**
   * Resolve the ids the request named. Returns `null` when ANY id does not
   * chain inside the workspace (missing, foreign, or in a different project /
   * environment than the ids beside it). Parent ids the request left out are
   * filled from the chain. Never throws for "not found".
   */
  resolve(scope: Scope): Promise<ResolvedScope | null>;
}

/* --------------------------------- signing --------------------------------- */

export interface GrantSigner {
  /**
   * Resolves when a grant can be signed; rejects with
   * `BrokerError("signer_unavailable")` otherwise. Called BEFORE an approval is
   * consumed, so a missing key never burns an approval.
   */
  ready(): Promise<void>;
  /** Sign the claims into a compact JWS. Must refuse malformed claims. */
  sign(claims: CapabilityGrantClaims): Promise<string>;
}

/* ---------------------------------- store ---------------------------------- */

export interface NewDecision {
  policyVersion: string;
  inputDigest: string;
  outcome: PolicyOutcome;
  reasons: PolicyReason[];
  approval?: ApprovalRequirement;
  constraints?: Record<string, unknown>;
}

export interface NewEvent {
  /** supplying an id makes the append idempotent */
  id?: string;
  type: PlatformEventType;
  workspaceId: string;
  projectId?: string;
  environmentId?: string;
  resourceId?: string;
  operationId?: string;
  correlationId: string;
  causationId?: string;
  actor?: Principal;
  /** redacted, bounded summary; never a secret value */
  data: Record<string, unknown>;
}

export interface NewOperation {
  /** broker-minted so events and the decision can reference it */
  id: string;
  /** broker-minted id of the decision persisted with the operation */
  decisionId: string;
  workspaceId: string;
  principal: Principal;
  proposal: OperationProposal;
  /** decided by policy: allow → approved, require_approval → awaiting_approval, deny → denied */
  status: "approved" | "awaiting_approval" | "denied";
  approvalRequired: boolean;
  decision: NewDecision;
  /** already scoped to workspace + principal + capability by the broker; absent = not idempotent */
  idempotencyKey?: string;
  /** digest of everything that makes two requests "the same request" */
  requestHash: string;
  correlationId: string;
  /** proposal / approval validity (1 min – 7 days) */
  ttlMs: number;
  /** appended in the same transaction, and only when the operation is newly created */
  events: NewEvent[];
}

export interface CreateOperationResult {
  operation: OperationRecord;
  /** the decision persisted with the operation (the original one on a replay) */
  decision: PolicyDecisionRecord;
  /** false when an earlier request with the same key and hash already created it */
  created: boolean;
}

export interface OperationFilters {
  status?: OperationStatus | readonly OperationStatus[];
  projectId?: string;
  environmentId?: string;
  resourceId?: string;
  capability?: string;
  principalId?: string;
}

export interface PageRequest {
  limit?: number;
  /** opaque, from a previous page's `nextCursor` */
  cursor?: string;
}

export interface OperationPage {
  items: OperationRecord[];
  nextCursor?: string;
}

export interface OperationPatch {
  result?: unknown;
  error?: string;
}

export interface TransitionRequest {
  workspaceId: string;
  id: string;
  from: readonly OperationStatus[];
  to: OperationStatus;
  patch?: OperationPatch;
  fence?: { scope: string; fenceToken: number };
}

export interface ClaimRequest {
  workspaceId: string;
  id: string;
  /** the digest the executor was told to run; must equal the stored proposal digest */
  expectedDigest: string;
  holder: string;
  leaseMs?: number;
  lease?: { scope: string; fenceToken: number };
  /** only approvals granted under exactly this bundle count (the broker omits it: it validates approvals against the CURRENT requirement itself) */
  expectedPolicyVersion?: string;
}

export interface RecordApprovalRequest {
  workspaceId: string;
  operationId: string;
  approver: Principal;
  approverRole: "viewer" | "editor" | "admin";
  decision: "approve" | "reject";
  proposalDigest: string;
  policyVersion: string;
  reason?: string;
  ttlMs?: number;
}

export interface RecordApprovalResult {
  approval: ApprovalRecord;
  operation: OperationRecord;
  approvals: { have: number; need: number };
}

export interface GrantRecord {
  jti: string;
  workspaceId: string;
  operationId: string;
  capability: string;
  audience: string;
  issuedAt: string;
  expiresAt: string;
  consumedAt?: string;
  revokedAt?: string;
}

export interface EnvironmentSettings {
  environmentId: string;
  workspaceId: string;
  autonomyLevel: AutonomyLevel;
  /** 0 when never configured */
  version: number;
  updatedBy?: string;
  updatedAt?: string;
  /** true when no row exists: `autonomyLevel` is then a store placeholder, not a decision */
  isDefault: boolean;
}

export interface WorkspacePolicySettings {
  workspaceId: string;
  /** overrides only (validated by `resolveWorkspacePolicy`); `{}` when never set */
  params: Record<string, unknown>;
  version: number;
  updatedBy?: string;
  updatedAt?: string;
  isDefault: boolean;
}

export interface ListEventsRequest {
  operationId?: string;
  environmentId?: string;
  type?: string;
  /** exclusive lower bound */
  afterSeq?: number;
  limit?: number;
}

export interface BrokerStore {
  /**
   * Create an operation together with its policy decision, atomically, with
   * idempotency: the same `idempotencyKey` + `requestHash` returns the existing
   * operation (`created: false`, no new events); the same key with a different
   * hash rejects with `BrokerError("idempotency_conflict")`. The store computes
   * `proposalDigest = digest(proposal)` itself so no caller can store a digest
   * that disagrees with the proposal.
   */
  createOperation(input: NewOperation): Promise<CreateOperationResult>;
  getOperation(workspaceId: string, id: string): Promise<OperationRecord | null>;
  listOperations(workspaceId: string, filters?: OperationFilters, page?: PageRequest): Promise<OperationPage>;
  /**
   * Conditional status change; `null` when the operation is missing, in another
   * workspace, or not in one of the `from` statuses. Refuses `running` (only
   * `claimForExecution` may set it) and, for an operation awaiting approval,
   * `approved` (only `recordApproval` may).
   */
  transition(input: TransitionRequest): Promise<OperationRecord | null>;
  /**
   * The single-use gate to execution. Atomically: require `approved`/`queued`,
   * digest equality, not expired, live lease fence (when given), consume the
   * approvals (each exactly once) when approval was required, set `running`.
   * Of two concurrent claimants exactly one succeeds; the other rejects with
   * `invalid_state`. Any failed check changes nothing.
   */
  claimForExecution(input: ClaimRequest): Promise<OperationRecord>;

  /** Append a decision for an existing operation (re-evaluation at execution). */
  recordPolicyDecision(input: NewDecision & { workspaceId: string; operationId: string; id?: string }): Promise<PolicyDecisionRecord>;
  getPolicyDecision(workspaceId: string, id: string): Promise<PolicyDecisionRecord | null>;

  /**
   * The ONLY path by which an operation that requires approval becomes
   * `approved` (or `rejected`): one transaction that checks the approver is a
   * human user, the digest, role, separation of duties and duplicate decisions,
   * inserts the approval, and moves the operation once enough DISTINCT
   * approvers have approved.
   */
  recordApproval(input: RecordApprovalRequest): Promise<RecordApprovalResult>;
  listApprovals(workspaceId: string, operationId: string): Promise<ApprovalRecord[]>;

  insertGrant(input: Omit<GrantRecord, "consumedAt" | "revokedAt">): Promise<GrantRecord>;
  /** true exactly once, only while unexpired, unrevoked and in `workspaceId`. */
  consumeGrant(input: { workspaceId: string; jti: string; audience?: string }): Promise<boolean>;
  /** Revoke every still-live grant of an operation (cancel, completion). Returns how many. */
  revokeGrantsForOperation(workspaceId: string, operationId: string): Promise<number>;

  getEnvironmentSettings(workspaceId: string, environmentId: string): Promise<EnvironmentSettings>;
  /** Optimistic concurrency: a stale `expectedVersion` rejects with `conflict`. */
  putEnvironmentAutonomy(input: {
    workspaceId: string;
    environmentId: string;
    autonomyLevel: AutonomyLevel;
    updatedBy: string;
    expectedVersion?: number;
  }): Promise<EnvironmentSettings>;
  getWorkspacePolicy(workspaceId: string): Promise<WorkspacePolicySettings>;
  putWorkspacePolicy(input: {
    workspaceId: string;
    params: Record<string, unknown>;
    updatedBy: string;
    expectedVersion?: number;
  }): Promise<WorkspacePolicySettings>;

  appendEvent(input: NewEvent): Promise<number>;
  listEvents(workspaceId: string, filter?: ListEventsRequest): Promise<PlatformEvent[]>;
}

/* ---------------------------------- deps ----------------------------------- */

/** Everything a broker function needs; built once per process by `platformBroker()`. */
export interface BrokerDeps {
  store: BrokerStore;
  scopes: ScopeResolver;
  roles: RoleResolver;
  signer: GrantSigner;
  clock: Clock;
  /** Resolves the policy engine; a rejection means "deny everything" (`policy_unavailable`). */
  policy: () => Promise<PolicyEngine>;
  /** `iss` of issued grants. Default `zenith-control`. */
  issuer?: string;
  /** id minting; injectable for deterministic tests. Default `<prefix>_<uuid>`. */
  newId?: (prefix: string) => string;
}
