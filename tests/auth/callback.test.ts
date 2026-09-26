import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_LINK_COOKIE, type IdentityLinkIntent } from "@/lib/auth/identity-link";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(), exchange: vi.fn(), verify: vi.fn(), signOut: vi.fn(), access: vi.fn(),
  destination: vi.fn(), flush: vi.fn(), session: vi.fn(), inScope: false,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: {
  getUser: mocks.getUser, exchangeCodeForSession: mocks.exchange, verifyOtp: mocks.verify, signOut: mocks.signOut,
} }) }));
vi.mock("@/lib/waitlist/access", () => ({ getWaitlistAccess: mocks.access }));
vi.mock("@/lib/server/workspace", () => ({ destinationAfterAuth: mocks.destination }));
vi.mock("@/lib/db/store", () => ({
  runInStoreScope: async (body: () => Promise<unknown>) => {
    mocks.inScope = true;
    try { return await body(); } finally { mocks.inScope = false; }
  },
  flushPendingAsync: mocks.flush,
}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/supabase/env", () => ({ isSupabaseConfigured: () => true }));
const { GET } = await import("@/app/auth/callback/route");
const { GET: CONTINUE } = await import("@/app/auth/continue/route");
const user = { id: "u-ada", email: "ada@example.test", identities: [{ provider: "google" }] };
const intent = (): IdentityLinkIntent => ({ userId: user.id, provider: "google", state: "e4dca1dc-ae0a-4e3c-9d86-447cd1db57c2", createdAt: Date.now() });
const callback = (query: string, link?: IdentityLinkIntent) => GET(new NextRequest(`https://zenith.test/auth/callback?${query}`, {
  headers: link ? { cookie: `${IDENTITY_LINK_COOKIE}=${encodeURIComponent(JSON.stringify(link))}` } : {},
}));
const location = (response: Response) => new URL(response.headers.get("location")!);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.inScope = false;
  mocks.getUser.mockResolvedValue({ data: { user }, error: null });
  mocks.session.mockResolvedValue(user);
  mocks.exchange.mockResolvedValue({ error: null });
  mocks.verify.mockResolvedValue({ error: null });
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.access.mockResolvedValue({ allowed: true, reason: "open" });
  mocks.destination.mockImplementation(async () => { expect(mocks.inScope).toBe(true); return "/overview"; });
  mocks.flush.mockImplementation(async () => { expect(mocks.inScope).toBe(true); return true; });
});

describe("Google and email authentication callback", () => {
  it("exchanges PKCE then checks access and durably resolves workspace membership", async () => {
    const response = await callback("code=google-code&next=%2Fp%2Fatlas%2Fmap");
    expect(mocks.exchange).toHaveBeenCalledWith("google-code");
    expect(mocks.access).toHaveBeenCalledWith({ id: user.id, email: user.email });
    expect(mocks.destination).toHaveBeenCalledWith("/p/atlas/map");
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(location(response).pathname).toBe("/overview");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(mocks.exchange.mock.invocationCallOrder[0]).toBeLessThan(mocks.access.mock.invocationCallOrder[0]);
    expect(mocks.access.mock.invocationCallOrder[0]).toBeLessThan(mocks.destination.mock.invocationCallOrder[0]);
  });
  it("selects the PKCE flow returned by the SDK instead of another tab's verifier", async () => {
    await callback("code=google-code&sb_flow_id=flow-returned-by-auth");
    expect(mocks.exchange).toHaveBeenCalledWith("google-code", { flowId: "flow-returned-by-auth" });
  });
  it("lets waiting users finish verified password recovery without resolving membership", async () => {
    mocks.access.mockResolvedValue({ allowed: false });
    const response = await callback("token_hash=reset-token&type=recovery&next=%2Freset-password%3Fnext%3D%252Finvite%253Finvite%253Dabc");
    expect(location(response).pathname).toBe("/reset-password");
    expect(mocks.verify).toHaveBeenCalledWith({ token_hash: "reset-token", type: "recovery" });
    expect(mocks.getUser).toHaveBeenCalled();
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.destination).not.toHaveBeenCalled();
  });
  it("routes unapproved people to waitlist before accepting workspace invites", async () => {
    mocks.access.mockResolvedValue({ allowed: false, reason: "waiting" });
    expect(location(await callback("code=google-code")).pathname).toBe("/waitlist");
    expect(mocks.destination).not.toHaveBeenCalled();
    expect(mocks.flush).not.toHaveBeenCalled();
  });
  it("keeps a safe continuation and fixed copy when Google consent is cancelled", async () => {
    const response = await callback("error=access_denied&error_description=attacker-text&next=%2Fapps%2Faccept%3Ftoken%3Dabc");
    expect(location(response).searchParams.get("error")).toBe("oauth_denied");
    expect(location(response).searchParams.get("next")).toBe("/apps/accept?token=abc");
    expect(response.headers.get("location")).not.toContain("attacker-text");
    expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it("discards an unsafe return target", async () => {
    await callback("code=google-code&next=%2F%0A%2Fevil.test");
    expect(mocks.destination).toHaveBeenCalledWith(undefined);
  });
  it("requires a verified user even after a successful exchange", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: new Error("missing user") });
    expect(location(await callback("code=google-code")).searchParams.get("error")).toBe("auth_unavailable");
    expect(mocks.access).not.toHaveBeenCalled();
  });
  it("accepts supported email tokens but never treats a link intent as email verification", async () => {
    await callback("token_hash=reset-token&type=recovery&next=%2Freset-password");
    expect(mocks.verify).toHaveBeenCalledWith({ token_hash: "reset-token", type: "recovery" });
    mocks.verify.mockClear();
    await callback("token_hash=token&type=unsupported");
    expect(mocks.verify).not.toHaveBeenCalled();
  });
  it("does not redirect before a database flush succeeds", async () => {
    mocks.flush.mockRejectedValue(new Error("database unavailable"));
    expect(location(await callback("code=google-code")).pathname).toBe("/login");
  });
});

