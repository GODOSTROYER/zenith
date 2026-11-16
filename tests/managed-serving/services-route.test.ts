/**
 * GET /api/platform/v1/managed-services (PROD-MAN-02/03), through the real `route()` wrapper. Same harness as
 * tests/offered-catalog/route.test.ts: the session and the credential authority are faked; everything else is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest as RequestType } from "next/server";
import type { SessionUser } from "@/lib/auth/session";
import type { Member, Workspace } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";
import { FULL_ENV } from "../providers/zenith/support";

tempDataDir("zenith-managed-services-", { fast: true });
process.env.ZENITH_STORE = "file";
process.env.ZENITH_PLATFORM_BROKER_MEMORY = "1";
process.env.ZENITH_PLATFORM_ORIGIN = "http://127.0.0.1:3000";
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
const servicesRoute = await import("@/app/api/platform/v1/managed-services/route");
const { getOfferedCatalog } = await import("@/lib/offered-catalog");

const ORIGIN = "http://127.0.0.1:3000";
const AT = "2026-01-01T00:00:00.000Z";
const ws = (id: string): Workspace => ({ id, name: id, slug: id, createdAt: AT }) as Workspace;
const member = (id: string, workspaceId: string, role: Member["role"]): Member => ({ id, workspaceId, role, name: id, email: `${id}@zenith.test` });
const signIn = (id: string | null) => { state.user = id ? { id, email: `${id}@zenith.test`, name: id } : null; };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
type Handler = (req: RequestType, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function get(query = "", headers: Record<string, string> = {}): Promise<{ status: number; body: Json; text: string }> {
  const request = new NextRequest(`${ORIGIN}/api/platform/v1/managed-services${query}`, { method: "GET", headers: { host: new URL(ORIGIN).host, cookie: `${WORKSPACE_COOKIE}=ws-a`, ...headers } });
  const response = await (servicesRoute.GET as Handler)(request, { params: Promise.resolve({}) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, text };
}

const SAVED = { ...process.env };
function configure(env: Record<string, string | undefined>): void {
  for (const k of Object.keys(process.env)) if (k.startsWith("ZENITH_MANAGED_")) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
}

beforeEach(() => {
  state.credentials = [{ id: "cred-ro", subject: "eve", workspaceId: "ws-a", projectIds: ["pa"], scopes: ["read"], label: "codex", issuedAt: AT, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }];
  resetDb({ workspaces: [ws("ws-a")], members: [member("eve", "ws-a", "editor")], projects: [], environments: [], connections: [] });
  resetPlatformBrokerForTests();
  signIn("eve");
  configure({});
});
afterEach(() => { configure({}); for (const [k, v] of Object.entries(SAVED)) if (k.startsWith("ZENITH_MANAGED_") && v !== undefined) process.env[k] = v; });

describe("GET /api/platform/v1/managed-services", () => {
  it("requires authentication", async () => {
    signIn(null);
    expect((await get()).status).toBe(401);
  });

  it("serves the promised services, the drift verdict and the offered catalog's identity, uncached", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ schemaVersion: 1, provider: "zenith", evidence: "contract", drift: { ok: true, problems: [] }, offeredCatalogVersion: getOfferedCatalog().catalogVersion });
    expect(res.body.services.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining(["web-services", "managed-postgres", "object-storage", "custom-domains", "autoscaling"]));
    expect(res.body.notOffered.map((n: { kind: string }) => n.kind)).toContain("mysql");
  });

  it("says the platform is not configured, and why, without inventing availability", async () => {
    const res = await get();
    expect(res.body).toMatchObject({ configured: false });
    expect(res.body.missing).toEqual(expect.arrayContaining(["ZENITH_MANAGED_CLUSTER_SERVER", "ZENITH_MANAGED_APP_DOMAIN"]));
    expect(res.body.services.every((s: { availability: { available: boolean } }) => s.availability.available === false)).toBe(true);
    expect(res.body.integrations.every((i: { state: string }) => i.state === "not_configured")).toBe(true);
  });

  it("reports availability and unverified integrations for a configured platform, never verified without a probe", async () => {
    configure({ ...FULL_ENV, ZENITH_MANAGED_HTTP_CLUSTER_ISSUER: "zenith-letsencrypt-http01", ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF: "vault:zenith-managed/object-store-admin" });
    const res = await get();
    expect(res.body.configured).toBe(true);
    expect(res.body.services.every((s: { availability: { available: boolean } }) => s.availability.available)).toBe(true);
    expect(res.body.integrations.some((i: { state: string }) => i.state === "verified")).toBe(false);
    expect(res.body.integrations.find((i: { id: string }) => i.id === "custom_domains").state).toBe("configured_unverified");
  });

  it("names the variable to set when one service lacks its component", async () => {
    configure({ ...FULL_ENV });
    const res = await get();
    const domains = res.body.services.find((s: { id: string }) => s.id === "custom-domains");
    expect(domains.availability).toMatchObject({ available: false, missing: ["http_issuer"] });
    expect(domains.availability.reason).toContain("ZENITH_MANAGED_HTTP_CLUSTER_ISSUER");
  });

  it("rejects a bad probe value with a 400", async () => {
    expect((await get("?probe=maybe")).status).toBe(400);
  });

  it("answers a bearer integration, and refuses a forged token", async () => {
    signIn(null);
    expect((await get("", { authorization: `Bearer ${state.token}` })).status).toBe(200);
    expect((await get("", { authorization: "Bearer za_nope" })).status).toBe(401);
  });

  it("carries nothing secret-shaped and no vault reference", async () => {
    configure({ ...FULL_ENV, ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF: "vault:zenith-managed/object-store-admin" });
    const res = await get();
    expect(res.text).not.toMatch(/AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.|-----BEGIN|postgres:\/\/|vault:/);
    expect(res.text).not.toContain("k8s.managed.example.com");
  });
});
