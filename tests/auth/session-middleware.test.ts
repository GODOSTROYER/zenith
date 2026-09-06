import { AuthInvalidJwtError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateSession } from "@/lib/supabase/middleware";

const mocks = vi.hoisted(() => ({ getClaims: vi.fn() }));
type CookieWrite = {
  name: string;
  value: string;
  options: { path: string; sameSite: "lax"; maxAge: number };
};
let cookieBatches: CookieWrite[][] = [];
const refreshedCookie: CookieWrite = {
  name: "sb-test-auth-token",
  value: "test-session",
  options: { path: "/", sameSite: "lax", maxAge: 3600 },
};

vi.mock("@/lib/supabase/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase/env")>()),
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_PUBLIC_KEY: "test-public-key",
  isSupabaseConfigured: () => true,
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, options: {
    cookies: { setAll: (cookies: CookieWrite[]) => void };
  }) => ({
    auth: {
      getClaims: async () => {
        for (const batch of cookieBatches) options.cookies.setAll(batch);
        return mocks.getClaims();
      },
    },
  }),
}));

beforeEach(() => {
  cookieBatches = [];
  mocks.getClaims.mockReset().mockResolvedValue({ data: null, error: null });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("session middleware", () => {
  it.each([0, 503])("explains transient verification failures (status %i) without exposing error details", async (status) => {
    mocks.getClaims.mockResolvedValue({
      data: null,
      error: new AuthRetryableFetchError("private response details", status),
    });
    const response = await updateSession(new NextRequest("http://localhost:3400/overview"));
    const redirect = new URL(response.headers.get("location")!);
    expect(redirect.pathname).toBe("/login");
    expect(redirect.searchParams.get("next")).toBe("/overview");
    expect(redirect.searchParams.get("error")).toBe("auth_unavailable");
    expect(console.warn).toHaveBeenCalledWith("[auth] Session verification failed", {
      name: "AuthRetryableFetchError", code: undefined, status,
    });
    expect(response.headers.get("location")).not.toContain("private");
  });

  it("requires sign-in for a missing session without reporting an outage", async () => {
    const response = await updateSession(new NextRequest("http://localhost:3400/overview"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3400/login?next=%2Foverview");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("rejects invalid JWTs without mislabeling them as a network failure", async () => {
    mocks.getClaims.mockResolvedValue({ data: null, error: new AuthInvalidJwtError("invalid") });
    const response = await updateSession(new NextRequest("http://localhost:3400/overview"));
    expect(new URL(response.headers.get("location")!).searchParams.has("error")).toBe(false);
  });

  it("keeps the public login page accessible during an outage", async () => {
    mocks.getClaims.mockResolvedValue({ data: null, error: new AuthRetryableFetchError("fetch failed", 0) });
    const response = await updateSession(new NextRequest("http://localhost:3400/login?error=auth_unavailable"));
    expect(response.status).toBe(200);
    expect(response.headers.has("location")).toBe(false);
  });

  it.each([
    { path: "/overview", signedIn: true, status: 200, location: null },
    { path: "/login", signedIn: true, status: 307, location: "/overview" },
    { path: "/signup", signedIn: true, status: 307, location: "/overview" },
    { path: "/overview", signedIn: false, status: 307, location: "/login" },
    { path: "/api/bootstrap", signedIn: false, status: 401, location: null },
    { path: "/login", signedIn: false, status: 200, location: null },
  ])("preserves session cookie updates for $path with signedIn=$signedIn", async ({ path, signedIn, status, location }) => {
    cookieBatches = [[refreshedCookie]];
    mocks.getClaims.mockResolvedValue({ data: signedIn ? { claims: { sub: "test-user" } } : null, error: null });
    const request = new NextRequest(`http://localhost:3400${path}`);
    const response = await updateSession(request);
    expect(response.status).toBe(status);
    const actualLocation = response.headers.get("location");
    expect(actualLocation ? new URL(actualLocation).pathname : null).toBe(location);
    expect(response.cookies.get(refreshedCookie.name)).toMatchObject({
      name: refreshedCookie.name, value: refreshedCookie.value, ...refreshedCookie.options,
    });
    expect(request.cookies.get(refreshedCookie.name)?.value).toBe(refreshedCookie.value);
    if (status === 401) expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps cookie deletions and writes across multiple refresh batches", async () => {
    const removedCookie = { ...refreshedCookie, name: "sb-test-auth-token.0", value: "", options: { ...refreshedCookie.options, maxAge: 0 } };
    cookieBatches = [[removedCookie], [refreshedCookie]];
    const response = await updateSession(new NextRequest("http://localhost:3400/overview"));
    expect(response.cookies.get(removedCookie.name)).toMatchObject({ value: "", maxAge: 0 });
    expect(response.cookies.get(refreshedCookie.name)?.value).toBe(refreshedCookie.value);
  });
});
