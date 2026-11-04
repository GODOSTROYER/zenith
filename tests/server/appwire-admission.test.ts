/**
 * Real route(), waitlist enforcement and bearer authentication. Store/session,
 * credential authority availability and admission repository are mocked;
 * these tests do not contact Supabase or claim live membership verification.
 */
import { createHash } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SessionUser } from "@/lib/auth/session";
import type { Credential } from "@/lib/agent-access/security";

const state = vi.hoisted(() => ({
  user: null as SessionUser | null, records: [] as Credential[], postgres: false,
  admitted: vi.fn(), identity: vi.fn(), verify: vi.fn(), ready: vi.fn(), boot: vi.fn(),
  resolve: vi.fn(), load: vi.fn(), flush: vi.fn(),
}));
vi.mock("@/lib/server/boot", () => ({ ensureBoot: state.boot }));
vi.mock("@/lib/db/store", () => ({ isPostgres: () => state.postgres, flushPendingAsync: state.flush }));
vi.mock("@/lib/db/postgres-store", () => ({ pgClient: () => "mock-pg-client", loadSnapshot: state.load }));
vi.mock("@/lib/db/request-snapshot", () => ({ runWithSnapshot: async (_: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/actions/core", () => ({ withActionOutcomes: async (fn: (outcomes: { commit: () => void }) => Promise<unknown>) => fn({ commit: () => undefined }) }));
vi.mock("@/lib/server/actor", () => ({ resolveRequest: state.resolve, resolveActor: async () => ({ id: "session", type: "user", name: "Session" }), routeGrant: vi.fn() }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: async () => state.user }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ auth: { admin: { getUserById: state.identity } } }) }));
vi.mock("@/lib/waitlist/repository", () => ({ waitlistRepository: async () => ({ admitted: state.admitted }) }));
vi.mock("@/lib/agent-access/authority", () => ({ requireCredentialAuthority: async () => { await state.ready(); return { verify: state.verify }; } }));

import { AgentError, authenticate } from "@/lib/agent-access/security";
import { platformRoute } from "@/app/api/platform/v1/_lib/http";
import { callerOf } from "@/app/api/platform/v1/_lib/principal";
import { currentRequest, route } from "@/lib/server/request";
import { assertNoCredentialLeak } from "@/lib/credentials/redact";

