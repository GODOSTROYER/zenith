/**
 * A minimal MCP client over streamable HTTP, for Demo H (a coding agent
 * connects to Zenith's MCP endpoint, inspects, proposes, waits for a human
 * approval and executes).
 *
 * It speaks just enough JSON-RPC 2.0: `initialize`, `notifications/initialized`,
 * `tools/list` and `tools/call`. The server answers in JSON mode
 * (`responseMode: "json"`); an `text/event-stream` answer is also accepted (the
 * first JSON `data:` event carrying the response id).
 *
 * Tool results and errors are DATA. A tool's text is never interpreted as an
 * instruction by the harness; it is recorded (redacted) and compared with what
 * the scenario expects.
 *
 * Not verified against a real endpoint: the v3 MCP server was unmerged when this
 * was written. Covered by tests against a fake JSON-RPC server only.
 */
import { redactCredentials, credentialPatternsIn, assertNoCredentialLeak } from "@/lib/credentials/redact";
import { parseApiUrl } from "../config";
import { responseText, removeToken } from "./response";
import { redactAcceptance } from "../redact";

export interface McpTool {
  name: string;
  description?: string;
}

export interface McpToolResult {
  isError: boolean;
  text: string;
  structured?: unknown;
  /** Pattern names only, captured BEFORE redaction; a leak cannot become a pass. */
  credentialPatterns?: string[];
}

export interface McpClient {
  describe(): { url: string; tokenSet: boolean };
  initialize(): Promise<{ serverName?: string; protocolVersion?: string }>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

export class McpError extends Error {
  readonly status?: number;
  readonly rpcCode?: number;
  constructor(message: string, extra: { status?: number; rpcCode?: number } = {}) {
    super(message);
    this.name = "McpError";
    this.status = extra.status;
    this.rpcCode = extra.rpcCode;
  }
}

const PROTOCOL_VERSION = "2025-06-18";

interface RpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

function parseBody(text: string, contentType: string, id: number): RpcResponse {
  if (contentType.includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        const msg = JSON.parse(line.slice(5).trim()) as RpcResponse;
        if (msg.id === id) return msg;
      } catch {
        /* keep scanning */
      }
    }
    throw new McpError("The MCP server's event stream carried no response for the request.");
  }
  try {
    const msg = JSON.parse(text) as RpcResponse;
    if (msg.jsonrpc !== "2.0" || msg.id !== id) throw new McpError("MCP JSON-RPC response id/version does not match the request.");
    return msg;
  } catch {
    throw new McpError("The MCP server did not return JSON.");
  }
}

export function createMcpClient(opts: { url: string; token?: string; fetch?: typeof fetch; timeoutMs?: number }): McpClient {
  const url = parseApiUrl(opts.url, "the MCP URL", { preservePath: true });
  if (!url) throw new McpError("The MCP URL is empty.");
  const endpoint = url;
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let nextId = 1;
  let sessionId: string | undefined;

  async function post(body: unknown, id?: number): Promise<RpcResponse | undefined> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      "user-agent": "zenith-live-acceptance",
    };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const res = await doFetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    const text = await responseText(res, 2 * 1024 * 1024);
    if (!res.ok) throw new McpError(`The MCP endpoint answered HTTP ${res.status}: ${redactCredentials(removeToken(text, opts.token)).slice(0, 200)}`, { status: res.status });
    if (id === undefined || text.trim() === "") return undefined;
    const msg = parseBody(text, res.headers.get("content-type") ?? "", id);
    if (msg.error) throw new McpError(redactCredentials(removeToken(msg.error.message ?? "MCP error", opts.token)).slice(0, 300), { rpcCode: msg.error.code });
    return msg;
  }

  async function rpc<T>(method: string, params: unknown): Promise<T> {
    const id = nextId++;
    const msg = await post({ jsonrpc: "2.0", id, method, params }, id);
    return (msg?.result ?? {}) as T;
  }

  return {
    describe: () => ({ url: endpoint, tokenSet: opts.token !== undefined }),
    async initialize() {
      const r = await rpc<{ serverInfo?: { name?: string }; protocolVersion?: string }>("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "zenith-live-acceptance", version: "1" },
      });
      assertNoCredentialLeak(r, { secrets: opts.token ? [opts.token] : [] });
      await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      return { serverName: r.serverInfo?.name, protocolVersion: r.protocolVersion };
    },
    async listTools() {
      const r = await rpc<{ tools?: { name?: unknown; description?: unknown }[] }>("tools/list", {});
      assertNoCredentialLeak(r, { secrets: opts.token ? [opts.token] : [] });
      return (r.tools ?? []).flatMap((t) => (typeof t.name === "string" ? [{ name: t.name, ...(typeof t.description === "string" ? { description: t.description.slice(0, 300) } : {}) }] : []));
    },
    async callTool(name, args) {
      const r = await rpc<{ isError?: boolean; content?: { type?: string; text?: string }[]; structuredContent?: unknown }>("tools/call", { name, arguments: args });
      const text = (r.content ?? []).map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : "")).join("\n");
      const raw = JSON.stringify(r);
      const credentialPatterns = credentialPatternsIn(raw);
      if (opts.token && raw.includes(opts.token)) credentialPatterns.push("configured-mcp-token");
      return { isError: r.isError === true, text: redactCredentials(removeToken(text, opts.token)).slice(0, 8_000), credentialPatterns, ...(r.structuredContent !== undefined ? { structured: redactAcceptance(r.structuredContent, opts.token ? [opts.token] : []) } : {}) };
    },
  };
}
