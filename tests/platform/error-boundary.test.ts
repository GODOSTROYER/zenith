/** Real route/step-up/SDK boundaries; only provider, session and policy replies are synthetic. */
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-platform-errors-", { fast: true });
const auth = vi.hoisted(() => ({ claims: vi.fn(), user: vi.fn(), policy: vi.fn(), configured: true }));
vi.mock("@/lib/server/boot", () => ({ ensureBoot: async () => undefined }));
vi.mock("@/lib/waitlist/enforcement", () => ({ requireProductRequestAccess: async () => undefined }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: async () => ({ id: "operator", email: "operator@zenith.test", name: "Operator" }) }));
vi.mock("@/lib/supabase/env", () => ({ SUPABASE_URL: "https://auth.test", SUPABASE_PUBLIC_KEY: "synthetic-publishable-key", isSupabaseConfigured: () => auth.configured }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getClaims: auth.claims, getUser: auth.user } }) }));
vi.mock("@/lib/controlplane/db/open", () => ({ platformDb: async () => ({}) }));
vi.mock("@/lib/controlplane/db/repos/workspace-mfa-controls", () => ({ getWorkspaceMfaControls: auth.policy }));
const credential = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("@/lib/agent-access/authority", () => ({ requireCredentialAuthority: async () => credential }));

const { resetDb } = await import("@/lib/db/store");
const { ApiError, errorResponse } = await import("@/lib/server/errors");
const { platformRoute } = await import("@/app/api/platform/v1/_lib/http");
const { createPlatformClient, PlatformApiError } = await import("@/lib/sdk");
const { setOpsRuntimeForTests, buildRuntime } = await import("@/lib/ops/runtime");
const { opsLimitsFromEnv } = await import("@/lib/ops/config");
const handle = vi.fn(async () => ({ body: { accepted: true } }));
const handler = platformRoute(handle);
const call = (headers: Record<string, string> = {}, path = "/operations/op/approve") => handler(new NextRequest(`https://zenith.test/api/platform/v1${path}`, {
  method: "POST", headers: { origin: "https://zenith.test", "sec-fetch-site": "same-origin", "x-zenith-workspace": "ws_errors", ...headers },
}), { params: Promise.resolve({}) });

beforeEach(() => {
  vi.clearAllMocks(); auth.configured = true;
  vi.stubEnv("ZENITH_STORE", "file"); vi.stubEnv("ZENITH_PLATFORM_ORIGIN", "https://zenith.test");
  resetDb({ workspaces: [{ id: "ws_errors", slug: "errors", name: "Errors", createdAt: new Date().toISOString() }], members: [{ id: "operator", workspaceId: "ws_errors", role: "admin", name: "Operator", email: "operator@zenith.test" }] });
  auth.claims.mockResolvedValue({ data: { claims: { sub: "operator", aal: "aal2", exp: Date.now() / 1000 + 600, amr: [{ method: "totp", timestamp: Date.now() / 1000 }] } }, error: null });
  auth.user.mockResolvedValue({ data: { user: { id: "operator", email_confirmed_at: new Date().toISOString(), factors: [{ factor_type: "totp", status: "verified" }] } }, error: null });
  auth.policy.mockResolvedValue({ privilegedActionsRequireAal2: true, requireForAllMutations: false, maxAgeSeconds: null });
  setOpsRuntimeForTests(buildRuntime(opsLimitsFromEnv({}), async () => { throw new Error("no ops database in fixture"); }));
});
afterEach(() => { vi.unstubAllEnvs(); setOpsRuntimeForTests(undefined); });

it.each<Record<string, string>>([{ authorization: "Bearer synthetic" }, { authorization: "" }, { "x-zenith-actor": "navigator" }, { "x-zenith-actor-key": "synthetic" }, { origin: "https://foreign.test" }, { "sec-fetch-site": "cross-site" }])("codes central browser refusals before handler or credential effects: %j", async (headers) => {
  const response = await call(headers);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: "browser_session_required" } });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-request-id")).toBeTruthy(); expect(response.headers.get("traceparent")).toBeTruthy();
  expect(handle).not.toHaveBeenCalled(); expect(credential.verify).not.toHaveBeenCalled(); expect(auth.claims).not.toHaveBeenCalled();
});

it.each(["aal1", "removed-factor"])("preserves MFA refusals and wire code: %s", async (mode) => {
  if (mode === "aal1") auth.claims.mockResolvedValue({ data: { claims: { sub: "operator", aal: "aal1", exp: Date.now() / 1000 + 600 } }, error: null });
  else auth.user.mockResolvedValue({ data: { user: { id: "operator", email_confirmed_at: new Date().toISOString(), factors: [] } }, error: null });
  const response = await call(); expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: "mfa_required" } }); expect(handle).not.toHaveBeenCalled();
});

it.each(["configuration", "provider", "policy"])("preserves unavailable refusals: %s", async (mode) => {
  if (mode === "configuration") auth.configured = false;
  if (mode === "provider") auth.claims.mockRejectedValue(new Error(randomUUID()));
  if (mode === "policy") auth.policy.mockRejectedValue(new Error(randomUUID()));
  const response = await call(); expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: "policy_unavailable" } }); expect(handle).not.toHaveBeenCalled();
});

it("the cookie SDK recognizes a real central guard refusal as PlatformApiError", async () => {
  auth.claims.mockResolvedValue({ data: { claims: { sub: "operator", aal: "aal1", exp: Date.now() / 1000 + 600 } }, error: null });
  const client = createPlatformClient({ baseUrl: "https://zenith.test", auth: { kind: "cookie" }, workspaceId: "ws_errors",
    fetch: (async (input, init) => handler(new NextRequest(String(input), { ...init, signal: init?.signal ?? undefined }), { params: Promise.resolve({}) })) as typeof fetch });
  const error = await client.cancelOperation("op").catch((error: unknown) => error);
  expect(error).toBeInstanceOf(PlatformApiError); expect(error).toMatchObject({ status: 403, code: "mfa_required" }); expect(handle).not.toHaveBeenCalled();
});

it("redacts and bounds platform ApiError diagnostics while generic bodies stay unchanged", async () => {
  const secret = `za_${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
  const error = new ApiError(`Bearer ${secret} ${"x".repeat(3000)}`, 403, { fix: `Bearer ${secret} ${"y".repeat(3000)}`, code: "mfa_required" });
  const mapped = platformRoute(async () => { throw error; });
  const response = await mapped(new NextRequest("https://zenith.test/api/platform/v1/test"), { params: Promise.resolve({}) });
  const body = await response.json();
  expect(body.error.code).toBe("mfa_required"); expect(JSON.stringify(body)).not.toContain(secret);
  expect(body.error.message.length).toBeLessThan(2100); expect(body.error.fix.length).toBeLessThan(2100);
  expect(await errorResponse(new ApiError("Refused", 403, { code: "mfa_required" })).json()).toEqual({ error: { message: "Refused" } });
});

it("omits arbitrary runtime metadata and custom serialization from platform errors", async () => {
  const diagnostic = randomUUID();
  const error = new ApiError("Refused", 403);
  Object.assign(error, { code: diagnostic, platformCode: diagnostic, details: { diagnostic }, cause: diagnostic, toJSON: () => ({ diagnostic }) });
  const mapped = platformRoute(async () => { throw error; });
  const response = await mapped(new NextRequest("https://zenith.test/api/platform/v1/test"), { params: Promise.resolve({}) });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: { code: "policy_denied", message: "Refused" } });
});
