/** Official SDK 2.0 against the real in-process MCP server and PGlite streams.
 * OAuth signatures/issuer/audience and grant intersection are real. Product,
 * policy, workflows and linked credential authority use the existing harness.
 * No browser, cloud, Docker or TCP listener is used here. */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { bindGrant, verifyOAuth, type OAuthConfig, type VerifiedOAuth } from "@/lib/agent-access/control/oauth";
import { handleMcp } from "@/lib/agent-access/v3/server";
import type { AuthDeps, OAuthLike } from "@/lib/agent-access/v3/auth";
import { sqlStreamPort } from "@/lib/agent-access/v3/stream";
import type { McpRuntime } from "@/lib/agent-access/v3/runtime";
import { officialLeg, redactDetail, replay, type OfficialConfig } from "../../scripts/agent/mcp-conformance";
import { tempDataDir } from "../_support/data-dir";
import { argsFor, identity, ids, makeHarness, type Harness } from "./support";

tempDataDir("zenith-official-mcp-", { fast: true });
const origin = "https://zenith.example.test";
const issuer = "https://issuer.example.test/realms/zenith";
const resource = `${origin}/api/agent/v3/mcp`;
let db: PlatformDbHandle;
beforeAll(async () => { db = await openPlatformDb({ kind: "pglite" }); });
afterAll(async () => { await db.close(); });
afterEach(() => vi.restoreAllMocks());

