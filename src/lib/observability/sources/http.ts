/**
 * Minimal, hardened JSON-over-HTTP GET for the Prometheus and Loki sources.
 *
 * - The base URL is operator configuration, not user input. It must be
 *   http(s) and must not embed credentials; secrets travel only through the
 *   injected token provider and are sent as a Bearer header.
 * - The token is validated as a header-safe token (no whitespace or control
 *   characters) and is never placed in an error message, URL or log.
 * - Redirects are refused: a backend that redirects is misconfigured, and
 *   following one would carry the bearer to another origin.
 * - Response bodies are read with a byte cap (default 8 MiB); an over-large
 *   answer is an error, not an out-of-memory.
 * - Error text from the backend is data: it is sanitized and bounded before it
 *   becomes part of an `unavailable` reason.
 */
import { abortReason, raceAbort, throwIfAborted } from "../abort";
import { sanitizeReason } from "../redact";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type TokenProvider = () => string | undefined | Promise<string | undefined>;

export interface HttpEndpointConfig {
  /** e.g. `https://prometheus.internal:9090` or `https://loki.example/loki-prefix` */
  baseUrl: string;
  /** injectable for tests; defaults to global `fetch` */
  fetch?: FetchLike;
  /** returns a bearer token per request, or undefined for none */
  tokenProvider?: TokenProvider;
  /** non-secret static headers, e.g. `X-Scope-OrgID` */
  headers?: Record<string, string>;
  maxResponseBytes?: number;
  /**
   * Deadline for ONE request (default 7 s). A slow backend then fails that
   * request only — one node's query — instead of waiting for the fabric's hard
   * per-source timeout and taking every node's answer down with it.
   */
  requestTimeoutMs?: number;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 7000;

export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const HEADER_TOKEN = /^[\x21-\x7e]{1,4096}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Cloud instance-metadata endpoints. An observability endpoint is normally a
 * private in-cluster address (which must stay allowed), but these hosts hand
 * out credentials and no metrics backend lives there.
 */
export function isMetadataHost(hostname: string): boolean {
  let h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h.includes(":")) {
    // WHATWG URL canonicalizes compressed, expanded and dotted IPv6 spellings.
    // Classification is local; this performs no DNS lookup or network request.
    try {
      h = new URL(`http://[${h}]`).hostname.slice(1, -1);
    } catch {
      return false;
    }
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (mapped) {
      const high = Number.parseInt(mapped[1], 16);
      const low = Number.parseInt(mapped[2], 16);
      h = `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
    }
  }
  return /^169\.254\./.test(h) || h === "metadata.google.internal" || h === "metadata" || h.startsWith("fd00:ec2:") || h === "100.100.100.200";
}

/**
 * Validate and normalize a base URL (no trailing slash, no credentials,
 * http/https only, not a cloud metadata host). The URL is platform
 * configuration; if tenants are ever allowed to supply endpoints, the caller
 * must also apply its own SSRF policy — private ranges are legitimately valid
 * here, so this function cannot.
 */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("baseUrl is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("baseUrl must be http or https");
  if (url.username || url.password) throw new Error("baseUrl must not embed credentials; use a token provider");
  if (url.search || url.hash) throw new Error("baseUrl must not include a query string or fragment");
  if (isMetadataHost(url.hostname)) throw new Error("baseUrl must not point at a cloud metadata endpoint");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export class HttpSourceError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    // deliberately the default name: reasons read "HTTP 500: …", not "HttpSourceError: HTTP 500: …"
  }
}

/**
 * GET `<baseUrl><path>?<params>` and return parsed JSON. `path` is a fixed API
 * path chosen by the source. Rejects with the caller's abort reason if `signal`
 * aborts, and with an `HttpSourceError` if the request outlives its own deadline.
 */
export async function getJson(cfg: HttpEndpointConfig & { baseUrl: string }, path: string, params: URLSearchParams, signal: AbortSignal): Promise<unknown> {
  throwIfAborted(signal);
  const timeoutMs = cfg.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(timeoutMs);
  try {
    return await getJsonWithin(cfg, path, params, AbortSignal.any([signal, deadline]));
  } catch (err) {
    if (signal.aborted) throw abortReason(signal);
    if (deadline.aborted) throw new HttpSourceError(`request timed out after ${timeoutMs} ms`);
    throw err;
  }
}

async function getJsonWithin(cfg: HttpEndpointConfig & { baseUrl: string }, path: string, params: URLSearchParams, signal: AbortSignal): Promise<unknown> {
  const doFetch: FetchLike = cfg.fetch ?? ((input, init) => fetch(input, init));
  const headers: Record<string, string> = { accept: "application/json" };
  for (const [k, v] of Object.entries(cfg.headers ?? {})) {
    if (HEADER_NAME.test(k) && HEADER_TOKEN.test(v)) headers[k] = v;
  }
  const token = await cfg.tokenProvider?.();
  if (token !== undefined) {
    if (!HEADER_TOKEN.test(token)) throw new HttpSourceError("token provider returned a value that is not a valid bearer token");
    headers.authorization = `Bearer ${token}`;
  }
  throwIfAborted(signal);

  let res: Response;
  try {
    res = await doFetch(`${cfg.baseUrl}${path}?${params.toString()}`, { method: "GET", headers, signal, redirect: "error", cache: "no-store" });
  } catch (err) {
    if (signal.aborted) throw abortReason(signal);
    // fetch errors carry the cause; the message alone is enough and cannot contain the header
    throw new HttpSourceError(`request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const cap = cfg.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const text = await readCapped(res, cap, signal);
  if (!res.ok) throw new HttpSourceError(`HTTP ${res.status}: ${sanitizeReason(text, 300)}`, res.status);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpSourceError(`HTTP ${res.status}: response body was not JSON`);
  }
}

async function readCapped(res: Response, cap: number, signal: AbortSignal): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    void res.body?.cancel().catch(() => undefined);
    throw new HttpSourceError(`response larger than ${cap} bytes`);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await raceAbort(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > cap) throw new HttpSourceError(`response larger than ${cap} bytes`);
      chunks.push(value);
    }
  } catch (err) {
    void reader.cancel().catch(() => undefined);
    throw err;
  }
  return Buffer.concat(chunks).toString("utf8");
}
