/**
 * Hosted mode (ZENITH_HOSTED_MODE=1) makes the member table the only
 * workspace-permission authority: no app_metadata.role re-grant, no taking
 * over an empty workspace, no inferred admin. Membership and invites still
 * work exactly as before.
 */
import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Invite, Member } from "@/lib/domain/types";
import type { SessionUser } from "@/lib/auth/session";

process.env.ORRERY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-hosted-members-"));
process.env.ZENITH_HOSTED_MODE = "1";

const { ensureMember, readInvites } = await import("@/lib/server/context");
const { roleOf } = await import("@/lib/actions/core");
const { db, resetDb } = await import("@/lib/db/store");

const WS = "ws-hosted";

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

const admin: Member = { id: "u-ada", workspaceId: WS, name: "Ada", email: "ada@orrery.test", role: "admin" };
const viewer: Member = { id: "u-vi", workspaceId: WS, name: "Vi", email: "vi@orrery.test", role: "viewer" };

describe("hosted mode: role claims never grant or re-grant", () => {
  beforeEach(() => seed([admin, viewer]));

  it("does not rewrite a stored role from app_metadata.role", () => {
    const r = ensureMember(user("u-vi", "vi@orrery.test", "Vi", "editor"));
    if ("denied" in r) throw new Error(r.denied.message);
    expect(r.member.role).toBe("viewer");
  });

  it("refuses a stranger who carries a role claim, and does not point at app_metadata", () => {
    const r = ensureMember(user("u-new", "new@orrery.test", "New", "admin"));
    expect("denied" in r).toBe(true);
    if ("denied" in r) {
      expect(r.denied.message).toMatch(/new@orrery\.test is not a member/);
      expect(r.denied.fix).toMatch(/Ada \(ada@orrery\.test\)/);
      expect(r.denied.fix).not.toMatch(/app_metadata/);
    }
    expect(db().members).toHaveLength(2);
  });

  it("keeps a removed member out on their next sign-in even with a claim", () => {
    db().members.splice(db().members.indexOf(viewer), 1);
    const r = ensureMember(user("u-vi", "vi@orrery.test", "Vi", "admin"));
    expect("denied" in r).toBe(true);
  });
});

describe("hosted mode: no empty-workspace takeover", () => {
  it("does not hand an empty workspace to the first stranger who signs in", () => {
    seed([]);
    const r = ensureMember(user("u-x", "stranger@example.com", "Stranger"));
    expect("denied" in r).toBe(true);
    expect(db().members).toHaveLength(0);
    if ("denied" in r) expect(r.denied.fix).toMatch(/hosted mode/);
  });

  it("never infers admin from an empty member table", () => {
    seed([]);
    expect(roleOf({ type: "user", id: "u-x", name: "X" }, WS)).toBe("viewer");
  });
});

describe("hosted mode: invites still admit", () => {
  beforeEach(() =>
    seed(
      [admin],
      [
        {
          id: "inv-1",
          workspaceId: WS,
          email: "claude@orrery.test",
          role: "editor",
          createdBy: "u-ada",
          createdAt: new Date().toISOString(),
        },
      ]
    )
  );

  it("admits the invited email with the invited role, ignoring any claim", () => {
    const r = ensureMember(user("u-claude", "claude@orrery.test", "Claude", "admin"));
    if ("denied" in r) throw new Error(r.denied.message);
    expect(r.member.role).toBe("editor");
    expect(readInvites()[0].acceptedAt).toBeTruthy();
  });
});
