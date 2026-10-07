/**
 * Client interoperability (PROD-UX-02): the full client journey over a REAL
 * HTTP socket, driven by the conformance client in scripts/agent/mcp-conformance
 * (the same code `npm run agent:conformance` aims at a deployment).
 *
 * Real: the v3 route handlers, the MCP SDK server transports, SSE framing over
 * node:http, the protected-resource metadata route, protocol negotiation, the
 * durable stream store (PGlite; ZENITH_TEST_PLATFORM_PG_URL for PostgreSQL),
 * cancellation through to the broker, the OAuth resource-server verification
 * (jose with a runtime-generated key) and the grant journal. Modeled, as in the
 * other v3 suites: the broker's product store, policy, cloud sessions,
 * workflows and the credential authority behind `za_` tokens.
 *
 * The official MCP SDK client (@modelcontextprotocol/client) is not installed
 * in this repository, so this file does not use it; see
 * docs/platform/CLIENT-INTEROP.md for running it and other real clients.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { tempDataDir } from "../_support/data-dir";
import { approve, argsFor, identity, ids, makeHarness, requireApproval, type Harness } from "./support";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import type { AuthDeps, OAuthLike } from "@/lib/agent-access/v3/auth";
import type { McpRuntime } from "@/lib/agent-access/v3/runtime";
import { sqlStreamPort } from "@/lib/agent-access/v3/stream";
import { AgentError } from "@/lib/agent-access/security";
import { bindGrant, verifyOAuth, type OAuthConfig, type VerifiedOAuth } from "@/lib/agent-access/control/oauth";
import { Journal, type Principal } from "@/lib/agent-access/control/journal";
import { revokeToken, type RevokeDeps } from "@/lib/agent-access/oauth/revoke";
import { McpClient, collect, toolResult } from "../../scripts/agent/mcp-conformance/client";
import { runJourney, STEPS, type JourneyConfig, type StepResult } from "../../scripts/agent/mcp-conformance/journey";

tempDataDir("zenith-mcp-v3-conformance-", { fast: true });
const updateSession = vi.hoisted(() => vi.fn(async () => new NextResponse(null, { status: 599 })));
vi.mock("@/lib/supabase/middleware", () => ({ updateSession }));
const { checkRequestOrigin } = await import("@/lib/agent-access/control/boundary");
const { setMcpRuntimeForTests } = await import("@/lib/agent-access/v3/runtime");
const mcpRoute = await import("@/app/api/agent/v3/mcp/route");
const prmRoute = await import("@/app/.well-known/oauth-protected-resource/api/agent/v3/mcp/route");
const { middleware } = await import("@/middleware");

const ISSUER = "https://issuer.example.test/tenant";
const ZA = "za_" + "Q".repeat(43);
const ZA_OTHER = "za_" + "R".repeat(43);
const ZA_WRITE = "za_" + "W".repeat(43);

/* ------------------------------ loopback server ----------------------------- */

interface Live { origin: string; close(): Promise<void> }
async function listen(handlers: { revoke: (request: Request) => Promise<Response> }): Promise<Live> {
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    const bodyless = ["GET", "HEAD"].includes(req.method ?? "GET");
    const request = new Request(url, { method: req.method, headers: req.headers as Record<string, string>, ...(bodyless ? {} : { body: Buffer.concat(chunks) }), signal: controller.signal });
    let response: Response;
    try {
      if (url.pathname === "/api/agent/v3/mcp") response = await (req.method === "GET" ? mcpRoute.GET(request) : req.method === "DELETE" ? mcpRoute.DELETE(request) : mcpRoute.POST(request));
      else if (url.pathname === "/.well-known/oauth-protected-resource/api/agent/v3/mcp") response = prmRoute.GET(request);
      else if (url.pathname === "/api/agent/oauth/revoke") response = await handlers.revoke(request);
      else response = new Response("not found", { status: 404 });
    } catch (error) { response = new Response(String(error), { status: 500 }); }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.flushHeaders();
    if (!response.body) { res.end(); return; }
    const reader = response.body.getReader();
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(value); } } catch { /* the client went away */ }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

