/** Real Supabase SSR SDK, with only Auth HTTP and Next's cookie store substituted. */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, expect, it, vi } from "vitest";
import { IDENTITY_LINK_COOKIE } from "@/lib/auth/identity-link";

const state = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  writes: [] as { name: string; value: string }[],
}));
vi.mock("next/headers", () => ({ cookies: async () => ({
  getAll: () => [...state.jar].map(([name, value]) => ({ name, value })),
  set: (name: string, value: string) => {
    state.writes.push({ name, value });
    if (value) state.jar.set(name, value); else state.jar.delete(name);
  },
}) }));
vi.mock("@/lib/supabase/env", () => ({
  SUPABASE_URL: "https://google-link-test.supabase.co", SUPABASE_PUBLIC_KEY: "test-public-key",
  SUPABASE_OAUTH_PROVIDERS: ["google"], isSupabaseConfigured: () => true,
}));
vi.mock("@/lib/waitlist/access", () => ({ getWaitlistAccess: async () => ({ allowed: true }) }));
vi.mock("@/lib/auth/server-destination", () => ({ resolveAuthDestination: async () => "/overview" }));
const { POST } = await import("@/app/api/account/identities/link/route");
const { GET } = await import("@/app/auth/callback/route");

afterEach(() => { vi.unstubAllGlobals(); state.jar.clear(); state.writes = []; });

it("carries the server-created PKCE verifier into callback and writes the exchanged session", async () => {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const token = (version: string) => `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "u-ada", exp: expires, version })).toString("base64url")}.dGVzdA`;
  const oldToken = token("before-link");
  const newToken = token("after-link");
  const user = (linked: boolean) => ({
    id: "u-ada", aud: "authenticated", role: "authenticated", email: "ada@example.test",
    email_confirmed_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z",
    app_metadata: {}, user_metadata: {}, identities: [
      { id: "email-id", identity_id: "email-id", user_id: "u-ada", provider: "email", identity_data: { email: "ada@example.test" } },
      ...(linked ? [{ id: "google-id", identity_id: "google-id", user_id: "u-ada", provider: "google", identity_data: { email: "ada@example.test" } }] : []),
    ],
  });
  const storageKey = "sb-google-link-test-auth-token";
  state.jar.set(storageKey, `base64-${Buffer.from(JSON.stringify({
    access_token: oldToken, refresh_token: "old-refresh-token", token_type: "bearer", expires_at: expires, expires_in: 3600, user: user(false),
  })).toString("base64url")}`);
  let linked = false;
  let authorizeUrl: URL | undefined;
  let exchangeBody: { auth_code: string; code_verifier: string } | undefined;
  const requestFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/auth/v1/user") return Response.json(user(linked));
    if (url.pathname === "/auth/v1/user/identities/authorize") {
      authorizeUrl = url;
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${oldToken}`);
      return Response.json({ url: "https://accounts.google.com/test-consent" });
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce") {
      exchangeBody = JSON.parse(String(init?.body));
      linked = true;
      return Response.json({ access_token: newToken, refresh_token: "new-refresh-token", token_type: "bearer", expires_in: 3600, user: user(true) });
    }
    throw new Error(`Unexpected Auth request ${url.pathname}`);
  });
  vi.stubGlobal("fetch", requestFetch);

  const start = await POST(new NextRequest("https://zenith.test/api/account/identities/link", {
    method: "POST", headers: { origin: "https://zenith.test", "content-type": "application/json" }, body: JSON.stringify({ provider: "google" }),
  }));
  expect(start.status).toBe(200);
  expect(authorizeUrl).toBeDefined();
  const verifierWrite = state.writes.find((cookie) => cookie.name.includes("code-verifier") && cookie.value);
  expect(verifierWrite, "SSR persisted PKCE verifier before provider redirect").toBeDefined();
  const intent = start.cookies.get(IDENTITY_LINK_COOKIE)!;
  state.jar.set(intent.name, intent.value);
  const returnUrl = new URL(authorizeUrl!.searchParams.get("redirect_to")!);
  returnUrl.searchParams.set("code", "google-authorization-code");
  const callback = await GET(new NextRequest(returnUrl, {
    headers: { cookie: [...state.jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ") },
  }));
  expect(new URL(callback.headers.get("location")!).searchParams.get("identity")).toBe("linked");
  expect(exchangeBody?.auth_code).toBe("google-authorization-code");
  expect(exchangeBody?.code_verifier.length).toBeGreaterThan(30);
  expect(createHash("sha256").update(exchangeBody!.code_verifier).digest("base64url")).toBe(authorizeUrl!.searchParams.get("code_challenge"));
  expect(callback.cookies.get(IDENTITY_LINK_COOKIE)?.value).toBe("");
  const finalCookie = state.jar.get(storageKey)!;
  const finalSession = JSON.parse(Buffer.from(finalCookie.slice("base64-".length), "base64url").toString());
  expect(finalSession.access_token).toBe(newToken);
  expect(finalSession.user.id).toBe("u-ada");
  expect(state.jar.has(verifierWrite!.name)).toBe(false);
});
