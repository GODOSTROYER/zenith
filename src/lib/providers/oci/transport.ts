/**
 * OCI native API access (ADR-0006 `runner` mode, ADR-0010).
 *
 * OCI credentials never leave the customer's tenancy: `OciConnectionConfig`
 * has exactly one mode, `runner`. The runner authenticates with its instance /
 * resource / workload principal and signs each request with OCI HTTP
 * Signatures. The control plane (this module's callers) therefore never holds
 * a key, a fingerprint or a security token; it holds an `OciApiTransport`, a
 * port whose only implementation ships jobs of kind `oci.http` to the
 * customer's runner (docs/platform/RUNNER-PROTOCOL-OCI.md — a PROPOSAL; the
 * runner protocol v1 has no `oci.http` kind yet, and `go/` is not touched by
 * this workstream).
 *
 * Invariants:
 *   - A request names a logical `service` (services.ts), a `region`, a method,
 *     an already-encoded `path` and a `query` map. No host, no Authorization,
 *     no signature headers: the runner adds those and refuses any the caller
 *     sends. Only the allowlisted request headers below may be set.
 *   - `OciSession` has no accessor for credentials, only the transport.
 *   - Every driver READ goes through `ociCall`, which honours the abort signal
 *     and converts every outcome (HTTP status, throttle, denial, transport
 *     failure) into a value; it never throws for a cloud-side condition.
 *   - Error text is bounded, control-character-free and built from OCI's
 *     `code` / `message` only; a caller that sent a secret body passes
 *     `redactMessage` so not even OCI's message is echoed.
 *
 * Honest limit: there is no real `OciApiTransport` implementation in this
 * workstream. Tests use a fake. Until the runner implements `oci.http`, OCI
 * observe / runtime / verify / discover are contract-tested only.
 */
import type { OciServiceId } from "./services";

/** DELETE is reserved for receipt-authorized terminal one-off migration cleanup. */
export type OciHttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "DELETE";

/** Request headers a driver may set; the runner enforces the same allowlist. */
export const OCI_REQUEST_HEADER_ALLOWLIST = ["opc-retry-token", "if-match", "if-none-match", "opc-request-id"] as const;

/** Response headers the runner returns; all others are dropped. */
export const OCI_RESPONSE_HEADER_ALLOWLIST = ["opc-request-id", "opc-next-page", "opc-work-request-id", "etag", "retry-after", "content-type"] as const;

export interface OciApiRequest {
  service: OciServiceId;
  region: string;
  method: OciHttpMethod;
  /** `/<version>/…`, segments already percent-encoded (`ociPath`) */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** JSON-serializable request body; for secret writes this carries the value and must never be logged */
  body?: unknown;
  /** only for `queue-data`: the queue's `messagesEndpoint` host, checked by the runner against `*.oraclecloud.com` */
  endpointHost?: string;
  /** Runner-local receipt selector, scoped by the verified workspace and operation. */
  migrationKey?: string;
}

export interface OciApiResponse {
  status: number;
  /** lower-cased names, allowlisted */
  headers: Record<string, string>;
  /** parsed JSON, or the raw text when the response was not JSON, or `undefined` for an empty body */
  body: unknown;
}

export interface OciApiTransport {
  request(req: OciApiRequest, opts?: { signal?: AbortSignal }): Promise<OciApiResponse>;
}

/**
 * The scoped session the credential broker hands a driver for one operation
 * (the OCI sibling of `AwsSession` / `GcpSession`). `runner` is the only mode.
 */
export interface OciSession {
  readonly provider: "oci";
  readonly region: string;
  readonly compartmentOcid: string;
  readonly tenancyOcid?: string;
  readonly transport: OciApiTransport;
}

/* --------------------------------- results -------------------------------- */

export type OciFailure = "not_found" | "denied" | "throttled" | "unavailable" | "error" | "transport";

export type OciResult =
  | { ok: true; status: number; body: unknown; headers: Record<string, string>; requestId?: string }
  | { ok: false; outcome: OciFailure; status?: number; code?: string; message: string; requestId?: string; retryAfterSec?: number };

/** Strip control characters, collapse whitespace, bound the length. */
export function cleanText(s: unknown, max = 200): string {
  if (typeof s !== "string") return "";
   
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function classifyStatus(status: number): "ok" | OciFailure {
  if (status >= 200 && status < 300) return "ok";
  if (status === 404) return "not_found";
  if (status === 401 || status === 403) return "denied";
  if (status === 429) return "throttled";
  if (status >= 500) return "unavailable";
  return "error";
}

/** OCI error bodies are `{ code, message }`. */
export function ociErrorFields(body: unknown): { code?: string; message?: string } {
  if (body === null || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  return {
    code: typeof b.code === "string" ? cleanText(b.code, 80) : undefined,
    message: typeof b.message === "string" ? cleanText(b.message, 200) : undefined,
  };
}

export interface CallContext {
  session: OciSession;
  signal: AbortSignal;
}

export interface CallOptions {
  /** do not echo OCI's error message (a secret body was sent) */
  redactMessage?: boolean;
}

/**
 * One native API call. Never throws: a cloud-side condition, a transport
 * failure or an abort all come back as `{ ok: false, outcome }`.
 */
export async function ociCall(ctx: CallContext, req: OciApiRequest, opts: CallOptions = {}): Promise<OciResult> {
  if (ctx.signal.aborted) return { ok: false, outcome: "transport", message: "The operation was cancelled before the OCI call was sent." };
  let res: OciApiResponse;
  try {
    res = await ctx.session.transport.request(req, { signal: ctx.signal });
  } catch (e) {
    // first line only: a thrown error's later lines are usually a stack
    const firstLine = (m: string) => m.split(/\r?\n/)[0];
    const why = ctx.signal.aborted ? "the operation was cancelled" : e instanceof Error ? cleanText(e.name === "Error" ? firstLine(e.message) : `${e.name}: ${firstLine(e.message)}`, 160) : "unknown failure";
    return { ok: false, outcome: "transport", message: `The OCI runner transport failed: ${why}.` };
  }
  const headers = Object.fromEntries(Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const requestId = headers["opc-request-id"] ? cleanText(headers["opc-request-id"], 120) : undefined;
  const kind = classifyStatus(res.status);
  if (kind === "ok") return { ok: true, status: res.status, body: res.body, headers, requestId };
  const { code, message } = ociErrorFields(res.body);
  const retry = Number(headers["retry-after"]);
  const tail = opts.redactMessage ? "" : message ? `: ${message}` : "";
  return {
    ok: false,
    outcome: kind,
    status: res.status,
    code,
    requestId,
    message: `OCI ${req.service} ${req.method} returned HTTP ${res.status}${code ? ` ${code}` : ""}${tail}`,
    ...(Number.isFinite(retry) && retry >= 0 ? { retryAfterSec: Math.min(retry, 3600) } : {}),
  };
}

/**
 * OCI returns 404 `NotAuthorizedOrNotFound` for BOTH a missing resource and one
 * the principal may not see. A 404 therefore proves "missing" only when a
 * second, compartment-scoped read that the principal is allowed to make also
 * finds nothing; `observe-kit` applies that rule.
 */
export const isAmbiguousNotFound = (r: OciResult): boolean => !r.ok && r.outcome === "not_found" && (r.code === undefined || r.code === "NotAuthorizedOrNotFound");