const opened: PlatformDbHandle[] = [];
const PG_URL = process.env.ZENITH_TEST_PLATFORM_PG_URL?.trim() || undefined;
afterAll(async () => { for (const db of opened) await db.close(); });
async function streamsPort() {
  const db = await (PG_URL ? openPlatformDb({ kind: "postgres", url: PG_URL, migrate: true, max: 3 }) : openPlatformDb({ kind: "pglite" }));
  opened.push(db);
  return sqlStreamPort(async () => db);
}

const summarize = (results: StepResult[]) => results.map((r) => `${r.status.toUpperCase()} ${r.id}: ${r.detail}`).join("\n");
/** Every step of the journey ran; all passed except the named skips. */
function expectJourney(results: StepResult[], skipped: string[] = []) {
  expect(results.filter((r) => r.status === "fail"), summarize(results)).toEqual([]);
  expect(results.filter((r) => r.status === "skip").map((r) => r.id).sort(), summarize(results)).toEqual([...skipped].sort());
  expect(results.map((r) => r.id)).toEqual(STEPS.map((s) => s.id));
}
const topology = { name: "zenith_get_topology", arguments: argsFor("zenith_get_topology") };

/**
 * Run the journey one step at a time so a single call can be held open exactly
 * for the cancel step: `arm()` makes the NEXT broker read wait for `gate`.
 */
async function runInOrder(base: JourneyConfig, h: Harness): Promise<StepResult[]> {
  const gate = Promise.withResolvers<void>();
  const impl = h.authorizeRead.getMockImplementation()!;
  let armed = false;
  h.authorizeRead.mockImplementation(async (...args) => { if (armed) { armed = false; await gate.promise; } return impl(...args); });
  const results: StepResult[] = [];
  for (const step of STEPS) {
    if (step.id === "cancel") armed = true;
    results.push(...await runJourney({ ...base, only: [step.id] }));
    if (step.id === "cancel") { armed = false; gate.resolve(); }
  }
  return results;
}

beforeEach(() => { vi.stubEnv("VERCEL", undefined); vi.stubEnv("ZENITH_SERVERLESS", undefined); updateSession.mockClear(); });
afterEach(() => { setMcpRuntimeForTests(null); vi.unstubAllEnvs(); });

/* ------------------------- leg 1: linked credential (za_) ------------------------- */

