/**
 * PATCH /api/account/profile — the claim and its copy.
 *
 * The claim is where a display name lives; the member row is the copy every
 * member list and denial sentence reads. This checks the copy moves in the same
 * request, in every workspace the person is in, and that history does not.
 *
 * The email half of the same rule is `ensureMember` following a changed claim,
 * which is checked here too because it has no route of its own — Supabase
 * writes the address and Zenith only ever catches up.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-account-profile-", { fast: true });

const state = vi.hoisted(() => ({
  user: { id: "u-me", email: "me@example.com", name: "Mika" },
  updateUser: null as { data?: { full_name?: string } } | null,
  updateError: null as { message: string } | null,
}));

vi.mock("@/lib/server/request", () => ({
  route: (a: unknown, b?: unknown) => (typeof a === "function" ? a : b),
  currentRequest: () => ({ user: state.user }),
  intParam: () => 0,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      updateUser: async (payload: { data?: { full_name?: string } }) => {
        state.updateUser = payload;
        return { error: state.updateError };
      },
    },
  }),
}));

const { PATCH } = await import("@/app/api/account/profile/route");
const { db, resetDb } = await import("@/lib/db/store");
const { ensureMember } = await import("@/lib/server/membership");

type Handler = (req: { json: () => Promise<unknown> }) => Promise<{
  name: string;
  members: { id: string; workspaceId: string; name: string }[];
}>;

const patch = (body: unknown) =>
  (PATCH as unknown as Handler)({ json: async () => body });

const workspace = (id: string, name: string) => ({
  id,
  name,
  slug: id,
  createdAt: "2026-01-01T00:00:00.000Z",
});

beforeEach(() => {
  state.user = { id: "u-me", email: "me@example.com", name: "Mika" };
  state.updateUser = null;
  state.updateError = null;
  resetDb({
    workspaces: [workspace("w-atlas", "Atlas"), workspace("w-orbit", "Orbit")],
    members: [
      { id: "u-me", workspaceId: "w-atlas", name: "Mika", email: "me@example.com", role: "editor" },
      { id: "u-me", workspaceId: "w-orbit", name: "Mika", email: "me@example.com", role: "admin" },
      { id: "u-them", workspaceId: "w-atlas", name: "Ada", email: "ada@example.com", role: "admin" },
    ],
  });
});

describe("changing your display name", () => {
  it("writes the claim and refreshes the member row in every workspace", async () => {
    const out = await patch({ name: "  Mika Oyelaran  " });
    expect(state.updateUser).toEqual({ data: { full_name: "Mika Oyelaran" } });
    expect(out.name).toBe("Mika Oyelaran");
    expect(
      db()
        .members.filter((m) => m.id === "u-me")
        .map((m) => m.name)
    ).toEqual(["Mika Oyelaran", "Mika Oyelaran"]);
    expect(out.members.map((m) => m.workspaceId).sort()).toEqual(["w-atlas", "w-orbit"]);
  });

  it("leaves everybody else's row alone", async () => {
    await patch({ name: "Mika Oyelaran" });
    expect(db().members.find((m) => m.id === "u-them")?.name).toBe("Ada");
  });

  it("refuses an empty name before it reaches Supabase", async () => {
    await expect(patch({ name: "   " })).rejects.toMatchObject({ status: 400 });
    expect(state.updateUser).toBeNull();
  });

  it("does not touch the member row when Supabase refuses the change", async () => {
    state.updateError = { message: "rate limit exceeded" };
    await expect(patch({ name: "Mika Oyelaran" })).rejects.toMatchObject({ status: 400 });
    expect(db().members.find((m) => m.id === "u-me")?.name).toBe("Mika");
  });
});

describe("a confirmed email change", () => {
  it("moves the stored member row onto the new address", () => {
    ensureMember({ id: "u-me", email: "new@example.com", name: "Mika" });
    expect(db().members.find((m) => m.workspaceId === "w-atlas" && m.id === "u-me")?.email).toBe(
      "new@example.com"
    );
  });

  it("leaves an invite keyed to the old address as it was", () => {
    db().settings.invites = [
      {
        id: "i-1",
        workspaceId: "w-atlas",
        email: "me@example.com",
        role: "editor",
        createdBy: "u-them",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    ];
    ensureMember({ id: "u-me", email: "new@example.com", name: "Mika" });
    const invite = (db().settings.invites as { email: string; acceptedAt?: string }[])[0];
    expect(invite.email).toBe("me@example.com");
    expect(invite.acceptedAt).toBeUndefined();
  });
});
