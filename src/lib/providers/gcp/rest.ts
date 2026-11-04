/**
 * Thin, bounded Google REST client over `GcpSession.authorizedFetch`.
 *
 * Drivers never build `fetch` calls themselves: this module classifies every
 * outcome into the five the driver contract distinguishes (present / missing /
 * inaccessible / throttled / error), bounds response size, honours the abort
 * signal and keeps error text model-safe (no credentials: messages go through
 * `scrub`, and request/response bodies are never logged).
 *
 * Mapping of HTTP status to outcome:
 *   2xx                     ok
 *   404                     missing      ("the API said not found")
 *   401, 403                inaccessible (includes "API not enabled", reported in `detail`)
 *   429                     throttled
 *   5xx, network, bad JSON  error        (presence becomes `unknown`)
 *   other 4xx               error
 */
import type { GcpSession } from "@/lib/credentials/types";
import { GcpSessionError, scrub } from "./errors";

export type Outcome = "ok" | "missing" | "inaccessible" | "throttled" | "error";

export interface RestResult {
  outcome: Outcome;
  status: number;
  json: Record<string, unknown>;
  requestId?: string;
  /** short, scrubbed reason for non-ok outcomes */
  detail?: string;
}

export interface RestContext {
  session: GcpSession;
  signal: AbortSignal;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_LIST_PAGES = 5;

async function readBounded(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("response body exceeded the size limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function requestIdOf(res: Response): string | undefined {
  for (const h of ["x-goog-request-id", "x-request-id", "x-guploader-uploadid"]) {
    const v = res.headers.get(h);
    if (v) return v.slice(0, 120);
  }
  return undefined;
}

/** Google error envelope → short reason. */
function reasonOf(json: Record<string, unknown>): string {
  const e = json.error;
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    const details = Array.isArray(o.details) ? (o.details as Record<string, unknown>[]) : [];
    const info = details.find((d) => typeof d?.reason === "string");
    const parts = [typeof o.status === "string" ? o.status : undefined, typeof info?.reason === "string" ? (info.reason as string) : undefined, typeof o.message === "string" ? o.message : undefined].filter(Boolean);
    return scrub(parts.join(": "), [], 200);
  }
  return "";
}

export function classify(status: number): Outcome {
  if (status >= 200 && status < 300) return "ok";
  if (status === 404) return "missing";
  if (status === 401 || status === 403) return "inaccessible";
  if (status === 429) return "throttled";
  return "error";
}

export async function gcpCall(ctx: RestContext, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, body?: unknown): Promise<RestResult> {
  ctx.signal.throwIfAborted();
  let res: Response;
  try {
    res = await ctx.session.authorizedFetch(url, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctx.signal,
    });
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    if (e instanceof GcpSessionError) throw e; // expired/closed/forbidden host: a caller bug, not a cloud outcome
    return { outcome: "error", status: 0, json: {}, detail: scrub(e instanceof Error ? e.message : String(e), [], 200) };
  }
  let json: Record<string, unknown> = {};
  let parseFailed = false;
  try {
    const text = await readBounded(res);
    if (text !== "") {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
      else parseFailed = true;
    }
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    parseFailed = true;
  }
  const outcome = classify(res.status);
  if (outcome === "ok" && parseFailed) return { outcome: "error", status: res.status, json: {}, requestId: requestIdOf(res), detail: "response was not valid JSON" };
  return {
    outcome,
    status: res.status,
    json,
    requestId: requestIdOf(res),
    ...(outcome === "ok" ? {} : { detail: reasonOf(json) || `HTTP ${res.status}` }),
  };
}

export const gcpGet = (ctx: RestContext, url: string): Promise<RestResult> => gcpCall(ctx, "GET", url);

export interface ListResult {
  outcome: Outcome;
  status: number;
  items: Record<string, unknown>[];
  /** more pages existed than the bound allowed */
  truncated: boolean;
  detail?: string;
  requestId?: string;
}

/** Paginated list, bounded to `MAX_LIST_PAGES` pages. `itemsKey` is the array member of the response. */
export async function gcpList(ctx: RestContext, url: string, itemsKey: string, opts: { maxPages?: number; pageTokenParam?: string } = {}): Promise<ListResult> {
  const param = opts.pageTokenParam ?? "pageToken";
  const maxPages = opts.maxPages ?? MAX_LIST_PAGES;
  const items: Record<string, unknown>[] = [];
  let token: string | undefined;
  let last: RestResult | undefined;
  for (let page = 0; page < maxPages; page++) {
    const u = token ? `${url}${url.includes("?") ? "&" : "?"}${param}=${encodeURIComponent(token)}` : url;
    last = await gcpGet(ctx, u);
    if (last.outcome !== "ok") return { outcome: last.outcome, status: last.status, items, truncated: false, detail: last.detail, requestId: last.requestId };
    const arr = last.json[itemsKey];
    if (Array.isArray(arr)) for (const x of arr) if (x && typeof x === "object") items.push(x as Record<string, unknown>);
    const next = last.json.nextPageToken;
    if (typeof next === "string" && next !== "") token = next;
    else return { outcome: "ok", status: last.status, items, truncated: false, requestId: last.requestId };
  }
  return { outcome: "ok", status: last?.status ?? 200, items, truncated: true, requestId: last?.requestId };
}

/** Poll a long-running `Operation` until done, at most `maxPolls` times. Returns the final operation JSON. */
export async function waitOperation(
  ctx: RestContext,
  operationUrl: string,
  opts: { maxPolls?: number; intervalMs?: number } = {}
): Promise<{ done: boolean; error?: string; json: Record<string, unknown>; requestId?: string }> {
  const maxPolls = opts.maxPolls ?? 15;
  const interval = opts.intervalMs ?? 2000;
  let last: RestResult | undefined;
  for (let i = 0; i < maxPolls; i++) {
    last = await gcpGet(ctx, operationUrl);
    if (last.outcome !== "ok") return { done: false, error: last.detail ?? `HTTP ${last.status}`, json: last.json, requestId: last.requestId };
    if (last.json.done === true) {
      const err = last.json.error as Record<string, unknown> | undefined;
      return { done: true, json: last.json, requestId: last.requestId, ...(err ? { error: scrub(String(err.message ?? err.code ?? "operation failed"), [], 200) } : {}) };
    }
    if (i < maxPolls - 1 && interval > 0) await new Promise((r) => setTimeout(r, interval));
  }
  return { done: false, json: last?.json ?? {}, requestId: last?.requestId };
}

/** Is `name` of the form `projects/<projectId>/…`? Guards externalIds against another project. */
export function inProject(name: string, projectId: string): boolean {
  return name.startsWith(`projects/${projectId}/`);
}