describe("explicit identity linking callback", () => {
  it("returns to account settings only when the same user now has the provider", async () => {
    const link = intent();
    const response = await callback(`intent=link&code=linked&link_state=${link.state}`, link);
    expect(mocks.getUser).toHaveBeenCalledTimes(2);
    expect(location(response).pathname).toBe("/account");
    expect(location(response).searchParams.get("identity")).toBe("linked");
    expect(response.cookies.get(IDENTITY_LINK_COOKIE)?.value).toBe("");
    expect(mocks.destination).not.toHaveBeenCalled();
  });
  it.each(["missing", "expired", "wrong-state"])("rejects %s intent before exchanging a code", async (kind) => {
    const link = intent();
    if (kind === "expired") link.createdAt -= 11 * 60 * 1000;
    const response = await callback(`intent=link&code=linked&link_state=${kind === "wrong-state" ? "wrong" : link.state}`, kind === "missing" ? undefined : link);
    expect(location(response).searchParams.get("identity_error")).toBe("identity_link_expired");
    expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it("rejects a different current account before exchanging a code", async () => {
    const link = intent();
    mocks.getUser.mockResolvedValue({ data: { user: { ...user, id: "different" } }, error: null });
    const response = await callback(`intent=link&code=linked&link_state=${link.state}`, link);
    expect(location(response).searchParams.get("identity_error")).toBe("identity_link_mismatch");
    expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it("clears the local session when exchange unexpectedly changes account", async () => {
    const link = intent();
    mocks.getUser.mockResolvedValueOnce({ data: { user }, error: null });
    mocks.getUser.mockResolvedValueOnce({ data: { user: { ...user, id: "different" } }, error: null });
    const response = await callback(`intent=link&code=linked&link_state=${link.state}`, link);
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(location(response).pathname).toBe("/login");
    expect(mocks.access).not.toHaveBeenCalled();
  });
  it("shows a cancelled linking notice in settings and keeps the existing session", async () => {
    const link = intent();
    const response = await callback(`intent=link&error=access_denied&link_state=${link.state}`, link);
    expect(location(response).searchParams.get("identity_error")).toBe("identity_link_cancelled");
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
  it("does not claim a link succeeded when the provider is absent", async () => {
    const link = intent();
    mocks.getUser.mockResolvedValue({ data: { user: { ...user, identities: [] } }, error: null });
    const response = await callback(`intent=link&code=linked&link_state=${link.state}`, link);
    expect(location(response).searchParams.get("identity_error")).toBe("identity_link_failed");
  });
});

describe("already signed in continuation", () => {
  it("resolves and flushes in the same store scope", async () => {
    expect(location(await CONTINUE(new NextRequest("https://zenith.test/auth/continue?next=/account"))).pathname).toBe("/overview");
    expect(mocks.destination).toHaveBeenCalledWith("/account");
    expect(mocks.flush).toHaveBeenCalledOnce();
  });
  it("redirects a waitlisted session before reading workspace state", async () => {
    mocks.access.mockResolvedValue({ allowed: false });
    expect(location(await CONTINUE(new NextRequest("https://zenith.test/auth/continue"))).pathname).toBe("/waitlist");
    expect(mocks.destination).not.toHaveBeenCalled();
  });
  it("retains safe login continuation for a signed-out visitor", async () => {
    mocks.session.mockResolvedValue(null);
    const response = await CONTINUE(new NextRequest("https://zenith.test/auth/continue?next=%2Fapps%2Faccept%3Ftoken%3Dabc"));
    expect(location(response).searchParams.get("next")).toBe("/apps/accept?token=abc");
    expect(mocks.access).not.toHaveBeenCalled();
  });
});
