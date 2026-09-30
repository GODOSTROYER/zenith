/**
 * Azure Resource Manager (ARM) REST helpers shared by every Azure driver.
 *
 * Everything goes through `AzureSession.authorizedFetch`, which alone decides
 * which hosts a bearer token may reach; this module only builds ARM URLs
 * (always `https://management.azure.com/...`) and classifies responses.
 *
 * Responses are data, never instructions: bodies are size-capped, parsed as
 * JSON only, and error text is truncated and scrubbed of token-shaped strings
 * before it can reach a log, an Observation or an operation result.
 *
 * Honest limit: the REST shapes (paths, api-versions, property names) come
 * from Microsoft's published API references and are exercised by contract
 * tests against a fake ARM server only — never a live subscription.
 */
import type { AzureSession } from "@/lib/credentials/types";

export const ARM_ORIGIN = "https://management.azure.com";
/** generic `Microsoft.Resources` list/tag-filter API version */
export const RESOURCES_API = "2021-04-01";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 10;

export type Json = Record<string, unknown>;

export interface ArmResource {
  id: string;
  name: string;
  type: string;
  location?: string;
  tags?: Record<string, string>;
  kind?: string;
  sku?: Json;
  identity?: Json;
  properties?: Json;
  etag?: string;
}

export type ArmErrorKind = "not_found" | "forbidden" | "throttled" | "conflict" | "server" | "client" | "network" | "aborted" | "bad_response";

/** An ARM call failed. `message` is safe to log and to show: no token, bounded length. */
export class ArmError extends Error {
  readonly code = "azure_arm_error";
  constructor(
    readonly kind: ArmErrorKind,
    readonly status: number,
    message: string,
    readonly armCode?: string,
    readonly requestId?: string,
    readonly retryAfterSec?: number
  ) {
    super(message);
    this.name = "ArmError";
  }
}

/* ---------------------------------- ids ----------------------------------- */

export interface ParsedArmId {
  subscriptionId: string;
  resourceGroup?: string;
  provider?: string;
  /** alternating type/name segments after the provider, lowercased types */
  segments: { type: string; name: string }[];
}

const SUB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse `/subscriptions/{s}[/resourceGroups/{rg}[/providers/{ns}/{type}/{name}[/{type}/{name}…]]]`. */
export function parseArmId(id: string): ParsedArmId | undefined {
  const parts = id.split("/").filter((p, i) => !(i === 0 && p === ""));
  if (parts.length < 2 || parts[0].toLowerCase() !== "subscriptions" || !SUB_ID.test(parts[1])) return undefined;
  const out: ParsedArmId = { subscriptionId: parts[1].toLowerCase(), segments: [] };
  let i = 2;
  if (parts[i]?.toLowerCase() === "resourcegroups") {
    if (!parts[i + 1]) return undefined;
    out.resourceGroup = parts[i + 1];
    i += 2;
  }
  if (parts[i]?.toLowerCase() === "providers") {
    if (!parts[i + 1]) return undefined;
    out.provider = parts[i + 1];
    i += 2;
    while (i < parts.length) {
      if (!parts[i + 1]) return undefined;
      out.segments.push({ type: parts[i].toLowerCase(), name: parts[i + 1] });
      i += 2;
    }
  } else if (i < parts.length) return undefined;
  return out;
}

/** `Microsoft.Network/virtualNetworks` for a resource id, or `.../subnets` for a child. */
export function armTypeOf(id: string): string | undefined {
  const p = parseArmId(id);
  if (!p?.provider || p.segments.length === 0) return undefined;
  return `${p.provider}/${p.segments.map((s) => s.type).join("/")}`.toLowerCase();
}

export function sameArmType(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._()-]{0,89}$/;

/** `/subscriptions/{s}/resourceGroups/{rg}/providers/{type...}`; segments are validated, never concatenated raw. */
export function armResourceId(subscriptionId: string, resourceGroup: string, provider: string, pairs: readonly [type: string, name: string][]): string {
  if (!SUB_ID.test(subscriptionId)) throw new Error("Invalid subscription id.");
  for (const s of [resourceGroup, provider, ...pairs.flat()]) {
    if (!SEGMENT.test(s.replace(/^Microsoft\./, "M"))) throw new Error(`Invalid ARM id segment "${s.slice(0, 40)}".`);
  }
  return `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/${provider}/${pairs.map(([t, n]) => `${t}/${n}`).join("/")}`;
}

