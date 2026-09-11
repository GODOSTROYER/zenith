/**
 * Where authentication lets you out.
 *
 * The bug these lock down: every door (email confirmation, password sign-in,
 * magic link, OAuth return, and the middleware's "you are already signed in")
 * hard-coded `/overview`, so a brand-new account landed on the one screen that
 * is empty precisely because the account is new. Membership is the signal —
 * there is no stored "onboarded" flag in this codebase and these tests assume
 * there is none.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Member, Workspace } from "@/lib/domain/types";
import type { SessionUser } from "@/lib/auth/session";
import { ONBOARDING, OVERVIEW, postAuthDestination, safeNextPath } from "@/lib/auth/destination";
import { tempDataDir } from "../_support/data-dir";

describe("safeNextPath", () => {
  it("takes a same-origin path, with its query", () => {
    expect(safeNextPath("/p/atlas/activity")).toBe("/p/atlas/activity");
    expect(safeNextPath("/apps/accept?token=abc")).toBe("/apps/accept?token=abc");
  });

  it("refuses anything that could leave this origin", () => {
    for (const bad of [
      "https://evil.test/steal",
      "//evil.test/steal",
      "/\\evil.test/steal",
      "evil.test",
      "",
      null,
      undefined,
    ])
      expect(safeNextPath(bad), String(bad)).toBeUndefined();
  });

  it("refuses the auth pages themselves, which would be a loop", () => {
    for (const bad of ["/login", "/signup", "/forgot-password", "/auth/callback", "/login?next=/x"])
      expect(safeNextPath(bad), bad).toBeUndefined();
  });
});

describe("postAuthDestination", () => {
  it("sends an account with no workspace membership to onboarding", () => {
    expect(postAuthDestination({ hasWorkspace: false, next: null })).toBe(ONBOARDING);
  });

  it("does not let a default-looking next drag a new account back to overview", () => {
    // The regression itself: signup used to pass `next=/overview`.
    expect(postAuthDestination({ hasWorkspace: false, next: "/overview" })).toBe(ONBOARDING);
    expect(postAuthDestination({ hasWorkspace: false, next: "/p/atlas/map" })).toBe(ONBOARDING);
  });

  it("never sends a returning member to onboarding", () => {
    expect(postAuthDestination({ hasWorkspace: true, next: null })).toBe(OVERVIEW);
    expect(postAuthDestination({ hasWorkspace: true, next: "/p/atlas/map" })).toBe("/p/atlas/map");
  });

  it("falls back to overview when the requested next is not safe", () => {
    expect(postAuthDestination({ hasWorkspace: true, next: "https://evil.test" })).toBe(OVERVIEW);
    expect(postAuthDestination({ hasWorkspace: true, next: "/login" })).toBe(OVERVIEW);
  });

  it("honours onboarding when onboarding is what was asked for", () => {
    expect(postAuthDestination({ hasWorkspace: true, next: "/onboarding?step=2" })).toBe(
      "/onboarding?step=2"
    );
  });

  it("keeps an invitation link intact even for an account with no workspace", () => {
    // An app invitation is the entire reason that person signed in; a setup
    // wizard would drop the token on the floor.
    expect(postAuthDestination({ hasWorkspace: false, next: "/apps/accept?token=abc" })).toBe(
      "/apps/accept?token=abc"
    );
  });

  it("lets a password reset finish before anything else", () => {
    expect(postAuthDestination({ hasWorkspace: false, next: "/reset-password" })).toBe(
      "/reset-password"
    );
  });
});

/* ------------------------- the server-side answer ------------------------- */

const session = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock("@/lib/auth/session", async (original) => ({
  ...(await original<typeof import("@/lib/auth/session")>()),
  getSessionUser: async () => session.user,
}));
vi.mock("@/lib/supabase/env", async (original) => ({
  ...(await original<typeof import("@/lib/supabase/env")>()),
  isSupabaseConfigured: () => true,
}));

tempDataDir("zenith-destination-");
const { destinationAfterAuth } = await import("@/lib/server/workspace");
const { writeInvites } = await import("@/lib/server/membership");
const { db, resetDb } = await import("@/lib/db/store");

const AT = "2026-09-01T10:00:00.000Z";
const ws: Workspace = { id: "ws-a", name: "Kepler Labs", slug: "kepler", createdAt: AT };
const ada: SessionUser = { id: "u-ada", email: "ada@zenith.test", name: "Ada" };
const bo: SessionUser = { id: "u-bo", email: "bo@zenith.test", name: "Bo" };
const adaMember: Member = {
  id: ada.id,
  workspaceId: ws.id,
  name: "Ada",
  email: ada.email,
  role: "admin",
};

beforeEach(() => {
  resetDb();
  session.user = null;
});

describe("destinationAfterAuth", () => {
  it("sends a brand-new signed-in account to onboarding, not overview", async () => {
    db().workspaces.push(ws);
    db().members.push(adaMember);
    session.user = bo; // signed up seconds ago, in nobody's workspace
    expect(await destinationAfterAuth(null)).toBe(ONBOARDING);
    expect(await destinationAfterAuth("/overview")).toBe(ONBOARDING);
  });

  it("sends a returning member to what they asked for", async () => {
    db().workspaces.push(ws);
    db().members.push(adaMember);
    session.user = ada;
    expect(await destinationAfterAuth(null)).toBe(OVERVIEW);
    expect(await destinationAfterAuth("/p/atlas/activity")).toBe("/p/atlas/activity");
  });

  it("lands an invited user in the workspace they were invited to", async () => {
    db().workspaces.push(ws);
    db().members.push(adaMember);
    writeInvites([
      {
        id: "inv-1",
        workspaceId: ws.id,
        email: bo.email,
        role: "editor",
        createdBy: ada.id,
        createdAt: AT,
      },
    ]);
    session.user = bo;
    // The invite became a membership on the way through, so this is overview —
    // the workspace they were invited to — and never the setup wizard.
    expect(await destinationAfterAuth(null)).toBe(OVERVIEW);
    expect(db().members.some((m) => m.id === bo.id && m.workspaceId === ws.id)).toBe(true);
  });
});
