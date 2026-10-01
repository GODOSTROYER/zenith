/**
 * `ControlPlaneClient`: the harness's view of a running Zenith control plane.
 *
 * Two surfaces, both over plain `fetch`:
 *
 *  - `/api/platform/v1/**`, the capability broker's REST API (the route shapes
 *    are read from the WS-CAP worktree: `capabilities/check`,
 *    `capabilities/propose`, `operations`, `operations/:id`,
 *    `operations/:id/{events,cancel}`, `environments/:id/autonomy`);
 *  - `/api/actions/:actionId` and a few read routes of the existing product API
 *    (`deployments/:id`, `environments/:id/drift`), merged today.
 *
 * What is NOT here, on purpose: approval. `POST /operations/:id/approve` is a
 * browser-session-only endpoint and refuses any request carrying an
 * Authorization header. The harness therefore cannot approve anything, and a
 * scenario that needs an approval waits for a person (see `approval.ts`).
 *
 * Status of this client: it has been exercised against a fake server that
 * mimics the documented response shapes (tests/acceptance). It has NOT been run
 * against a real Zenith deployment: the platform routes were unmerged when it
 * was written. Field names are read defensively; an unexpected shape surfaces
 * as a failed check, never as a silent pass.
 *
 * Secrets: the bearer token is sent in the Authorization header only, never
 * logged, never part of an error, and never sent over plain http to a
 * non-local host (`parseApiUrl` refuses that at construction).
 */
import type { CapabilityRequest } from "@/lib/capabilities/catalog";
import { TERMINAL_OPERATION_STATUSES, type OperationStatus } from "@/lib/controlplane/types";
import { redactCredentials } from "@/lib/credentials/redact";
import { parseApiUrl } from "../config";
import { responseText, removeToken } from "./response";

export interface DecisionViewLike {
  outcome: "allow" | "deny" | "require_approval";
  reasons: { code: string; message: string }[];
  approval?: { count: number; minRole: string; separationOfDuties: boolean };
  risk?: string;
  environment?: { id: string; class: string; autonomyLevel: number; autonomyIsDefault: boolean };
  [k: string]: unknown;
}

export interface OperationViewLike {
  id: string;
  capability: string;
  status: OperationStatus;
  approvalRequired: boolean;
  proposalDigest?: string;
  planDigest?: string;
  environmentId?: string;
  resourceId?: string;
  principal?: { kind: string; id: string; name?: string };
  proposal?: { summary?: string; details?: string[]; risk?: string; planDigest?: string; costDeltaUsd?: number; input?: unknown };
  result?: unknown;
  error?: string;
  expiresAt?: string;
  [k: string]: unknown;
}

export interface ProposeResponse {
  operation: OperationViewLike;
  decision: DecisionViewLike;
  replayed: boolean;
}

export interface OperationDetailResponse {
  operation: OperationViewLike;
  decision?: DecisionViewLike;
  approvals: { id: string; decision: "approve" | "reject"; approverId: string; approverName?: string; approverRole?: string; consumed?: boolean }[];
}