describe("journey with a linked credential", () => {
  let h: Harness;
  let live: Live;
  let revoked: Set<string>;
  let runtime: McpRuntime;
  const tokenFor = (id: string) => (id === ids.integration ? ZA : id === "int-other" ? ZA_OTHER : ZA_WRITE);

  beforeEach(async () => {
    h = await makeHarness();
    revoked = new Set();
    const verify = async (header: string | null) => {
      const token = header?.slice(7) ?? "";
      if (revoked.has(token)) throw new AgentError("unauthorized", "The connection was revoked.", 401);
      const who = token === ZA ? identity({ scopes: ["read", "plan", "logs"] })
        : token === ZA_OTHER ? identity({ integrationId: "int-other", scopes: ["read"] })
        : token === ZA_WRITE ? identity({ integrationId: "int-write", scopes: ["read", "plan", "logs", "write"] }) : undefined;
      if (!who) throw new AgentError("unauthorized", "Not a credential.", 401);
      return { ...who, id: who.integrationId };
    };
    // the modeled broker knows this integration as the same member and grant as ids.integration
    h.world.integrations.set(`${ids.ws}|int-write`, { subject: "bob", scopes: ["read", "plan", "logs", "write"], projectIds: [ids.project], environmentIds: [ids.env] });
    const auth: AuthDeps = { checkOrigin: checkRequestOrigin, now: Date.now,
      authority: async () => ({ kind: "postgres", verify, touch: async () => {} }),
      oauth: { config: () => undefined, verify: async () => { throw new Error("none"); }, bind: async () => identity() } };
    runtime = { auth, ports: h.ports, requireEnabled: async () => {}, throttle: async () => {}, streams: await streamsPort() };
    setMcpRuntimeForTests(runtime);
    const revokeDeps: RevokeDeps = {
      checkOrigin: checkRequestOrigin, limit: async () => undefined,
      authority: async () => ({ verify: async (header) => { const who = await verify(header); return { id: who.id, subject: who.subject, workspaceId: who.workspaceId }; },
        revokeCredential: async (_subject, _workspace, id) => { revoked.add(tokenFor(id)); return true; } }),
      oauth: { config: () => undefined, verify: async () => { throw new Error("none"); }, revokeGrant: async () => false },
      resources: (origin) => [`${origin}/api/agent/v3/mcp`],
    };
    live = await listen({ revoke: (request) => revokeToken(request, revokeDeps) });
    vi.stubEnv("ZENITH_AGENT_ORIGIN", live.origin);
    vi.stubEnv("ZENITH_AGENT_OAUTH_ISSUER", ISSUER);
    vi.stubEnv("ZENITH_AGENT_OAUTH_JWKS", "https://issuer.example.test/keys");
  });
  afterEach(async () => { await live.close(); });

  const config = (over: Partial<JourneyConfig> = {}): JourneyConfig => ({
    baseUrl: live.origin, token: ZA, readTool: topology, expectedScopes: ["read", "plan", "logs"], expectedIssuer: ISSUER,
    foreignPrincipalToken: ZA_OTHER, slowTool: topology, revoke: {}, ...over });
  const client = (token = ZA) => new McpClient({ url: `${live.origin}/api/agent/v3/mcp`, token, protocolVersion: "2025-11-25" });

  it("runs every journey step over HTTP; only the audience step needs an OAuth token", async () => {
    const propose = vi.spyOn(h.broker, "propose");
    expectJourney(await runInOrder(config(), h), ["audience"]);
    expect(propose).not.toHaveBeenCalled();
    expect(revoked.has(ZA)).toBe(true);
  });

  it("a dropped connection is not a cancellation: the held call finishes and the resumed stream delivers its result", async () => {
    const gate = Promise.withResolvers<void>();
    const impl = h.authorizeRead.getMockImplementation()!;
    h.authorizeRead.mockImplementationOnce(async (...args) => { await gate.promise; return impl(...args); });
    const c = client();
    const call = await c.stream("zenith_get_topology", argsFor("zenith_get_topology"), "drop");
    const priming = (await call.events.next()).value!;
    call.abort(); // the network drops while the tool is still running
    const pending = collect(await c.resume(priming.id!));
    await new Promise((resolve) => setTimeout(resolve, 150));
    gate.resolve();
    const { final } = await pending;
    expect(toolResult(final)?.ok).toBe(true);
    expect(final?.id).toBe(call.requestId);
    expect(h.authorizeRead).toHaveBeenCalledTimes(1); // it ran once; resuming did not execute it again
  });

  it("explicit cancellation of a propose call withdraws the proposal that call recorded", async () => {
    const gate = Promise.withResolvers<void>();
    const realPropose = h.propose.getMockImplementation()!;
    h.propose.mockImplementationOnce(async (...args) => { const result = await realPropose(...args); await gate.promise; return result; });
    const c = client();
    const call = await c.stream("zenith_plan_change", argsFor("zenith_plan_change"), "cancel-propose");
    await call.events.next();
    await vi.waitFor(() => expect(h.propose).toHaveBeenCalledTimes(1));
    expect((await c.cancel(call.requestId)).status).toBe(202);
    gate.resolve();
    const { final } = await collect(call);
    expect(toolResult(final)?.error?.code).toBe("request_cancelled");
    const proposed = await h.propose.mock.results[0].value;
    const detail = await h.broker.getOperationDetail({ workspaceId: ids.ws, operationId: proposed.operation.id, principal: h.principal.principal });
    expect(detail.operation.status).toBe("cancelled");
  });

  it("a cancel recorded by ANOTHER instance reaches a streamed call through the database", async () => {
    const gate = Promise.withResolvers<void>();
    const impl = h.authorizeRead.getMockImplementation()!;
    h.authorizeRead.mockImplementationOnce(async (...args) => { await gate.promise; return impl(...args); });
    const c = client();
    const call = await c.stream("zenith_get_topology", argsFor("zenith_get_topology"), "durable-cancel");
    await call.events.next();
    // Another process has no in-memory registry entry for this request: only the durable flag can stop it.
    const who = identity({ scopes: ["read", "plan", "logs"] });
    expect(await runtime.streams!.requestCancel(identity({ integrationId: "int-other" }), String(call.requestId))).toBe(0);
    expect(await runtime.streams!.requestCancel(who, String(call.requestId))).toBe(1);
    const { final } = await collect(call);
    gate.resolve();
    expect(toolResult(final)?.error?.code).toBe("request_cancelled");
  });

  it("a cancelled execute stops BEFORE the claim: nothing started, no approval consumed", async () => {
    h.setDecision(() => requireApproval());
    const write = client(ZA_WRITE);
    const proposed = await write.callTool("zenith_prepare_deploy", argsFor("zenith_prepare_deploy"));
    const envelope = toolResult(proposed.body);
    expect(envelope.ok, JSON.stringify(envelope.error)).toBe(true);
    const operationId = envelope.data.operationId as string;
    await approve(h, operationId, envelope.data.proposalDigest as string);
    const gate = Promise.withResolvers<void>();
    h.ports.workflows.available = vi.fn(async () => { await gate.promise; return { available: true as const }; });
    const call = await write.stream("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", operationId, envelope.data.proposalDigest as string), "cancel-execute");
    await call.events.next();
    await vi.waitFor(() => expect(h.ports.workflows.available).toHaveBeenCalledTimes(1));
    expect((await write.cancel(call.requestId)).status).toBe(202);
    gate.resolve();
    const { final } = await collect(call);
    expect(toolResult(final)?.error?.code).toBe("request_cancelled");
    expect(h.beginExecution).not.toHaveBeenCalled();
    expect(h.starts.deploy).toHaveLength(0);
    // the approval is still usable: executing again (not cancelled) starts it
    h.ports.workflows.available = vi.fn(async () => ({ available: true as const }));
    const again = await write.callTool("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation", operationId, envelope.data.proposalDigest as string));
    expect(toolResult(again.body)?.ok, JSON.stringify(toolResult(again.body)?.error)).toBe(true);
    expect(h.starts.deploy).toHaveLength(1);
  });

  it("answers the protocol edge cases a real client can hit", async () => {
    const url = `${live.origin}/api/agent/v3/mcp`;
    const headers = { authorization: `Bearer ${ZA}`, accept: "text/event-stream" };
    // no standalone notification stream is offered
    const standalone = await fetch(url, { headers });
    expect(standalone.status).not.toBe(200);
    expect(standalone.headers.get("content-type") ?? "").not.toContain("event-stream");
    // an unsupported version header on a resume is refused before any lookup
    expect((await fetch(url, { headers: { ...headers, "last-event-id": `${"a".repeat(32)}.1`, "mcp-protocol-version": "2024-11-05" } })).status).toBe(400);
    // a resume must accept event streams
    expect((await fetch(url, { headers: { authorization: `Bearer ${ZA}`, accept: "application/json", "last-event-id": `${"a".repeat(32)}.1` } })).status).toBe(406);
    // without durable streams the server refuses to pretend to resume ...
    runtime.streams = undefined;
    expect((await fetch(url, { headers: { ...headers, "last-event-id": `${"a".repeat(32)}.1` } })).status).toBe(501);
    // ... and a progressToken call then falls back to bounded JSON instead of a stream it could not resume
    const json = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${ZA}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "zenith_get_topology", arguments: argsFor("zenith_get_topology"), _meta: { progressToken: "p" } } }) });
    expect(json.headers.get("content-type")).toContain("application/json");
    expect(toolResult(await json.json())?.ok).toBe(true);
  });

  it("a default call (no progressToken) stays bounded JSON even when the client accepts event streams", async () => {
    const { status, headers, body } = await client().rpc("tools/call", { name: "zenith_get_topology", arguments: argsFor("zenith_get_topology") });
    expect(status).toBe(200);
    expect(headers.get("content-type")).toContain("application/json");
    expect(headers.has("mcp-session-id")).toBe(false);
    expect(toolResult(body)?.ok).toBe(true);
  });

  it("a 2026-07-28 call with a progressToken is served and its progress is not resumable by id", async () => {
    const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, progressToken: "modern" };
    const response = await client().post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "zenith_get_topology", arguments: argsFor("zenith_get_topology"), _meta: meta } },
      { "mcp-method": "tools/call", "mcp-name": "zenith_get_topology", "mcp-protocol-version": "2026-07-28" });
    expect(response.status).toBe(200);
    const text = await response.text();
    const frames = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean);
    const final = response.headers.get("content-type")?.includes("text/event-stream")
      ? JSON.parse(frames.filter((frame) => frame.includes('"result"')).at(-1)!) : JSON.parse(text);
    expect(toolResult(final)?.ok).toBe(true);
    expect(text).not.toMatch(/^id: [0-9a-f]{32}\./m);
  });
});

