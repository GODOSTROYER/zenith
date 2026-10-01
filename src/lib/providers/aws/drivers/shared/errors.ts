/**
 * Error handling shared by AWS drivers.
 *
 * Observation errors are classified, never thrown past the driver (spec §39:
 * "unknown" and "inaccessible" are drift results, not silence):
 *
 *   AccessDenied*, UnauthorizedOperation, …  → `inaccessible`
 *   *NotFound, NoSuch*, HTTP 404             → `missing`
 *   Throttling*, RequestLimitExceeded, …     → `throttled`  (presence `unknown`)
 *   AbortError / a fired signal              → `aborted`    (presence `unknown`)
 *   anything else                            → `error`      (presence `unknown`)
 *
 * The summary that reaches an Observation is bounded (240 chars) and scrubbed
 * of credential-shaped tokens: SDK messages occasionally echo request fields.
 *
 * `DriverCompileError` is what `compile()` throws for a spec it must refuse
 * (an invalid CIDR, a public rule that is not the load-balancer rule…). It
 * carries the node address so the caller can report which node is wrong.
 */
import type { Presence } from "@/lib/resources/types";

export type AwsFailureKind = "missing" | "inaccessible" | "throttled" | "aborted" | "error";

export interface AwsFailure {
  kind: AwsFailureKind;
  /** the SDK error name / code, e.g. `AccessDenied`; `Unknown` when there is none */
  code: string;
  /** bounded, scrubbed text, safe to store in an Observation */
  summary: string;
  requestId?: string;
}

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  Code?: unknown;
  message?: unknown;
  $metadata?: { httpStatusCode?: number; requestId?: string; extendedRequestId?: string };
}

const ACCESS_DENIED = /^(AccessDenied(Exception)?|UnauthorizedOperation|UnauthorizedAccess(Exception)?|AuthFailure|InvalidClientTokenId|Forbidden|UnrecognizedClientException|OptInRequired|AccessDeniedFault)$/i;
const NOT_FOUND = /(\.NotFound|NotFound(Exception|Fault)?|NoSuch[A-Za-z]+|DoesNotExist|ResourceNotFound(Exception)?)$/i;
const THROTTLED = /^(Throttling(Exception)?|ThrottledException|RequestLimitExceeded|RequestThrottled(Exception)?|TooManyRequestsException|SlowDown|PriorRequestNotComplete|LimitExceededException|BandwidthLimitExceeded)$/i;
const ABORTED = /^(AbortError|TimeoutError|CanceledError)$/i;

function nameOf(e: ErrorLike): string {
  for (const v of [e.name, e.code, e.Code]) if (typeof v === "string" && v !== "" && v !== "Error") return v;
  return "Unknown";
}

/** Strip long opaque tokens and access-key ids, collapse whitespace, bound the length. */
export function scrubErrorText(text: string, max = 240): string {
  const scrubbed = text
    .replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted-key-id]")
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return scrubbed.length > max ? `${scrubbed.slice(0, max - 1)}…` : scrubbed;
}

/** Classify anything a driver's `catch` receives. Never throws. */
export function classifyAwsError(error: unknown, signal?: AbortSignal): AwsFailure {
  const e: ErrorLike = typeof error === "object" && error !== null ? (error as ErrorLike) : {};
  const code = nameOf(e);
  const status = e.$metadata?.httpStatusCode;
  const requestId = e.$metadata?.requestId;
  const message = typeof e.message === "string" ? e.message : typeof error === "string" ? error : "";
  const summary = scrubErrorText(message !== "" ? `${code}: ${message}` : code);
  const base = { code, summary, ...(requestId ? { requestId } : {}) };

  if (signal?.aborted || ABORTED.test(code)) return { kind: "aborted", ...base };
  if (ACCESS_DENIED.test(code)) return { kind: "inaccessible", ...base };
  if (THROTTLED.test(code) || status === 429) return { kind: "throttled", ...base };
  if (NOT_FOUND.test(code) || status === 404) return { kind: "missing", ...base };
  if (status === 403 && !THROTTLED.test(code)) return { kind: "inaccessible", ...base };
  return { kind: "error", ...base };
}

/** Observation presence for a failed read. Only a definite API answer is `missing` / `inaccessible`. */
export function presenceOfFailure(f: AwsFailure): Presence {
  return f.kind === "missing" ? "missing" : f.kind === "inaccessible" ? "inaccessible" : "unknown";
}

/** The `ObservedValue.unknown` reason for a failed read. */
export function unknownReasonOf(f: AwsFailure): "access_denied" | "error" {
  return f.kind === "inaccessible" ? "access_denied" : "error";
}

/** Rethrow when the caller's signal fired: an abort is never an observation result. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const e = new Error("The operation was aborted.");
    e.name = "AbortError";
    throw e;
  }
}

export type CompileErrorCode = "invalid_spec" | "missing_node" | "unsupported" | "policy_refused";

/** Thrown by `compile()` for a spec the driver must refuse. Messages never contain secret values. */
export class DriverCompileError extends Error {
  readonly code: CompileErrorCode;
  readonly address: string;
  constructor(code: CompileErrorCode, address: string, message: string) {
    super(scrubErrorText(`${address}: ${message}`, 400));
    this.name = "DriverCompileError";
    this.code = code;
    this.address = address;
  }
}

/* --------------------------------- attempts -------------------------------- */

export type Attempt<T> = { ok: true; value: T } | { ok: false; failure: AwsFailure };

/**
 * Run one read and capture a classified failure instead of throwing, so one
 * denied or throttled call degrades ONE attribute to `unknown` instead of
 * discarding the whole observation. An abort is not a result: it is rethrown.
 */
export async function attempt<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    const failure = classifyAwsError(error, signal);
    if (failure.kind === "aborted") throw error;
    return { ok: false, failure };
  }
}
