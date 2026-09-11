/**
 * Who gets into a workspace, and with what role.
 *
 * Three rules under test: joining is gated (signing up is not joining), a
 * placeholder admin nobody can sign in as never holds the admin seat, and a
 * role claim is read from app_metadata only — user_metadata is user-writable.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Invite, Member } from "@/lib/domain/types";
import type { SessionUser } from "@/lib/auth/session";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-members-");
const { ensureMember, readInvites } = await import("@/lib/server/context");
const { userFromClaims } = await import("@/lib/auth/session");
const { db, resetDb } = await import("@/lib/db/store");

const WS = "ws-members";

const user = (id: string, email: string, name: string, role?: SessionUser["role"]): SessionUser => ({
  id,
  email,
  name,
  role,
});

function seed(members: Member[] = [], invites: Invite[] = []) {
  resetDb({
    workspaces: [{ id: WS, name: "Kepler Labs", slug: "kepler", createdAt: new Date().toISOString() }],
    members,
    settings: { invites },
  });
}

const placeholder: Member = {
  id: "m-you",
  workspaceId: WS,
  name: "You",
  email: "you@kepler.dev",
  role: "admin",
};

const tarun = user("u-tarun", "tarun@zenith.test", "Tarun");

const memberOf = (r: ReturnType<typeof ensureMember>): Member => {
  if ("denied" in r) throw new Error(`expected a member, got a denial: ${r.denied.message}`);
  return r.member;
};

describe("first real user", () => {
  beforeEach(() => seed());

  it("owns the workspace", () => {
    expect(memberOf(ensureMember(tarun)).role).toBe("admin");
  });

  it("does not hand the second signup an editor seat", () => {
    ensureMember(tarun);
    const second = ensureMember(user("u-x", "stranger@example.com", "Stranger"));
    expect("denied" in second).toBe(true);
    expect(db().members).toHaveLength(1);
  });
});

describe("placeholder admin", () => {
  // The exact shape a seeded install ends up in: an admin seat nobody can
  // sign in as, and every real user demoted to editor behind it.
  beforeEach(() =>
    seed([
      placeholder,
      { id: "u-tarun", workspaceId: WS, name: "Tarun", email: "tarun@zenith.test", role: "editor" },
    ])
  );

  it("hands the admin seat to the real user who signs in", () => {
    expect(memberOf(ensureMember(tarun)).role).toBe("admin");
  });

  it("drops the placeholder rather than leaving two admins", () => {
    ensureMember(tarun);
    expect(db().members.map((m) => m.email)).toEqual(["tarun@zenith.test"]);
  });

  it("leaves a real admin's seat alone", () => {
    seed([
      placeholder,
      { id: "u-ada", workspaceId: WS, name: "Ada", email: "ada@zenith.test", role: "admin" },
      { id: "u-tarun", workspaceId: WS, name: "Tarun", email: "tarun@zenith.test", role: "editor" },
    ]);
    expect(memberOf(ensureMember(tarun)).role).toBe("editor");
    expect(db().members.find((m) => m.email === "you@kepler.dev")).toBeUndefined();
  });
});

describe("invites", () => {
  const invite: Invite = {
    id: "inv-1",
    workspaceId: WS,
    email: "claude@zenith.test",
    role: "editor",
    createdBy: "u-tarun",
    createdAt: new Date().toISOString(),
  };

  beforeEach(() =>
    seed([{ id: "u-tarun", workspaceId: WS, name: "Tarun", email: "tarun@zenith.test", role: "admin" }], [invite])
  );

  it("admits the invited email with the invited role, and marks it accepted", () => {
    const member = memberOf(ensureMember(user("u-claude", "claude@zenith.test", "Claude")));
    expect(member.role).toBe("editor");
    expect(readInvites()[0].acceptedAt).toBeTruthy();
  });

  it("does not admit the same invite twice", () => {
    ensureMember(user("u-claude", "claude@zenith.test", "Claude"));
    db().members.splice(1, 1); // removed by an admin
    const again = ensureMember(user("u-claude", "claude@zenith.test", "Claude"));
    expect("denied" in again).toBe(true);
  });

  it("refuses everyone else by name, and names the admin who can invite them", () => {
    const denied = ensureMember(user("u-x", "stranger@example.com", "Stranger"));
    if (!("denied" in denied)) throw new Error("expected a denial");
    expect(denied.denied.message).toMatch(/stranger@example\.com is not a member of Kepler Labs/);
    expect(denied.denied.fix).toMatch(/Tarun \(tarun@zenith\.test\)/);
    expect(denied.denied.fix).toMatch(/invite/i);
  });
});

describe("app_metadata role claim", () => {
  beforeEach(() =>
    seed([
      { id: "u-tarun", workspaceId: WS, name: "Tarun", email: "tarun@zenith.test", role: "admin" },
      { id: "u-claude", workspaceId: WS, name: "Claude", email: "claude@zenith.test", role: "viewer" },
    ])
  );

  it("updates an existing member's role", () => {
    const member = memberOf(ensureMember(user("u-claude", "claude@zenith.test", "Claude", "editor")));
    expect(member.role).toBe("editor");
  });

  it("admits a new user the operator granted a role, without an invite", () => {
    const member = memberOf(ensureMember(user("u-v", "vedant@zenith.test", "Vedant", "editor")));
    expect(member.role).toBe("editor");
  });

  it("is read from app_metadata, never from user_metadata", () => {
    const claims = {
      sub: "u-1",
      email: "e@x.dev",
      user_metadata: { full_name: "Elevated", role: "admin" },
      app_metadata: { role: "viewer" },
    };
    expect(userFromClaims(claims)?.role).toBe("viewer");
    expect(userFromClaims({ sub: "u-2", email: "e@x.dev", user_metadata: { role: "admin" } })?.role).toBeUndefined();
  });

  it("ignores a role that is not one of ours", () => {
    expect(userFromClaims({ sub: "u-3", email: "e@x.dev", app_metadata: { role: "owner" } })?.role).toBeUndefined();
  });
});
