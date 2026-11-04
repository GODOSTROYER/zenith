/** Streamable HTTP for MCP v3. Every request and tool call verifies its bearer
 * live. Catalog hints are informational; strict zod inputs, grant restrictions
 * and the shared capability broker enforce authority.
 *
 * Reply shapes:
 *  - default: one bounded JSON response (stateless; what the Zenith plugin and
 *    most clients use);
 *  - a `tools/call` that sends `_meta.progressToken` and accepts
 *    `text/event-stream`: Server-Sent Events with progress, stored durably so
 *    `GET` + `Last-Event-ID` resumes it (see ./stream.ts);
 *  - `notifications/cancelled`: answered 202 and honoured through to the tool
 *    and broker (explicit cancel only; a dropped connection is not a cancel).
 *
 * Protocol versions are pinned in ./protocol.ts and an unsupported one is
 * refused with HTTP 400 / JSON-RPC -32602 listing what is supported. */
import { createMcpHandler, fromJsonSchema, isLegacyRequest, McpServer, WebStandardStreamableHTTPServerTransport, type JsonSchemaType } from "@modelcontextprotocol/server";
import { boundedBody } from "../control/boundary";
import { authenticateMcp, authenticationChallengeFor, resourceFor } from "./auth";
import { catalogFor, toolMeta } from "./catalog";
import { INTEGRATION_SCOPES, SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION } from "./contract";
import { buildErrorEnvelope, toCallToolResult } from "./envelope";
import { mapError, McpToolError, requestCancelled } from "./errors";
import { LEGACY_PROTOCOL_VERSIONS, checkProtocolVersion, versionRefusalResponse } from "./protocol";
import { toolAllowedFor } from "./principal";
import type { McpRuntime } from "./runtime";
import { cancelFlights, notFoundStream, type Flight, registerFlight, RequestEventStore, resumeStream, watchDurableCancel } from "./stream";
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

type Rpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };
const asObject = (value: unknown): Rpc | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rpc) : undefined);
const requestIdOf = (message: Rpc | undefined): string | undefined => (typeof message?.id === "string" || typeof message?.id === "number" ? String(message.id) : undefined);
const progressTokenOf = (message: Rpc | undefined): string | number | undefined => {
  const meta = message?.params?._meta;
  const token = typeof meta === "object" && meta !== null ? (meta as { progressToken?: unknown }).progressToken : undefined;
  return typeof token === "string" || typeof token === "number" ? token : undefined;
};
const acceptsSse = (request: Request): boolean => (request.headers.get("accept") ?? "").includes("text/event-stream");

/** Hold a streamed body open, then release `close` when it ends or the client goes away. */
function closeAfterBody(response: Response, close: () => Promise<void>): Response {
  if (!response.body) { void close().catch(() => undefined); return response; }
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  void response.body.pipeTo(writable).catch(() => undefined).finally(() => { void close().catch(() => undefined); });
  return new Response(readable, { status: response.status, headers: response.headers });
}

