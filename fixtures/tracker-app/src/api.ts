/**
 * Tracker v1 client — every byte this app exchanges with its host goes through
 * here. It mirrors the host's frozen data contract (record shape, limits,
 * conflict payload) by hand, because the app ships as source and may not import
 * anything from the platform.
 *
 * Three rules shape the whole file:
 *   1. A write id is minted once per logical operation and reused on every
 *      retry of that operation, so a lost acknowledgement cannot duplicate it.
 *   2. A refusal is data, not an exception to guess at: `{ error: { code,
 *      message, fix, details } }` is decoded into a typed `ApiError`.
 *   3. Only requests that are safe to repeat are repeated — a dropped
 *      connection or a 503 — and only three times.
 *
 * Workstream W4 (hosted R3)
 */

/* ------------------------------------------------------------------ paths */

const BASE = "/_zenith";

/** Where the host explains how to get back in. A 401 sends the browser here. */
export const SIGN_IN_PATH = `${BASE}/auth/signin`;

/* ----------------------------------------------- the record and its limits */

export const TRACKER_LIMITS = {
  title: 120,
  details: 2000,
  requestedFor: 120,
  quantityMax: 99,
  listMax: 100,
  listDefault: 25,
} as const;

export const REQUEST_CATEGORIES = [
  "laptop",
  "monitor",
  "peripheral",
  "software",
  "furniture",
  "other",
] as const;
export type RequestCategory = (typeof REQUEST_CATEGORIES)[number];

export const REQUEST_PRIORITIES = ["low", "normal", "high"] as const;
export type RequestPriority = (typeof REQUEST_PRIORITIES)[number];

