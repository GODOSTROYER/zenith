import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/server/errors";

const state = vi.hoisted(() => ({
  enabled: false,
  user: { id: "subject", email: "person@example.com", name: "Person" } as { id: string; email: string; name: string } | null,
  allowed: false,
  require: vi.fn(),
  requestUser: vi.fn(),
  pageUser: vi.fn(),
  boot: vi.fn(),
  redirect: vi.fn((path: string) => { throw new Error(`redirect:${path}`); }),
}));
vi.mock("@/lib/waitlist/access", () => ({
  waitlistGateEnabled: () => state.enabled,
  requireWaitlistAccess: state.require,
  getWaitlistAccess: vi.fn(async () => ({ allowed: state.allowed })),
}));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: state.requestUser }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: state.pageUser }));
vi.mock("@/lib/server/boot", () => ({ ensureBoot: state.boot }));
vi.mock("next/navigation", () => ({ redirect: state.redirect }));

import { requireProductPageAccess, requireProductRequestAccess } from "@/lib/waitlist/enforcement";
import { route } from "@/lib/server/request";

beforeEach(() => {
  vi.clearAllMocks();
  state.enabled = false;
  state.allowed = false;
  state.user = { id: "subject", email: "person@example.com", name: "Person" };
  state.require.mockResolvedValue(undefined);
  state.requestUser.mockImplementation(async () => state.user);
  state.pageUser.mockImplementation(async () => state.user);
});

describe("waitlist product boundaries", () => {
  it("preserves demo mode without loading or verifying a session when disabled", async () => {
    await requireProductRequestAccess(new NextRequest("https://zenith.test/api/bootstrap"));
    await requireProductPageAccess();
    expect(state.requestUser).not.toHaveBeenCalled();
    expect(state.pageUser).not.toHaveBeenCalled();
    expect(state.require).not.toHaveBeenCalled();
  });

  it("checks the verified request identity before entering the product", async () => {
    state.enabled = true;
    await requireProductRequestAccess(new NextRequest("https://zenith.test/api/workspace"));
    expect(state.require).toHaveBeenCalledWith(state.user);
  });

  it("refuses an API call before boot, snapshot loads, invitation acceptance or handler execution", async () => {
    state.enabled = true;
    state.require.mockRejectedValue(new ApiError("Your account is waiting for access.", 403));
    const handler = vi.fn();
    const response = await route(handler)(new NextRequest("https://zenith.test/api/workspace", { method: "POST" }), { params: Promise.resolve({}) });
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(handler).not.toHaveBeenCalled();
    expect(state.boot).not.toHaveBeenCalled();
  });

  it("does not enter product handlers when admission verification is unavailable", async () => {
    state.enabled = true;
    state.require.mockRejectedValue(new ApiError("Admission verification is unavailable.", 503));
    const handler = vi.fn();
    const response = await route(handler)(new NextRequest("https://zenith.test/api/bootstrap"), { params: Promise.resolve({}) });
    expect(response.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
    expect(state.boot).not.toHaveBeenCalled();
  });

  it("sends waiting page requests to their status screen", async () => {
    state.enabled = true;
    await expect(requireProductPageAccess()).rejects.toThrow("redirect:/waitlist");
  });

  it("sends signed-out page requests to login", async () => {
    state.enabled = true;
    state.user = null;
    await expect(requireProductPageAccess()).rejects.toThrow("redirect:/login");
  });

  it("renders admitted users without a redirect", async () => {
    state.enabled = true;
    state.allowed = true;
    await requireProductPageAccess();
    expect(state.redirect).not.toHaveBeenCalled();
  });
});

describe("RSC data admission independent of layouts", () => {
  it.each(["file", "postgres"])("refuses %s page reads even when a cached layout is skipped", async (kind) => {
    state.enabled = true;
    vi.stubEnv("ZENITH_STORE", kind);
    const readBody = vi.fn();
    try {
      const { runInStoreScope } = await import("@/lib/db/store");
      await expect(runInStoreScope(readBody)).rejects.toThrow("redirect:/waitlist");
      expect(readBody).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
