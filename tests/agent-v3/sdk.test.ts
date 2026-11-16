/** Typed REST client contracts with fake fetch plus a real loopback HTTP server.
 * The loopback server is a fixture, not a live Zenith deployment. */
import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createPlatformClient, PlatformApiError, PlatformInvalidResponseError, PlatformNetworkError, PlatformTimeoutError } from "@/lib/sdk";
import type { CapabilityRequest } from "@/lib/sdk";
import { bearer, canaries, ids, ORIGIN, target } from "./support";

const capability: CapabilityRequest = { capability: "deployment.deploy", scope: target, input: { revisionId: ids.revision }, idempotencyKey: "sdk-intent-001" };
const operation = { id: "op-a", status: "approved" };
const decision = { outcome: "allow" };
const autonomy = { environmentId: ids.env, level: 2, version: 1 };
const policy = { workspaceId: ids.ws, overrides: {}, effective: {}, version: 1 };

function fakeFetch() {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = path.endsWith("/propose") ? { operation, decision, replayed: false } : path.endsWith("/check") ? { decision } : path.endsWith("/events") ? { events: [] } :
      path.endsWith("/cancel") ? { operation } : path.endsWith("/autonomy") ? autonomy : path.endsWith("/policy") ? policy : path.endsWith("/operations") ? { operations: [operation], nextCursor: "page-2" } : { operation, approvals: [] };
    expect(init?.redirect).toBe("error");
    return Response.json(body, { status: path.endsWith("/propose") ? 201 : 200 });
  });
  return fetch;
}
describe("platform SDK", () => {
  it("sends exact bearer request bodies, paths, filters and pagination", async () => {
    const fetch = fakeFetch(); const client = createPlatformClient({ baseUrl: ORIGIN, auth: { kind: "bearer", token: bearer }, workspaceId: ids.ws, fetch });
    expect(await client.proposeCapability(capability)).toEqual({ operation, decision, replayed: false });
    await client.checkCapability(capability);
    await client.listOperations({ status: ["approved", "running"], projectId: ids.project, environmentId: ids.env, resourceId: ids.service, capability: "deployment.deploy", limit: 12, cursor: "page-1" });
    await client.getOperation("op-a"); await client.listOperationEvents("op-a", { afterSeq: 0, limit: 10 });
    await client.cancelOperation("op-a", { reason: "Stop this intent." }); await client.getEnvironmentAutonomy(ids.env); await client.getWorkspacePolicy();
    expect(fetch).toHaveBeenCalledTimes(8);
    const calls = fetch.mock.calls.map(([url, init]) => ({ url: new URL(String(url)), init: init!, headers: new Headers(init?.headers) }));
    for (const c of calls) { expect(c.headers.get("authorization")).toBe(`Bearer ${bearer}`); expect(c.headers.get("x-zenith-workspace")).toBe(ids.ws); expect(c.headers.get("cookie")).toBeNull(); expect(c.init.credentials).toBe("omit"); }
    expect(calls[0].url.pathname).toBe("/api/platform/v1/capabilities/propose"); expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toEqual(capability); expect(JSON.parse(calls[1].init.body as string)).toEqual(capability);
    expect(Object.fromEntries(calls[2].url.searchParams)).toEqual({ status: "approved,running", projectId: ids.project, environmentId: ids.env, resourceId: ids.service, capability: "deployment.deploy", limit: "12", cursor: "page-1" });
    expect(calls[3].url.pathname).toBe("/api/platform/v1/operations/op-a"); expect(calls[4].url.searchParams.get("afterSeq")).toBe("0");
    expect(JSON.parse(calls[5].init.body as string)).toEqual({ reason: "Stop this intent." });
    expect(client).not.toHaveProperty("approveOperation"); expect(client).not.toHaveProperty("rejectOperation");
  });
  it("accepts 200 proposal replays", async () => {
    const client = createPlatformClient({ baseUrl: ORIGIN, auth: { kind: "bearer", token: bearer }, fetch: async () => Response.json({ operation, decision, replayed: true }) });
    expect((await client.proposeCapability(capability)).replayed).toBe(true);
  });
  it.each([undefined, "session=cookie-fixture"])("cookie mode %s uses credentials include and same-origin updates", async (cookie) => {
    const fetch = fakeFetch(); const client = createPlatformClient({ baseUrl: `${ORIGIN}/`, auth: { kind: "cookie", cookie }, workspaceId: ids.ws, fetch });
    await client.setEnvironmentAutonomy(ids.env, { level: 3, expectedVersion: 1 });
    await client.setWorkspacePolicy({ overrides: { deniedCapabilities: ["service.restart"] }, expectedVersion: 1 });
    for (const [, init] of fetch.mock.calls) {
      const headers = new Headers(init?.headers); expect(headers.has("authorization")).toBe(false); expect(headers.get("cookie")).toBe(cookie ?? null);
      expect(headers.get("origin")).toBe(ORIGIN); expect(init?.credentials).toBe("include"); expect(init?.method).toBe("PUT");
    }
    expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toEqual({ level: 3, expectedVersion: 1 });
    expect(JSON.parse(fetch.mock.calls[1][1]?.body as string)).toEqual({ overrides: { deniedCapabilities: ["service.restart"] }, expectedVersion: 1 });
  });
  it("browser-only methods refuse bearers locally without a request", async () => {
    const fetch = fakeFetch(); const client = createPlatformClient({ baseUrl: ORIGIN, auth: { kind: "bearer", token: bearer }, fetch });
    await expect(client.setEnvironmentAutonomy(ids.env, { level: 5 })).rejects.toMatchObject({ name: "PlatformApiError", status: 403, code: "browser_session_required" });
    await expect(client.setWorkspacePolicy({ overrides: {} })).rejects.toBeInstanceOf(PlatformApiError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([404, 403, 409, 500, 503])("HTTP %s produces a typed sanitized error", async (status) => {
    const token = "a-private-fixture-without-a-known-prefix";
    const client = createPlatformClient({ baseUrl: ORIGIN, auth: { kind: "bearer", token }, fetch: async () => Response.json({ error: { code: status === 404 ? "not_found" : "test_error", message: `Failed ${token} ${canaries.join(" ")}`, fix: `Do not echo ${token}`, details: { message: token } } }, { status }) });
    try { await client.getOperation("op-a"); throw new Error("Expected API error"); }
    catch (e) {
      expect(e).toBeInstanceOf(PlatformApiError); const error = e as PlatformApiError;
      expect(error.status).toBe(status); expect(error.isNotFound()).toBe(status === 404);
      for (const secret of [token, ...canaries]) { expect(error.message).not.toContain(secret); expect(JSON.stringify(error.toJSON())).not.toContain(secret); }
    }
  });
  it("drops potentially credential-bearing network causes", async () => {
    const client = createPlatformClient({ baseUrl: ORIGIN, auth: { kind: "bearer", token: bearer }, fetch: async () => { throw new Error(`Connection failure ${bearer}`); } });
    await expect(client.getOperation("op-a")).rejects.toBeInstanceOf(PlatformNetworkError);
    await expect(client.getOperation("op-a")).rejects.not.toHaveProperty("cause");
  });
  it("times out and aborts even when a fake fetch ignores the signal", async () => {
    let signal: AbortSignal | null | undefined;
    const client = createPlatformClient({ baseUrl: ORIGIN, auth: { kind: "bearer", token: bearer }, timeoutMs: 10, fetch: async (_url, init) => { signal = init?.signal; return new Promise(() => {}); } });
    await expect(client.getOperation("op-a")).rejects.toBeInstanceOf(PlatformTimeoutError); expect(signal?.aborted).toBe(true);
  });
  it("the deadline includes a stalled response body", async () => {
    const client = createPlatformClient({ baseUrl: ORIGIN, auth: { kind: "bearer", token: bearer }, timeoutMs: 10,
      fetch: async () => new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/json" } }) });
    await expect(client.getOperation("op-a")).rejects.toBeInstanceOf(PlatformTimeoutError);
  });
  it.each([new Response("not JSON", { headers: { "content-type": "text/plain" } }), new Response("bad", { headers: { "content-type": "application/json" } }), Response.json({ unexpected: true })])("invalid responses are typed without echoing bodies", async (response) => {
    const client = createPlatformClient({ baseUrl: ORIGIN, auth: { kind: "cookie" }, fetch: async () => response });
    await expect(client.getOperation("op-a")).rejects.toBeInstanceOf(PlatformInvalidResponseError);
  });
  it("rejects credential URLs and traversal ids without a request", () => {
    const fetch = fakeFetch(); expect(() => createPlatformClient({ baseUrl: "https://user:password@host", auth: { kind: "cookie" }, fetch })).toThrowError(PlatformApiError);
    const client = createPlatformClient({ baseUrl: ORIGIN, auth: { kind: "cookie" }, fetch });
    expect(() => client.getOperation("../workspace/policy")).toThrowError(PlatformApiError); expect(fetch).not.toHaveBeenCalled();
  });
  it("invalid header values never appear in configuration errors", () => {
    const token = bearer + "\nprivate-canary";
    try { createPlatformClient({ baseUrl: ORIGIN, auth: { kind: "bearer", token } }); throw new Error("Expected refusal"); }
    catch (e) { expect(e).toBeInstanceOf(PlatformApiError); expect(String(e)).not.toContain(bearer); expect(JSON.stringify(e)).not.toContain("private-canary"); }
  });
  it("performs actual fetch against a loopback node:http fixture", async () => {
    const received: { path?: string; auth?: string; workspace?: string; body?: unknown } = {};
    const server = createServer(async (req, res) => {
      received.path = req.url; received.auth = req.headers.authorization; received.workspace = String(req.headers["x-zenith-workspace"]);
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify({ operation, decision, replayed: false }));
    });
    server.listen(0, "127.0.0.1");
    try {
      await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture not listening");
      const client = createPlatformClient({ baseUrl: `http://127.0.0.1:${address.port}`, auth: { kind: "bearer", token: bearer }, workspaceId: ids.ws });
      expect(await client.proposeCapability(capability)).toEqual({ operation, decision, replayed: false });
      expect(received).toEqual({ path: "/api/platform/v1/capabilities/propose", auth: `Bearer ${bearer}`, workspace: ids.ws, body: capability });
    } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});
