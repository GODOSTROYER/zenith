/** Small typed fetch client for /api/platform/v1. No automatic write retries,
 * no approvals, no credential-bearing redirects, and a deadline that includes
 * reading the body. Cookie auth still requires the server's live browser proof. */
import { scrubSecrets } from "@/lib/capabilities/secret-guard";
import { PlatformApiError, PlatformInvalidResponseError, PlatformNetworkError, PlatformTimeoutError } from "./errors";
import type { PlatformClient, PlatformClientOptions } from "./types";

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): v is ObjectValue => !!v && typeof v === "object" && !Array.isArray(v);
type Shape = (v: ObjectValue) => boolean;
const operation = (v: ObjectValue) => object(v.operation) && typeof v.operation.id === "string" && typeof v.operation.status === "string";
const decision = (v: ObjectValue) => object(v.decision) && typeof v.decision.outcome === "string";
const autonomy = (v: ObjectValue) => typeof v.environmentId === "string" && typeof v.level === "number" && typeof v.version === "number";
const policy = (v: ObjectValue) => object(v.overrides) && object(v.effective) && typeof v.version === "number";

export function createPlatformClient(options: PlatformClientOptions): PlatformClient {
  let base: URL;
  try {
    base = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error();
  } catch { throw new PlatformApiError(0, "invalid_configuration", "Use an HTTP(S) base URL without credentials, query or fragment."); }
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new PlatformApiError(0, "invalid_configuration", "timeoutMs must be between 1 and 300000.");
  // Copy authentication so a caller cannot switch a bearer client to cookie mode
  // after the browser-only guard has been applied.
  const auth = { ...options.auth };
  if (auth.kind === "bearer" && (!auth.token || /\s/.test(auth.token)) || auth.kind === "cookie" && auth.cookie !== undefined && /[\r\n]/.test(auth.cookie)) {
    throw new PlatformApiError(0, "invalid_configuration", "Authentication must contain a valid header value.");
  }
  if (options.workspaceId !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(options.workspaceId)) throw new PlatformApiError(0, "invalid_configuration", "Use a valid workspace identifier.");
  const fetcher = options.fetch ?? globalThis.fetch;
  const root = `${base.href.replace(/\/$/, "")}/api/platform/v1`;
  const privateStrings = [auth.kind === "bearer" ? auth.token : auth.cookie].filter((s): s is string => !!s);
  const sanitize = (value: unknown): unknown => {
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") return privateStrings.reduce((text, secret) => text.split(secret).join("[redacted]"), scrubSecrets(v));
      if (Array.isArray(v)) return v.map(walk);
      if (object(v)) return Object.fromEntries(Object.entries(v).map(([k, child]) => [String(walk(k)), walk(child)]));
      return v;
    };
    return walk(scrubSecrets(value));
  };

  async function request<T>(path: string, method: string, shape: Shape, body?: unknown, query?: object): Promise<T> {
    const url = new URL(`${root}${path}`);
    if (query) for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
    const headers = new Headers({ accept: "application/json" });
    if (options.workspaceId) headers.set("x-zenith-workspace", options.workspaceId);
    if (body !== undefined) headers.set("content-type", "application/json");
    if (auth.kind === "bearer") headers.set("authorization", `Bearer ${auth.token}`);
    else {
      if (auth.cookie) headers.set("cookie", auth.cookie);
      if (method !== "GET") headers.set("origin", base.origin);
    }
    const controller = new AbortController();
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { expired = true; controller.abort(); reject(new PlatformTimeoutError()); }, timeoutMs);
    });
    const perform = async (): Promise<T> => {
      let response: Response;
      try {
        response = await fetcher(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
          credentials: auth.kind === "cookie" ? "include" : "omit", redirect: "error", cache: "no-store", signal: controller.signal });
      } catch { throw expired ? new PlatformTimeoutError() : new PlatformNetworkError(); }
      let value: unknown;
      try {
        if (!/\bapplication\/(?:[\w.+-]*\+)?json\b/i.test(response.headers.get("content-type") ?? "")) throw new Error();
        value = await response.json();
      } catch { throw expired ? new PlatformTimeoutError() : new PlatformInvalidResponseError(response.status); }
      if (!response.ok) {
        if (!object(value) || !object(value.error) || typeof value.error.code !== "string" || typeof value.error.message !== "string") throw new PlatformInvalidResponseError(response.status);
        const error = sanitize(value.error) as ObjectValue;
        throw new PlatformApiError(response.status, String(error.code), String(error.message).slice(0, 2000),
          typeof error.fix === "string" ? error.fix.slice(0, 2000) : undefined, object(error.details) ? error.details : undefined);
      }
      if (!object(value) || !shape(value)) throw new PlatformInvalidResponseError(response.status);
      return value as T;
    };
    try { return await Promise.race([perform(), deadline]); }
    finally { clearTimeout(timer); }
  }
  async function browserOnly<T>(fn: () => Promise<T>): Promise<T> {
    if (auth.kind === "bearer") throw new PlatformApiError(403, "browser_session_required", "This action requires a person signed in to the Zenith web app.");
    return fn();
  }
  const idPath = (id: string): string => {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new PlatformApiError(400, "invalid_request", "Use a valid platform identifier.");
    return encodeURIComponent(id);
  };
  return {
    proposeCapability: (input) => request("/capabilities/propose", "POST", (v) => operation(v) && decision(v) && typeof v.replayed === "boolean", input),
    checkCapability: (input) => request("/capabilities/check", "POST", decision, input),
    listOperations: (query) => request("/operations", "GET", (v) => Array.isArray(v.operations) && (v.nextCursor === undefined || typeof v.nextCursor === "string"), undefined, query),
    getOperation: (id) => request(`/operations/${idPath(id)}`, "GET", (v) => operation(v) && Array.isArray(v.approvals)),
    listOperationEvents: (id, query) => request(`/operations/${idPath(id)}/events`, "GET", (v) => Array.isArray(v.events), undefined, query),
    cancelOperation: (id, input = {}) => request(`/operations/${idPath(id)}/cancel`, "POST", operation, input),
    getEnvironmentAutonomy: (id) => request(`/environments/${idPath(id)}/autonomy`, "GET", autonomy),
    setEnvironmentAutonomy: (id, input) => browserOnly(() => request(`/environments/${idPath(id)}/autonomy`, "PUT", autonomy, input)),
    getWorkspacePolicy: () => request("/workspace/policy", "GET", policy),
    setWorkspacePolicy: (input) => browserOnly(() => request("/workspace/policy", "PUT", policy, input)),
  };
}
