/** Standalone, bounded metadata reader. No SDK, application imports, or generic URL API. */
export const API_ORIGIN = "https://api.cloudflare.com";
export const MAX_RESPONSE_BYTES = 64 * 1024;
export const MAX_RESPONSE_CHUNKS = 4096;
export const REQUEST_TIMEOUT_MS = 10_000;

export type InspectionEndpoint = "bindings" | "settings";
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type ReadFailureCode =
  | "invalid-selector" | "invalid-token" | "aborted" | "timeout" | "network"
  | "redirect" | "credentials-rejected" | "resource-unavailable" | "rate-limited"
  | "http-error" | "body-too-large" | "body-too-fragmented" | "unexpected-content-type"
  | "invalid-json" | "invalid-envelope" | "api-rejected";

// Every diagnostic is a fixed local message, never an upstream message or URL.
const MESSAGES: Record<ReadFailureCode, string> = {
  "invalid-selector": "Use a lowercase 32-hex account ID and test-prefixed namespace/script names.",
  "invalid-token": "Supply a valid token through HOSTED_SPIKE_CLOUDFLARE_API_TOKEN; do not pass it as an argument.",
  aborted: "Inspection cancelled. No further metadata requests were started.",
  timeout: "Metadata request exceeded its deadline. Inspect connectivity and retry explicitly.",
  network: "Metadata request failed. Inspect connectivity and retry explicitly; upstream details were discarded.",
  redirect: "Cloudflare returned a redirect. Redirects are forbidden; no destination was followed.",
  "credentials-rejected": "Cloudflare rejected access. Use a token with Workers Scripts Read scoped to the test account.",
  "resource-unavailable": "A selected test script was not found. Check the account, namespace and pre-existing test script selectors.",
  "rate-limited": "Cloudflare rate limited inspection. Retry explicitly after the service limit clears.",
  "http-error": "Cloudflare returned an unexpected HTTP status. No error response body was retained.",
  "body-too-large": "Metadata response exceeded 64 KiB. Inspection stopped without retaining the response.",
  "body-too-fragmented": "Metadata response exceeded the bounded stream chunk count. Inspection stopped.",
  "unexpected-content-type": "Cloudflare did not return application/json metadata.",
  "invalid-json": "Cloudflare returned malformed JSON metadata.",
  "invalid-envelope": "Cloudflare metadata did not contain the documented successful result envelope.",
  "api-rejected": "Cloudflare reported an API error. Upstream messages were discarded.",
};

export class ReadFailure extends Error {
  constructor(public readonly code: ReadFailureCode) {
    super(MESSAGES[code]);
    this.name = "ReadFailure";
  }
}

export const isTestName = (value: unknown): value is string =>
  typeof value === "string" && /^test-[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/.test(value);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function inspectionUrl(accountId: string, namespace: string, script: string, endpoint: InspectionEndpoint): string {
  if (!/^[a-f0-9]{32}$/.test(accountId) || !isTestName(namespace) || !isTestName(script)
      || (endpoint !== "bindings" && endpoint !== "settings")) {
    throw new ReadFailure("invalid-selector");
  }
  return `${API_ORIGIN}/client/v4/accounts/${accountId}/workers/dispatch/namespaces/${namespace}/scripts/${script}/${endpoint}`;
}

export interface MetadataRequest {
  accountId: string;
  namespace: string;
  script: string;
  endpoint: InspectionEndpoint;
  token: string;
  signal?: AbortSignal;
}

export interface ReaderDependencies {
  fetch?: FetchLike;
  /** Test-only shorter deadline; callers cannot increase the production bound. */
  timeoutMs?: number;
}

function cancelBody(response: Response): void {
  // Do not await cancellation: an uncooperative remote stream must not stall failure.
  void response.body?.cancel().catch(() => undefined);
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    cancelBody(response);
    throw new ReadFailure("body-too-large");
  }
  if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    cancelBody(response);
    throw new ReadFailure("unexpected-content-type");
  }
  if (!response.body) throw new ReadFailure("invalid-json");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let chunkCount = 0;
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new ReadFailure("aborted");
      const chunk = await reader.read();
      if (signal.aborted) throw new ReadFailure("aborted");
      if (chunk.done) break;
      if (++chunkCount > MAX_RESPONSE_CHUNKS) {
        void reader.cancel().catch(() => undefined);
        throw new ReadFailure("body-too-fragmented");
      }
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new ReadFailure("body-too-large");
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new ReadFailure("invalid-json");
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/** GET only; no retries, redirects, pagination, script content or D1 requests. */
export async function readMetadata(request: MetadataRequest, deps: ReaderDependencies = {}): Promise<unknown> {
  const url = inspectionUrl(request.accountId, request.namespace, request.script, request.endpoint);
  if (!/^[A-Za-z0-9_-]{20,256}$/.test(request.token)) throw new ReadFailure("invalid-token");
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > REQUEST_TIMEOUT_MS) throw new ReadFailure("invalid-selector");
  if (request.signal?.aborted) throw new ReadFailure("aborted");

  const controller = new AbortController();
  let expired = false;
  let rejectAbort!: (error: ReadFailure) => void;
  const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    controller.abort();
    rejectAbort(new ReadFailure(expired ? "timeout" : "aborted"));
  };
  request.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => { expired = true; onAbort(); }, timeoutMs);
  const operation = async () => {
    const response = await (deps.fetch ?? globalThis.fetch)(url, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      headers: { Authorization: `Bearer ${request.token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (controller.signal.aborted) { cancelBody(response); throw new ReadFailure("aborted"); }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      cancelBody(response);
      throw new ReadFailure("redirect");
    }
    if (response.status !== 200) {
      cancelBody(response);
      const code = response.status === 401 || response.status === 403 ? "credentials-rejected"
        : response.status === 404 ? "resource-unavailable"
        : response.status === 429 ? "rate-limited" : "http-error";
      throw new ReadFailure(code);
    }
    const envelope = await boundedJson(response, controller.signal);
    if (!isRecord(envelope) || envelope.success !== true || !("result" in envelope)
        || !Array.isArray(envelope.errors) || !Array.isArray(envelope.messages)) {
      throw new ReadFailure("invalid-envelope");
    }
    if (envelope.errors.length !== 0) throw new ReadFailure("api-rejected");
    // Deliberately discard messages and all error metadata. Results remain private
    // to the validator and are never serialized as evidence.
    return envelope.result;
  };
  try {
    return await Promise.race([operation(), interrupted]);
  } catch (error) {
    if (expired) throw new ReadFailure("timeout");
    if (request.signal?.aborted) throw new ReadFailure("aborted");
    if (error instanceof ReadFailure) throw error;
    throw new ReadFailure("network");
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
  }
}
