import { NextRequest } from "next/server";
import { expect, it, vi } from "vitest";
vi.mock("@/lib/supabase/env", () => ({ isSupabaseConfigured: () => false }));
vi.mock("@/lib/hosted/access", () => ({ terminateAppSessionsForSubject: vi.fn() }));
vi.mock("@/lib/server/boot", () => ({ ensureBoot: vi.fn() }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
const { POST } = await import("@/app/auth/signout/route");

it("preserves a workspace invitation when switching to the invited account", async () => {
  const response = await POST(new NextRequest("https://zenith.test/auth/signout", {
    method: "POST", body: new URLSearchParams({ next: "/invite?invite=workspace-token" }),
  }));
  const destination = new URL(response.headers.get("location")!);
  expect(response.status).toBe(303);
  expect(destination.pathname).toBe("/login");
  expect(destination.searchParams.get("next")).toBe("/invite?invite=workspace-token");
});

it.each(["//evil.test", "/\n/evil.test", "/auth/callback"])("drops unsafe signout continuation %j", async (next) => {
  const response = await POST(new NextRequest("https://zenith.test/auth/signout", {
    method: "POST", body: new URLSearchParams({ next }),
  }));
  expect(response.headers.get("location")).toBe("https://zenith.test/login");
});

it("keeps ordinary body-less signout working", async () => {
  const response = await POST(new NextRequest("https://zenith.test/auth/signout", { method: "POST" }));
  expect(response.headers.get("location")).toBe("https://zenith.test/login");
});
