/** Supabase contract tests only. SDK identity/claims replies are explicitly mocked. */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { requireStepUp } from "@/lib/auth/mfa";
import { workspaceMfaControl } from "@/lib/auth/mfa-policy";
import { mfaReturnPath } from "@/lib/auth/mfa-navigation";

const mocks = vi.hoisted(() => ({ claims: vi.fn(), user: vi.fn(), factory: vi.fn(), controls: vi.fn(), configured: true }));
vi.mock("@/lib/controlplane/db/open", () => ({ platformDb: async () => ({}) }));
vi.mock("@/lib/controlplane/db/repos/workspace-mfa-controls", () => ({ getWorkspaceMfaControls: mocks.controls }));
vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.factory }));
vi.mock("@/lib/supabase/env", () => ({ SUPABASE_URL: "http://auth.test", SUPABASE_PUBLIC_KEY: "", isSupabaseConfigured: () => mocks.configured }));
const req = (headers: Record<string, string> = {}, method = "POST") => new NextRequest("https://zenith.test/api/platform/v1/operations/op/approve", { method, headers: { origin: "https://zenith.test", ...headers } });
const check = (request = req(), workspaceId = "ws-a") => requireStepUp(request, { subject: "operator", workspaceId });
const claims = (fields: Record<string, unknown> = {}) => ({ data: { claims: { sub: "operator", aal: "aal2", exp: Math.floor(Date.now() / 1000) + 600, ...fields } }, error: null });
const user = (fields: Record<string, unknown> = {}) => ({ data: { user: { id: "operator", email_confirmed_at: new Date().toISOString(), factors: [{ id: randomUUID(), status: "verified", factor_type: "totp" }], ...fields } }, error: null });
beforeEach(() => {
  vi.resetAllMocks(); mocks.configured = true;
  mocks.claims.mockResolvedValue(claims()); mocks.user.mockResolvedValue(user());
  mocks.factory.mockReturnValue({ auth: { getClaims: mocks.claims, getUser: mocks.user } });
  mocks.controls.mockImplementation((_sql, workspaceId) => ({ workspaceId, privilegedActionsRequireAal2: true, requireForAllMutations: false, maxAgeSeconds: null, version: 0, isDefault: true }));
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("requireStepUp Supabase contract", () => {
  it("requires signed AAL2 claims and a live verified subject with an enrolled factor", async () => {
    await expect(check()).resolves.toEqual({ subject: "operator", aal: "aal2" });
    expect(mocks.claims).toHaveBeenCalledOnce(); expect(mocks.user).toHaveBeenCalledOnce();
    const options = mocks.factory.mock.calls[0][2];
    expect(options.cookies.getAll()).toEqual([]);
    options.cookies.setAll([{ name: "ignored", value: randomUUID() }]);
  });
  it.each([undefined, null, "aal1", "aal3", "AAL2", 2, true])("refuses missing or unknown AAL %s", async (aal) => {
    mocks.claims.mockResolvedValue(claims({ aal, user_metadata: { aal: "aal2" }, app_metadata: { aal: "aal2", role: "admin" } }));
    await expect(check()).rejects.toMatchObject({ status: 403 }); expect(mocks.user).not.toHaveBeenCalled();
  });
  it.each([undefined, 0, NaN, Infinity, Math.floor(Date.now() / 1000) - 1])("refuses missing/expired token expiry %s", async (exp) => {
    mocks.claims.mockResolvedValue(claims({ exp })); await expect(check()).rejects.toMatchObject({ status: 403 });
  });
  it.each(["other-operator", undefined])( "binds the claims to the resolved subject %s", async (sub) => {
    mocks.claims.mockResolvedValue(claims({ sub })); await expect(check()).rejects.toMatchObject({ status: 401 });
  });
  it.each([{ id: "other" }, { email_confirmed_at: null }, { id: "" }])("refuses changed or unverified live identity %j", async (fields) => {
    mocks.user.mockResolvedValue(user(fields)); await expect(check()).rejects.toMatchObject({ status: 401 });
  });
  it.each([undefined, [], [{ status: "unverified", factor_type: "totp" }], [{ status: "verified", factor_type: "phone" }]])("refuses revoked/unverified TOTP factors %j", async (factors) => {
    mocks.user.mockResolvedValue(user({ factors })); await expect(check()).rejects.toMatchObject({ status: 403 });
  });
  it.each([401, 403, 429, 500, undefined])("classifies live provider error %s without admitting", async (status) => {
    mocks.user.mockResolvedValue({ data: { user: null }, error: { status, message: randomUUID() } });
    await expect(check()).rejects.toMatchObject({ status: status === 401 || status === 403 ? 401 : 503 });
  });
  it("fails closed on provider configuration, SDK construction and network/signature failures", async () => {
    mocks.configured = false; await expect(check()).rejects.toMatchObject({ status: 503 });
    mocks.configured = true; mocks.factory.mockImplementationOnce(() => { throw new Error(randomUUID()); });
    await expect(check()).rejects.toMatchObject({ status: 503 });
    mocks.claims.mockRejectedValueOnce(new Error(randomUUID())); await expect(check()).rejects.toMatchObject({ status: 503 });
    mocks.claims.mockResolvedValueOnce({ data: null, error: new Error(randomUUID()) }); await expect(check()).rejects.toMatchObject({ status: 503 });
    mocks.user.mockRejectedValueOnce(new Error(randomUUID())); await expect(check()).rejects.toMatchObject({ status: 503 });
  });
  it.each<Record<string, string>>([{ authorization: "" }, { authorization: `Bearer ${randomUUID()}` }, { "x-zenith-actor": "navigator" }, { "x-zenith-actor-key": randomUUID() }, { origin: "null" }, { origin: "https://zenith.test.attacker.test" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }])("rejects non-browser transport %j", async (headers) => {
    await expect(check(req(headers))).rejects.toMatchObject({ status: 403 }); expect(mocks.factory).not.toHaveBeenCalled();
  });
  it("requires origin on mutations and refuses malformed configured origins", async () => {
    const request = req(); request.headers.delete("origin"); await expect(check(request)).rejects.toMatchObject({ status: 403 });
    vi.stubEnv("ZENITH_PLATFORM_ORIGIN", "not an origin"); await expect(check()).rejects.toMatchObject({ status: 403 });
  });
  it("does not cache an earlier successful verification", async () => {
    const request = req(); await check(request); mocks.user.mockResolvedValueOnce({ data: { user: null }, error: { status: 401 } });
    await expect(check(request)).rejects.toMatchObject({ status: 401 }); expect(mocks.user).toHaveBeenCalledTimes(2);
  });
  it("uses workspace MFA age, never JWT refresh time, and rejects absent/future AMR", async () => {
    mocks.controls.mockImplementation((_sql, workspaceId) => ({ privilegedActionsRequireAal2: true, requireForAllMutations: false, maxAgeSeconds: workspaceId === "ws-a" ? 120 : null }));
    const now = Math.floor(Date.now() / 1000);
    for (const amr of [undefined, [{ method: "password", timestamp: now }], [{ method: "totp", timestamp: now - 121 }], [{ method: "totp", timestamp: now + 1 }]]) {
      mocks.claims.mockResolvedValue(claims({ amr, iat: now })); await expect(check()).rejects.toMatchObject({ status: 403 });
    }
    mocks.claims.mockResolvedValue(claims({ amr: [{ method: "totp", timestamp: now }] })); await expect(check()).resolves.toMatchObject({ aal: "aal2" });
    mocks.claims.mockResolvedValue(claims()); await expect(check(req(), "ws-b")).resolves.toMatchObject({ aal: "aal2" });
  });
});

describe("workspace controls and return navigation", () => {
  it("reads current per-workspace state without using the removed host map", async () => {
    vi.stubEnv("ZENITH_MFA_WORKSPACE_CONTROLS", JSON.stringify({ "ws-a": { requireForAllMutations: false } }));
    mocks.controls.mockImplementation((_sql, workspaceId) => ({ privilegedActionsRequireAal2: true, requireForAllMutations: workspaceId === "ws-a", maxAgeSeconds: workspaceId === "ws-a" ? 300 : null }));
    expect(await workspaceMfaControl("ws-a")).toEqual({ privilegedActionsRequireAal2: true, requireForAllMutations: true, maxAgeSeconds: 300 });
    expect(await workspaceMfaControl("ws-b")).toEqual({ privilegedActionsRequireAal2: true, requireForAllMutations: false, maxAgeSeconds: null });
  });
  it("refuses mutations on store failure rather than using defaults", async () => {
    mocks.controls.mockRejectedValue(new Error(randomUUID()));
    await expect(workspaceMfaControl("ws-a")).rejects.toMatchObject({ status: 503 });
    await expect(check()).rejects.toMatchObject({ status: 503 }); expect(mocks.factory).not.toHaveBeenCalled();
  });
  it.each(["{", "[]", "null", JSON.stringify({ a: { privilegedActionsRequireAal2: false } }), JSON.stringify({ a: { requireForAllMutations: "true" } }), JSON.stringify({ a: { maxAgeSeconds: 0 } }), JSON.stringify({ a: { maxAgeSeconds: 90000 } })])("ignores the retired host-map input %s and retains persisted enforcement", async (raw) => {
    vi.stubEnv("ZENITH_MFA_WORKSPACE_CONTROLS", raw);
    const persisted = { privilegedActionsRequireAal2: true, requireForAllMutations: true, maxAgeSeconds: 300 };
    mocks.controls.mockResolvedValue(persisted);
    await expect(workspaceMfaControl("ws-a")).resolves.toEqual(persisted);
  });
  it("uses the immutable minimum for installation controls without a workspace", async () => {
    expect(await workspaceMfaControl()).toEqual({ privilegedActionsRequireAal2: true, requireForAllMutations: false, maxAgeSeconds: null });
    expect(mocks.controls).not.toHaveBeenCalled();
  });
  it.each([undefined, "https://attacker.test", "//attacker.test", "/\\attacker.test", "/auth/callback", "/api/actions/deploy.approve", "/platform\n/approve"])("rejects unsafe return %s", (path) => {
    expect(mfaReturnPath(path)).toBe("/platform");
  });
  it("preserves the local review URL only", () => {
    expect(mfaReturnPath("/platform/operations/op?workspace=ws-a#plan")).toBe("/platform/operations/op?workspace=ws-a#plan");
  });
});
