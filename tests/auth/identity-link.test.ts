import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_LINK_COOKIE, readIdentityLinkIntent } from "@/lib/auth/identity-link";
const mocks = vi.hoisted(() => ({ getUser: vi.fn(), linkIdentity: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: mocks }) }));
vi.mock("@/lib/supabase/env", () => ({ isSupabaseConfigured: () => true, SUPABASE_OAUTH_PROVIDERS: ["google"] }));
const { POST } = await import("@/app/api/account/identities/link/route");
const post = (provider: unknown = "google", origin = "https://zenith.test") => POST(new NextRequest("https://zenith.test/api/account/identities/link", {
  method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ provider }),
}));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "u-ada", identities: [{ provider: "email" }] } }, error: null });
  mocks.linkIdentity.mockResolvedValue({ data: { url: "https://accounts.google.com/test-oauth" }, error: null });
});

describe("starting an identity link", () => {
  it("uses linkIdentity and binds the callback to the verified current user", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "https://accounts.google.com/test-oauth" });
    const intent = readIdentityLinkIntent(response.cookies.get(IDENTITY_LINK_COOKIE)?.value)!;
    expect(intent).toMatchObject({ userId: "u-ada", provider: "google" });
    expect(mocks.linkIdentity).toHaveBeenCalledWith({ provider: "google", options: {
      redirectTo: `https://zenith.test/auth/callback?intent=link&link_state=${intent.state}`,
      skipBrowserRedirect: true, queryParams: { prompt: "select_account" },
    } });
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("set-cookie")).toContain("SameSite=lax");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects a cross-site post before reading or changing authentication", async () => {
    expect((await post("google", "https://evil.test")).status).toBe(403);
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.linkIdentity).not.toHaveBeenCalled();
  });
  it("refuses unknown or disabled providers", async () => {
    expect((await post("github")).status).toBe(400);
    expect((await post({ provider: "google" })).status).toBe(400);
    expect(mocks.linkIdentity).not.toHaveBeenCalled();
  });
  it("requires a live verified account", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: new Error("expired") });
    expect((await post()).status).toBe(401);
    expect(mocks.linkIdentity).not.toHaveBeenCalled();
  });
  it("does not initiate a second link for an already connected provider", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "u-ada", identities: [{ provider: "google" }] } }, error: null });
    expect((await post()).status).toBe(409);
    expect(mocks.linkIdentity).not.toHaveBeenCalled();
  });
  it("explains disabled manual linking without returning provider diagnostics", async () => {
    mocks.linkIdentity.mockResolvedValue({ data: null, error: { code: "manual_linking_disabled", message: "private diagnostics" } });
    const response = await post();
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.fix).toContain("Enable manual identity linking");
    expect(JSON.stringify(body)).not.toContain("private diagnostics");
    expect(response.cookies.get(IDENTITY_LINK_COOKIE)).toBeUndefined();
  });
});

it("discards malformed and future-dated correlation cookies", () => {
  for (const raw of [undefined, "not-json", "{}", "null", JSON.stringify({ userId: "u", provider: "google", state: "x".repeat(36), createdAt: Date.now() + 60000 })])
    expect(readIdentityLinkIntent(raw)).toBeNull();
});
