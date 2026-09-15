/**
 * Serverless enablement of the agent endpoints (WORK-GRAPH-2.md §5, P3).
 *
 * Four claims, pinned here so a future edit that regresses any of them fails
 * loudly instead of silently reopening a hole:
 *
 *  1. The middleware bypass literal (F10) is exactly the frozen set, and
 *     `/agent/link` is deliberately absent — the approval page must keep
 *     getting the `/login?next=…` redirect.
 *  2. Every v2 transport entry point (`mcp`, `gateway`/tools, `source` upload)
 *     answers 401 with `www-authenticate` when no credential is supplied, and
 *     403 on a host that does not match the configured origin — both before
 *     any credential file or database is touched.
 *  3. The v1 reader route is wired to the real handler, and its
 *     `createReaderHandler` primitive answers 401/403 the same way, exercised
 *     directly (not through the file-backed authority stub, which is refused
 *     by design on win32 — see security.ts's platform gate — so a Windows
 *     checkout cannot prove the real file path end to end; CI runs ubuntu).
 *  4. `maxDuration = 60` is exported, as a static fact, by the four routes
 *     this packet budgets: v2/mcp, v2/tools, v2/source, tick/agent. The tick
 *     route's cron gate (bearer, 503-when-unset, 401-on-mismatch) matches the
 *     shape of the other four tick routes exactly, because it reuses the same
 *     `cronRoute` helper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { ReaderDependencies, CredentialAuthority } from "@/lib/agent-access/http";
import { tempDataDir } from "./_support/data-dir";

tempDataDir("zenith-agent-serverless-", { fast: true });

// The middleware literal is what is under test, not Supabase session behaviour
// (covered by tests/auth/session-middleware.test.ts) or Supabase env presence in
// this process — so updateSession is replaced with a distinguishable sentinel.
// The claim being pinned is purely: which paths reach it, and which do not.
const updateSession = vi.hoisted(() => vi.fn(async () => new NextResponse(null, { status: 599, headers: { "x-sentinel": "update-session" } })));
vi.mock("@/lib/supabase/middleware", () => ({ updateSession }));

const { middleware } = await import("@/middleware");
const { createReaderHandler } = await import("@/lib/agent-access/http");
const { AgentError } = await import("@/lib/agent-access/security");
const { agentReader } = await import("@/lib/agent-access/zenith-reader");
const { POST: v1Post } = await import("@/app/api/agent/v1/mcp/route");
const v2Mcp = await import("@/app/api/agent/v2/mcp/route");
const v2Tools = await import("@/app/api/agent/v2/tools/route");
const v2Source = await import("@/app/api/agent/v2/source/route");
const tickAgent = await import("@/app/api/internal/tick/agent/route");

/* ---------------------------- 1. middleware ---------------------------- */