/** Does `id` belong to this subscription? (ids are compared case-insensitively) */
export function inSubscription(id: string, subscriptionId: string): boolean {
  return parseArmId(id)?.subscriptionId === subscriptionId.toLowerCase();
}

/* --------------------------------- client --------------------------------- */

const TOKENISH = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b|\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}|(?:AccountKey|SharedAccessKey|Password|pwd|sig)=[^;&\s"]+/gi;

/** Bounded, single-line, token-scrubbed text from an untrusted response. */
export function safeText(text: string, max = 300): string {
  return text.replace(TOKENISH, "[REDACTED]").replace(/\s+/g, " ").trim().slice(0, max);
}

export interface ArmRequestOptions {
  apiVersion: string;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ArmResponse<T = Json> {
  status: number;
  body: T;
  headers: Headers;
  requestId?: string;
}

export interface ArmClient {
  get<T = Json>(path: string, o: ArmRequestOptions): Promise<ArmResponse<T>>;
  post<T = Json>(path: string, o: ArmRequestOptions): Promise<ArmResponse<T>>;
  put<T = Json>(path: string, o: ArmRequestOptions): Promise<ArmResponse<T>>;
  patch<T = Json>(path: string, o: ArmRequestOptions): Promise<ArmResponse<T>>;
  /** follow `nextLink` (same host only) and concatenate `value` arrays */
  list<T = Json>(path: string, o: ArmRequestOptions, maxPages?: number): Promise<{ items: T[]; truncated: boolean; requestIds: string[] }>;
}

function buildUrl(path: string, o: ArmRequestOptions): string {
  if (!path.startsWith("/") || path.includes("..") || path.includes("//") || /[\s#\\]/.test(path)) throw new ArmError("client", 0, "Invalid ARM path.");
  const q = new URLSearchParams({ "api-version": o.apiVersion });
  for (const [k, v] of Object.entries(o.query ?? {})) q.set(k, v);
  // URLSearchParams encodes spaces as '+', which ARM filters accept; `$` stays readable
  return `${ARM_ORIGIN}${path}?${q.toString().replace(/%24/g, "$")}`;
}

function classify(status: number): ArmErrorKind {
  if (status === 404) return "not_found";
  if (status === 401 || status === 403) return "forbidden";
  if (status === 429) return "throttled";
  if (status === 409 || status === 412) return "conflict";
  if (status >= 500) return "server";
  return "client";
}

async function readJson(res: Response): Promise<{ text: string; json: unknown }> {
  const reader = res.body?.getReader();
  let text = "";
  if (reader) {
    const decoder = new TextDecoder();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ArmError("bad_response", res.status, "The ARM response exceeded the size limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  if (!text.trim()) return { text, json: {} };
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: undefined };
  }
}

/**
 * Send one JSON request through the session and classify the outcome. Used for
 * ARM and for the other allowlisted Azure hosts (Key Vault data plane, Log
 * Analytics); the session decides which hosts may receive a bearer token.
 */
export async function sendJson<T = Json>(
  session: AzureSession,
  signal: AbortSignal | undefined,
  method: string,
  url: string,
  o: { body?: unknown; headers?: Record<string, string> } = {}
): Promise<ArmResponse<T>> {
  if (signal?.aborted) throw new ArmError("aborted", 0, "The operation was aborted.");
  let res: Response;
  try {
    res = await session.authorizedFetch(url, {
      method,
      headers: { accept: "application/json", ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.headers ?? {}) },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw new ArmError("aborted", 0, "The operation was aborted.");
    // `authorizedFetch` refusals carry safe messages; anything else is reduced to its class
    const refused = e instanceof Error && e.name === "AzureRequestRefusedError";
    throw new ArmError("network", 0, refused ? safeText((e as Error).message) : `Azure request failed (${e instanceof Error ? e.name : "error"}).`);
  }
  const requestId = res.headers.get("x-ms-request-id") ?? res.headers.get("x-ms-correlation-request-id") ?? undefined;
  const { text, json } = await readJson(res);
  if (!res.ok) {
    const err = (json as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
    const code = typeof err?.code === "string" ? err.code.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) : undefined;
    const msg = typeof err?.message === "string" ? err.message : text;
    const retry = Number(res.headers.get("retry-after"));
    throw new ArmError(
      classify(res.status),
      res.status,
      `Azure ${method} failed (HTTP ${res.status}${code ? `, ${code}` : ""})${msg ? `: ${safeText(msg)}` : ""}`,
      code,
      requestId,
      Number.isFinite(retry) && retry >= 0 ? Math.min(retry, 3600) : undefined
    );
  }
  if (json === undefined) throw new ArmError("bad_response", res.status, "The Azure response was not JSON.", undefined, requestId);
  return { status: res.status, body: json as T, headers: res.headers, requestId };
}

export function armClient(session: AzureSession, signal?: AbortSignal): ArmClient {
  const call = <T,>(method: string, path: string, o: ArmRequestOptions, absoluteUrl?: string): Promise<ArmResponse<T>> =>
    sendJson<T>(session, signal, method, absoluteUrl ?? buildUrl(path, o), { body: o.body, headers: o.headers });

  return {
    get: (p, o) => call("GET", p, o),
    post: (p, o) => call("POST", p, o),
    put: (p, o) => call("PUT", p, o),
    patch: (p, o) => call("PATCH", p, o),
    async list<T>(path: string, o: ArmRequestOptions, maxPages = DEFAULT_MAX_PAGES) {
      const items: T[] = [];
      const requestIds: string[] = [];
      let next: string | undefined;
      for (let page = 0; page < maxPages; page++) {
        const r: ArmResponse<{ value?: T[]; nextLink?: string }> = await call("GET", path, o, next);
        if (r.requestId) requestIds.push(r.requestId);
        if (Array.isArray(r.body.value)) items.push(...r.body.value);
        next = typeof r.body.nextLink === "string" && r.body.nextLink ? r.body.nextLink : undefined;
        if (!next) return { items, truncated: false, requestIds };
        // never follow a nextLink off ARM: the session would refuse, but fail with a clear reason first
        if (!next.startsWith(`${ARM_ORIGIN}/`)) throw new ArmError("bad_response", 200, "The ARM nextLink pointed outside management.azure.com.");
      }
      return { items, truncated: true, requestIds };
    },
  };
}

/* ------------------------------ async operations --------------------------- */

export interface OperationOutcome {
  state: "succeeded" | "failed" | "pending" | "unknown";
  detail?: string;
  requestIds: string[];
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Poll an ARM long-running operation (`azure-asyncoperation` / `location`
 * header) for a bounded time. The URL comes from a response header, i.e. from
 * the network: it is used only if it is an `https://management.azure.com` URL.
 */
export async function pollOperation(
  session: AzureSession,
  response: Pick<ArmResponse, "headers" | "status">,
  opts: { signal?: AbortSignal; maxPolls?: number; intervalMs?: number } = {}
): Promise<OperationOutcome> {
  const url = response.headers.get("azure-asyncoperation") ?? response.headers.get("location");
  if (response.status !== 202 || !url) return { state: "succeeded", requestIds: [] };
  if (!url.startsWith(`${ARM_ORIGIN}/`)) return { state: "unknown", detail: "operation URL was outside management.azure.com", requestIds: [] };
  const client = armClient(session, opts.signal);
  const requestIds: string[] = [];
  const maxPolls = opts.maxPolls ?? 12;
  for (let i = 0; i < maxPolls; i++) {
    let r: ArmResponse<{ status?: string; error?: { message?: string } }>;
    try {
      r = await client.get(new URL(url).pathname, { apiVersion: new URL(url).searchParams.get("api-version") ?? "2024-03-01", query: Object.fromEntries([...new URL(url).searchParams].filter(([k]) => k !== "api-version")) });
    } catch (e) {
      return { state: "unknown", detail: e instanceof Error ? safeText(e.message) : "poll failed", requestIds };
    }
    if (r.requestId) requestIds.push(r.requestId);
    const status = typeof r.body.status === "string" ? r.body.status.toLowerCase() : "";
    if (status === "succeeded") return { state: "succeeded", requestIds };
    if (status === "failed" || status === "canceled" || status === "cancelled") {
      return { state: "failed", detail: safeText(r.body.error?.message ?? status), requestIds };
    }
    await sleep(opts.intervalMs ?? 1000, opts.signal);
    if (opts.signal?.aborted) break;
  }
  return { state: "pending", requestIds };
}