export async function handleMcp(request: Request, runtime: McpRuntime): Promise<Response> {
  let origin: string | undefined;
  let flight: Flight | undefined;
  const releaseFlight = () => { flight?.done(); flight = undefined; };
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
    const identity = auth.principal.identity;

    // ---- resume: GET + Last-Event-ID, bound to the authenticated principal ----
    const headerVersion = request.headers.get("mcp-protocol-version");
    if (request.method === "GET" && request.headers.has("last-event-id")) {
      const refusal = checkProtocolVersion(headerVersion, undefined);
      if (refusal) return versionRefusalResponse(refusal);
      if (!runtime.streams) return json({ error: { code: "resume_unavailable", message: "Resumable streams are not enabled on this deployment. Repeat the request with the same idempotency key.", retryable: false } }, 501);
      if (!acceptsSse(request)) return json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Not Acceptable: Client must accept text/event-stream" } }, 406);
      const resumed = await resumeStream(runtime.streams, identity, request.headers.get("last-event-id"), request.signal);
      return resumed ?? notFoundStream();
    }

    const bytes = request.method === "POST" ? await boundedBody(request) : undefined;
    let parsed: unknown;
    if (bytes) { try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { parsed = undefined; } }
    const refusal = checkProtocolVersion(headerVersion, parsed);
    if (refusal) return versionRefusalResponse(refusal);

    const message = asObject(parsed);
    const requestId = requestIdOf(message);

    // ---- explicit client cancellation (notifications/cancelled) ----
    if (message?.method === "notifications/cancelled" && message.id === undefined) {
      const target = message.params?.requestId;
      if (typeof target === "string" || typeof target === "number") {
        cancelFlights(identity, String(target), requestCancelled());
        // Durable form, so a cancel that lands on another instance reaches a streamed request in flight.
        await runtime.streams?.requestCancel(identity, String(target)).catch(() => 0);
      }
      return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
    }

    const isToolCall = message?.method === "tools/call" && requestId !== undefined;
    const wantsProgress = isToolCall && progressTokenOf(message) !== undefined;
    flight = isToolCall ? registerFlight(identity, requestId!) : undefined;

    const factory = (modern: boolean) => {
      const mcp = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION },
        { instructions: SERVER_INSTRUCTIONS, supportedProtocolVersions: [...LEGACY_PROTOCOL_VERSIONS] });
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
          // Explicit cancellation: the registered flight (notifications/cancelled, durable or in-process) for the
          // 2025 era; the HTTP abort itself for the 2026 era, where closing the request IS the cancel.
          const explicit = modern ? context.mcpReq.signal : flight?.controller.signal;
          const signal = explicit && !modern ? AbortSignal.any([context.mcpReq.signal, explicit]) : context.mcpReq.signal;
          try {
            signal.throwIfAborted();
            await runtime.requireEnabled();
            const current = await authenticateMcp(request, runtime.auth);
            const token = context.mcpReq._meta?.progressToken;
            let step = 0;
            const progress = token === undefined ? undefined : async (note: string) => {
              step += 1;
              // Progress is a courtesy to the client; failing to send it never fails the call.
              try { await context.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress: step, message: note.slice(0, 200) } }); } catch { /* ignore */ }
            };
            await progress?.("authorized for this call");
            return toCallToolResult(await runTool(tool.name, args, { principal: current.principal, ports: runtime.ports, signal,
              ...(explicit ? { cancel: explicit } : {}), ...(progress ? { progress } : {}) }));
          } catch (error) {
            return toCallToolResult(buildErrorEnvelope(tool, mapError(signal.aborted && !(error instanceof McpToolError) ? requestCancelled() : error).body));
          }
        });
      }
      return mcp;
    };
    const input = bytes ? new Request(request.url, { method: request.method, headers: request.headers, body: bytes as BodyInit, signal: request.signal }) : request;
    let response: Response;
    if (await isLegacyRequest(input)) {
      // SDK 2.0's createMcpHandler does not forward responseMode to its 2025
      // fallback. Use its public stateless transport directly, sharing exactly
      // the same authenticated factory and handlers.
      if (input.method !== "POST") { releaseFlight(); return json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed." } }, 405); }
      const mcp = factory(false);
      const streamed = wantsProgress && acceptsSse(input) && runtime.streams !== undefined;
      if (!streamed) {
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, supportedProtocolVersions: [...LEGACY_PROTOCOL_VERSIONS] });
        // A JSON reply can no longer be delivered once the client is gone.
        const abort = () => { void mcp.close().catch(() => undefined); };
        input.signal.addEventListener("abort", abort, { once: true });
        try {
          await mcp.connect(transport);
          response = await transport.handleRequest(input);
        } finally {
          input.signal.removeEventListener("abort", abort);
          releaseFlight();
          await mcp.close();
        }
      } else {
        // Streamed + resumable. A dropped connection does NOT cancel (MCP spec); the
        // result is stored and the client resumes with Last-Event-ID.
        const streams = runtime.streams!;
        const activeFlight = flight!;
        let finished = false;
        let stopWatch: () => void = () => undefined;
        const finish = () => {
          if (finished) return;
          finished = true;
          stopWatch();
          releaseFlight();
          void mcp.close().catch(() => undefined);
        };
        const store = new RequestEventStore(streams, identity, requestId!, headerVersion ?? "2025-03-26", () => { setTimeout(finish, 1000).unref?.(); });
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: false, eventStore: store, retryInterval: 2000, supportedProtocolVersions: [...LEGACY_PROTOCOL_VERSIONS] });
        stopWatch = watchDurableCancel(streams, identity, () => store.durableStreamId, activeFlight.controller);
        setTimeout(finish, 55_000).unref?.();
        try {
          await mcp.connect(transport);
          // The SDK is handed a request WITHOUT the client connection's abort signal: a dropped connection
          // must not cancel the call (MCP spec); only notifications/cancelled does.
          response = await transport.handleRequest(new Request(request.url, { method: "POST", headers: request.headers, body: bytes as BodyInit }));
        } catch (error) { finish(); throw error; }
        if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) finish();
      }
    } else {
      // 2026-07-28: stateless per request; closing the HTTP request is the cancel, and a
      // retry with the same idempotency key is the reconnect. SSE only when progress was requested.
      const server = createMcpHandler(() => factory(true), { responseMode: wantsProgress ? "auto" : "json", maxSubscriptions: 0, legacy: "reject" });
      try { response = await server.fetch(input); }
      catch (error) { releaseFlight(); await server.close(); throw error; }
      releaseFlight();
      if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) response = closeAfterBody(response, () => server.close());
      else await server.close();
    }
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) response.headers.set("cache-control", "no-store");
    else response.headers.set("cache-control", "no-store, no-transform");
    response.headers.set("x-content-type-options", "nosniff");
    return response;
  } catch (error) {
    releaseFlight();
    return failure(error, origin);
  }
}
