/** Stateless Streamable HTTP in JSON response mode. Every request and tool call
 * verifies its bearer live. Catalog hints are informational; strict zod inputs,
 * grant restrictions and the shared capability broker enforce authority. */
import { createMcpHandler, fromJsonSchema, isLegacyRequest, McpServer, WebStandardStreamableHTTPServerTransport, type JsonSchemaType } from "@modelcontextprotocol/server";
import { boundedBody } from "../control/boundary";
import { authenticateMcp, authenticationChallengeFor, resourceFor } from "./auth";
import { catalogFor, toolMeta } from "./catalog";
import { INTEGRATION_SCOPES, SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION } from "./contract";
import { buildErrorEnvelope, toCallToolResult } from "./envelope";
import { mapError, McpToolError } from "./errors";
import { toolAllowedFor } from "./principal";
import type { McpRuntime } from "./runtime";
import { runTool } from "./tools";
import { scrubMcpValue } from "./redaction";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

export function failure(error: unknown, origin?: string): Response {
  const mapped = mapError(error);
  const response = json({ error: scrubMcpValue(mapped.body) }, mapped.status);
  if (mapped.status === 401 && origin) {
    response.headers.set("www-authenticate", authenticationChallengeFor(origin));
  }
  return response;
}

export async function handleMcp(request: Request, runtime: McpRuntime): Promise<Response> {
  let origin: string | undefined;
  try {
    origin = runtime.auth.checkOrigin(request);
    if (request.method === "GET" && new URL(request.url).searchParams.get("metadata") === "oauth-protected-resource") {
      const config = runtime.auth.oauth.config(origin) as { issuer?: unknown } | undefined;
      if (!config || typeof config.issuer !== "string") throw new McpToolError("oauth_unavailable", "OAuth is not configured on this deployment.", 503);
      return json({ resource: resourceFor(origin), authorization_servers: [config.issuer],
        scopes_supported: INTEGRATION_SCOPES.map((s) => `zenith:${s}`), bearer_methods_supported: ["header"], resource_name: "Zenith control v3" });
    }
    await runtime.requireEnabled();
    const auth = await authenticateMcp(request, runtime.auth);
    await runtime.throttle(auth.principal.identity);
    const factory = () => {
      const mcp = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
      for (const tool of catalogFor(auth.principal.scopes).filter((t) => toolAllowedFor(auth.principal, t.name))) {
        const rendered = fromJsonSchema<Record<string, unknown>>(tool.inputSchema as JsonSchemaType);
        // Advertise the exact schema, but validate in runTool with strict zod.
        // SDK pre-validation errors are bare text and can echo external keys;
        // every tool refusal must instead use our redacted, labelled envelope.
        const inputSchema = { ...rendered, "~standard": { ...rendered["~standard"],
          validate: (args: unknown) => ({ value: args as Record<string, unknown> }) } };
        mcp.registerTool(tool.name, { title: tool.title, description: tool.description,
          inputSchema,
          annotations: tool.annotations, _meta: { zenith: toolMeta(tool) } }, async (args, context) => {
          try {
            context.mcpReq.signal.throwIfAborted();
            await runtime.requireEnabled();
            const current = await authenticateMcp(request, runtime.auth);
            return toCallToolResult(await runTool(tool.name, args, { principal: current.principal, ports: runtime.ports, signal: context.mcpReq.signal }));
          } catch (error) {
            return toCallToolResult(buildErrorEnvelope(tool, mapError(error).body));
          }
        });
      }
      return mcp;
    };
    const bytes = request.method === "POST" ? await boundedBody(request) : undefined;
    const input = bytes ? new Request(request.url, { method: request.method, headers: request.headers, body: bytes as BodyInit, signal: request.signal }) : request;
    let response: Response;
    if (await isLegacyRequest(input)) {
      // SDK 2.0's createMcpHandler does not forward responseMode to its 2025
      // fallback. Use its public stateless transport with JSON explicitly
      // enabled, sharing exactly the same authenticated factory and handlers.
      if (input.method !== "POST") return json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed." } }, 405);
      const mcp = factory();
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const abort = () => { void mcp.close().catch(() => undefined); };
      input.signal.addEventListener("abort", abort, { once: true });
      try {
        await mcp.connect(transport);
        response = await transport.handleRequest(input);
      } finally {
        input.signal.removeEventListener("abort", abort);
        await mcp.close();
      }
    } else {
      const server = createMcpHandler(factory, { responseMode: "json", maxSubscriptions: 0, legacy: "reject" });
      try { response = await server.fetch(input); }
      finally { await server.close(); }
    }
    response.headers.set("cache-control", "no-store");
    response.headers.set("x-content-type-options", "nosniff");
    return response;
  } catch (error) {
    return failure(error, origin);
  }
}
