/** REST stays behind the SDK. MCP uses stateless JSON-RPC v2 over HTTP.
 * Only GET is retried; POSTs, including MCP reads and execution, never retry.
 * Deadlines cover bodies, redirects are refused, and response bytes are capped. */
import { PlatformApiError, PlatformInvalidResponseError, PlatformNetworkError, PlatformTimeoutError } from "@/lib/sdk";
import { CliError, interrupted } from "./errors";
import { DATA_NOTE, MAX_RESPONSE_BYTES, object } from "./security";

export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw interrupted();
  await new Promise<void>((resolve, reject) => {
    const done = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(interrupted()); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function boundedFetch(fetcher: typeof fetch, interrupt?: AbortSignal): typeof fetch {
  return async (input, init) => {
    const signal = init?.signal && interrupt ? AbortSignal.any([init.signal, interrupt]) : init?.signal ?? interrupt;
    const method = init?.method ?? "GET";
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      try { response = await fetcher(input, { ...init, signal, redirect: "error", credentials: "omit" }); }
      catch (error) {
        if (method !== "GET" || attempt === 2 || signal?.aborted) throw error;
        await pause(100 * (2 ** attempt), signal ?? undefined);
        continue;
      }
      if (method !== "GET" || attempt === 2 || ![429, 500, 502, 503, 504].includes(response.status)) break;
      const retryAfter = response.headers.get("retry-after");
      const delay = retryAfter === null ? 100 * (2 ** attempt) : /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
      if (!Number.isFinite(delay) || delay > 2000) break;
      await response.body?.cancel();
      await pause(Math.max(0, delay), signal ?? undefined);
    }
    if (!response) throw new PlatformNetworkError();
    let bytes = 0;
    const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) controller.error(new PlatformInvalidResponseError(response!.status));
        else controller.enqueue(chunk);
      },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export class McpClient {
  private sequence = 0;
  constructor(private readonly options: { baseUrl: string; token: string; workspaceId?: string; timeoutMs: number; fetch: typeof fetch; signal?: AbortSignal }) {}

  async request(method: string, params?: object): Promise<Record<string, unknown>> {
    const { baseUrl, token, workspaceId, timeoutMs, fetch: fetcher, signal } = this.options;
    if (signal?.aborted) throw interrupted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const id = ++this.sequence;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new PlatformTimeoutError()); }, timeoutMs);
    });
    const perform = async () => {
      let response: Response;
      try {
        response = await fetcher(`${baseUrl}/api/agent/v3/mcp`, { method: "POST", signal: controller.signal,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-06-18", ...(workspaceId ? { "x-zenith-workspace": workspaceId } : {}) },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) });
      } catch { throw new PlatformNetworkError(); }
      let value: unknown;
      try {
        if (!/\bapplication\/(?:[\w.+-]*\+)?json\b/i.test(response.headers.get("content-type") ?? "")) throw new Error();
        value = await response.json();
      } catch { throw new PlatformInvalidResponseError(response.status); }
      if (!response.ok) {
        if (!object(value) || !object(value.error) || typeof value.error.code !== "string" || typeof value.error.message !== "string") {
          throw new PlatformApiError(response.status, "http_error", "The server returned no valid error details.");
        }
        throw new PlatformApiError(response.status, value.error.code, value.error.message,
          typeof value.error.fix === "string" ? value.error.fix : undefined);
      }
      if (!object(value) || value.jsonrpc !== "2.0" || value.id !== id) throw new PlatformInvalidResponseError(response.status);
      if (object(value.error)) throw new CliError(value.error.code === -32602 ? 2 : 6, "rpc_error", "The MCP server refused the JSON-RPC request.");
      if (!object(value.result)) throw new PlatformInvalidResponseError(response.status);
      return value.result;
    };
    try { return await Promise.race([perform(), deadline]); }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }

  async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.request("tools/call", { name, arguments: args });
    let envelope: unknown = result.structuredContent;
    if (envelope === undefined && Array.isArray(result.content)) {
      const content = result.content.filter((block: unknown) => object(block) && block.type === "text");
      if (content.length === 1 && object(content[0]) && typeof content[0].text === "string") {
        try { envelope = JSON.parse(content[0].text); } catch { /* Invalid data is refused below. */ }
      }
    }
    if (!object(envelope) || envelope.contractVersion !== 3 || envelope.tool !== name || !Number.isSafeInteger(envelope.schemaVersion) || Number(envelope.schemaVersion) < 1 || envelope.note !== DATA_NOTE ||
        typeof envelope.ok !== "boolean" || typeof envelope.simulated !== "boolean" || typeof envelope.truncated !== "boolean" ||
        !Array.isArray(envelope.unavailable) || envelope.unavailable.some((entry: unknown) => !object(entry) || typeof entry.source !== "string" || typeof entry.reason !== "string") ||
        !Array.isArray(envelope.notes) || envelope.notes.some((note: unknown) => typeof note !== "string") || !object(envelope.data) ||
        (envelope.untrusted_data !== undefined && (!object(envelope.untrusted_data) || envelope.untrusted_data.label !== "untrusted_data" || !object(envelope.untrusted_data.content))) ||
        (envelope.ok === false && (!object(envelope.error) || typeof envelope.error.code !== "string" || typeof envelope.error.message !== "string")) ||
        (envelope.ok && (result.isError === true || envelope.error !== undefined))) throw new PlatformInvalidResponseError(200);
    return envelope;
  }
}
