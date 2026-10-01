/**
 * Errors the reconciliation controller raises on its own behalf.
 *
 * Everything a provider, driver or store throws while a node is being read is
 * NOT one of these: that is data about the node (it becomes an `unknown` or
 * `inaccessible` observation, never an exception). These are the failures of
 * the controller's own contract: a caller asked for something invalid, or the
 * platform store the controller persists to was never wired.
 */
export type ReconcileErrorCode =
  /** the platform control store / ports were not wired into this process */
  | "platform_store_unavailable"
  /** the caller passed something that cannot be reconciled (wrong environment, bad option) */
  | "invalid_input"
  /** a store refused a write because the environment belongs to another workspace */
  | "tenant_mismatch";

export class ReconcileError extends Error {
  readonly code: ReconcileErrorCode;
  constructor(code: ReconcileErrorCode, message: string) {
    super(message);
    this.name = "ReconcileError";
    this.code = code;
  }
}