describe("official MCP SDK conformance", () => {
  let h: Harness;
  let config: OfficialConfig;
  let runtime: McpRuntime;
  let requests: Request[];
  let revoked: boolean;
  let gate: ReturnType<typeof Promise.withResolvers<void>>;
  let gateSlowRead: boolean;
  let fetcher: typeof fetch;
  beforeEach(async () => {
    h = await makeHarness();
    gate = Promise.withResolvers<void>();
    revoked = false;
    requests = [];
    gateSlowRead = false;
    const realRead = h.authorizeRead.getMockImplementation()!;
    h.authorizeRead.mockImplementation(async (...args) => { if (gateSlowRead) { gateSlowRead = false; await gate.promise; } return realRead(...args); });
    const keys = await generateKeyPair("RS256");
    const key = createLocalJWKSet({ keys: [await exportJWK(keys.publicKey)] });
    const oauthConfig: OAuthConfig = { issuer, jwksUrl: `${issuer}/protocol/openid-connect/certs`, resource, clientClaim: "azp" };
    const mint = (aud = resource, iss = issuer, client = "interop-client") => new SignJWT({ scope: "zenith:read zenith:plan", azp: client })
      .setProtectedHeader({ alg: "RS256" }).setIssuer(iss).setAudience(aud).setSubject("bob")
      .setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
    const oauth: OAuthLike<OAuthConfig, VerifiedOAuth> = {
      config: () => oauthConfig, verify: (token, cfg) => verifyOAuth(token, cfg, key),
      bind: async (who) => {
        const other = who.clientId === "other-client";
        const base = identity({ integrationId: other ? "other-integration" : ids.integration, scopes: ["read"] });
        const grant = { ...base, projectIds: [...base.projectIds], scopes: [...base.scopes],
          environmentIds: base.environmentIds ? [...base.environmentIds] : undefined,
          appIds: base.appIds ? [...base.appIds] : undefined, clientId: who.clientId, oauthIssuer: issuer };
        return bindGrant(who, revoked ? undefined : grant);
      },
    };
    const linked = "za_" + randomBytes(32).toString("base64url");
    const auth: AuthDeps = { checkOrigin: () => origin, now: Date.now, oauth: oauth as OAuthLike,
      authority: async () => ({ kind: "postgres", verify: async (header) => {
        if (header !== `Bearer ${linked}` || revoked) throw new Error("credential refused");
        return { ...identity({ scopes: ["read"] }), id: ids.integration };
      }, touch: async () => {} }),
    };
    runtime = { auth, ports: h.ports, requireEnabled: async () => {}, throttle: async () => {}, streams: sqlStreamPort(async () => db) };
    let progressCalls = 0;
    fetcher = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      if (new URL(request.url).pathname === "/api/agent/oauth/revoke") {
        const form = new URLSearchParams(await request.text());
        expect(form.get("token")).toBe(config.token);
        revoked = true; // modeled authority/grant mutation; SDK must reauthenticate through real server
        return new Response(null, { status: 200 });
      }
      if (request.method === "POST") {
        const body = await request.clone().json();
        if (body.method === "tools/call" && body.params?._meta?.progressToken !== undefined) {
          progressCalls++;
          if (progressCalls === 2) gateSlowRead = true;
        }
      }
      return handleMcp(request, runtime);
    }) as typeof fetch;
    config = { baseUrl: origin, token: await mint(), workspaceId: ids.ws, expectedScopes: ["read"], expectedIssuer: issuer,
      foreignAudienceToken: await mint(`${origin}/api/agent/v2/mcp`), foreignIssuerToken: await mint(resource, `${issuer}-other`),
      foreignPrincipalToken: await mint(resource, issuer, "other-client"), readTool: { name: "zenith_get_topology", arguments: argsFor("zenith_get_topology") },
      slowTool: { name: "zenith_get_topology", arguments: argsFor("zenith_get_topology") }, fetch: fetcher, revoke: {} };
  });
  afterEach(() => gate.resolve());

  it("runs every official step with zero skips using signed OAuth and a restricted grant", async () => {
    const results = await officialLeg(config);
    expect(results.filter((r) => r.status !== "pass"), JSON.stringify(results, null, 2)).toEqual([]);
    expect(results.map((r) => r.id)).toEqual([
      "official-2025-11-25", "official-2025-06-18", "official-2025-03-26", "official-2026-07-28",
      "official-scopes", "official-auth", "official-audience", "official-issuer", "official-old-version",
      "official-stream-resume", "official-resume-isolation", "official-cancel", "official-revocation",
    ]);
    expect(revoked).toBe(true);
    expect(requests.some((r) => r.headers.has("last-event-id"))).toBe(true);
    const methods = await Promise.all(requests.filter((r) => r.method === "POST" && new URL(r.url).pathname.endsWith("/mcp")).map(async (r) => (await r.json()).method));
    expect(methods).toContain("notifications/cancelled");
    expect(h.beginExecution).not.toHaveBeenCalled();
    expect(h.propose).not.toHaveBeenCalled();
  });

  it("names absent acceptance inputs as skips and never revokes without --revoke", async () => {
    const results = await officialLeg({ ...config, foreignAudienceToken: undefined, foreignIssuerToken: undefined,
      foreignPrincipalToken: undefined, slowTool: undefined, expectedScopes: undefined, revoke: undefined });
    expect(results.filter((r) => r.status === "fail"), JSON.stringify(results)).toEqual([]);
    expect(results.filter((r) => r.status === "skip").map((r) => r.id)).toEqual([
      "official-scopes", "official-audience", "official-issuer", "official-resume-isolation", "official-cancel", "official-revocation",
    ]);
    expect(revoked).toBe(false);
  });

  it("fails if the requested read is absent rather than accepting an empty list", async () => {
    const close = vi.spyOn(Client.prototype, "close");
    const results = await officialLeg({ ...config, readTool: { name: "missing_tool", arguments: {} }, slowTool: undefined, revoke: undefined });
    expect(results.filter((r) => r.id.startsWith("official-202")).every((r) => r.status === "fail")).toBe(true);
    // Ten distinct clients: four protocol calls, scopes, four refusals, stream.
    // The SDK also closes failed connects internally, so counting invocations double-counts them.
    expect(new Set(close.mock.contexts).size).toBe(10);
  });

  it("refuses a mutating cancellation probe before calling it", async () => {
    const results = await officialLeg({ ...config, slowTool: { name: "zenith_prepare_deploy", arguments: {} }, revoke: undefined });
    expect(results.find((r) => r.id === "official-cancel")).toMatchObject({ status: "fail", detail: "Cancellation probe must use a read tool" });
    expect(h.propose).not.toHaveBeenCalled();
    expect(h.beginExecution).not.toHaveBeenCalled();
  });

  it("redacts every supplied token from failures", () => {
    const tokens = [config.token, config.foreignAudienceToken!, config.foreignIssuerToken!, config.foreignPrincipalToken!];
    expect(redactDetail(tokens.join(" "), config)).toBe(tokens.map(() => "[REDACTED]").join(" "));
  });

  it("bounds resume startup and aborts the SDK GET if response headers never arrive", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const stalledFetch: typeof fetch = async (_input, init) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    };
    try {
      const pending = replay({ ...config, fetch: stalledFetch }, `${"a".repeat(32)}.1`);
      const refused = expect(pending).rejects.toThrow("SDK resume timed out waiting for final result");
      await vi.advanceTimersByTimeAsync(15_000);
      await refused;
      expect(signal).toBeDefined();
      expect(signal!.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("the official SDK reconnects after a dropped POST stream without re-executing the held read", async () => {
    const entered = Promise.withResolvers<void>();
    const realRead = h.authorizeRead.getMockImplementation()!;
    h.authorizeRead.mockImplementationOnce(async (...args) => { entered.resolve(); await gate.promise; return realRead(...args); });
    let dropped = false;
    let resumed = false;
    const droppingFetch: typeof fetch = async (input, init) => {
      const response = await fetcher(input, init);
      if (new Headers(init?.headers).has("last-event-id")) { resumed = true; gate.resolve(); }
      if (!dropped && init?.method === "POST" && response.headers.get("content-type")?.includes("event-stream")) {
        dropped = true;
        const reader = response.body!.getReader();
        const first = await reader.read();
        // Real server's persisted priming event, followed by a network-like close.
        const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(first.value!); controller.close(); } });
        void reader.cancel();
        return new Response(stream, { status: response.status, headers: response.headers });
      }
      return response;
    };
    const transport = new StreamableHTTPClientTransport(new URL(resource), { fetch: droppingFetch,
      requestInit: { headers: { authorization: `Bearer ${config.token}`, "x-zenith-workspace": ids.ws } },
      reconnectionScheduler: (reconnect) => { queueMicrotask(reconnect); }, protocolVersion: "2025-11-25" });
    const client = new Client({ name: "drop-test", version: "1" }, { supportedProtocolVersions: ["2025-11-25"], versionNegotiation: { mode: "legacy" } });
    try {
      await client.connect(transport);
      const pending = client.callTool(config.readTool, { onprogress: () => {}, timeout: 10_000 });
      await entered.promise;
      const result = await pending;
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: true });
      expect(dropped && resumed).toBe(true);
      expect(h.authorizeRead).toHaveBeenCalledTimes(1);
    } finally { gate.resolve(); await client.close(); }
  });
});