describe("middleware bypass literal (F10)", () => {
  const BYPASSED = [
    "/api/agent/v1/mcp",
    "/api/agent/v2/mcp",
    "/api/agent/v2/tools",
    "/api/agent/v2/source",
    "/api/agent/link/start",
    "/api/agent/link/token",
    "/.well-known/oauth-protected-resource/api/agent/v2/mcp",
  ];

  beforeEach(() => updateSession.mockClear());

  it.each(BYPASSED)("bypasses the browser-cookie gate for %s", async (pathname) => {
    const res = await middleware(new NextRequest(`http://zenith.test${pathname}`));
    expect(updateSession).not.toHaveBeenCalled();
    // NextResponse.next({ request }) forwards, never the sentinel.
    expect(res.headers.get("x-sentinel")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("/agent/link is deliberately absent — the page must keep getting the /login?next=… redirect", async () => {
    const res = await middleware(new NextRequest("http://zenith.test/agent/link"));
    expect(updateSession).toHaveBeenCalledTimes(1);
    expect(res.headers.get("x-sentinel")).toBe("update-session");
  });
});

/* ------------------------------ 2. v2 ----------------------------------- */

describe("v2 transport entry points", () => {
  const ORIGIN = "http://127.0.0.1:3400";

  beforeEach(() => {
    process.env.ZENITH_AGENT_CONTROL = "1";
    process.env.ZENITH_AGENT_ORIGIN = ORIGIN;
    delete process.env.VERCEL;
    delete process.env.ZENITH_SERVERLESS;
  });
  afterEach(() => {
    delete process.env.ZENITH_AGENT_CONTROL;
    delete process.env.ZENITH_AGENT_ORIGIN;
  });

  const ROUTES: [string, (req: Request) => Promise<Response>][] = [
    ["v2/mcp", v2Mcp.GET as (req: Request) => Promise<Response>],
    ["v2/tools", v2Tools.GET as (req: Request) => Promise<Response>],
    ["v2/source", v2Source.POST as (req: Request) => Promise<Response>],
  ];

  describe.each(ROUTES)("%s", (_name, handler) => {
    it("401s with www-authenticate when no credential is supplied", async () => {
      const res = await handler(new Request(`${ORIGIN}/api/agent/x`, { method: "POST" }));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
      expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("authentication_required");
    });

    it("403s on a host that does not match the configured origin", async () => {
      const res = await handler(
        new Request("http://evil.example/api/agent/x", {
          method: "POST",
          headers: { authorization: "Bearer za_" + "A".repeat(43) },
        })
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("origin_denied");
    });
  });
});

/* ------------------------------ 3. v1 ------------------------------------ */

describe("v1 reader route", () => {
  it("is wired to the real handler", () => {
    expect(v1Post).toBe(agentReader);
  });

  // Exercised directly against the exported primitive with an injected stub
  // authority: the real, wired singleton uses the file-backed authority, which
  // security.ts refuses by design on win32 (LINK-PROTOCOL.md §3.1's "on Windows
  // the file authority answers 503 link_unavailable from ready()"), so it
  // cannot prove the 401/403 paths on every dev machine. http.ts's contract —
  // what this packet owns — is what is under test here.
  function fileAuthorityStub(): CredentialAuthority {
    return {
      kind: "file",
      async ready() {},
      async verify(): Promise<never> {
        throw new AgentError("unauthorized", "Supply an unexpired scoped Zenith agent credential.", 401);
      },
    };
  }
  function handler(more: Partial<ReaderDependencies> = {}) {
    return createReaderHandler({
      enabled: async () => true,
      authority: () => fileAuthorityStub(),
      origin: "http://127.0.0.1:3400",
      credentialsPath: "/tmp/unused",
      tools: [],
      inScope: async (_g, _s, fn) => fn(),
      call: async () => ({}),
      ...more,
    });
  }
  const req = (extra: Record<string, string> = {}, origin = "http://127.0.0.1:3400") =>
    new Request(`${origin}/api/agent/v1/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...extra },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

  it("401s when no credential is supplied", async () => {
    const res = await handler()(req());
    expect(res.status).toBe(401);
  });

  it("403s on a host that does not match the configured origin", async () => {
    const res = await handler()(req({}, "http://evil.example"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("origin_denied");
  });

  it("503s when disabled", async () => {
    const res = await handler({ enabled: async () => false })(req());
    expect(res.status).toBe(503);
  });
});

/* --------------------------- 4. maxDuration ------------------------------ */

describe("maxDuration is a static export on every serverless-budgeted agent route", () => {
  it.each([
    ["v2/mcp", v2Mcp],
    ["v2/tools", v2Tools],
    ["v2/source", v2Source],
    ["internal/tick/agent", tickAgent],
  ])("%s exports maxDuration = 60", (_name, mod) => {
    expect((mod as { maxDuration?: number }).maxDuration).toBe(60);
  });
});

/* --------------------------- 4b. tick route ------------------------------ */

describe("POST /api/internal/tick/agent", () => {
  const SECRET = "test-agent-tick-secret";
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    delete process.env.VERCEL;
    delete process.env.ZENITH_SERVERLESS;
  });
  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  const call = (opts: { bearer?: string; raw?: string } = {}) => {
    const headers = new Headers();
    if (opts.raw !== undefined) headers.set("authorization", opts.raw);
    else if (opts.bearer !== undefined) headers.set("authorization", `Bearer ${opts.bearer}`);
    return tickAgent.POST(new NextRequest("http://zenith.test/api/internal/tick/agent", { method: "POST", headers }));
  };

  it("refuses a request with no Authorization header", async () => {
    const res = await call();
    expect(res.status).toBe(401);
  });

  it("refuses a wrong bearer", async () => {
    expect((await call({ bearer: "nope" })).status).toBe(401);
    expect((await call({ raw: SECRET })).status).toBe(401);
  });

  it("answers 503, not 200, when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    const res = await call({ bearer: SECRET });
    expect(res.status).toBe(503);
  });

  it("runs one pass and answers counts with the right bearer", async () => {
    const res = await call({ bearer: SECRET });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.pass).toBe("agent");
    expect(body.ok).toBe(true);
  });
});
