/**
 * Broker-level types that are not part of the fixed control-plane contract.
 * Additive only; nothing here changes `controlplane/types.ts`.
 */
import type { NormalizedPlan } from "@/lib/tofu/types";
import type {
  ApprovalRequirement,
  OperationProposal,
  OperationStatus,
  PolicyOutcome,
  PolicyReason,
  Principal,
  Scope,
} from "@/lib/controlplane/types";
import type { CapabilityRisk } from "./catalog";

/* ---------------------------- browser-session proof ------------------------- */

/**
 * Evidence that a HUMAN, signed in through a browser, is making this call.
 *
 * Only `assertBrowserSession()` in the REST layer mints one, after refusing any
 * `Authorization` header, requiring an exact same-origin request and verifying
 * the identity live against the provider. The services that loosen or decide
 * something a model must never decide — approve, reject, revoke an approval,
 * change autonomy, change workspace policy — demand one and check that its
 * subject is the principal acting. A token, an integration or the Navigator
 * cannot produce it.
 *
 * This is a structural guard inside one process, not a cryptographic proof: it
 * stops a caller that has no session from reaching those services by mistake or
 * by a compromised integration path, and it makes the requirement impossible to
 * forget. It does not defend against code already running with full authority
 * in this process.
 */
export interface BrowserSessionProof {
  readonly method: "browser_session";
  /** the verified user id */
  readonly subject: string;
  readonly verifiedAtMs: number;
}

/* ------------------------------ propose context ---------------------------- */

/**
 * Authoritative inputs to a proposal. They come from Zenith's own code (the
 * execution side that ran `tofu plan`, the cost engine) and are NEVER taken
 * from a request body: `CapabilityRequestSchema` is strict, and nothing inside
 * `request.input` is ever read as a policy fact.
 */
export interface ProposeContext {
  /** Server-side reference only; the broker reloads the recorded destroy facts. */
  destroyPlan?: { operationId: string; planDigest: string };
  /** Required when a human proposes teardown. Never read from request.input. */
  session?: BrowserSessionProof;
  /** the normalized OpenTofu plan; facts are derived here with `extractPlanFacts` */
  plan?: NormalizedPlan;
  /** authoritative cost numbers from the cost engine */
  cost?: { deltaUsdMonthly?: number; projectedUsdMonthly?: number };
  /** raise (never lower) the risk beyond the catalog floor */
  risk?: CapabilityRisk;
  /** for `system` principals only: mark the proposal as coming from the reconciliation controller */
  origin?: "reconciler";
  /** which interface submitted this; recorded for the approver, never used for authorization */
  via?: "rest" | "mcp" | "ui" | "cli" | "navigator" | "workflow" | "reconciler";
  /** proposal / approval validity in ms (60 s – 7 days). Default 24 h. */
  ttlMs?: number;
  correlationId?: string;
}

/* ---------------------------- additive proposal fields ---------------------- */

/** JSON-primitive values a request may use as constraints (what the policy input allows). */
export type ConstraintValue = string | number | boolean | null;

/**
 * Broker-owned additions to `OperationProposal.broker`. The proposal is stored
 * as one JSON document and its digest covers every member, so what is recorded
 * here is exactly what an approver approves and what execution re-evaluates:
 * the request's constraints and duration, and the plan facts the decision was
 * made on. Other readers of `OperationProposal` ignore the extra member.
 */
export interface BrokerProposalExt {
  v: 1;
  /** who submitted it and through which interface */
  via?: string;
  requestedConstraints?: Record<string, ConstraintValue>;
  requestedDurationSec?: number;
  /** the risk after any raise by the caller */
  risk: CapabilityRisk;
  /** facts (plan + cost) evaluated at proposal time; re-evaluated verbatim at execution */
  plan?: PlanFactsWithCost;
  destroyPlan?: { operationId: string; evidenceId: string; retained: string[] };
}

export type PlanFactsWithCost = NonNullable<import("@/lib/policy").PolicyInput["plan"]>;

export type BrokerProposal = OperationProposal & { broker?: BrokerProposalExt };

/* --------------------------------- decisions -------------------------------- */

/** What a caller is told about a decision. Never contains a secret; reasons are catalog codes + fixed messages. */
export interface DecisionView {
  outcome: PolicyOutcome;
  reasons: PolicyReason[];
  approval?: ApprovalRequirement;
  constraints?: Record<string, unknown>;
  policyVersion: string;
  inputDigest: string;
  evaluatedAt: string;
  /** the persisted decision row, when there is one (`check` persists nothing) */
  decisionId?: string;
  environment?: { id: string; class: string; autonomyLevel: number; autonomyIsDefault: boolean };
  /** effective risk the policy evaluated (catalog floor, possibly raised) */
  risk: CapabilityRisk;
}

export interface OperationView {
  id: string;
  workspaceId: string;
  projectId?: string;
  environmentId?: string;
  resourceId?: string;
  capability: string;
  status: OperationStatus;
  principal: Pick<Principal, "kind" | "id" | "name" | "onBehalfOf">;
  proposal: {
    summary: string;
    details: string[];
    risk: string;
    scope: Scope;
    input: unknown;
    planDigest?: string;
    costDeltaUsd?: number;
    requestedConstraints?: Record<string, ConstraintValue>;
    requestedDurationSec?: number;
  };
  proposalDigest: string;
  planDigest?: string;
  policyDecisionId?: string;
  approvalRequired: boolean;
  correlationId: string;
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  expiresAt: string;
}

export interface ProposeResult {
  operation: OperationView;
  decision: DecisionView;
  /** true when this answer is an earlier identical request's (same idempotency key) */
  replayed: boolean;
}

export interface CheckResult {
  decision: DecisionView;
}

export interface ReadAuthorization {
  decision: DecisionView;
  /** present only for an allow: a short-lived compact JWS for the executing surface */
  grant?: string;
  /** the claims inside `grant` (no secret) */
  claims?: import("@/lib/controlplane/types").CapabilityGrantClaims;
}
