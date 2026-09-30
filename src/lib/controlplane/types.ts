/**
 * Control-plane contract: the vocabulary every deterministic subsystem shares.
 *
 * The platform control store (`src/lib/controlplane/db`) is the fifth state
 * authority (ADR-0002). It is Postgres (schema `platform`) in production and
 * PGlite in local development and tests — one SQL dialect, one set of
 * repositories, real transactions everywhere. It holds what the product store
 * (PostgREST, no cross-table transactions) cannot: operations, leases and
 * fence tokens, durable idempotency, approvals, policy decision records,
 * capability grants, resources with observed/runtime state, provider
 * connections, runners, machines, incidents and the structured event log.
 *
 * Invariants (every implementation and every caller):
 *  1. Tenancy is explicit. Every row that belongs to a tenant carries
 *     `workspace_id`; every read that could cross tenants takes a workspace id
 *     and filters on it in SQL, never in application code after the fact.
 *  2. No secret values. Rows hold references (`vault:…`, ARNs, secret names),
 *     digests and redacted summaries. A credential, token or password never
 *     reaches this store, an event, a log line, or a model-visible response.
 *  3. Mutations that protect a scope carry a fence token; a write whose fence
 *     is stale affects zero rows and the caller treats that as lease loss.
 *  4. Status transitions are conditional UPDATEs (`WHERE status IN (…)`), so a
 *     racing second writer loses deterministically instead of overwriting.
 *  5. "Unknown" is a first-class answer. Nothing here infers an observed value
 *     that was not actually read from a provider.
 */

/* ------------------------------ SQL executor ------------------------------ */

/** Positional-parameter SQL (`$1`, `$2`, …), identical on Postgres and PGlite. */
export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /**
   * Run `fn` in one transaction. Resolves only after COMMIT. A nested call
   * opens a savepoint. `fn` must be database-only: it may be retried on a
   * serialization failure, so it must not perform external side effects.
   */
  tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
}

export interface PlatformDb extends Sql {
  readonly kind: "postgres" | "pglite";
  close(): Promise<void>;
}

/* -------------------------------- principals ------------------------------ */

/**
 * Who is asking. A model is never a principal by itself: an agent acts through
 * an `integration` principal bound to a human subject's grant, and it can never
 * be the approver of its own proposal.
 */
export type PrincipalKind = "user" | "integration" | "navigator" | "system" | "runner" | "machine";

export interface Principal {
  kind: PrincipalKind;
  /** user id, integration credential id, runner id, … */
  id: string;
  /** human-readable, never used for authorization */
  name: string;
  /** For `integration` and `navigator`: the human whose grant bounds it. */
  onBehalfOf?: string;
  /** For `integration`: the linked client / credential id. */
  integrationId?: string;
}

/** The tenant hierarchy every request is scoped through (spec §51). */
export interface Scope {
  workspaceId: string;
  projectId?: string;
  environmentId?: string;
  resourceId?: string;
}

/* ---------------------------------- leases -------------------------------- */

/**
 * A lease scope is a string key. Conventions:
 *   `env:<environmentId>`      — exclusive: every mutation of an environment's
 *                                infrastructure or workloads (deploy, apply,
 *                                restart, scale, remediation, destroy)
 *   `resource:<resourceId>`    — resources not owned by one environment
 *   `connection:<connectionId>`— credential rotation / connection mutation
 *   `reconcile:<environmentId>`— the reconciliation controller's pass
 * Read-only work takes no lease.
 */
export type LeaseScope = string;

export interface Lease {
  scope: LeaseScope;
  /** worker/process identity, e.g. `worker:<host>:<pid>:<uuid>` or an operation id */
  holder: string;
  /** strictly increasing per scope; carried by every fenced write and external call */
  fenceToken: number;
  acquiredAt: string;
  expiresAt: string;
}

export class LeaseLostError extends Error {
  readonly code = "lease_lost";
  constructor(
    readonly scope: LeaseScope,
    readonly fenceToken: number
  ) {
    super(`Lease ${scope} (fence ${fenceToken}) is no longer held; the operation must stop and be reconciled.`);
  }
}

