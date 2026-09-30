/**
 * Typed errors of the platform control store.
 *
 * Every refusal a repository can make is a `ControlStoreError` with a stable
 * machine `code`, so an API layer maps it to an HTTP status and a caller
 * branches on the code instead of parsing a message. `LeaseLostError` (in
 * `controlplane/types.ts`) is the one exception that predates this file and is
 * kept where the contract put it.
 *
 * Invariant: **no message or field here ever contains a query parameter or a
 * row value.** Driver errors from PGlite and postgres.js both carry the SQL
 * text and its parameters (and Postgres puts `Key (col)=(value)` in `detail`);
 * `PlatformDbError.from` keeps only the SQLSTATE, the constraint name, the
 * table name and a sanitised message, and it does not chain the original error
 * as `cause`, because printing a `cause` would print exactly what was dropped.
 */

export type ControlStoreErrorCode =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "tenant_mismatch"
  | "idempotency_conflict"
  | "operation_not_found"
  | "invalid_state"
  | "digest_mismatch"
  | "operation_expired"
  | "approval_required"
  | "approver_not_human"
  | "approver_role_insufficient"
  | "separation_of_duties"
  | "duplicate_decision"
  | "policy_changed"
  | "lease_unavailable"
  | "secret_material"
  | "invalid_registration_token"
  | "schema_behind"
  | "schema_tampered"
  | "value_out_of_range"
  | "db_error";

/** Suggested HTTP status per code, for the API layer that maps these. */
export const CONTROL_STORE_HTTP_STATUS: Readonly<Record<ControlStoreErrorCode, number>> = {
  invalid_input: 400,
  not_found: 404,
  conflict: 409,
  tenant_mismatch: 404,
  idempotency_conflict: 409,
  operation_not_found: 404,
  invalid_state: 409,
  digest_mismatch: 409,
  operation_expired: 409,
  approval_required: 409,
  approver_not_human: 403,
  approver_role_insufficient: 403,
  separation_of_duties: 403,
  duplicate_decision: 409,
  policy_changed: 409,
  lease_unavailable: 409,
  secret_material: 400,
  invalid_registration_token: 401,
  schema_behind: 503,
  schema_tampered: 503,
  value_out_of_range: 500,
  db_error: 500,
};

export class ControlStoreError extends Error {
  constructor(
    readonly code: ControlStoreErrorCode,
    message: string,
    /** machine-readable, secret-free context (ids, statuses, digests) */
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ControlStoreError";
  }

  get httpStatus(): number {
    return CONTROL_STORE_HTTP_STATUS[this.code];
  }
}

/** The same idempotency key was reused with a different request. */
export class IdempotencyConflictError extends ControlStoreError {
  constructor(key: string) {
    super(
      "idempotency_conflict",
      "This idempotency key was already used with a different request. Use a new key for a different request, or repeat the original request unchanged.",
      { key }
    );
    this.name = "IdempotencyConflictError";
  }
}

/** The schema is behind, missing, or its ledger no longer matches the code. */
export class PlatformSchemaError extends ControlStoreError {
  constructor(code: "schema_behind" | "schema_tampered", message: string, details?: Record<string, unknown>) {
    super(code, message, details);
    this.name = "PlatformSchemaError";
  }
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** A database failure with the parameters and row values stripped. */
export class PlatformDbError extends ControlStoreError {
  constructor(
    message: string,
    /** SQLSTATE when the driver reported one (`23505`, `40001`, …) */
    readonly sqlstate?: string,
    readonly constraint?: string,
    readonly table?: string
  ) {
    super("db_error", message, { sqlstate, constraint, table });
    this.name = "PlatformDbError";
  }

  /** True for serialization failure and deadlock — the whole transaction may be replayed. */
  get retryable(): boolean {
    return this.sqlstate === "40001" || this.sqlstate === "40P01";
  }

  /** True for a unique-constraint violation (`23505`). */
  get isUniqueViolation(): boolean {
    return this.sqlstate === "23505";
  }

  /**
   * Convert any driver error. Returns the input unchanged when it is already
   * one of ours (or a `LeaseLostError`-style domain error, which has a
   * non-SQLSTATE `code`), so wrapping is idempotent.
   */
  static from(err: unknown): unknown {
    if (err instanceof ControlStoreError) return err;
    if (typeof err !== "object" || err === null) return err;
    const e = err as Record<string, unknown>;
    const code = typeof e.code === "string" ? e.code : undefined;
    const looksLikeDriver =
      (code !== undefined && SQLSTATE.test(code) && ("severity" in e || "routine" in e || e.name === "PostgresError")) ||
      e.name === "PostgresError" ||
      (typeof e.name === "string" && e.name === "error" && code !== undefined && SQLSTATE.test(code));
    const looksLikeTransport =
      code !== undefined &&
      /^(ECONN|ENOTFOUND|ETIMEDOUT|EPIPE|CONNECT_TIMEOUT|CONNECTION_|AUTH_|SASL_|CRYPTO_)/.test(code);
    if (!looksLikeDriver && !looksLikeTransport) return err;
    const constraint = (e.constraint_name ?? e.constraint) as unknown;
    const table = (e.table_name ?? e.table) as unknown;
    const raw = typeof e.message === "string" && e.message ? e.message : (code ?? "database error");
    // Postgres appends the offending literal after ': "…"' in data exceptions.
    const message = raw.replace(/: ".*$/s, "").slice(0, 300);
    const out = new PlatformDbError(
      message,
      code && SQLSTATE.test(code) ? code : undefined,
      typeof constraint === "string" ? constraint : undefined,
      typeof table === "string" ? table : undefined
    );
    if (looksLikeTransport) (out.details as Record<string, unknown>).transport = code;
    return out;
  }
}

/** Throw `invalid_input` unless `value` is a non-empty string within `max` characters. */
export function requireText(name: string, value: unknown, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new ControlStoreError("invalid_input", `${name} must be a non-empty string of at most ${max} characters.`, { field: name });
  return value;
}

/** Same as `requireText` but `undefined`/`null` pass through as `undefined`. */
export function optionalText(name: string, value: unknown, max = 256): string | undefined {
  return value === undefined || value === null ? undefined : requireText(name, value, max);
}
