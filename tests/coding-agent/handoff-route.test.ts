/** Real browser/session, role, MFA and body boundaries with only external identity and export IO replaced. */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-handoff-route-", { fast: true });
const mocks = vi.hoisted(() => ({ claims: vi.fn(), user: vi.fn(), identity: vi.fn(), export: vi.fn() }));
vi.mock("@/lib/controlplane/db/open", () => ({ platformDb: async () => ({}) }));
vi.mock("@/lib/controlplane/db/repos/workspace-mfa-controls", () => ({ getWorkspaceMfaControls: async (_sql: unknown, workspaceId: string) => ({
  workspaceId, privilegedActionsRequireAal2: true, requireForAllMutations: false, maxAgeSeconds: null,
}) }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getClaims: mocks.claims, getUser: mocks.user } }) }));
vi.mock("@/lib/supabase/env", () => ({ SUPABASE_URL: "http://auth.test", SUPABASE_PUBLIC_KEY: "", isSupabaseConfigured: () => true }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: async () => ({ id: "operator", email: "operator@example.test", name: "Operator" }) }));
vi.mock("@/lib/server/boot", () => ({ ensureBoot: async () => undefined }));
vi.mock("@/lib/waitlist/enforcement", () => ({ requireProductRequestAccess: async () => undefined }));
vi.mock("@/lib/hosted/access/identity", () => ({ verifyRequestIdentity: mocks.identity }));
vi.mock("@/lib/coding-agent/handoff-platform", () => ({ authorizedRunHandoff: mocks.export }));

const { db, resetDb } = await import("@/lib/db/store");
const { POST } = await import("@/app/api/platform/v1/coding-agent/runs/[id]/handoff/route");
const { BrokerError } = await import("@/lib/capabilities/errors");
const context = { params: Promise.resolve({ id: "run-a" }) };
function call(body: unknown = {}, headers: Record<string, string> = {}) {
  return POST(new NextRequest("https://zenith.test/api/platform/v1/coding-agent/runs/run-a/handoff", {
    method: "POST", headers: { origin: "https://zenith.test", "content-type": "application/json", cookie: "zenith-workspace=ws-a", ...headers }, body: JSON.stringify(body),
  }), context);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ZENITH_PLATFORM_ORIGIN", "https://zenith.test");
  mocks.claims.mockResolvedValue({ data: { claims: { sub: "operator", aal: "aal2", exp: Date.now() / 1000 + 600 } }, error: null });
  mocks.user.mockResolvedValue({ data: { user: { id: "operator", email_confirmed_at: new Date().toISOString(), factors: [{ factor_type: "totp", status: "verified" }] } }, error: null });
  mocks.identity.mockResolvedValue({ subject: "operator", emailVerified: true });
  mocks.export.mockResolvedValue({ id: "run-a", markdown: "# Redacted context", digest: "a".repeat(64) });
  resetDb({ workspaces: [{ id: "ws-a", name: "A", slug: "a", createdAt: new Date().toISOString(), ownerId: "operator" }],
    members: [{ id: "operator", workspaceId: "ws-a", role: "admin", name: "Operator", email: "operator@example.test" }] });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("browser handoff boundary", () => {
  it("uses the verified workspace and returns a noncached bounded artifact to an admin", async () => {
    const response = await call({ expectedVersion: 5, expectedDigest: "b".repeat(64) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ id: "run-a", markdown: "# Redacted context" });
    expect(mocks.export).toHaveBeenCalledWith({ workspaceId: "ws-a", runId: "run-a", expectedVersion: 5, expectedDigest: "b".repeat(64) });
  });
  it("refuses cross-site and machine requests before exporting", async () => {
    const requests: Record<string, string>[] = [{ origin: "https://foreign.test" }, { "sec-fetch-site": "cross-site" }, { authorization: "Bearer not-a-browser" }, { "x-zenith-actor": "navigator" }];
    for (const headers of requests) {
      expect((await call({}, headers)).status).toBe(403);
    }
    expect(mocks.export).not.toHaveBeenCalled();
  });
  it("refuses stale identity, non-admins, foreign workspaces and missing MFA before exporting", async () => {
    mocks.identity.mockResolvedValueOnce({ subject: "someone-else", emailVerified: true });
    expect((await call()).status).toBe(401);
    db().members[0].role = "viewer";
    expect((await call()).status).toBe(403);
    db().members[0].role = "admin";
    expect((await call({}, { "x-zenith-workspace": "foreign" })).status).toBe(404);
    mocks.claims.mockResolvedValueOnce({ data: { claims: { sub: "operator", aal: "aal1", exp: Date.now() / 1000 + 600 } }, error: null });
    expect((await call()).status).toBe(403);
    expect(mocks.export).not.toHaveBeenCalled();
  });
  it("accepts no authority from the body, caps size and preserves provider revocation refusals", async () => {
    expect((await call({ workspaceId: "foreign", approved: true })).status).toBe(400);
    expect((await call({ text: "x".repeat(2_049) })).status).toBe(400);
    expect(mocks.export).not.toHaveBeenCalled();
    mocks.export.mockRejectedValueOnce(new BrokerError("policy_denied", "Current repository access could not be confirmed."));
    const revoked = await call();
    expect(revoked.status).toBe(403);
    expect((await revoked.json()).error.code).toBe("policy_denied");
  });
});
