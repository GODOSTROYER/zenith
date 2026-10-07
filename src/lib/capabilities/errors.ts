/**
 * Typed refusals of the capability broker.
 *
 * Every way the broker (or a store behind it) can say "no" is a `BrokerError`
 * with a stable machine `code`, an HTTP status, and a message that never
 * contains a request value, a secret, or anything that distinguishes "this id
 * belongs to another tenant" from "this id does not exist".
 *
 * `not_found` is deliberately ONE code with ONE message. Scope resolution,
 * operation lookup and membership checks all answer with `notFound()`, so a
 * caller in workspace A cannot tell a foreign id from a missing one — not by
 * status, not by message, not by `fix`.
 *
 * Store implementations (the in-memory store here, the platform-database
 * adapter later) reject with `BrokerError` using the store-facing codes below,
 * so the broker maps every failure the same way whatever the backend is.
 */

export type BrokerErrorCode =
  /* request shape */
  | "invalid_request"
  | "scope_incomplete"
  | "secret_material"
  /* tenancy: foreign and missing are the same answer */
  | "not_found"
  /* authentication / authorization */
  | "unauthenticated"
  | "role_insufficient"
  | "admin_required"
  | "browser_session_required"
  | "approver_not_human"
  | "approver_role_insufficient"
  | "separation_of_duties"
  | "policy_denied"
  /* lifecycle */
  | "invalid_state"
  | "digest_mismatch"
  | "operation_expired"
  | "approval_required"
  | "reapproval_required"
  | "duplicate_decision"
  | "idempotency_conflict"
  | "plan_changed"
  | "semantics_changed"
  | "semantics_mismatch"
  | "standing_grant_lapsed"
  | "already_claimed"
  | "conflict"
  | "lease_lost"
  /* the platform cannot answer: refused, never allowed */
  | "policy_unavailable"
  | "platform_store_unavailable"
  | "signer_unavailable"
  | "grant_issue_failed"
  | "internal";

export const BROKER_HTTP_STATUS: Readonly<Record<BrokerErrorCode, number>> = {
  invalid_request: 400,
  scope_incomplete: 400,
  secret_material: 400,
  not_found: 404,
  unauthenticated: 401,
  role_insufficient: 403,
  admin_required: 403,
  browser_session_required: 403,
  approver_not_human: 403,
  approver_role_insufficient: 403,
  separation_of_duties: 403,
  policy_denied: 403,
  invalid_state: 409,
  digest_mismatch: 409,
  operation_expired: 409,
  approval_required: 409,
  reapproval_required: 409,
  duplicate_decision: 409,
  idempotency_conflict: 409,
  plan_changed: 409,
  semantics_changed: 409,
  semantics_mismatch: 409,
  standing_grant_lapsed: 409,
  already_claimed: 409,
  conflict: 409,
  lease_lost: 409,
  policy_unavailable: 503,
  platform_store_unavailable: 503,
  signer_unavailable: 503,
  grant_issue_failed: 500,
  internal: 500,
};

export class BrokerError extends Error {
  readonly name = "BrokerError";
  constructor(
    readonly code: BrokerErrorCode,
    message: string,
    /** what the caller can do about it, in prose */
    readonly fix?: string,
    /** machine-readable, secret-free context (ids the caller already holds, statuses, digests, reason codes) */
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }

  get status(): number {
    return BROKER_HTTP_STATUS[this.code];
  }
}

export const isBrokerError = (error: unknown): error is BrokerError => error instanceof BrokerError;

/** The single answer for a foreign id, a missing id and a non-member. */
export const NOT_FOUND_MESSAGE = "The requested item was not found in a workspace you can act in.";
export const NOT_FOUND_FIX = "Check that the ids belong to a workspace you are a member of.";

export const notFound = (): BrokerError => new BrokerError("not_found", NOT_FOUND_MESSAGE, NOT_FOUND_FIX);
