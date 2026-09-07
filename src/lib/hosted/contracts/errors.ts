/**
 * Hosted error vocabulary — one code, one status, one fix per refusal.
 *
 * Every hosted refusal (gateway, broker, control API, jobs) is a `HostedError`.
 * The gateway maps codes to the p.24 status contract: unknown host 404,
 * missing identity 401, grant denial 403, policy/identity authority
 * unavailable 503, quota 429, suspended 423. Sensitive responses are
 * `cache-control: no-store`. A denial never invokes app code or the broker.
 *
 * SPINE FILE — owned by the integrator. Import from `@/lib/hosted/contracts`.
 */

export type HostedErrorCode =
  | "unknown_host"
  | "sign_in_required"
  | "forbidden"
  | "csrf_rejected"
  | "not_found"
  | "invalid_input"
  | "unsupported_source"
  | "body_too_large"
  | "conflict"
  | "stale_version"
  | "idempotency_conflict"
  | "quota_exceeded"
  | "suspended"
  | "recovering"
  | "policy_unavailable"
  | "runtime_unavailable"
  | "internal";

export const HOSTED_STATUS: Record<HostedErrorCode, number> = {
  unknown_host: 404,
  sign_in_required: 401,
  forbidden: 403,
  csrf_rejected: 403,
  not_found: 404,
  invalid_input: 400,
  unsupported_source: 422,
  body_too_large: 413,
  conflict: 409,
  stale_version: 409,
  idempotency_conflict: 409,
  quota_exceeded: 429,
  suspended: 423,
  recovering: 423,
  policy_unavailable: 503,
  runtime_unavailable: 503,
  internal: 500,
};

export class HostedError extends Error {
  readonly code: HostedErrorCode;
  readonly status: number;
  readonly fix?: string;
  /** structured detail the caller can act on (e.g. the current record on 409) */
  readonly details?: Record<string, unknown>;

  constructor(
    code: HostedErrorCode,
    message: string,
    opts: { fix?: string; details?: Record<string, unknown> } = {}
  ) {
    super(message);
    this.name = "HostedError";
    this.code = code;
    this.status = HOSTED_STATUS[code];
    this.fix = opts.fix;
    this.details = opts.details;
  }
}

export interface HostedErrorBody {
  error: {
    code: HostedErrorCode;
    message: string;
    fix?: string;
    details?: Record<string, unknown>;
  };
}

/** The wire shape of every hosted refusal. Never includes a stack or a path. */
export function hostedErrorBody(err: unknown): { status: number; body: HostedErrorBody } {
  if (err instanceof HostedError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message, fix: err.fix, details: err.details } },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: "internal",
        message: "Something went wrong on the server while handling this request.",
        fix: "Try again. If it keeps happening, quote the request id from the response headers.",
      },
    },
  };
}

export const isHostedError = (err: unknown): err is HostedError => err instanceof HostedError;