const TOKEN = `za_${"a".repeat(43)}`;
const ctx = { params: Promise.resolve({}) };
function request(path = "/operations", method = "GET", authorization: string | null = `Bearer ${TOKEN}`, headers: Record<string, string> = {}) {
  return new NextRequest(`https://zenith.test/api/platform/v1${path}`, {
    method, headers: { ...(authorization !== null ? { authorization } : {}), ...headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ZENITH_WAITLIST_GATE_ENABLED", "1");
  vi.stubEnv("ZENITH_WAITLIST_ENABLED", "0");
  vi.stubEnv("ZENITH_WAITLIST_EXISTING_USERS_BEFORE", "2025-01-01T00:00:00.000Z");
  vi.stubEnv("ZENITH_WAITLIST_ADMIN_IDS", "");
  state.user = null;
  state.postgres = false;
  state.records = [{
    id: "cred_1", tokenHash: createHash("sha256").update(TOKEN).digest("hex"),
    subject: "subject_1", workspaceId: "ws_1", projectIds: ["project_1"], scopes: ["read"],
    issuedAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
  }];
  state.ready.mockResolvedValue(undefined);
  state.verify.mockImplementation(async (header: string) => authenticate(header, state.records));
  state.boot.mockResolvedValue(undefined);
  state.flush.mockResolvedValue(undefined);
  state.resolve.mockImplementation(async () => ({ user: state.user }));
  state.load.mockResolvedValue({ scoped: true });
  state.admitted.mockResolvedValue(false);
  state.identity.mockImplementation(async (id: string) => ({ data: { user: { id, email: state.user?.email, email_confirmed_at: "2026-01-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z" } }, error: null }));
});
afterEach(() => vi.unstubAllEnvs());

describe("integration admission before product state", () => {
  it("reaches a principal-aware handler with waitlist on and no cookie", async () => {
    const handler = vi.fn(async (req: NextRequest) => ({ body: await callerOf(req) }));
    const response = await platformRoute(handler)(request(), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ via: "bearer", workspaceId: "ws_1", principal: { kind: "integration", onBehalfOf: "subject_1" } });
    expect(handler).toHaveBeenCalledOnce();
    expect(state.boot).toHaveBeenCalledOnce();
    expect(state.resolve).not.toHaveBeenCalled();
    expect(state.identity).not.toHaveBeenCalled();
    expect(state.admitted).not.toHaveBeenCalled();
  });

  it("prefetches Postgres using the verified subject instead of an unrestricted null user", async () => {
    state.postgres = true;
    const response = await platformRoute(async () => ({ body: { snapshot: currentRequest()?.snapshot, user: currentRequest()?.user } }))(request(), ctx);
    expect(response.status).toBe(200);
    expect(state.load).toHaveBeenCalledWith("mock-pg-client", { id: "subject_1", email: "" });
    expect(await response.json()).toEqual({ snapshot: { scoped: true }, user: null });
    expect(state.resolve).not.toHaveBeenCalled();
  });

  it("does not accept a cookie user's invitations when a credential selects the principal", async () => {
    state.user = { id: "waiting-user", email: "waiting@example.test", name: "Waiting" };
    const response = await platformRoute(async () => ({ body: { user: currentRequest()?.user } }))(request(), ctx);
    expect(response.status).toBe(200);
    expect(state.resolve).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ user: null });
  });

  it.each(["forged", "malformed", "expired", "revoked", "future"])("refuses a %s bearer with 401 before boot, reads or handler", async (failure) => {
    let header = `Bearer ${TOKEN}`;
    if (failure === "forged") header = `Bearer za_${"b".repeat(43)}`;
    if (failure === "malformed") header = "Bearer malformed";
    if (failure === "expired") state.records[0].expiresAt = new Date(Date.now() - 1).toISOString();
    if (failure === "revoked") state.records[0].revokedAt = new Date().toISOString();
    if (failure === "future") state.records[0].issuedAt = new Date(Date.now() + 60000).toISOString();
    const handler = vi.fn();
    const response = await platformRoute(handler)(request("/operations", "GET", header), ctx);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: failure === "malformed" ? "unauthenticated" : "unauthorized" } });
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(handler).not.toHaveBeenCalled();
    expect(state.boot).not.toHaveBeenCalled();
    expect(state.resolve).not.toHaveBeenCalled();
    expect(state.load).not.toHaveBeenCalled();
  });

  it("refuses an unavailable authority without entering the product", async () => {
    state.ready.mockRejectedValue(new AgentError("link_unavailable", "Credential authority unavailable.", 503));
    const handler = vi.fn();
    const response = await platformRoute(handler)(request(), ctx);
    expect(response.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
    expect(state.boot).not.toHaveBeenCalled();
  });

  it("redacts external diagnostics in an authority refusal response", async () => {
    const password = "synthetic-authority-password";
    state.ready.mockRejectedValue(new AgentError("link_unavailable", `postgres://operator:${password}@db.test ${TOKEN}`, 503));
    const handler = vi.fn();
    const response = await platformRoute(handler)(request(), ctx);
    expect(response.status).toBe(503);
    assertNoCredentialLeak(await response.json(), { secrets: [password, TOKEN] });
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a foreign workspace before loading a tenant snapshot", async () => {
    const handler = vi.fn();
    const response = await platformRoute(handler)(request("/operations", "GET", `Bearer ${TOKEN}`, { "x-zenith-workspace": "ws_foreign" }), ctx);
    expect(response.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
    expect(state.load).not.toHaveBeenCalled();
  });

  it("verifies each new request so revocation cannot reuse an earlier admission", async () => {
    const handler = vi.fn(async () => ({ body: { ok: true } }));
    const wrapped = platformRoute(handler);
    expect((await wrapped(request(), ctx)).status).toBe(200);
    state.records[0].revokedAt = new Date().toISOString();
    expect((await wrapped(request(), ctx)).status).toBe(401);
    expect(state.verify).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("retains the mutation flush for admitted integrations", async () => {
    state.postgres = true;
    const response = await platformRoute(async () => ({ body: { ok: true } }))(request("/capabilities/check", "POST"), ctx);
    expect(response.status).toBe(200);
    expect(state.flush).toHaveBeenCalledOnce();
  });

  it("never grants a browser workspace role to an integration", async () => {
    const handler = vi.fn();
    const response = await route({ workspaceRole: "admin", integrationAccess: async () => ({ subject: "subject_1" }) }, handler)(request(), ctx);
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("session admission remains enforced", () => {
  it("refuses an unadmitted cookie user before invitation acceptance or boot", async () => {
    state.user = { id: "waiting-user", email: "waiting@example.test", name: "Waiting" };
    const handler = vi.fn();
    const response = await platformRoute(handler)(request("/operations", "GET", null), ctx);
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(state.boot).not.toHaveBeenCalled();
    expect(state.resolve).not.toHaveBeenCalled();
    expect(state.admitted).toHaveBeenCalledWith("waiting@example.test");
  });

  it("lets an admitted cookie user use the original resolution path", async () => {
    state.user = { id: "member", email: "member@example.test", name: "Member" };
    state.admitted.mockResolvedValue(true);
    const handler = vi.fn(async () => ({ body: { ok: true } }));
    expect((await platformRoute(handler)(request("/operations", "GET", null), ctx)).status).toBe(200);
    expect(state.resolve).toHaveBeenCalledOnce();
    expect(state.verify).not.toHaveBeenCalled();
  });

  it.each([
    ["POST", "/operations/x/approve"], ["POST", "/operations/x/reject"],
    ["PUT", "/environments/x/autonomy"], ["PUT", "/workspace/policy"],
    ["GET", "/runners"], ["POST", "/runners/tokens"], ["POST", "/machines/x/revoke"],
    ["POST", "/operations"], ["GET", "/unknown"],
  ])("does not skip admission for bearer on %s %s", async (method, suffix) => {
    const handler = vi.fn();
    expect((await platformRoute(handler)(request(suffix, method), ctx)).status).toBe(403);
    expect(state.verify).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(state.boot).not.toHaveBeenCalled();
  });

  it("never treats an Authorization header as admission on an unrelated product route", async () => {
    const handler = vi.fn();
    const response = await route(handler)(new NextRequest("https://zenith.test/api/workspace", { headers: { authorization: `Bearer ${TOKEN}` } }), ctx);
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });
});