export interface OperationEventLike {
  seq?: number;
  type: string;
  ts?: string;
  data?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface ActionResponse {
  ok?: boolean;
  summary?: string;
  error?: string;
  data?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface ActionBody {
  input?: unknown;
  mode?: "plan" | "execute";
  scope?: { projectId?: string; environmentId?: string };
  idempotencyKey?: string;
}

export interface ControlPlaneClient {
  describe(): { baseUrl: string; tokenSet: boolean; workspaceId?: string };
  ping(): Promise<{ ok: boolean; status: number }>;
  runAction(actionId: string, body: ActionBody): Promise<ActionResponse>;
  checkCapability(request: CapabilityRequest): Promise<{ decision: DecisionViewLike }>;
  proposeCapability(request: CapabilityRequest): Promise<ProposeResponse>;
  getOperation(id: string): Promise<OperationDetailResponse>;
  listOperations(filters?: { status?: string[]; environmentId?: string; capability?: string; limit?: number }): Promise<{ operations: OperationViewLike[]; nextCursor?: string }>;
  listOperationEvents(id: string, afterSeq?: number): Promise<{ events: OperationEventLike[] }>;
  cancelOperation(id: string, reason?: string): Promise<{ operation: OperationViewLike }>;
  getAutonomy(environmentId: string): Promise<Record<string, unknown>>;
  getDeployment(id: string): Promise<Record<string, unknown>>;
  getDrift(environmentId: string): Promise<Record<string, unknown>>;
}

export class ControlPlaneError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly fix?: string;
  constructor(status: number, message: string, code?: string, fix?: string) {
    super(message);
    this.name = "ControlPlaneError";
    this.status = status;
    this.code = code;
    this.fix = fix;
  }
}

export interface HttpControlPlaneOptions {
  baseUrl: string;
  token?: string;
  workspaceId?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class HttpControlPlaneClient implements ControlPlaneClient {
  readonly #base: string;
  readonly #token?: string;
  readonly #workspaceId?: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: HttpControlPlaneOptions) {
    const base = parseApiUrl(options.baseUrl, "the control plane URL");
    if (!base) throw new ControlPlaneError(0, "The control plane URL is empty.");
    this.#base = base;
    this.#token = options.token;
    this.#workspaceId = options.workspaceId;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  describe() {
    return { baseUrl: this.#base, tokenSet: this.#token !== undefined, ...(this.#workspaceId ? { workspaceId: this.#workspaceId } : {}) };
  }

  async #request<T>(method: "GET" | "POST", path: string, body?: unknown, query?: Record<string, string | undefined>): Promise<T> {
    const url = new URL(path, this.#base);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "zenith-live-acceptance" };
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    if (this.#workspaceId) headers["x-zenith-workspace"] = this.#workspaceId;
    if (body !== undefined) headers["content-type"] = "application/json";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await this.#fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, redirect: "manual" });
      text = await responseText(res, MAX_RESPONSE_BYTES);
    } catch (err) {
      throw new ControlPlaneError(0, controller.signal.aborted ? `${method} ${path} timed out after ${this.#timeoutMs} ms.` : `${method} ${path} failed (${err instanceof Error ? err.name : "error"}).`, "unreachable");
    } finally {
      clearTimeout(timer);
    }
    const safe = (value: string) => redactCredentials(removeToken(value, this.#token));
    let parsed: unknown;
    if (text.trim() !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (res.status >= 300 && res.status < 400) throw new ControlPlaneError(res.status, `${method} ${path} was redirected (${res.status}); the control plane wants a browser session for this route.`, "redirected");
        throw new ControlPlaneError(res.status, `${method} ${path} did not return JSON (status ${res.status}).`, "invalid_response");
      }
    }
    if (!res.ok) {
      const err = (parsed as { error?: unknown } | undefined)?.error;
      if (err && typeof err === "object") {
        const e = err as { code?: unknown; message?: unknown; fix?: unknown };
        throw new ControlPlaneError(res.status, safe(String(e.message ?? `HTTP ${res.status}`)).slice(0, 400), typeof e.code === "string" ? safe(e.code) : undefined, typeof e.fix === "string" ? safe(e.fix).slice(0, 300) : undefined);
      }
      const message = typeof err === "string" ? err : (parsed as { message?: unknown } | undefined)?.message;
      throw new ControlPlaneError(res.status, safe(typeof message === "string" ? message : `HTTP ${res.status}`).slice(0, 400));
    }
    return parsed as T;
  }

  async ping() {
    try {
      const res = await this.#fetch(new URL("/api/platform/v1/operations", this.#base), {
        method: "GET",
        headers: { accept: "application/json", ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}), ...(this.#workspaceId ? { "x-zenith-workspace": this.#workspaceId } : {}) },
        signal: AbortSignal.timeout(10_000),
        redirect: "manual",
      });
      await res.body?.cancel().catch(() => undefined);
      return { ok: res.ok, status: res.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  runAction(actionId: string, body: ActionBody) {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(actionId)) throw new ControlPlaneError(0, "Invalid action id.");
    return this.#request<ActionResponse>("POST", `/api/actions/${actionId}`, body);
  }

  checkCapability(request: CapabilityRequest) {
    return this.#request<{ decision: DecisionViewLike }>("POST", "/api/platform/v1/capabilities/check", request);
  }

  proposeCapability(request: CapabilityRequest) {
    return this.#request<ProposeResponse>("POST", "/api/platform/v1/capabilities/propose", request);
  }

  getOperation(id: string) {
    return this.#request<OperationDetailResponse>("GET", `/api/platform/v1/operations/${encodeURIComponent(id)}`);
  }

  listOperations(filters: { status?: string[]; environmentId?: string; capability?: string; limit?: number } = {}) {
    return this.#request<{ operations: OperationViewLike[]; nextCursor?: string }>("GET", "/api/platform/v1/operations", undefined, {
      status: filters.status?.join(","),
      environmentId: filters.environmentId,
      capability: filters.capability,
      limit: filters.limit === undefined ? undefined : String(filters.limit),
    });
  }

