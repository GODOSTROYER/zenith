/** Real configuration parsing and route responses; authority/store calls are
 * tripwires. No external authorization server or cloud is contacted. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-mcp-v3-oauth-", { fast: true });
const gates = vi.hoisted(() => ({
  session: vi.fn(async () => new NextResponse(null, { status: 599 })),
  authority: vi.fn(() => { throw new Error("Discovery must not open an authority."); }),
  control: vi.fn(() => { throw new Error("Discovery must not open a grant store."); }),
  enabled: vi.fn(() => { throw new Error("Discovery must not require an enabled control plane."); }),
}));
vi.mock("@/lib/supabase/middleware", () => ({ updateSession: gates.session }));
vi.mock("@/lib/agent-access/authority", () => ({ credentialAuthority: gates.authority, requireCredentialAuthority: gates.authority }));
vi.mock("@/lib/agent-access/control/runtime", () => ({
  control: gates.control, requireControlAsync: gates.enabled,
  inAgentScope: gates.control, resolveTarget: gates.control,
  catalog: gates.control, invoke: gates.control, acceptUpload: gates.control,
}));
const route = await import("@/app/.well-known/oauth-protected-resource/api/agent/v3/mcp/route");
const v2Route = await import("@/app/.well-known/oauth-protected-resource/api/agent/v2/mcp/route");
const { authenticationChallengeFor, resourceMetadataFor } = await import("@/lib/agent-access/v3/auth");
const { middleware } = await import("@/middleware");

const ORIGIN = "https://zenith.example.test";
const ISSUER = "https://issuer.example.test/tenant";
const JWKS = "https://issuer.example.test/keys";
const PATH = "/.well-known/oauth-protected-resource/api/agent/v3/mcp";
const request = (headers?: Record<string, string>, origin = ORIGIN) => new Request(`${origin}${PATH}`, { headers });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ZENITH_AGENT_ORIGIN", ORIGIN);
  vi.stubEnv("ZENITH_AGENT_OAUTH_ISSUER", ISSUER);
  vi.stubEnv("ZENITH_AGENT_OAUTH_JWKS", JWKS);
  vi.stubEnv("ZENITH_AGENT_OAUTH_CLIENT_CLAIM", undefined);
  vi.stubEnv("ZENITH_AGENT_OAUTH_SUBJECT_CLAIM", undefined);
  vi.stubEnv("ZENITH_AGENT_CONTROL", "0");
  vi.stubEnv("ZENITH_APP_DOMAIN", "apps.localhost");
});
afterEach(() => vi.unstubAllEnvs());

describe("MCP v3 protected-resource discovery", () => {
  it.each([ORIGIN, "http://localhost:4321", "http://127.0.0.1:4321", "http://[::1]:4321"])("publishes the exact v3 resource anonymously at %s", async (origin) => {
    vi.stubEnv("ZENITH_AGENT_ORIGIN", origin);
    const response = route.GET(request(undefined, origin));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual({
      resource: `${origin}/api/agent/v3/mcp`,
      authorization_servers: [ISSUER],
      scopes_supported: ["zenith:read", "zenith:plan", "zenith:export", "zenith:write", "zenith:publish", "zenith:logs"],
      bearer_methods_supported: ["header"],
      resource_name: "Zenith control v3",
    });
    expect(gates.authority).not.toHaveBeenCalled();
    expect(gates.control).not.toHaveBeenCalled();
    expect(gates.enabled).not.toHaveBeenCalled();
  });

  it("retains v2 discovery's issuer, scopes and bearer method while separating resources", async () => {
    const v2 = await v2Route.GET(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/api/agent/v2/mcp`)).json();
    const v3 = await route.GET(request()).json();
    expect(v2.resource).toBe(`${ORIGIN}/api/agent/v2/mcp`);
    expect(v3.resource).toBe(`${ORIGIN}/api/agent/v3/mcp`);
    for (const key of ["authorization_servers", "scopes_supported", "bearer_methods_supported"]) expect(v3[key]).toEqual(v2[key]);
  });

  it("treats bearer and cookie values as irrelevant to public metadata", async () => {
    const response = route.GET(request({ authorization: "Bearer discovery-token-canary", cookie: "session=discovery-cookie-canary" }));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("discovery-token-canary");
    expect(body).not.toContain("discovery-cookie-canary");
    expect(body).not.toContain(JWKS);
    expect(gates.authority).not.toHaveBeenCalled();
    expect(gates.control).not.toHaveBeenCalled();
  });

  it("reports unconfigured OAuth as unavailable", async () => {
    vi.stubEnv("ZENITH_AGENT_OAUTH_ISSUER", undefined);
    vi.stubEnv("ZENITH_AGENT_OAUTH_JWKS", undefined);
    const response = route.GET(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: { code: "oauth_unavailable" } });
  });

  it.each([
    ["ZENITH_AGENT_OAUTH_ISSUER", undefined],
    ["ZENITH_AGENT_OAUTH_JWKS", undefined],
    ["ZENITH_AGENT_OAUTH_ISSUER", "malformed-config-canary"],
    ["ZENITH_AGENT_OAUTH_JWKS", "malformed-config-canary"],
    ["ZENITH_AGENT_OAUTH_ISSUER", "http://issuer.example.test/config-canary"],
    ["ZENITH_AGENT_OAUTH_JWKS", "https://user:config-canary@issuer.example.test/keys"],
    ["ZENITH_AGENT_OAUTH_JWKS", "https://issuer.example.test/keys?token=config-canary"],
    ["ZENITH_AGENT_OAUTH_ISSUER", "https://issuer.example.test/tenant#config-canary"],
    ["ZENITH_AGENT_OAUTH_CLIENT_CLAIM", "config-canary"],
    ["ZENITH_AGENT_OAUTH_SUBJECT_CLAIM", "invalid config-canary"],
  ])("refuses invalid %s configuration without disclosing its value (%s)", async (key, value) => {
    vi.stubEnv(key!, value);
    const response = route.GET(request());
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ error: { code: "oauth_configuration" } });
    expect(body).not.toContain("config-canary");
    expect(gates.authority).not.toHaveBeenCalled();
    expect(gates.control).not.toHaveBeenCalled();
  });

  it.each([
    [{}, "https://foreign.example.test"],
    [{ host: "foreign.example.test", "x-forwarded-host": "zenith.example.test" }, ORIGIN],
    [{ origin: "https://foreign.example.test", "x-forwarded-host": "zenith.example.test" }, ORIGIN],
  ] as [Record<string, string>, string][])("refuses an untrusted Host or Origin (%j, %s)", async (headers, origin) => {
    const response = route.GET(request(headers, origin));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "origin_denied" } });
    expect(gates.authority).not.toHaveBeenCalled();
    expect(gates.control).not.toHaveBeenCalled();
  });

  it.each([undefined, "origin-config-canary", "https://user:origin-config-canary@zenith.example.test", "http://zenith.example.test"])("fails closed for an invalid trusted origin (%s)", async (origin) => {
    vi.stubEnv("ZENITH_AGENT_ORIGIN", origin);
    const response = route.GET(request());
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ error: { code: "origin_configuration" } });
    expect(body).not.toContain("origin-config-canary");
  });

  it("exports a dynamic Node discovery route", () => {
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
  });
});

describe("MCP v3 canonical 401 challenge helper (transport wiring pending)", () => {
  it.each([ORIGIN, "http://localhost:4321", "http://[::1]:4321"])("points at matching RFC 9728 metadata on %s", async (origin) => {
    vi.stubEnv("ZENITH_AGENT_ORIGIN", origin);
    const metadataUrl = resourceMetadataFor(origin);
    expect(metadataUrl).toBe(`${origin}${PATH}`);
    expect(authenticationChallengeFor(origin)).toBe(`Bearer resource_metadata="${metadataUrl}", scope="zenith:read"`);
    expect((await route.GET(new Request(metadataUrl)).json()).resource).toBe(`${origin}/api/agent/v3/mcp`);
  });
});

describe("MCP v3 discovery middleware boundary", () => {
  it("bypasses only the exact public discovery path, with or without a query", async () => {
    for (const suffix of ["", "?client=discovery-client"]) {
      const response = await middleware(new NextRequest(`${ORIGIN}${PATH}${suffix}`));
      expect(response.headers.get("x-middleware-next")).toBe("1");
    }
    expect(gates.session).not.toHaveBeenCalled();
  });

  it.each([`${PATH}/`, `${PATH}/extra`, `${PATH}-extra`, PATH.replace("/v3/", "/v4/"), "/.well-known/oauth-protected-resource", "/agent/link", "/integrations/operations/op-a"])("keeps adjacent and browser-only path %s gated", async (path) => {
    expect((await middleware(new NextRequest(`${ORIGIN}${path}`))).status).toBe(599);
    expect(gates.session).toHaveBeenCalledOnce();
  });
});
