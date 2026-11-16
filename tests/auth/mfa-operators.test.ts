/** Raw operator routes also enforce the same guard. Supabase and stores are explicit doubles. */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireOpsOperator } from "@/lib/ops/operator";
import { requireWaitlistOperator } from "@/lib/waitlist/http";
import { PUT as maintenance } from "@/app/api/admin/ops/maintenance/route";

const mocks = vi.hoisted(() => ({ id: "", claims: vi.fn(), user: vi.fn(), mutation: vi.fn(), prime: vi.fn(), session: true }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getClaims: mocks.claims, getUser: mocks.user } }) }));
vi.mock("@/lib/supabase/env", () => ({ SUPABASE_URL: "http://auth.test", SUPABASE_PUBLIC_KEY: "", isSupabaseConfigured: () => true }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: async () => mocks.session ? { id: mocks.id } : null }));
vi.mock("@/lib/ops/runtime", () => ({ platformConfigured: () => true, opsRuntime: () => ({ limits: {}, maintenance: { prime: mocks.prime } }) }));
vi.mock("@/lib/controlplane/db", () => ({ platformDb: async () => ({}) }));
vi.mock("@/lib/ops/store", () => ({ setMaintenance: mocks.mutation, getMaintenance: async () => ({ mode: "off", version: 0 }), maintenanceHistory: async () => [], drainStatus: async () => ({}) }));
const request = (method = "PUT", headers: Record<string, string> = {}) => new NextRequest("https://zenith.test/api/admin/ops/maintenance", { method, headers: { origin: "https://zenith.test", "content-type": "application/json", ...headers }, ...(method === "GET" ? {} : { body: JSON.stringify({ mode: "off" }) }) });
beforeEach(() => {
  vi.clearAllMocks(); mocks.id = randomUUID(); mocks.session = true;
  vi.stubEnv("ZENITH_OPS_ADMIN_IDS", mocks.id); vi.stubEnv("ZENITH_WAITLIST_ADMIN_IDS", mocks.id); vi.stubEnv("ZENITH_PLATFORM_ORIGIN", "https://zenith.test");
  mocks.claims.mockResolvedValue({ data: { claims: { sub: mocks.id, aal: "aal2", exp: Date.now() / 1000 + 600 } }, error: null });
  mocks.user.mockResolvedValue({ data: { user: { id: mocks.id, email_confirmed_at: new Date().toISOString(), factors: [{ factor_type: "totp", status: "verified" }] } }, error: null });
  mocks.mutation.mockResolvedValue({ mode: "off", version: 1 });
});
afterEach(() => { vi.unstubAllEnvs(); });
describe("operator step-up", () => {
  it("does not change maintenance at AAL1", async () => {
    mocks.claims.mockResolvedValue({ data: { claims: { sub: mocks.id, aal: "aal1" } }, error: null });
    expect((await maintenance(request())).status).toBe(403); expect(mocks.mutation).not.toHaveBeenCalled(); expect(mocks.prime).not.toHaveBeenCalled();
  });
  it("permits an allowlisted AAL2 operator and keeps the audit actor", async () => {
    expect((await maintenance(request())).status).toBe(200);
    expect(mocks.mutation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actor: mocks.id })); expect(mocks.prime).toHaveBeenCalledOnce();
  });
  it("requires AAL2 on waitlist admission/preview mutations but does not require it to inspect", async () => {
    mocks.claims.mockResolvedValue({ data: { claims: { sub: mocks.id, aal: "aal1" } }, error: null });
    await expect(requireWaitlistOperator(request("POST"))).rejects.toMatchObject({ status: 403 });
    await expect(requireWaitlistOperator(request("GET"))).resolves.toMatchObject({ id: mocks.id });
  });
  it.each<Record<string, string>>([{}, { authorization: "Bearer invalid" }, { origin: "https://attacker.test" }])("fails closed on unavailable provider or wrong transport %j", async (headers) => {
    mocks.user.mockRejectedValueOnce(new Error(randomUUID()));
    expect([403, 503]).toContain((await maintenance(request("PUT", headers))).status); expect(mocks.mutation).not.toHaveBeenCalled();
  });
  it("does not turn a workspace admin into an installation operator", async () => {
    vi.stubEnv("ZENITH_OPS_ADMIN_IDS", randomUUID());
    await expect(requireOpsOperator(request(), true)).rejects.toMatchObject({ status: 403 }); expect(mocks.claims).not.toHaveBeenCalled();
  });
  it("still refuses signed-out callers before querying MFA", async () => {
    mocks.session = false; await expect(requireOpsOperator(request(), true)).rejects.toMatchObject({ status: 401 }); expect(mocks.claims).not.toHaveBeenCalled();
  });
});