/* -------------------------------- operations ------------------------------ */

/**
 * The canonical durable record of any capability execution — deploy, apply,
 * restart, scale, exec, remediation. Created at proposal time, bound to an
 * immutable `proposalDigest`, and advanced only by conditional transitions.
 *
 *   proposed ─▶ awaiting_approval ─▶ approved ─▶ queued ─▶ running ─▶ succeeded
 *      │               │                 │          │          ├─▶ failed
 *      ├─▶ denied      ├─▶ rejected      │          │          └─▶ uncertain
 *      └─▶ approved (policy allow)       └──────────┴─▶ cancelled / expired
 *
 * `uncertain` means the control plane cannot prove whether an external side
 * effect happened (a worker crashed mid-call, a lease was lost, a timeout).
 * It is terminal for automation: nothing re-dispatches an uncertain operation;
 * reconciliation observes reality and a human or a new operation decides.
 */
export type OperationStatus =
  | "proposed"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "denied"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "uncertain"
  | "cancelled"
  | "expired";

export const TERMINAL_OPERATION_STATUSES: readonly OperationStatus[] = [
  "rejected",
  "denied",
  "succeeded",
  "failed",
  "uncertain",
  "cancelled",
  "expired",
];

export interface OperationProposal {
  capability: string;
  scope: Scope;
  /** validated, redacted input (no secret values; references only) */
  input: unknown;
  /** human-readable plan the approver sees */
  summary: string;
  details: string[];
  risk: "low" | "medium" | "high" | "critical";
  /** present for infrastructure changes: the OpenTofu plan digest reviewed */
  planDigest?: string;
  /** estimated monthly cost delta in USD, when computed */
  costDeltaUsd?: number;
  /** provenance: which model/tool proposed it, which source revision */
  origin?: { tool?: string; model?: string; sourceRef?: string };
}

export interface OperationRecord {
  id: string;
  workspaceId: string;
  projectId?: string;
  environmentId?: string;
  resourceId?: string;
  capability: string;
  principal: Principal;
  status: OperationStatus;
  proposal: OperationProposal;
  /** digest(proposal) — approvals and grants bind to exactly this */
  proposalDigest: string;
  /** digest of the validated input alone (idempotency) */
  inputDigest: string;
  planDigest?: string;
  policyDecisionId?: string;
  approvalRequired: boolean;
  idempotencyKey?: string;
  workflowId?: string;
  runnerJobId?: string;
  leaseScope?: LeaseScope;
  fenceToken?: number;
  correlationId: string;
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** proposals and approvals are not valid forever */
  expiresAt: string;
}

/* -------------------------------- approvals ------------------------------- */

export interface ApprovalRecord {
  id: string;
  operationId: string;
  workspaceId: string;
  /** the digest the approver actually reviewed; must equal the operation's */
  proposalDigest: string;
  decision: "approve" | "reject";
  approver: Principal; // always kind "user" — enforced by the approval service
  approverRole: "viewer" | "editor" | "admin";
  reason?: string;
  /** the policy bundle digest in force when approved; a changed bundle re-evaluates */
  policyVersion: string;
  createdAt: string;
  expiresAt: string;
  /** set once, in the same transaction that claims the operation for execution */
  consumedAt?: string;
}

/* ----------------------------- policy decisions --------------------------- */

export type PolicyOutcome = "allow" | "deny" | "require_approval";

export interface PolicyReason {
  /** stable machine code, e.g. `prod_db_delete_denied` */
  code: string;
  message: string;
  /** rule path inside the bundle, e.g. `zenith.rules.destructive` */
  rule?: string;
}

export interface ApprovalRequirement {
  /** number of distinct human approvers */
  count: number;
  /** minimum workspace role of each approver */
  minRole: "editor" | "admin";
  /** approver must differ from the requesting human (two-person rule) */
  separationOfDuties: boolean;
}

