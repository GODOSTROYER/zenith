/**
 * GET /api/platform/v1/capability-catalog and the MCP capabilities summary
 * (PROD-LIFE-02), through the real `route()` wrapper. Same harness as
 * tests/capabilities/routes.test.ts: the session and the credential authority
 * are faked; everything else is real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest as RequestType } from "next/server";
import type { SessionUser } from "@/lib/auth/session";
import type { Member, Workspace } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-offered-catalog-", { fast: true });
process.env.ZENITH_STORE = "file";
process.env.ZENITH_PLATFORM_BROKER_MEMORY = "1";
process.env.ZENITH_PLATFORM_ORIGIN = "https://zenith.test";
delete process.env.ZENITH_AGENT_ORIGIN;

const state = vi.hoisted(() => ({
  user: null as SessionUser | null,
  credentials: [] as Record<string, unknown>[],
  token: "za_" + "a".repeat(43),
}));

vi.mock("@/lib/server/boot", () => ({ ensureBoot: async () => undefined }));
vi.mock("@/lib/supabase/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/supabase/env")>()), isSupabaseConfigured: () => true }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: async () => state.user }));
vi.mock("@/lib/waitlist/enforcement", () => ({ requireProductRequestAccess: async () => undefined }));
vi.mock("@/lib/hosted/access/identity", () => ({
  verifyRequestIdentity: async () => ({ subject: state.user?.id ?? "nobody", email: state.user?.email ?? "", emailVerified: true }),
}));
vi.mock("@/lib/agent-access/authority", async () => {
  const { AgentError } = await import("@/lib/agent-access/security");
  const authority = {
    kind: "file" as const,
    ready: async () => undefined,
    verify: async (header: string | null) => {
      const found = header === `Bearer ${state.token}` ? state.credentials[0] : undefined;
      if (!found) throw new AgentError("unauthorized", "Supply an unexpired scoped Zenith agent credential.", 401);
      return found;
    },
    listCredentials: async () => state.credentials,
  };
  return { credentialAuthority: () => authority, requireCredentialAuthority: async () => authority };
});

const { resetDb } = await import("@/lib/db/store");
const { WORKSPACE_COOKIE } = await import("@/lib/server/workspace");
const { NextRequest } = await import("next/server");
const { resetPlatformBrokerForTests } = await import("@/lib/capabilities/platform");
const catalogRoute = await import("@/app/api/platform/v1/capability-catalog/route");
const { getOfferedCatalog } = await import("@/lib/offered-catalog");

const ORIGIN = "https://zenith.test";
const AT = "2026-01-01T00:00:00.000Z";

const ws = (id: string): Workspace => ({ id, name: id, slug: id, createdAt: AT }) as Workspace;
const member = (id: string, workspaceId: string, role: Member["role"]): Member => ({ id, workspaceId, role, name: id, email: `${id}@zenith.test` });
const signIn = (id: string | null) => {
  state.user = id ? { id, email: `${id}@zenith.test`, name: id } : null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
type Handler = (req: RequestType, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function get(query = "", headers: Record<string, string> = {}): Promise<{ status: number; body: Json; text: string }> {
  const request = new NextRequest(`${ORIGIN}/api/platform/v1/capability-catalog${query}`, { method: "GET", headers: { cookie: `${WORKSPACE_COOKIE}=ws-a`, ...headers } });
  const response = await (catalogRoute.GET as Handler)(request, { params: Promise.resolve({}) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, text };
}

beforeEach(() => {
  state.credentials = [{ id: "cred-ro", subject: "eve", workspaceId: "ws-a", projectIds: ["pa"], scopes: ["read"], label: "codex", issuedAt: AT, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }];
  resetDb({ workspaces: [ws("ws-a")], members: [member("eve", "ws-a", "editor")], projects: [], environments: [], connections: [] });
  resetPlatformBrokerForTests();
  signIn("eve");
});

describe("GET /api/platform/v1/capability-catalog", () => {
  it("requires authentication", async () => {
    signIn(null);
    const res = await get();
    expect(res.status).toBe(401);
  });

  it("serves the full versioned catalog to a signed-in member, uncached", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const catalog = getOfferedCatalog();
    expect(res.body).toMatchObject({ schemaVersion: 1, catalogVersion: catalog.catalogVersion, contentDigest: catalog.contentDigest });
    expect(res.body.entries).toHaveLength(catalog.entries.length);
    expect(res.body.rollup).toHaveLength(catalog.rollup.length);
    expect(res.body.domains.map((d: { id: string }) => d.id)).toContain("day-two");
  });

  it("filters by provider, domain, kind and level", async () => {
    const res = await get("?provider=aws&domain=data&level=preview");
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeGreaterThan(0);
    for (const e of res.body.entries) expect(e).toMatchObject({ provider: "aws", domain: "data", level: "preview" });
    expect(res.body.rollup.every((r: { provider: string }) => r.provider === "aws")).toBe(true);
    const none = await get("?provider=sandbox&level=supported");
    expect(none.body.entries).toEqual([]);
  });

  it("serves a compact summary", async () => {
    const res = await get("?view=summary");
    expect(res.status).toBe(200);
    expect(res.body.providers).toHaveLength(getOfferedCatalog().providers.length);
    expect(res.body.entries).toBeUndefined();
  });

  it("rejects unknown query values with a 400 that does not echo them", async () => {
    for (const q of ["?provider=zzcanary", "?domain=zzcanary", "?level=zzcanary", "?kind=zzcanary", "?view=zzcanary"]) {
      const res = await get(q);
      expect(res.status, q).toBe(400);
      expect(res.text).not.toContain("zzcanary");
    }
  });

  it("answers a bearer integration with the same catalog, and refuses a forged token", async () => {
    signIn(null);
    const ok = await get("?view=summary", { authorization: `Bearer ${state.token}` });
    expect(ok.status).toBe(200);
    const bad = await get("?view=summary", { authorization: "Bearer za_nope" });
    expect(bad.status).toBe(401);
  });

  it("carries nothing secret-shaped", async () => {
    const res = await get();
    expect(res.text).not.toMatch(/AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.|-----BEGIN|postgres:\/\//);
  });
});
