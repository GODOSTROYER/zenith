/**
 * DELETE /api/account — the refusal, and the order of the irreversible half.
 *
 * The two things worth pinning: a workspace never loses its last admin to
 * somebody deleting themselves, and when the deletion does run, every door is
 * closed before the identity goes. An identity deleted first would leave live
 * grants naming a subject nobody can sign in as.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-account-", { fast: true });

const state = vi.hoisted(() => ({
  user: { id: "u-me", email: "me@example.com", name: "Mika" },
  /** every side effect, in the order it happened */
  order: [] as string[],
  grants: [] as { id: string }[],
  adminClients: 0,
  deleteUserError: null as { message: string } | null,
}));

vi.mock("@/lib/server/request", () => ({
  route: (a: unknown, b?: unknown) => (typeof a === "function" ? a : b),
  currentRequest: () => ({ user: state.user }),
  intParam: () => 0,
}));

vi.mock("@/lib/hosted/access", () => ({
  terminateAppSessionsForSubject: () => {
    state.order.push("sessions");
    return 3;
  },
  revokeGrant: (grantId: string) => {
    state.order.push(`revoke:${grantId}`);
  },
}));

vi.mock("@/lib/hosted/authority", () => ({
  authority: () => ({ repos: { grants: { listBySubject: () => state.grants } } }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    state.adminClients += 1;
    return {
      auth: {
        admin: {
          deleteUser: async () => {
            state.order.push("deleteUser");
            return { error: state.deleteUserError };
          },
        },
      },
    };
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      signOut: async () => {
        state.order.push("signOut");
        return { error: null };
      },
    },
  }),
}));

const { DELETE } = await import("@/app/api/account/route");
const { db, readAudit, resetDb } = await import("@/lib/db/store");

const workspace = (id: string, name: string) => ({
  id,
  name,
  slug: id,
  createdAt: "2026-01-01T00:00:00.000Z",
});
const member = (id: string, workspaceId: string, role: "admin" | "editor") => ({
  id,
  workspaceId,
  name: id,
  email: `${id}@example.com`,
  role,
});

const run = () => (DELETE as unknown as () => Promise<Response>)();

beforeEach(() => {
  state.order = [];
  state.grants = [];
  state.adminClients = 0;
  state.deleteUserError = null;
  state.user = { id: "u-me", email: "me@example.com", name: "Mika" };
  resetDb({
    workspaces: [workspace("w-atlas", "Atlas")],
    members: [member("u-me", "w-atlas", "admin"), member("u-other", "w-atlas", "editor")],
  });
});

describe("deleting your own account", () => {
  it("refuses while you are the only admin, and names the workspace", async () => {
    await expect(run()).rejects.toMatchObject({
      status: 409,
      message: "You are the only admin of Atlas.",
      fix: "Make someone else an admin first from Settings → Members, then delete your account.",
    });
    expect(db().members).toHaveLength(2);
  });

  it("never constructs the service-role client on the refusal path", async () => {
    await expect(run()).rejects.toThrow();
    expect(state.adminClients).toBe(0);
    expect(state.order).toEqual([]);
  });

  it("names every workspace that would be left without an admin", async () => {
    db().workspaces.push(workspace("w-orbit", "Orbit"));
    db().members.push(member("u-me", "w-orbit", "admin"));
    await expect(run()).rejects.toMatchObject({
      message: "You are the only admin of Atlas and Orbit.",
    });
  });

  it("ends sessions and revokes grants before the identity is deleted", async () => {
    db().members[1].role = "admin";
    state.grants = [{ id: "g-1" }, { id: "g-2" }];

    const res = await run();
    expect(res.status).toBe(204);
    expect(state.order).toEqual([
      "sessions",
      "revoke:g-1",
      "revoke:g-2",
      "deleteUser",
      "signOut",
    ]);
    expect(state.adminClients).toBe(1);
  });

  it("removes the member row and the invites they issued, and records why", async () => {
    db().members[1].role = "admin";
    db().settings.invites = [
      { id: "i-1", workspaceId: "w-atlas", email: "new@example.com", role: "editor", createdBy: "u-me", createdAt: "2026-01-02T00:00:00.000Z" },
      { id: "i-2", workspaceId: "w-atlas", email: "other@example.com", role: "editor", createdBy: "u-other", createdAt: "2026-01-02T00:00:00.000Z" },
    ];

    await run();

    expect(db().members.map((m) => m.id)).toEqual(["u-other"]);
    expect((db().settings.invites as { id: string }[]).map((i) => i.id)).toEqual(["i-2"]);
    const audit = readAudit({ workspaceId: "w-atlas" });
    expect(audit).toHaveLength(1);
    expect(audit[0].actionId).toBe("workspace.removeMember");
    expect(audit[0].actor).toEqual({ type: "user", id: "u-me", name: "Mika" });
    expect(audit[0].summary).toContain("deleted their Zenith account");
  });

  it("says the doors are already shut when Supabase will not delete the sign-in", async () => {
    db().members[1].role = "admin";
    state.deleteUserError = { message: "service unavailable" };
    await expect(run()).rejects.toMatchObject({
      status: 502,
      message: "Your Zenith sign-in was not deleted: service unavailable",
    });
  });
});
