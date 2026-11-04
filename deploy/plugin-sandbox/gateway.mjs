/** Trusted API-only Unix-socket gateway. The untrusted process has no IP NIC.
 * This process has one configured HTTPS origin and never accepts target URLs,
 * credential/store routes, caller authentication headers, or arbitrary RPC. */
import { createServer } from "node:http";
import { chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapInput } from "./runner.mjs";

const MCP_PATH = "/api/agent/v3/mcp";
const CHECK_PATH = "/api/integrations/plugins/launch/check";
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function allowRpc(message, lease) {
  if (!object(message) || message.jsonrpc !== "2.0" ||
      Object.keys(message).some((key) => !["jsonrpc", "id", "method", "params"].includes(key)) ||
      (message.id !== undefined && typeof message.id !== "string" && !Number.isSafeInteger(message.id))) return false;
  if (message.method === "tools/call") {
    const args = message.params?.arguments;
    const target = object(args?.target) ? args.target : args;
    return object(message.params) && Object.keys(message.params).every((key) => ["name", "arguments"].includes(key)) &&
      lease.tools.includes(message.params.name) && object(args) && object(target) && target.workspaceId === lease.workspaceId &&
      (target.projectId === undefined || lease.projectIds.includes(target.projectId)) &&
      (target.environmentId === undefined || lease.environmentIds.includes(target.environmentId));
  }
  if (message.method === "tools/list" || message.method === "ping") return message.params === undefined || (object(message.params) && !Object.keys(message.params).length);
  if (message.method === "initialize") return object(message.params) && Object.keys(message.params).every((key) => ["protocolVersion", "capabilities", "clientInfo"].includes(key));
  return message.method === "notifications/initialized" && message.id === undefined && message.params === undefined;
}

export function sameLease(value, lease) {
  if (!object(value) || Object.keys(value).sort().join() !== Object.keys(lease).sort().join()) return false;
  return Object.keys(lease).every((key) => JSON.stringify(value[key]) === JSON.stringify(lease[key])) && Date.parse(value.expiresAt) > Date.now();
}

export async function boundedResponse(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  let size = 0; const chunks = [];
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > limit) throw new Error("response_too_large");
      chunks.push(part.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

export async function checkAuthority(input, fetcher = fetch) {
  const response = await fetcher(new URL(CHECK_PATH, input.apiOrigin), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(3000),
    headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" }, body: JSON.stringify(input.binding),
  });
  if (!response.ok || !sameLease(JSON.parse((await boundedResponse(response, 16_384)).toString()), input.lease)) throw new Error("launch_authority_refused");
}

export function gatewayHandler(input, fetcher = fetch, lostAuthority = () => {}) {
  let active = 0;
  return async (request, response) => {
    const refuse = (status) => { if (!response.headersSent) response.writeHead(status, { "content-type": "application/json" }); response.end('{"error":"plugin_gateway_refused"}'); };
    if (++active > 4) { active--; refuse(429); request.resume(); return; }
    try {
      if (request.method !== "POST" || request.url !== MCP_PATH || !/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? "") ||
          request.headers.authorization || request.headers.cookie || request.headers.upgrade) { refuse(403); request.resume(); return; }
      request.setTimeout(3000, () => request.destroy());
      let size = 0; const chunks = [];
      for await (const chunk of request) { size += chunk.length; if (size > 65_536) throw new Error(); chunks.push(chunk); }
      const message = JSON.parse(Buffer.concat(chunks).toString());
      if (!allowRpc(message, input.lease)) { refuse(403); return; }
      try { await checkAuthority(input, fetcher); } catch { lostAuthority(); refuse(401); return; }
      const upstream = await fetcher(new URL(MCP_PATH, input.apiOrigin), {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json", accept: "application/json, text/event-stream",
          "x-zenith-workspace": input.lease.workspaceId, "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify(message),
      });
      if ([401, 403].includes(upstream.status)) { lostAuthority(); refuse(upstream.status); return; }
      const bytes = await boundedResponse(upstream, 1024 * 1024);
      if (upstream.status === 202 || upstream.status === 204) { response.writeHead(upstream.status); response.end(); return; }
      if (!/^application\/json(?:;|$)/i.test(upstream.headers.get("content-type") ?? "")) throw new Error();
      const result = JSON.parse(bytes.toString());
      if (message.method === "tools/list" && object(result.result) && Array.isArray(result.result.tools)) {
        result.result.tools = result.result.tools.filter((tool) => object(tool) && input.lease.tools.includes(tool.name));
      }
      response.writeHead(upstream.status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(result));
    } catch { refuse(400); }
    finally { active--; }
  };
}

async function main() {
  if (!process.versions.node.startsWith("22.")) throw new Error("node22_required");
  const input = await bootstrapInput();
  const url = new URL(input.apiOrigin);
  if (url.protocol !== "https:" || url.origin !== input.apiOrigin || input.binding.audience !== `${input.apiOrigin}${MCP_PATH}` ||
      input.lease.credentialKind !== "plugin_scoped_za") throw new Error();
  await checkAuthority(input);
  const stop = () => { server.closeAllConnections(); server.close(); clearInterval(timer); process.exitCode = 1; };
  const server = createServer(gatewayHandler(input, fetch, stop));
  server.maxConnections = 8;
  server.requestTimeout = 3000; server.headersTimeout = 3000;
  await new Promise((done, reject) => { server.once("error", reject); server.listen("/channel/api.sock", done); });
  await chmod("/channel/api.sock", 0o600);
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void checkAuthority(input).catch(stop).finally(() => { checking = false; });
  }, 1000);
  process.stdout.write('{"event":"ready"}\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => { process.stderr.write("plugin_gateway_refused\n"); process.exitCode = 1; });
}
