/** Contract-shaped fake HTTP/RPC servers, not real Zenith verification. */
import http from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { HttpControlPlaneClient, ControlPlaneError, waitForOperation, type OperationViewLike } from "../../scripts/acceptance/clients/control-plane";
import { createMcpClient } from "../../scripts/acceptance/clients/mcp";
import { createWorkerController } from "../../scripts/acceptance/clients/worker-control";
import { createHttpProbe } from "../../scripts/acceptance/http-probe";
import { loadLiveConfig, parseApiUrl, describeConfig } from "../../scripts/acceptance/config";
import { parseArgs } from "../../scripts/acceptance/args";
import { kubectlEnv, deleteRunNamespace, type Kubectl } from "../../scripts/acceptance/clients/kubernetes";
import { RUN } from "./_helpers";

async function server(fn: (req: http.IncomingMessage, res: http.ServerResponse, body: Record<string, unknown>) => void, test: (url: string) => Promise<void>) {
  const s = http.createServer((req, res) => { let body = ""; req.on("data", (d) => { body += d.toString(); }); req.on("end", () => fn(req, res, body ? JSON.parse(body) : {})); });
  s.listen(0, "127.0.0.1"); await once(s, "listening");
  try { await test(`http://127.0.0.1:${(s.address() as { port: number }).port}`); }
  finally { s.closeAllConnections(); await new Promise<void>((resolve) => s.close(() => resolve())); }
}
const op = (status: OperationViewLike["status"]): OperationViewLike => ({ id: "op_test", capability: "infrastructure.plan", status, approvalRequired: false });
const send = (res: http.ServerResponse, v: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
describe("control-plane client contract", () => {
  it("drains event pages so later apply events cannot be hidden", async () => {
    let pages = 0;
    await server((req, res) => { const cursor = new URL(req.url!, "http://localhost").searchParams.get("afterSeq"); pages++; send(res, { events: cursor === null ? Array.from({ length: 100 }, (_, i) => ({ seq: i + 1, type: "resource.observed" })) : [{ seq: 101, type: "resource.applying" }] }); }, async (url) => { const r = await new HttpControlPlaneClient({ baseUrl: url }).listOperationEvents("op"); expect(r.events).toHaveLength(101); expect(r.events.at(-1)?.type).toBe("resource.applying"); expect(pages).toBe(2); });
  });
  it("uses bearer, workspace, route shapes and error envelopes without leaking the token", async () => {
    const token = "opaque-token-canary"; const calls: { path: string; body: Record<string, unknown> }[] = [];
    await server((req, res, body) => {
      expect(req.headers.authorization).toBe(`Bearer ${token}`); expect(req.headers["x-zenith-workspace"]).toBe("ws_test"); const path = req.url!; calls.push({ path, body });
      if (path.endsWith("/bad")) return send(res, { error: { code: token, message: `revoked ${token}`, fix: `replace ${token}` } }, 403);
      if (path.includes("/capabilities/check")) return send(res, { decision: { outcome: "allow", reasons: [] } });
      if (path.includes("/capabilities/propose")) return send(res, { operation: op("queued"), decision: { outcome: "allow", reasons: [] }, replayed: false });
      if (path.includes("/events")) return send(res, { events: [{ seq: 1, type: "operation.started" }] });
      if (path.includes("/cancel")) return send(res, { operation: op("cancelled") });
      if (path.includes("/operations/op_test")) return send(res, { operation: op("succeeded"), approvals: [] });
      send(res, { operations: [op("queued")] });
    }, async (url) => {
      const c = new HttpControlPlaneClient({ baseUrl: url, token, workspaceId: "ws_test" }); const req = { capability: "infrastructure.plan" as const, scope: { workspaceId: "ws_test" } };
      expect((await c.checkCapability(req)).decision.outcome).toBe("allow"); expect((await c.proposeCapability(req)).operation.status).toBe("queued"); expect((await c.getOperation("op_test")).operation.status).toBe("succeeded"); expect((await c.listOperations({ limit: 2 })).operations).toHaveLength(1); expect((await c.listOperationEvents("op_test", 0)).events[0]?.seq).toBe(1); expect((await c.cancelOperation("op_test", "sandbox test")).operation.status).toBe("cancelled");
      try { await c.getOperation("bad"); throw new Error("expected failure"); } catch (err) { expect(err).toBeInstanceOf(ControlPlaneError); expect(JSON.stringify(err)).not.toContain(token); expect((err as Error).message).not.toContain(token); }
      expect(calls.map((r) => r.path)).toContain("/api/platform/v1/operations/op_test/events?afterSeq=0&limit=100"); expect(c.describe().tokenSet).toBe(true);
    });
  });
  it("distinguishes reached, other terminal and timeout with injected time", async () => {
    let now = 0; const cp = { getOperation: vi.fn(async () => ({ operation: op("running"), approvals: [] })) };
    const opts = { until: (o: OperationViewLike) => o.status === "succeeded", timeoutMs: 100, pollMs: 50, now: () => now, sleep: async (ms: number) => { now += ms; } };
    expect(await waitForOperation(cp, "op", opts)).toMatchObject({ timedOut: true, reached: false });
    cp.getOperation.mockResolvedValue({ operation: op("failed"), approvals: [] }); expect(await waitForOperation(cp, "op", opts)).toMatchObject({ terminal: true, reached: false, timedOut: false });
    cp.getOperation.mockResolvedValue({ operation: op("succeeded"), approvals: [] }); expect(await waitForOperation(cp, "op", opts)).toMatchObject({ reached: true });
  });
  it("times out a response whose headers arrive but body never finishes", async () => {
    await server((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"operations":'); }, async (url) => {
      const c = new HttpControlPlaneClient({ baseUrl: url, timeoutMs: 100 }); await expect(c.listOperations()).rejects.toMatchObject({ code: "unreachable" });
    });
  });
});
describe("MCP fake JSON-RPC transport", () => {
  it.each([false, true])("accepts JSON/SSE=%s and detects leaks before redaction", async (sse) => {
    const seen: string[] = [];
    await server((req, res, body) => {
      expect(req.headers.authorization).toBe("Bearer opaque-mcp-canary"); const method = body.method as string; seen.push(method);
      if (method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
      const result = method === "initialize" ? { serverInfo: { name: "fake" }, protocolVersion: "2025-06-18" } : method === "tools/list" ? { tools: [{ name: "inspect" }] } : { content: [{ type: "text", text: "AKIAABCDEFGHIJKLMNOP" }], structuredContent: { token: "AKIAABCDEFGHIJKLMNOP" } };
      res.setHeader("mcp-session-id", "test-session"); if (method !== "initialize") expect(req.headers["mcp-session-id"]).toBe("test-session");
      if (sse) { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`); } else send(res, { jsonrpc: "2.0", id: body.id, result });
    }, async (url) => {
      const c = createMcpClient({ url: `${url}/mcp`, token: "opaque-mcp-canary" }); expect(await c.initialize()).toMatchObject({ serverName: "fake" }); expect(await c.listTools()).toEqual([{ name: "inspect" }]); const r = await c.callTool("inspect", {}); expect(r.credentialPatterns).toContain("aws-access-key-id"); expect(JSON.stringify(r)).not.toContain("AKIAABCDEFGHIJKLMNOP"); expect(seen).toContain("notifications/initialized");
    });
  });
  it("refuses mismatched JSON-RPC ids", async () => { const c = createMcpClient({ url: "http://localhost/mcp", fetch: vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} }))) }); await expect(c.initialize()).rejects.toThrow(); });
});
describe("bounded independent probes", () => {
  it("does not follow redirects and bounds bodies", async () => { let redirected = false; await server((req, res) => { if (req.url === "/next") { redirected = true; send(res, {}); } else { res.writeHead(302, { location: "/next" }); res.end("redirect"); } }, async (url) => { expect(await createHttpProbe().get(url)).toMatchObject({ status: 302, ok: false }); expect(redirected).toBe(false); }); });
  it("times out and refuses bad schemes/embedded credentials", async () => { await server(() => undefined, async (url) => { expect(await createHttpProbe().get(url, { timeoutMs: 50 })).toMatchObject({ error: "timeout" }); }); for (const url of ["file:///etc/passwd", "https://user:password@example.test/"]) await expect(createHttpProbe().get(url)).rejects.toThrow(); });
  it("waitFor and DNS/TLS report actual injected observations", async () => { let now = 0; const p = createHttpProbe({ fetch: vi.fn(async () => new Response("bad", { status: 503 })), sleep: async (ms) => { now += ms; }, now: () => now, resolve: async () => ["127.0.0.1"], connectTls: async (host) => ({ host, authorized: false, authorizationError: "CERT_HAS_EXPIRED" }) }); expect((await p.waitFor("http://localhost", { accept: (r) => r.status === 200, timeoutMs: 10, intervalMs: 5 })).accepted).toBe(false); expect(await p.resolveDns("example.test")).toEqual(["127.0.0.1"]); expect(await p.tlsInfo("example.test")).toMatchObject({ authorized: false }); });
});
describe("strict config/arguments and worker/kubernetes safety", () => {
  it("refuses unknown/duplicate/stringless arguments", () => { for (const argv of [["--confirm-billble"], ["--scenario"], ["--scenario", "A", "--scenario", "B"], ["--dry-run=true"]]) expect(() => parseArgs(argv, { booleans: ["dry-run"], strings: ["scenario"] })).toThrow(); expect(parseArgs(["--scenario=J"], { booleans: [], strings: ["scenario"] }).values.get("scenario")).toBe("J"); });
  it("refuses insecure URLs and hides configured secrets", () => { expect(() => parseApiUrl("http://example.com", "API")).toThrow(); expect(() => parseApiUrl("https://u:p@example.com", "API")).toThrow(); expect(parseApiUrl("http://localhost:3000/path", "API")).toBe("http://localhost:3000"); const c = loadLiveConfig({ ZENITH_LIVE_API_TOKEN: "canary", ZENITH_LIVE_MCP_TOKEN: "canary", ZENITH_LIVE_ALLOWED_REGIONS: "us-east-1,us-east-1" }); expect(describeConfig(c)).toMatchObject({ apiToken: "set", mcpToken: "set" }); expect(JSON.stringify(describeConfig(c))).not.toContain("canary"); expect(c.allowedRegions).toEqual(["us-east-1"]); });
  it.each([{ ZENITH_LIVE_AWS_ACCOUNT_ID: "bad" }, { ZENITH_LIVE_MAX_MONTHLY_USD: "0" }, { ZENITH_LIVE_MCP_TOOLS: "[]" }, { ZENITH_LIVE_ALLOWED_REGIONS: "," }, { ZENITH_LIVE_REGION: "bad" }])("rejects malformed config %j", (env) => { expect(() => loadLiveConfig(env)).toThrow(); });
  it("validates worker args and refuses fictitious manual confirmation", async () => { for (const spec of ["docker:--all", "docker:name;rm", "docker:ssc-worker", "process:", "invalid"]) expect(() => createWorkerController(spec)).toThrow(); expect(createWorkerController("docker:zenith-live-worker").kind).toBe("docker"); await expect(createWorkerController("manual").kill()).rejects.toThrow("confirmation"); const confirm = vi.fn(async () => undefined); expect(await createWorkerController("manual", { confirm }).kill()).toMatchObject({ done: true }); expect(confirm).toHaveBeenCalledOnce(); });
  it("preserves configured MCP endpoint paths and refuses URL query tokens", () => { expect(loadLiveConfig({ ZENITH_LIVE_MCP_URL: "http://localhost/api/agent/v3/mcp" }).mcpUrl).toBe("http://localhost/api/agent/v3/mcp"); expect(() => createMcpClient({ url: "https://example.test/mcp?token=secret" })).toThrow(); });
  it("kubectl child environment excludes secrets; deletion checks label and UID", async () => {
    expect(kubectlEnv({ PATH: "path", KUBECONFIG: "sandbox-file", AWS_SECRET_ACCESS_KEY: "secret", DATABASE_URL: "secret" })).toEqual({ PATH: "path", KUBECONFIG: "sandbox-file" });
    const run = vi.fn(async (args: string[]) => { expect(args[0]).toBe("get"); return JSON.stringify({ metadata: { uid: "uid", labels: {} } }); }); const kube: Kubectl = { run, forward: vi.fn() };
    await expect(deleteRunNamespace(kube, RUN)).rejects.toThrow("not provably"); expect(run.mock.calls.every((c) => c[0][0] !== "delete")).toBe(true);
    const safeRun = vi.fn(async (args: string[], _timeout?: number, input?: string) => { if (args[0] === "delete") { expect(JSON.parse(input!).preconditions).toEqual({ uid: "uid", resourceVersion: "3" }); return "{}"; } return JSON.stringify({ metadata: { uid: "uid", resourceVersion: "3", labels: { "zenith.io/live-run": RUN } } }); });
    await deleteRunNamespace({ run: safeRun, forward: vi.fn() }, RUN); expect(safeRun.mock.calls.map((c) => c[0][0])).toEqual(["get", "get", "delete", "wait"]);
  });
});
