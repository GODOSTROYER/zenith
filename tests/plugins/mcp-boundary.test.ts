/**
 * PROD-UX-03: the MCP v3 layer holds a plugin to its approved tools, through the
 * same broker as every other agent call, and never forwards a bearer. Real
 * Request/Response + MCP SDK transport, injected ports (same harness as
 * tests/agent-v3/route.test.ts). The plugin authenticator here is a model of the
 * service (its real behaviour is covered in service.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { tempDataDir } from "../_support/data-dir";
import { argsFor, bearer, identity, ids, makeHarness, ORIGIN } from "../agent-v3/support";
import type { McpRuntime } from "@/lib/agent-access/v3/runtime";
import type { AuthDeps } from "@/lib/agent-access/v3/auth";
import { PluginError } from "@/lib/plugins/errors";
import type { PluginBinding } from "@/lib/agent-access/v3/principal";

tempDataDir("zenith-plugin-boundary-", { fast: true });
const updateSession = vi.hoisted(() => vi.fn(async () => new NextResponse(null, { status: 599 })));
vi.mock("@/lib/supabase/middleware", () => ({ updateSession }));
const { checkRequestOrigin } = await import("@/lib/agent-access/control/boundary");
const { setMcpRuntimeForTests } = await import("@/lib/agent-access/v3/runtime");
const route = await import("@/app/api/agent/v3/mcp/route");
const { runTool } = await import("@/lib/agent-access/v3/tools");
const { principalFromIdentity } = await import("@/lib/agent-access/v3/principal");
const { scrubMcpValue } = await import("@/lib/agent-access/v3/redaction");

const PLUGIN_TOKEN = "zp_" + "P".repeat(43);
const binding = (tools: string[]): PluginBinding => ({ registrationId: "plg_1", grantId: "pgr_1", pluginId: "acme/viewer", version: "1.0.0", manifestDigest: "d".repeat(64), tools });

function request(method: string, params?: object, token = PLUGIN_TOKEN): Request {
  return new Request(`${ORIGIN}/api/agent/v3/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }) });
}

async function setup(tools: string[] = ["zenith_get_topology"]) {
  const h = await makeHarness();
  const state = { revoked: false, tools };
  const authenticate = vi.fn(async (token: string, audience: string) => {
    if (token !== PLUGIN_TOKEN) throw new PluginError("plugin_grant_invalid", "The plugin token is not valid.");
    expect(audience).toBe(`${ORIGIN}/api/agent/v3/mcp`);
    if (state.revoked) throw new PluginError("plugin_revoked", "This plugin was revoked in this workspace.");
    return identity({ scopes: ["read"], plugin: binding(state.tools) });
  });
  const deps: AuthDeps = { checkOrigin: checkRequestOrigin, now: Date.now,
    authority: async () => ({ kind: "postgres", verify: async () => { throw new Error("a plugin token must not reach the credential authority"); }, touch: async () => {} }),
    oauth: { config: () => undefined, verify: async () => { throw new Error("a plugin token must not reach OAuth"); }, bind: async () => identity() },
    plugins: { authenticate } };
  const runtime: McpRuntime = { auth: deps, ports: h.ports, requireEnabled: vi.fn(async () => {}), throttle: vi.fn(async () => {}) };
  setMcpRuntimeForTests(runtime);
  return { h, runtime, authenticate, state };
}

beforeEach(() => { vi.stubEnv("ZENITH_AGENT_ORIGIN", ORIGIN); vi.stubEnv("VERCEL", undefined); vi.stubEnv("ZENITH_SERVERLESS", undefined); updateSession.mockClear(); });
afterEach(() => { setMcpRuntimeForTests(null); vi.unstubAllEnvs(); });

describe("plugin tokens at MCP v3", () => {
  it("tools/list shows only the approved tools", async () => {
    await setup(["zenith_get_topology"]);
    const body = await (await route.POST(request("tools/list"))).json();
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(["zenith_get_topology"]);
  });

  it("an approved tool runs through the broker as the parent integration, labelled as the plugin", async () => {
    const { h } = await setup();
    const res = await route.POST(request("tools/call", { name: "zenith_get_topology", arguments: argsFor("zenith_get_topology") }));
    const body = await res.json();
    expect(body.result.isError).not.toBe(true);
    expect(body.result.structuredContent).toMatchObject({ ok: true, tool: "zenith_get_topology" });
    expect(h.authorizeRead).toHaveBeenCalledTimes(1);
    const principal = h.authorizeRead.mock.calls[0]?.[1] as { kind: string; id: string; integrationId: string; name: string };
    expect(principal).toMatchObject({ kind: "integration", id: ids.integration, integrationId: ids.integration });
    expect(principal.name).toBe(`plugin acme/viewer@1.0.0 via integration ${ids.integration}`);
  });

  it("a tool outside the approval is not callable even by name (HTTP) and is denied before the broker (dispatcher)", async () => {
    const { h } = await setup(["zenith_get_topology"]);
    const http = await route.POST(request("tools/call", { name: "zenith_scale_service", arguments: argsFor("zenith_scale_service") }));
    const text = JSON.stringify(await http.json());
    expect(text).not.toContain("operationId");
    expect(h.propose).not.toHaveBeenCalled();
    const principal = principalFromIdentity(identity({ scopes: ["read", "write"], plugin: binding(["zenith_get_topology"]) }));
    const direct = await runTool("zenith_scale_service", argsFor("zenith_scale_service"), { principal, ports: h.ports });
    expect(direct).toMatchObject({ ok: false, error: { code: "plugin_capability_denied" } });
    const execute = await runTool("zenith_execute_approved_operation", argsFor("zenith_execute_approved_operation"), { principal, ports: h.ports });
    expect(execute).toMatchObject({ ok: false, error: { code: "plugin_capability_denied" } });
    expect(h.propose).not.toHaveBeenCalled();
    expect(h.beginExecution).not.toHaveBeenCalled();
  });

  it("a tool held by the parent credential but not approved for the plugin stays denied", async () => {
    const { h } = await setup(["zenith_get_topology"]);
    const principal = principalFromIdentity(identity({ scopes: ["read", "plan", "logs", "write"], plugin: binding(["zenith_get_topology"]) }));
    const denied = await runTool("zenith_query_logs", { target: { workspaceId: ids.ws, projectId: ids.project, environmentId: ids.env } }, { principal, ports: h.ports });
    expect(denied).toMatchObject({ ok: false, error: { code: "plugin_capability_denied" } });
  });

  it("revocation is effective mid-session: the next request and an in-flight call are both refused", async () => {
    const { h, state } = await setup();
    expect((await route.POST(request("tools/list"))).status).toBe(200);
    state.revoked = true;
    const res = await route.POST(request("tools/list"));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("plugin_revoked");
    const call = await (await route.POST(request("tools/call", { name: "zenith_get_topology", arguments: argsFor("zenith_get_topology") }))).json();
    expect(call.error?.code ?? call.result?.structuredContent?.error?.code).toBe("plugin_revoked");
    expect(h.authorizeRead).not.toHaveBeenCalled();
  });

  it("never forwards a bearer into the tool layer", async () => {
    const { h } = await setup();
    const seen: string[] = [];
    const real = h.ports.scope.bind(h.ports);
    vi.spyOn(h.ports, "scope").mockImplementation(((id: unknown, fn: () => Promise<unknown>) => { seen.push(JSON.stringify(id)); return real(id as never, fn as never); }) as never);
    await route.POST(request("tools/call", { name: "zenith_get_topology", arguments: argsFor("zenith_get_topology") }));
    expect(seen.length).toBeGreaterThan(0);
    for (const dump of seen) {
      expect(dump).not.toContain(PLUGIN_TOKEN);
      expect(dump).not.toContain(bearer);
    }
  });

  it("a plugin token is refused as unavailable when the deployment has no plugin authenticator (not treated as another credential)", async () => {
    const { runtime } = await setup();
    delete (runtime.auth as { plugins?: unknown }).plugins;
    const res = await route.POST(request("tools/list"));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("plugin_unavailable");
  });

  it("the response scrubber removes plugin tokens", () => {
    expect(JSON.stringify(scrubMcpValue({ note: `token ${PLUGIN_TOKEN} here`, [PLUGIN_TOKEN]: 1 }))).not.toContain(PLUGIN_TOKEN);
  });
});

describe("plugin tokens are refused everywhere else", () => {
  it("the v2 control endpoint does not accept a plugin token", async () => {
    vi.stubEnv("ZENITH_AGENT_ORIGIN", ORIGIN);
    const { authorizeRequest } = await import("@/lib/agent-access/control/boundary");
    await expect(authorizeRequest(new Request(`${ORIGIN}/api/agent/v2/mcp`, { headers: { authorization: `Bearer ${PLUGIN_TOKEN}`, "x-zenith-workspace": ids.ws } }))).rejects.toMatchObject({ code: "plugin_token_wrong_resource", status: 401 });
  });
});