export const REQUEST_STATUSES = [
  "requested",
  "approved",
  "ordered",
  "delivered",
  "declined",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export interface EquipmentRequestInput {
  title: string;
  details: string;
  category: RequestCategory;
  quantity: number;
  priority: RequestPriority;
  status: RequestStatus;
  requestedFor: string;
  /** calendar date, YYYY-MM-DD, or null for no date */
  neededBy: string | null;
}

export type EquipmentRequestPatch = Partial<EquipmentRequestInput>;

export interface EquipmentRequest extends EquipmentRequestInput {
  id: string;
  /** starts at 1; every committed update increments it */
  version: number;
  createdBy: string;
  createdByEmail: string;
  createdAt: string;
  updatedBy: string;
  updatedByEmail: string;
  updatedAt: string;
}

export interface ListRequestsResult {
  items: EquipmentRequest[];
  nextCursor?: string;
}

export interface ListRequestsQuery {
  limit?: number;
  cursor?: string;
  status?: RequestStatus;
  category?: RequestCategory;
}

export type SessionRole = "owner" | "editor" | "viewer";

export interface SessionInfo {
  subject: string;
  email: string;
  role: SessionRole;
  app: { id: string; slug: string; name: string };
  releaseId: string;
  schemaVersion: number;
  limits: { listMax: number; bodyBytes: number };
  expiresAt: string;
}

/** Body of a 409 stale_version: re-base on `current`, retry with a new write id. */
export interface StaleVersionDetails {
  expectedVersion: number;
  current: EquipmentRequest;
}

/* ---------------------------------------------------------------- failures */

/**
 * Every code the host vocabulary can put on the wire, plus two the client
 * decides for itself: `network` when the request never reached anyone, and
 * `unsupported` for a refusal this version does not recognise.
 */
export const API_ERROR_CODES = [
  "unknown_host",
  "sign_in_required",
  "forbidden",
  "csrf_rejected",
  "not_found",
  "invalid_input",
  "unsupported_source",
  "body_too_large",
  "conflict",
  "stale_version",
  "idempotency_conflict",
  "quota_exceeded",
  "suspended",
  "recovering",
  "policy_unavailable",
  "runtime_unavailable",
  "internal",
  "network",
  "unsupported",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

const KNOWN_CODES = new Set<string>(API_ERROR_CODES);

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  /** 0 when the request never got a response */
  readonly status: number;
  readonly fix?: string;
  readonly details?: Record<string, unknown>;
  /** the code the host actually sent, when this client did not recognise it */
  readonly rawCode?: string;

  constructor(
    code: ApiErrorCode,
    message: string,
    opts: {
      status?: number;
      fix?: string;
      details?: Record<string, unknown>;
      rawCode?: string;
      cause?: unknown;
    } = {}
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ApiError";
    this.code = code;
    this.status = opts.status ?? 0;
    this.fix = opts.fix;
    this.details = opts.details;
    this.rawCode = opts.rawCode;
  }
}

export const isApiError = (err: unknown): err is ApiError => err instanceof ApiError;

/** The current record a 409 carries, or null when the host sent no usable detail. */
export function staleVersionDetails(err: unknown): StaleVersionDetails | null {
  if (!isApiError(err) || err.code !== "stale_version") return null;
  const details = err.details;
  if (!details) return null;
  const current = (details as { current?: unknown }).current;
  if (!current || typeof current !== "object") return null;
  const expected = (details as { expectedVersion?: unknown }).expectedVersion;
  return {
    expectedVersion: typeof expected === "number" ? expected : 0,
    current: current as EquipmentRequest,
  };
}

/* ------------------------------------------------------ injectable runtime */

export interface ApiRuntime {
  /** the fetch to use; defaults to the one on the page */
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** how a 401 leaves the app; defaults to a full-page navigation */
  navigate: (url: string) => void;
  /** how a write id is minted; defaults to crypto.randomUUID() */
  newWriteId: () => string;
  /** backoff between retries; defaults to a timer */
  sleep: (ms: number) => Promise<void>;
}

const defaults: ApiRuntime = {
  fetch: (input, init) => globalThis.fetch(input, init),
  navigate: (url) => {
    if (typeof window !== "undefined") window.location.assign(url);
  },
  newWriteId: () => globalThis.crypto.randomUUID(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

let runtime: ApiRuntime = { ...defaults };

/** Tests replace pieces of the environment; the app itself never calls this. */
export function configureApi(patch: Partial<ApiRuntime>): void {
  runtime = { ...runtime, ...patch };
}

export function resetApi(): void {
  runtime = { ...defaults };
}

/** A write id for one logical operation. Reuse it for every retry of that operation. */
export const newWriteId = (): string => runtime.newWriteId();

/* ----------------------------------------------------------- the transport */

const RETRY_ATTEMPTS = 3;
const BACKOFF_MS = [200, 800];

interface Sent {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
  signal?: AbortSignal;
}

const STATUS_CODES: Record<number, ApiErrorCode> = {
  400: "invalid_input",
  401: "sign_in_required",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "body_too_large",
  422: "unsupported_source",
  423: "suspended",
  429: "quota_exceeded",
  500: "internal",
  503: "runtime_unavailable",
};

const FALLBACK_MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  sign_in_required: "Your session has ended.",
  forbidden: "You do not have permission to do that.",
  not_found: "That request no longer exists.",
  invalid_input: "The host would not accept those values.",
  body_too_large: "That is more text than one request may carry.",
  conflict: "Someone else changed this first.",
  stale_version: "Someone else changed this first.",
  quota_exceeded: "This app has reached its limit for today.",
  suspended: "This app is paused right now.",
  recovering: "This app is coming back up.",
  policy_unavailable: "The service that checks access is not answering.",
  runtime_unavailable: "The app service is not answering.",
  internal: "The host hit a problem handling that.",
  network: "The connection dropped before the host answered.",
  unsupported: "The host refused that in a way this version does not understand.",
};

function messageFor(code: ApiErrorCode, status: number): string {
  const known = FALLBACK_MESSAGES[code];
  if (known) return known;
  return status ? `The host answered ${status}.` : "The host did not answer.";
}

async function readBody(res: Response): Promise<unknown> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    return null;
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function decodeError(status: number, body: unknown): ApiError {
  const envelope =
    body && typeof body === "object"
      ? (body as { error?: Record<string, unknown> }).error
      : undefined;
  const byStatus = STATUS_CODES[status] ?? "unsupported";

  if (envelope && typeof envelope === "object") {
    const raw = typeof envelope.code === "string" ? envelope.code : "";
    const known = KNOWN_CODES.has(raw);
    const code = (known ? raw : "unsupported") as ApiErrorCode;
    const message =
      typeof envelope.message === "string" && envelope.message.trim()
        ? envelope.message
        : messageFor(known ? code : byStatus, status);
    const details =
      envelope.details && typeof envelope.details === "object"
        ? (envelope.details as Record<string, unknown>)
        : undefined;
    return new ApiError(code, message, {
      status,
      fix: typeof envelope.fix === "string" ? envelope.fix : undefined,
      details,
      rawCode: raw && !known ? raw : undefined,
    });
  }

  return new ApiError(byStatus, messageFor(byStatus, status), { status });
}

/** Repeatable only when nothing was decided: no answer at all, or the service is down. */
function retryable(err: ApiError): boolean {
  return (
    err.code === "network" ||
    err.code === "runtime_unavailable" ||
    err.code === "policy_unavailable"
  );
}

async function attempt(sent: Sent): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/json" };
  const init: RequestInit = { method: sent.method, credentials: "same-origin", headers };
  if (sent.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(sent.body);
  }
  if (sent.signal) init.signal = sent.signal;

  let res: Response;
  try {
    res = await runtime.fetch(sent.path, init);
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    throw new ApiError("network", messageFor("network", 0), { cause });
  }

  if (res.ok) return readBody(res);
  throw decodeError(res.status, await readBody(res));
}

/**
 * One logical operation. The body is built once, so every retry sends the same
 * bytes — including the same write id, which is what makes repeating a POST
 * safe when the acknowledgement was lost rather than the write.
 */
async function send(sent: Sent): Promise<unknown> {
  let last: ApiError | undefined;
  for (let i = 0; i < RETRY_ATTEMPTS; i++) {
    try {
      return await attempt(sent);
    } catch (err) {
      if (!isApiError(err)) throw err;
      if (err.code === "sign_in_required") {
        runtime.navigate(SIGN_IN_PATH);
        throw err;
      }
      if (!retryable(err) || i === RETRY_ATTEMPTS - 1) throw err;
      last = err;
      await runtime.sleep(BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)]);
    }
  }
  throw last ?? new ApiError("internal", messageFor("internal", 0));
}

