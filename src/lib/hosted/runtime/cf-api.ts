/**
 * A bounded, injectable transport for the Cloudflare API.
 *
 * The rules are the ones the binding-inspection spike settled on
 * (`scripts/hosted-spike/`, and its README for the reasoning). They are
 * re-implemented here rather than imported, because `scripts/` is an operator
 * harness that product code must not depend on:
 *
 *  - the origin is fixed to `https://api.cloudflare.com`; no base URL, path or
 *    destination ever comes from an argument or from a response;
 *  - redirects are refused rather than followed;
 *  - every request has a deadline, and every response body is read through a
 *    byte and chunk cap, so a hostile or broken upstream cannot exhaust this
 *    process;
 *  - only `application/json` with the documented `{success, errors, messages,
 *    result}` envelope is accepted;
 *  - upstream messages are summarised into the refusal, never echoed as HTML,
 *    and the token never appears in one.
 *
 * `fetch` is injectable, which is how the runtime tests assert the exact shape
 * of every request without a Cloudflare account existing.
 *
 * Workstream W6 (hosted R3).
 */
import { HostedError } from "@/lib/hosted/contracts";

/** The only origin this client will talk to. */
export const CF_API_ORIGIN = "https://api.cloudflare.com";

/** Response caps. Metadata answers are small; anything larger is a failure, not a page. */
export const CF_MAX_RESPONSE_BYTES = 256 * 1024;
export const CF_MAX_RESPONSE_CHUNKS = 4096;
export const CF_REQUEST_TIMEOUT_MS = 15_000;

/** The subset of `fetch` this client uses. Tests supply their own. */
export type CfFetch = (url: string, init: RequestInit) => Promise<Response>;

/** What the client needs to make one request. */
export interface CfClientOptions {
  accountId: string;
  token: string;
  fetch?: CfFetch;
  timeoutMs?: number;
}

/** One call: a method, a path under the fixed origin, and an optional body. */
export interface CfRequest {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  /** Path only, starting with `/client/v4/`. Never a full URL. */
  path: string;
  query?: Record<string, string>;
  body?: BodyInit;
  headers?: Record<string, string>;
  /** Overrides the account token — the assets upload session hands back its own JWT. */
  bearer?: string;
  signal?: AbortSignal;
  /** 404 is an answer rather than a failure for "does this exist?" reads. */
  allowNotFound?: boolean;
}

/** A Cloudflare answer, already unwrapped from its envelope. */
export interface CfResult {
  /** The envelope's `result`; `null` when the resource was absent and 404 was allowed. */
  result: unknown;
  status: number;
}

const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;
const NAMESPACE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Dispatch script and D1 database names this platform is willing to create. */
export const CF_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A refusal that names the input, never the token and never the upstream body. */
const refuse = (message: string, fix: string, details?: Record<string, unknown>): HostedError =>
  new HostedError("runtime_unavailable", message, { fix, details });

/** Reject anything that is not a plain identifier before it can reach a URL. */
export function assertCfName(kind: string, value: string): string {
  if (!CF_NAME_RE.test(value))
    throw refuse(
      `"${value}" is not a name this platform will use for a Cloudflare ${kind}.`,
      "Names are lowercase letters, digits and hyphens, 1–63 characters, starting with a letter or digit. App slugs already satisfy this."
    );
  return value;
}

/**
 * A bounded client for one Cloudflare account.
 *
 * Constructed with a token, never reading one: the single place
 * `ZENITH_CF_API_TOKEN` is read is `runtime/index.ts`, so a grep for it finds
 * one line.
 */
export class CloudflareApiClient {
  readonly accountId: string;

  private readonly token: string;
  private readonly transport: CfFetch;
  private readonly timeoutMs: number;

  constructor(options: CfClientOptions) {
    if (!ACCOUNT_ID_RE.test(options.accountId))
      throw refuse(
        "ZENITH_CF_ACCOUNT_ID is not a Cloudflare account id.",
        "A Cloudflare account id is 32 lowercase hexadecimal characters; copy it from the account's dashboard overview."
      );
    this.accountId = options.accountId;
    this.token = options.token;
    this.transport = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.timeoutMs = Math.min(options.timeoutMs ?? CF_REQUEST_TIMEOUT_MS, CF_REQUEST_TIMEOUT_MS);
  }

  /** The absolute URL one request will use. Exported shape, so tests can assert it. */
  url(pathTemplate: string, query?: Record<string, string>): string {
    if (!pathTemplate.startsWith("/client/v4/"))
      throw refuse(
        "A Cloudflare request was built with a path outside /client/v4/.",
        "This is a programming error in the Cloudflare runtime adapter, not a configuration problem."
      );
    const search = query
      ? `?${Object.entries(query)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&")}`
      : "";
    return `${CF_API_ORIGIN}${pathTemplate}${search}`;
  }