  async listOperationEvents(id: string, afterSeq?: number) {
    const events: OperationEventLike[] = [];
    let cursor = afterSeq;
    // WS-CAP defaults to 100 events. A truncated first page cannot establish
    // Demo E's no-replay criterion; drain explicit bounded pages instead.
    for (let page = 0; page < 100; page++) {
      const response = await this.#request<{ events: OperationEventLike[] }>("GET", `/api/platform/v1/operations/${encodeURIComponent(id)}/events`, undefined, { afterSeq: cursor === undefined ? undefined : String(cursor), limit: "100" });
      if (!Array.isArray(response?.events)) throw new ControlPlaneError(200, "The event response has no events array.", "invalid_response");
      events.push(...response.events);
      if (response.events.length < 100) return { events };
      const last = response.events.at(-1)?.seq;
      if (typeof last !== "number" || !Number.isSafeInteger(last) || last <= (cursor ?? -1)) throw new ControlPlaneError(200, "Event pagination has no advancing sequence.", "invalid_response");
      cursor = last;
    }
    throw new ControlPlaneError(200, "Event history exceeds the acceptance limit; replay safety is unknown.", "invalid_response");
  }

  cancelOperation(id: string, reason?: string) {
    return this.#request<{ operation: OperationViewLike }>("POST", `/api/platform/v1/operations/${encodeURIComponent(id)}/cancel`, reason ? { reason } : {});
  }

  getAutonomy(environmentId: string) {
    return this.#request<Record<string, unknown>>("GET", `/api/platform/v1/environments/${encodeURIComponent(environmentId)}/autonomy`);
  }

  getDeployment(id: string) {
    return this.#request<Record<string, unknown>>("GET", `/api/deployments/${encodeURIComponent(id)}`);
  }

  getDrift(environmentId: string) {
    return this.#request<Record<string, unknown>>("GET", `/api/environments/${encodeURIComponent(environmentId)}/drift`);
  }
}

/* ------------------------------ waiting helpers ------------------------------ */

export const isTerminalStatus = (status: string): boolean => (TERMINAL_OPERATION_STATUSES as readonly string[]).includes(status);

export interface WaitOptions {
  /** stop waiting when this returns true for the latest operation view */
  until: (op: OperationViewLike) => boolean;
  timeoutMs: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** called after every poll (progress lines, background work such as tag adoption) */
  onPoll?: (op: OperationViewLike, polls: number) => void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * Poll an operation until `until` holds, it reaches a terminal state, or the
 * deadline passes. `reached` is true only when `until` held: a terminal state
 * `until` does not accept is returned with `reached: false`, so the caller
 * sees what actually happened instead of waiting out the clock.
 */
export async function waitForOperation(
  cp: Pick<ControlPlaneClient, "getOperation">,
  operationId: string,
  opts: WaitOptions,
): Promise<{ reached: boolean; terminal: boolean; timedOut: boolean; operation: OperationViewLike; polls: number }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + opts.timeoutMs;
  const pollMs = opts.pollMs ?? 5_000;
  let polls = 0;
  for (;;) {
    if (opts.signal?.aborted) throw new Error("Waiting for the operation was aborted.");
    const { operation } = await cp.getOperation(operationId);
    polls++;
    await opts.onPoll?.(operation, polls);
    const reached = opts.until(operation);
    const terminal = isTerminalStatus(operation.status);
    if (reached) return { reached: true, terminal, timedOut: false, operation, polls };
    if (terminal) return { reached: false, terminal: true, timedOut: false, operation, polls };
    if (now() + pollMs > deadline) return { reached: false, terminal: false, timedOut: true, operation, polls };
    await sleep(pollMs);
  }
}