/* ------------------------------------------------------------- decoding */

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("unsupported", `The host sent something that is not ${what}.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Create and update answer `{ record }`. A single read is documented only by
 * its path, so accept either the wrapper or a bare record rather than fail on
 * a shape the contract never pinned down.
 */
function unwrapRecord(body: unknown): EquipmentRequest {
  const obj = asObject(body, "a request");
  const inner = obj.record;
  const record =
    inner && typeof inner === "object" ? (inner as Record<string, unknown>) : obj;
  if (typeof record.id !== "string" || typeof record.version !== "number") {
    throw new ApiError("unsupported", "The host sent a record this version cannot read.");
  }
  return record as unknown as EquipmentRequest;
}

/* -------------------------------------------------------------- the calls */

export async function getSession(signal?: AbortSignal): Promise<SessionInfo> {
  const body = asObject(
    await send({ method: "GET", path: `${BASE}/session`, signal }),
    "a session"
  );
  if (typeof body.role !== "string" || typeof body.releaseId !== "string") {
    throw new ApiError("unsupported", "The host sent a session this version cannot read.");
  }
  return body as unknown as SessionInfo;
}

export async function listRequests(
  query: ListRequestsQuery = {},
  signal?: AbortSignal
): Promise<ListRequestsResult> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.status) params.set("status", query.status);
  if (query.category) params.set("category", query.category);
  const qs = params.toString();
  const body = asObject(
    await send({
      method: "GET",
      path: `${BASE}/data/v1/requests${qs ? `?${qs}` : ""}`,
      signal,
    }),
    "a list of requests"
  );
  if (!Array.isArray(body.items)) {
    throw new ApiError("unsupported", "The host sent a list this version cannot read.");
  }
  return {
    items: body.items as EquipmentRequest[],
    nextCursor: typeof body.nextCursor === "string" ? body.nextCursor : undefined,
  };
}

export async function getRequest(id: string, signal?: AbortSignal): Promise<EquipmentRequest> {
  return unwrapRecord(
    await send({
      method: "GET",
      path: `${BASE}/data/v1/requests/${encodeURIComponent(id)}`,
      signal,
    })
  );
}

export async function createRequest(
  record: EquipmentRequestInput,
  opts: { writeId?: string; signal?: AbortSignal } = {}
): Promise<EquipmentRequest> {
  const writeId = opts.writeId ?? runtime.newWriteId();
  return unwrapRecord(
    await send({
      method: "POST",
      path: `${BASE}/data/v1/requests`,
      body: { writeId, record },
      signal: opts.signal,
    })
  );
}

export async function updateRequest(
  id: string,
  change: { expectedVersion: number; patch: EquipmentRequestPatch },
  opts: { writeId?: string; signal?: AbortSignal } = {}
): Promise<EquipmentRequest> {
  const writeId = opts.writeId ?? runtime.newWriteId();
  return unwrapRecord(
    await send({
      method: "PATCH",
      path: `${BASE}/data/v1/requests/${encodeURIComponent(id)}`,
      body: { writeId, expectedVersion: change.expectedVersion, patch: change.patch },
      signal: opts.signal,
    })
  );
}

export async function signOut(): Promise<void> {
  await send({ method: "POST", path: `${BASE}/auth/signout`, body: {} });
}
