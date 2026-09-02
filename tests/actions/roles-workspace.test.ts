/**
 * Membership is per workspace. A person can be admin of one workspace and a
 * viewer in another, and the action registry must read the row for the
 * workspace the action runs in — never the first row it finds anywhere.
 */
import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Actor } from "@/lib/domain/types";

process.env.ORRERY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-roles-ws-"));
const { roleOf } = await import("@/lib/actions/core");
const { resetDb } = await import("@/lib/db/store");

const ada: Actor = { type: "user", id: "u-ada", name: "Ada" };
const stranger: Actor = { type: "user", id: "u-nobody", name: "Nobody" };

beforeAll(() => {
  resetDb({
    workspaces: [
      { id: "ws-a", name: "A", slug: "a", createdAt: new Date().toISOString() },
      { id: "ws-b", name: "B", slug: "b", createdAt: new Date().toISOString() },
      { id: "ws-empty", name: "Empty", slug: "empty", createdAt: new Date().toISOString() },
    ],
    members: [
      { id: "u-ada", workspaceId: "ws-a", name: "Ada", email: "ada@x.dev", role: "admin" },
      { id: "u-ada", workspaceId: "ws-b", name: "Ada", email: "ada@x.dev", role: "viewer" },
      { id: "u-bob", workspaceId: "ws-b", name: "Bob", email: "bob@x.dev", role: "admin" },
    ],
  });
});

describe("roleOf is scoped to the workspace", () => {
  it("reads the row for the workspace asked about, not the first row anywhere", () => {
    expect(roleOf(ada, "ws-a")).toBe("admin");
    expect(roleOf(ada, "ws-b")).toBe("viewer");
  });

  it("treats someone with no row in that workspace as a viewer, even if they are admin elsewhere", () => {
    // Bob is admin of B and has no seat in A.
    expect(roleOf({ type: "user", id: "u-bob", name: "Bob" }, "ws-a")).toBe("viewer");
    expect(roleOf(stranger, "ws-b")).toBe("viewer");
  });

  it("keeps the first-member rule per workspace: an empty workspace grants admin", () => {
    // Nobody is in ws-empty yet, so whoever arrives first owns it — the same
    // rule ensureMember applies on sign-in, and it must not leak from B.
    expect(roleOf(stranger, "ws-empty")).toBe("admin");
  });

  it("keeps the demo actor as admin everywhere", () => {
    expect(roleOf({ type: "user", id: "local", name: "You" }, "ws-b")).toBe("admin");
  });
});
