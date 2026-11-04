/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A dependency-free MCP Streamable HTTP client for the conformance journey
 * (PROD-UX-02). It speaks the wire protocol directly with `fetch`, so the same
 * code drives a loopback server in a unit test and a deployed Zenith from the
 * command line, and every request header and body is visible to the checks.
 *
 * It is NOT the official MCP SDK client. That package (`@modelcontextprotocol/
 * client`) is not installed in this repository and adding a dependency was not
 * permitted for this requirement; `scripts/agent/mcp-conformance.ts --official`
 * runs the same journey through it when the verifier has installed it.
 */

export interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

export interface SseEvent {
  id?: string;
  event?: string;
  data: string;
}

/** Parse a Server-Sent Events body. Comments (keepalives) are skipped; an empty `data:` priming event is yielded with data "". */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const end = buffer.search(/\r?\n\r?\n/);
        if (end < 0) break;
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
        const event: SseEvent = { data: "" };
        let sawField = false;
        for (const line of block.split(/\r?\n/)) {
          if (!line || line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          sawField = true;
          if (field === "id") event.id = value;
          else if (field === "event") event.event = value;
          else if (field === "data") event.data += (event.data ? "\n" : "") + value;
        }
        if (sawField) yield event;
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

export interface ClientOptions {
  url: string;
  token?: string;
  workspaceId?: string;
  protocolVersion?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

export interface StreamHandle {
  response: Response;
  /** Raw events in order, including the empty priming event that carries the first resumable id. */
  events: AsyncGenerator<SseEvent>;
  /** Parsed JSON-RPC messages, one per event; the priming event is skipped. */
  messages: AsyncGenerator<{ id?: string; message: Rpc & { method?: string; params?: any } }>;
  /** Every event id seen so far, in order, including the priming event. */
  eventIds: string[];
  abort(): void;
}

export class McpClient {
  readonly fetcher: typeof fetch;
  private nextId = 1;
  constructor(readonly options: ClientOptions) {
    this.fetcher = options.fetch ?? fetch;
  }

  headers(extra: Record<string, string> = {}, withAuth = true): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(withAuth && this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
      ...(this.options.workspaceId ? { "x-zenith-workspace": this.options.workspaceId } : {}),
      ...(this.options.protocolVersion ? { "mcp-protocol-version": this.options.protocolVersion } : {}),
      ...this.options.headers,
      ...extra,
    };
  }

  post(body: unknown, extra: Record<string, string> = {}, signal?: AbortSignal, withAuth = true): Promise<Response> {
    return this.fetcher(this.options.url, { method: "POST", headers: this.headers(extra, withAuth), body: JSON.stringify(body), redirect: "error", signal });
  }

  /** One JSON-RPC request answered as JSON. */
  async rpc(method: string, params?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; headers: Headers; body: Rpc }> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }, extra);
    const text = await response.text();
    let body: Rpc;
    try { body = JSON.parse(text) as Rpc; } catch { body = { error: { code: -1, message: text.slice(0, 200) } }; }
    return { status: response.status, headers: response.headers, body };
  }

  async initialize(protocolVersion: string): Promise<{ status: number; body: Rpc }> {
    const { status, body } = await this.rpc("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "zenith-conformance", version: "1" } });
    return { status, body };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ status: number; body: Rpc }> {
    const { status, body } = await this.rpc("tools/call", { name, arguments: args });
    return { status, body };
  }

  /** A streamed tools/call: progressToken + Accept text/event-stream. Resolves once response headers arrive. */
  async stream(name: string, args: Record<string, unknown>, progressToken: string | number = "conformance-progress"): Promise<StreamHandle & { requestId: number }> {
    const requestId = this.nextId++;
    const controller = new AbortController();
    const response = await this.post({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name, arguments: args, _meta: { progressToken } } }, {}, controller.signal);
    return { ...this.handle(response, controller), requestId };
  }

  /** Reconnect: GET + Last-Event-ID with the given (or the client's) token. */
  async resume(lastEventId: string, token: string | undefined = this.options.token): Promise<StreamHandle> {
    const controller = new AbortController();
    const response = await this.fetcher(this.options.url, {
      method: "GET", redirect: "error", signal: controller.signal,
      headers: { accept: "text/event-stream", "last-event-id": lastEventId, ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(this.options.workspaceId ? { "x-zenith-workspace": this.options.workspaceId } : {}),
        ...(this.options.protocolVersion ? { "mcp-protocol-version": this.options.protocolVersion } : {}) },
    });
    return this.handle(response, controller);
  }

  /** notifications/cancelled for a request id. */
  cancel(requestId: string | number, reason = "conformance cancel"): Promise<Response> {
    return this.post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId, reason } });
  }

  private handle(response: Response, controller: AbortController): StreamHandle {
    const eventIds: string[] = [];
    const sse = (response.headers.get("content-type") ?? "").includes("text/event-stream") && response.body ? response.body : undefined;
    async function* tap(): AsyncGenerator<SseEvent> {
      if (!sse) return;
      for await (const event of readSse(sse)) {
        if (event.id) eventIds.push(event.id);
        yield event;
      }
    }
    const events = tap();
    async function* messages(): AsyncGenerator<{ id?: string; message: any }> {
      for await (const event of events) {
        if (!event.data) continue;
        yield { id: event.id, message: JSON.parse(event.data) };
      }
    }
    return { response, events, messages: messages(), eventIds, abort: () => controller.abort() };
  }
}

/** Drain a stream until the JSON-RPC response (result or error) arrives, or the stream ends. */
export async function collect(handle: StreamHandle): Promise<{ progress: any[]; final?: Rpc; ids: string[] }> {
  const progress: any[] = [];
  let final: Rpc | undefined;
  for await (const { message } of handle.messages) {
    if ((message as any).method === "notifications/progress") progress.push((message as any).params);
    else if ((message as Rpc).result !== undefined || (message as Rpc).error !== undefined) { final = message as Rpc; break; }
  }
  handle.abort();
  return { progress, final, ids: handle.eventIds };
}

export const toolResult = (rpc: Rpc | undefined): any => rpc?.result?.structuredContent;
