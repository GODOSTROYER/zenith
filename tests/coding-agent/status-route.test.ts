/** Real browser/current-role admission; SQL metadata and external identity are explicit models. */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-analysis-status-", { fast: true });
const mocks = vi.hoisted(() => ({ claims: vi.fn(), user: vi.fn(), identity: vi.fn(), statuses: vi.fn(), source: vi.fn(), store: vi.fn() }));
vi.mock("@/lib/controlplane/db/open", () => ({ platformDb: async () => ({}) }));
vi.mock("@/lib/controlplane/db/repos/coding-agent-runs", async original => ({ ...await original<object>(), listRunStatuses: mocks.statuses }));
vi.mock("@/lib/coding-agent/platform", () => ({ createRunSourceAccessChecker: mocks.source, codingAgentStore: mocks.store, codingAgentControl: vi.fn() }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getClaims: mocks.claims, getUser: mocks.user } }) }));
vi.mock("@/lib/supabase/env", () => ({ SUPABASE_URL: "http://auth.test", SUPABASE_PUBLIC_KEY: "", isSupabaseConfigured: () => true }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: async () => ({ id: "operator", email: "operator@example.test", name: "Operator" }) }));
vi.mock("@/lib/server/boot", () => ({ ensureBoot: async () => undefined }));
vi.mock("@/lib/waitlist/enforcement", () => ({ requireProductRequestAccess: async () => undefined }));
vi.mock("@/lib/hosted/access/identity", () => ({ verifyRequestIdentity: mocks.identity }));
const { db, resetDb } = await import("@/lib/db/store");
const { GET } = await import("@/app/api/platform/v1/coding-agent/runs/route");
const status = { id: "run-a", status: "running", version: 2, updatedAt: "2026-11-03T12:00:00Z" };
function call(query = "view=status&ids=run-a", headers: Record<string, string> = {}) {
  return GET(new NextRequest(`https://zenith.test/api/platform/v1/coding-agent/runs?${query}`, {
    headers: { cookie: "zenith-workspace=ws-a", ...headers },
  }), { params: Promise.resolve({}) });
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("ZENITH_PLATFORM_ORIGIN", "https://zenith.test");
  mocks.claims.mockResolvedValue({ data: { claims: { sub: "operator", aal: "aal1", exp: Date.now() / 1000 + 600 } }, error: null });
  mocks.user.mockResolvedValue({ data: { user: { id: "operator", email_confirmed_at: new Date().toISOString() } }, error: null });
  mocks.identity.mockResolvedValue({ subject: "operator", emailVerified: true }); mocks.statuses.mockResolvedValue([status]);
  resetDb({ workspaces: [{ id: "ws-a", name: "A", slug: "a", createdAt: new Date().toISOString(), ownerId: "operator" }],
    members: [{ id: "operator", workspaceId: "ws-a", role: "admin", name: "Operator", email: "operator@example.test" }] });
});
afterEach(() => vi.unstubAllEnvs());

describe("browser analysis status projection", () => {
  it("returns only selected metadata without loading source-bearing runs or calling GitHub", async () => {
    const response = await call(); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ runs: [status] });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.statuses).toHaveBeenCalledWith({}, "ws-a", ["run-a"]);
    expect(mocks.source).not.toHaveBeenCalled(); expect(mocks.store).not.toHaveBeenCalled();
  });
  it("rechecks browser identity and current admin membership before metadata is read", async () => {
    expect((await call(undefined, { authorization: "Bearer za_forbidden" })).status).toBe(403);
    db().members[0].role = "viewer"; expect((await call()).status).toBe(403);
    db().members[0].role = "admin"; expect((await call(undefined, { "x-zenith-workspace": "foreign" })).status).toBe(404);
    expect(mocks.statuses).not.toHaveBeenCalled();
  });
  it("bounds the selected IDs and refuses unknown query authority", async () => {
    for (const query of ["view=status", "ids=run-a", "view=status&ids=run-a&workspaceId=foreign", `view=status&ids=${Array.from({ length: 51 }, (_, i) => `run-${i}`).join(",")}`]) {
      expect((await call(query)).status).toBe(400);
    }
    expect(mocks.statuses).not.toHaveBeenCalled();
  });
});