  /** The account-scoped path prefix every call below is built from. */
  account(suffix: string): string {
    return `/client/v4/accounts/${this.accountId}${suffix}`;
  }

  /** Perform one bounded request and return the unwrapped result. */
  async send(request: CfRequest): Promise<CfResult> {
    const url = this.url(request.path, request.query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = (): void => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });

    let response: Response;
    try {
      response = await this.transport(url, {
        method: request.method,
        redirect: "manual",
        cache: "no-store",
        headers: {
          authorization: `Bearer ${request.bearer ?? this.token}`,
          accept: "application/json",
          ...(request.headers ?? {}),
        },
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: controller.signal,
      });
    } catch (err) {
      throw refuse(
        controller.signal.aborted
          ? `Cloudflare did not answer within ${this.timeoutMs} ms.`
          : "The request to Cloudflare could not be made.",
        "Check this host's outbound network access to api.cloudflare.com, then try again. Nothing was created.",
        { cause: err instanceof Error ? err.name : "unknown" }
      );
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    }

    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => undefined);
      throw refuse(
        "Cloudflare answered with a redirect, which this client never follows.",
        "This usually means the request went through a proxy that rewrites api.cloudflare.com. Give this host a direct route."
      );
    }
    if (response.status === 404 && request.allowNotFound) {
      void response.body?.cancel().catch(() => undefined);
      return { result: null, status: 404 };
    }
    if (response.status === 401 || response.status === 403) {
      void response.body?.cancel().catch(() => undefined);
      throw refuse(
        "Cloudflare rejected this account's API token.",
        "Give ZENITH_CF_API_TOKEN the Workers Scripts, Workers for Platforms and D1 permissions for this account, then restart the control service."
      );
    }
    if (response.status === 429) {
      void response.body?.cancel().catch(() => undefined);
      throw refuse(
        "Cloudflare rate limited this account.",
        "Wait for the limit to clear and publish again. Nothing partial was left behind: this client does not retry."
      );
    }

    const envelope = await readBoundedJson(response);
    if (
      typeof envelope !== "object" ||
      envelope === null ||
      Array.isArray(envelope) ||
      (envelope as { success?: unknown }).success !== true ||
      !("result" in (envelope as Record<string, unknown>))
    ) {
      throw refuse(
        `Cloudflare answered ${response.status} without the result envelope this client requires.`,
        "This is a provider-side change or an outage. Nothing was created; try again, and if it persists check Cloudflare's status page.",
        { status: response.status, errors: summariseErrors(envelope) }
      );
    }
    return { result: (envelope as Record<string, unknown>).result, status: response.status };
  }
}

/** The upstream error codes, without upstream prose. Enough to act on, nothing to inject. */
function summariseErrors(envelope: unknown): number[] {
  if (typeof envelope !== "object" || envelope === null) return [];
  const errors = (envelope as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .map((entry) => (typeof entry === "object" && entry !== null ? (entry as { code?: unknown }).code : undefined))
    .filter((code): code is number => typeof code === "number");
}

/** Read a JSON body under both a byte cap and a chunk cap. Neither is negotiable. */
async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > CF_MAX_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => undefined);
    throw refuse(
      "Cloudflare's answer was larger than this client will read.",
      "This client reads metadata only. If Cloudflare has started returning larger documents the adapter needs updating."
    );
  }
  const type = (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    void response.body?.cancel().catch(() => undefined);
    throw refuse(
      `Cloudflare answered ${response.status} with ${type || "no"} content type instead of JSON.`,
      "Something between this host and api.cloudflare.com is rewriting responses — a captive portal or a proxy. Give this host a direct route."
    );
  }

  const body = response.body;
  if (!body) throw refuse("Cloudflare's answer had no body.", "Try again; nothing was created.");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let count = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (++count > CF_MAX_RESPONSE_CHUNKS)
        throw refuse(
          "Cloudflare's answer arrived in more pieces than this client will assemble.",
          "Try again. A stream this fragmented is a transport fault, not a large document."
        );
      size += chunk.value.byteLength;
      if (size > CF_MAX_RESPONSE_BYTES)
        throw refuse(
          "Cloudflare's answer was larger than this client will read.",
          "This client reads metadata only. If Cloudflare has started returning larger documents the adapter needs updating."
        );
      chunks.push(chunk.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* the body is already finished with */
    }
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw refuse(
      "Cloudflare's answer was not valid JSON.",
      "Try again; if it persists, check Cloudflare's status page. Nothing was created."
    );
  }
}

/** Guard for the namespace name before it is put in a URL. */
export function assertNamespace(namespace: string): string {
  if (!NAMESPACE_RE.test(namespace))
    throw refuse(
      `"${namespace}" is not a dispatch namespace name.`,
      "ZENITH_CF_NAMESPACE is lowercase letters, digits and hyphens, up to 63 characters."
    );
  return namespace;
}

/** The refusal builder, so the runtime adapter raises the same shape this client does. */
export const cfRefusal = refuse;
