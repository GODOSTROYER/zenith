import { beforeEach, describe, expect, it } from "vitest";
import type { ActionContext } from "@/lib/actions/core";
import type { Actor } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("orrery-workspace-", { fast: true });
const { getAction, runAction } = await import("@/lib/actions/core");
const { db, resetDb } = await import("@/lib/db/store");
await import("@/lib/actions/defs");

const WS = "ws-rename";
const actor = (id: string, name = id): Actor => ({ type: "user", id, name });
const ctx = (a: Actor = actor("t", "Tester")): ActionContext => ({ workspaceId: WS, actor: a });

const plan = async (input: unknown, a?: Actor) =>
  (await runAction("workspace.rename", ctx(a), input, { mode: "plan" })).plan!;
const exec = async (input: unknown, a?: Actor) =>
  (await runAction("workspace.rename", ctx(a), input, { mode: "execute" })).result!;

function seed(members: { id: string; role: "admin" | "editor" | "viewer" }[] = []) {
  resetDb({
    workspaces: [{ id: WS, name: "Kepler Labs", slug: "kepler-labs", createdAt: new Date().toISOString() }],
    members: members.map((m) => ({
      id: m.id,
      workspaceId: WS,
      name: m.id,
      email: `${m.id}@x.dev`,
      role: m.role,
    })),
  });
}

describe("workspace.rename", () => {
  beforeEach(() => seed());

  it("is declared as an admin-only mutation", () => {
    const def = getAction("workspace.rename");
    expect(def.requiredRole).toBe("admin");
    expect(def.mutates).toBe(true);
    expect(def.risk).toBe("low");
  });

  it("plans in plain words: old name, new name, and that the slug survives", async () => {
    const p = await plan({ name: "Kepler Systems" });
    expect(p.summary).toContain("Kepler Labs");
    expect(p.summary).toContain("Kepler Systems");
    expect(p.details.join(" ")).toContain("kepler-labs");
    expect(p.costDeltaUsd).toBe(0);
    expect(p.warnings).toHaveLength(0);
    expect(db().workspaces[0].name).toBe("Kepler Labs"); // planning changed nothing
  });

  it("warns instead of pretending when the name is unchanged", async () => {
    const p = await plan({ name: "Kepler Labs" });
    expect(p.summary).toMatch(/already called/);
    expect(p.warnings.join(" ")).toMatch(/already/);
  });

  it("changes the name, keeps the slug, and says both", async () => {
    const r = await exec({ name: "Kepler Systems" });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("kepler-labs");
    expect(db().workspaces[0].name).toBe("Kepler Systems");
    expect(db().workspaces[0].slug).toBe("kepler-labs");
    expect(r.data).toMatchObject({ name: "Kepler Systems", previousName: "Kepler Labs" });
  });

  it("trims surrounding whitespace rather than storing it", async () => {
    await exec({ name: "  Orbital  " });
    expect(db().workspaces[0].name).toBe("Orbital");
  });

  it("rejects a name that is too short or too long, and leaves the workspace alone", async () => {
    const short = await exec({ name: "K" });
    expect(short.ok).toBe(false);
    expect(short.error).toMatch(/at least 2 characters/);

    const long = await exec({ name: "K".repeat(61) });
    expect(long.ok).toBe(false);
    expect(long.error).toMatch(/under 60 characters/);

    const missing = await exec({});
    expect(missing.ok).toBe(false);

    expect(db().workspaces[0].name).toBe("Kepler Labs");
  });

  it("refuses an editor and names the fix", async () => {
    seed([
      { id: "u-admin", role: "admin" },
      { id: "u-editor", role: "editor" },
    ]);
    const denied = await exec({ name: "Editor Rename" }, actor("u-editor", "Eli"));
    expect(denied.ok).toBe(false);
    expect(denied.summary).toMatch(/needs the admin role/);
    expect(denied.error).toMatch(/role_denied/);
    expect(db().workspaces[0].name).toBe("Kepler Labs");

    const allowed = await exec({ name: "Admin Rename" }, actor("u-admin", "Ada"));
    expect(allowed.ok).toBe(true);
    expect(db().workspaces[0].name).toBe("Admin Rename");
  });
});
