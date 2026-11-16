/** A loopback HTTP fixture, never a live Zenith or cloud service. */
import { createServer } from "node:http";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { once } from "node:events";
import { runCli } from "@/cli/main";
import type { CliRuntime } from "@/cli/main";
import { DATA_NOTE } from "@/cli/security";

export const TOKEN = "opaque-cli-fixture-credential-do-not-log";
export const DIGEST = "a".repeat(64);
export const scope = { workspaceId: "ws-cli", projectId: "project-cli", environmentId: "env-cli" };
export const operation = {
  id: "op-cli", workspaceId: scope.workspaceId, projectId: scope.projectId, environmentId: scope.environmentId,
  status: "approved", capability: "deployment.deploy", proposalDigest: DIGEST, updatedAt: "2026-10-01T00:00:00Z",
};
export const decision = { outcome: "allow" };
export function envelope(name = "zenith_get_operation", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { contractVersion: 3, schemaVersion: 1, tool: name, note: DATA_NOTE, ok: true, simulated: false,
    truncated: false, unavailable: [], notes: [], data: { operation }, ...extra };
}
export interface Recorded { method: string; url: string; headers: IncomingHttpHeaders; body?: Record<string, unknown> }
export type Responder = (request: Recorded, response: ServerResponse, count: number) => void | Promise<void>;

function defaultResponse(request: Recorded, response: ServerResponse): void {
  const path = new URL(request.url, "http://fixture").pathname;
  let result: unknown;
  if (path.endsWith("/mcp")) {
    const body = request.body!;
    const params = body.params as Record<string, unknown>;
    result = body.method === "initialize" ? { protocolVersion: "2025-06-18", serverInfo: { name: "zenith-control-v3", version: "fixture" }, capabilities: {} } :
      body.method === "tools/list" ? { tools: [{ name: "zenith_get_operation", description: "Inspect an operation", inputSchema: {}, annotations: { readOnlyHint: true } }] } :
        { structuredContent: envelope(String(params.name)), content: [] };
    reply(response, { jsonrpc: "2.0", id: body.id, result });
  } else {
    result = path.endsWith("/operations") ? { operations: [operation], nextCursor: "next-cli" } :
      path.endsWith("/events") ? { events: [{ seq: 1, id: "event-cli", ts: "2026-10-01T00:00:00Z", type: "operation.proposed", data: { message: "fixture" } }] } :
        path.endsWith("/cancel") ? { operation: { ...operation, status: "cancelled" } } :
          path.endsWith("/propose") ? { operation, decision, replayed: false } : path.endsWith("/check") ? { decision } : { operation, approvals: [] };
    reply(response, result, path.endsWith("/propose") ? 201 : 200);
  }
}
export function reply(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
}
export async function fixture(responder: Responder = defaultResponse) {
  const requests: Recorded[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const request: Recorded = { method: req.method!, url: req.url!, headers: req.headers, ...(raw ? { body: JSON.parse(raw) } : {}) };
    requests.push(request);
    try { await responder(request, res, requests.length); }
    catch { if (!res.destroyed) reply(res, { error: { code: "fixture_error", message: "The fixture handler failed." } }, 500); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture not listening");
  return { url: `http://127.0.0.1:${address.port}`, requests,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}
export async function invoke(url: string, args: string[], input = "", overrides: CliRuntime = {}) {
  const out: string[] = []; const err: string[] = [];
  const code = await runCli(args, { env: { ZENITH_URL: url, ZENITH_TOKEN: TOKEN, ZENITH_WORKSPACE: scope.workspaceId },
    stdin: (async function* () { yield input; })(), stdout: (text) => { out.push(text); }, stderr: (text) => { err.push(text); }, ...overrides });
  return { code, stdout: out.join(""), stderr: err.join("") };
}