/* -------------------------- leg 2: OAuth access token -------------------------- */

describe("journey with an OAuth access token", () => {
  let live: Live;
  let journal: Journal;
  let pair: Awaited<ReturnType<typeof generateKeyPair>>;
  let keys: ReturnType<typeof createLocalJWKSet>;
  let h: Harness;
  beforeAll(async () => {
    pair = await generateKeyPair("ES256");
    keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "fixture", alg: "ES256" }] });
  });
  const mint = (aud: string, over: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sub: "bob", iss: ISSUER, aud, iat: now, exp: now + 300, client_id: "claude-code", scope: "zenith:read zenith:plan zenith:logs", ...over })
      .setProtectedHeader({ alg: "ES256", kid: "fixture", typ: "at+jwt" }).sign(pair.privateKey);
  };

  beforeEach(async () => {
    h = await makeHarness();
    journal = new Journal(":memory:");
    const grant: Principal & { clientId: string } = { subject: "bob", integrationId: ids.integration, workspaceId: ids.ws, projectIds: [ids.project], environmentIds: [ids.env],
      scopes: ["read", "plan", "logs"], expiresAt: new Date(Date.now() + 3_600_000).toISOString(), clientId: "claude-code", oauthIssuer: ISSUER };
    journal.setGrant(grant);
    journal.setGrant({ ...grant, subject: "carol", integrationId: "integration-carol", clientId: "other-client" });
    const configFor = (origin: string): OAuthConfig => ({ issuer: ISSUER, jwksUrl: "https://issuer.example.test/keys", resource: `${origin}/api/agent/v3/mcp`, clientClaim: "client_id" });
    const oauth: OAuthLike<OAuthConfig, VerifiedOAuth> = { config: configFor, verify: (token, c) => verifyOAuth(token, c, keys), bind: async (verified, workspaceId) => bindGrant(verified, journal.getGrant(verified.subject, verified.clientId, workspaceId)) };
    const auth: AuthDeps = { checkOrigin: checkRequestOrigin, now: Date.now,
      authority: async () => { throw new Error("A linked credential is not used on this leg."); }, oauth };
    setMcpRuntimeForTests({ auth, ports: h.ports, requireEnabled: async () => {}, throttle: async () => {}, streams: await streamsPort() });
    const revokeDeps: RevokeDeps = {
      checkOrigin: checkRequestOrigin, limit: async () => undefined,
      authority: async () => { throw new Error("unused"); },
      oauth: { config: configFor, verify: (token, c) => verifyOAuth(token, c, keys),
        revokeGrant: async (identity, workspaceId) => { const stored = journal.getGrant(identity.subject, identity.clientId, workspaceId); if (!stored || stored.oauthIssuer !== identity.issuer) return false; journal.setGrant({ ...stored, revoked: true }); return true; } },
      resources: (origin) => [`${origin}/api/agent/v3/mcp`, `${origin}/api/agent/v2/mcp`],
    };
    live = await listen({ revoke: (request) => revokeToken(request, revokeDeps) });
    vi.stubEnv("ZENITH_AGENT_ORIGIN", live.origin);
    vi.stubEnv("ZENITH_AGENT_OAUTH_ISSUER", ISSUER);
    vi.stubEnv("ZENITH_AGENT_OAUTH_JWKS", "https://issuer.example.test/keys");
  });
  afterEach(async () => { await live.close(); journal.close(); });

  it("completes the whole journey: exact issuer and audience, scopes, streaming, resume, cancel, audience refusal and grant revocation", async () => {
    const v3 = `${live.origin}/api/agent/v3/mcp`;
    const propose = vi.spyOn(h.broker, "propose");
    const results = await runInOrder({
      baseUrl: live.origin, token: await mint(v3), workspaceId: ids.ws, readTool: topology, expectedScopes: ["read", "plan", "logs"], expectedIssuer: ISSUER, slowTool: topology,
      foreignAudienceToken: await mint(`${live.origin}/api/agent/v2/mcp`), revoke: {},
      foreignPrincipalToken: await mint(v3, { sub: "carol", client_id: "other-client" }),
    }, h);
    expectJourney(results);
    expect(propose).not.toHaveBeenCalled();
    // the Zenith grant is revoked: the same client cannot come back with a fresh token
    const { status, body } = await new McpClient({ url: v3, token: await mint(v3), workspaceId: ids.ws }).rpc("tools/list");
    expect(status).toBe(403);
    expect((body as { error?: { code?: string } }).error?.code).toBe("integration_grant_required");
  });

  it("refuses a token for another resource, issuer or key, an expired token, a missing grant and a missing workspace", async () => {
    const v3 = `${live.origin}/api/agent/v3/mcp`;
    const call = async (token: string, workspaceId: string | null = ids.ws) => {
      const { status, body } = await new McpClient({ url: v3, token, workspaceId: workspaceId ?? undefined }).rpc("tools/list");
      return { status, code: (body as { error?: { code?: string } }).error?.code };
    };
    const now = Math.floor(Date.now() / 1000);
    expect(await call(await mint(v3))).toEqual({ status: 200, code: undefined });
    expect(await call(await mint(`${live.origin}/api/agent/v2/mcp`))).toEqual({ status: 401, code: "invalid_token" });
    expect(await call(await mint("https://elsewhere.example.test/mcp"))).toEqual({ status: 401, code: "invalid_token" });
    expect(await call(await mint(v3, { iss: "https://evil.example.test/tenant" }))).toEqual({ status: 401, code: "invalid_token" });
    expect(await call(await mint(v3, { exp: now - 10, iat: now - 60 }))).toEqual({ status: 401, code: "invalid_token" });
    expect(await call(await mint(v3, { client_id: "unknown-client" }))).toEqual({ status: 403, code: "integration_grant_required" });
    expect(await call(await mint(v3), "ws-other")).toEqual({ status: 403, code: "integration_grant_required" });
    expect(await call(await mint(v3), null)).toEqual({ status: 400, code: "scope_required" });
    // only scopes in BOTH the token and the grant are served
    const names = ((await new McpClient({ url: v3, token: await mint(v3, { scope: "zenith:read" }), workspaceId: ids.ws }).rpc("tools/list")).body.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain("zenith_get_topology");
    expect(names).not.toContain("zenith_plan_change");
  });
});