export interface PolicyDecisionRecord {
  id: string;
  workspaceId: string;
  operationId?: string;
  /** sha256 of the compiled policy bundle (wasm + data schema) */
  policyVersion: string;
  /** digest(canonical policy input) */
  inputDigest: string;
  outcome: PolicyOutcome;
  reasons: PolicyReason[];
  approval?: ApprovalRequirement;
  /** "restrict": allow, but only within these constraints */
  constraints?: Record<string, unknown>;
  evaluatedAt: string;
}

/* ---------------------------- capability grants --------------------------- */

/**
 * The claims of a short-lived signed capability grant (JWT, EdDSA or ES256).
 * Issued by the capability broker at execution time, verified by every
 * execution surface (Temporal activities, runners, zenithd) before acting.
 * A grant authorizes exactly one capability on exactly one scope for exactly
 * one operation digest; it is useless for anything else.
 */
export interface CapabilityGrantClaims {
  /** unique grant id; single-use grants are consumed by id */
  jti: string;
  iss: string;
  /** who may present it: `worker`, `runner:<id>`, `machine:<id>` */
  aud: string;
  /** the principal the operation runs on behalf of */
  sub: string;
  iat: number;
  exp: number;
  cap: string;
  op: string;
  digest: string;
  ws: string;
  proj?: string;
  env?: string;
  res?: string;
  /** fence token of the lease the operation holds, when it holds one */
  fence?: number;
  /** policy "restrict" constraints the executor must enforce */
  constraints?: Record<string, unknown>;
}

/* ---------------------------------- events -------------------------------- */

/**
 * Structured control-plane events (spec §37). Append-only. Never contains
 * secret values; `data` is a redacted, bounded summary.
 */
export type PlatformEventType =
  | "operation.proposed"
  | "operation.prepared"
  | "operation.approved"
  | "operation.rejected"
  | "operation.denied"
  | "operation.started"
  | "operation.succeeded"
  | "operation.failed"
  | "operation.uncertain"
  | "operation.cancelled"
  | "policy.evaluated"
  | "workflow.started"
  | "workflow.completed"
  | "lease.acquired"
  | "lease.lost"
  | "lease.released"
  | "credential.assumed"
  | "credential.denied"
  | "resource.planned"
  | "resource.applying"
  | "resource.applied"
  | "resource.verified"
  | "resource.observed"
  | "deployment.healthy"
  | "deployment.unhealthy"
  | "drift.detected"
  | "drift.cleared"
  | "incident.opened"
  | "incident.investigated"
  | "incident.resolved"
  | "remediation.proposed"
  | "remediation.approved"
  | "remediation.completed"
  | "runner.registered"
  | "runner.revoked"
  | "runner.job.dispatched"
  | "runner.job.completed"
  | "machine.registered"
  | "machine.revoked"
  | "machine.request.completed";

export interface PlatformEvent {
  /** global monotonic sequence (bigserial) */
  seq: number;
  id: string;
  ts: string;
  type: PlatformEventType;
  workspaceId: string;
  projectId?: string;
  environmentId?: string;
  resourceId?: string;
  operationId?: string;
  /** groups every event of one logical flow (a deploy, an incident) */
  correlationId: string;
  /** the event or operation that caused this one */
  causationId?: string;
  actor?: Principal;
  data: Record<string, unknown>;
}

/* --------------------------------- evidence ------------------------------- */

/** Durable proof of what happened, referenced from operations and incidents. */
export interface EvidenceRecord {
  id: string;
  workspaceId: string;
  operationId?: string;
  incidentId?: string;
  kind:
    | "tofu_plan"
    | "tofu_apply"
    | "observation"
    | "verification"
    | "http_probe"
    | "log_query"
    | "metric_query"
    | "policy_decision"
    | "build"
    | "machine_request"
    | "runner_job";
  /** content digest of the underlying artifact (plan JSON, response body, …) */
  digest: string;
  /** redacted, bounded, model-safe summary */
  summary: Record<string, unknown>;
  /** where the full (still redacted) artifact is stored, if kept */
  blobRef?: string;
  simulated: boolean;
  createdAt: string;
}