/* ------------------------------ routing and bypass ------------------------------ */

describe("edge routing", () => {
  const ORIGIN = "https://zenith.example.test";
  it("the revoke endpoint is on the cookie-middleware bypass list, exactly", async () => {
    expect((await middleware(new NextRequest(`${ORIGIN}/api/agent/oauth/revoke`))).headers.get("x-middleware-next")).toBe("1");
    expect(updateSession).not.toHaveBeenCalled();
    for (const path of ["/api/agent/oauth/revoke/", "/api/agent/oauth/revoke/x", "/api/agent/oauth"]) expect((await middleware(new NextRequest(`${ORIGIN}${path}`))).status).toBe(599);
  });

  it("the revoke route is wired to the default deps", async () => {
    const calls: string[] = [];
    vi.resetModules();
    vi.doMock("@/lib/agent-access/oauth/revoke-default", () => ({ defaultRevokeDeps: () => ({
      checkOrigin: () => ORIGIN, limit: async () => { calls.push("limit"); },
      authority: async () => ({ verify: async () => ({ id: "c", subject: "s", workspaceId: "w" }), revokeCredential: async () => { calls.push("revoke"); return true; } }),
      oauth: { config: () => undefined, verify: async () => { throw new Error("x"); }, revokeGrant: async () => false }, resources: () => [] }) }));
    const route = await import("@/app/api/agent/oauth/revoke/route");
    const response = await route.POST(new Request(`${ORIGIN}/api/agent/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: ZA }) }));
    expect(response.status).toBe(200);
    expect(calls).toEqual(["limit", "revoke"]);
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
    vi.doUnmock("@/lib/agent-access/oauth/revoke-default");
  });
});
