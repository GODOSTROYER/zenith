import { beforeAll, describe, expect, it } from "vitest";
import type { ActionContext } from "@/lib/actions/core";
import type { Actor, Changeset } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("orrery-roles-", { fast: true });
const { runAction } = await import("@/lib/actions/core");
const { db, readAudit, resetDb } = await import("@/lib/db/store");
await import("@/lib/actions/defs");

const WS = "ws-roles";

const actor = (id: string, name = id): Actor => ({ type: "user", id, name });
const ctx = (a: Actor, scope: Partial<ActionContext> = {}): ActionContext => ({
  workspaceId: WS,
  actor: a,
  ...scope,
});

const exec = async (actionId: string, a: Actor, input: unknown, scope: Partial<ActionContext> = {}) =>
  (await runAction(actionId, ctx(a, scope), input, { mode: "execute" })).result!;

function seed(withMembers: boolean) {
  resetDb({
    workspaces: [{ id: WS, name: "Roles", slug: "roles", createdAt: new Date().toISOString() }],
    members: withMembers
      ? [
          { id: "u-admin", workspaceId: WS, name: "Ada", email: "ada@x.dev", role: "admin" },
          { id: "u-editor", workspaceId: WS, name: "Eli", email: "eli@x.dev", role: "editor" },
          { id: "u-viewer", workspaceId: WS, name: "Vic", email: "vic@x.dev", role: "viewer" },
        ]
      : [],
  });
}

describe("role enforcement", () => {
  beforeAll(() => seed(true));

  it("refuses an action above the actor's role, and the error names the fix", async () => {
    const result = await exec("project.applyBlueprint", actor("u-viewer", "Vic"), {
      blueprint: "internal-tool",
      name: "Nope",
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/needs the editor role/);
    expect(result.summary).toMatch(/you are viewer/);
    expect(result.error).toMatch(/role_denied/);
    expect(result.error).toMatch(/Settings → Members/);
    expect(db().projects).toHaveLength(0); // refused before anything was written
  });

  it("records the refusal in the audit log as denied", async () => {
    const denied = readAudit({ workspaceId: WS }).find((e) => e.result === "denied");
    expect(denied?.actionId).toBe("project.applyBlueprint");
    expect(denied?.actor.id).toBe("u-viewer");
  });

  it("lets an editor run an editor action but not an admin one", async () => {
    const eli = actor("u-editor", "Eli");
    const created = await exec("project.applyBlueprint", eli, { blueprint: "internal-tool", name: "Atlas" });
    expect(created.ok).toBe(true);

    const autonomy = await exec("workspace.setAutonomy", eli, { level: "bounded" });
    expect(autonomy.ok).toBe(false);
    expect(autonomy.summary).toMatch(/needs the admin role/);
  });

  it("lets an admin run an admin action", async () => {
    const result = await exec("workspace.setAutonomy", actor("u-admin", "Ada"), { level: "bounded" });
    expect(result.ok).toBe(true);
    expect(db().settings.autonomy).toBe("bounded");
  });

  it("treats the local demo actor as admin even when other members exist", async () => {
    const result = await exec("workspace.setAutonomy", actor("local", "You"), { level: "approve" });
    expect(result.ok).toBe(true);
  });

  it("gives a signed-in user with no member record the lowest role, not the highest", async () => {
    const result = await exec("project.applyBlueprint", actor("u-stranger", "Stranger"), {
      blueprint: "internal-tool",
      name: "Trespass",
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/you are viewer/);
  });

  it("never gates planning — a viewer can preview what an action would do", async () => {
    const { plan } = await runAction(
      "project.applyBlueprint",
      ctx(actor("u-viewer", "Vic")),
      { blueprint: "internal-tool", name: "Preview" },
      { mode: "plan" }
    );
    expect(plan?.summary.length).toBeGreaterThan(0);
    expect(plan?.warnings.some((w) => /role/i.test(w))).toBe(false);
  });

  it("is admin when the store has no members at all (tests, smoke, seed)", async () => {
    seed(false);
    const result = await exec("workspace.setAutonomy", actor("t", "Smoke"), { level: "bounded" });
    expect(result.ok).toBe(true);
  });
});

describe("idempotency cache", () => {
  let projectId = "";
  let environmentId = "";

  beforeAll(async () => {
    seed(false);
    db().connections.push({
      id: "conn-idem",
      workspaceId: WS,
      provider: "sandbox",
      label: "Sandbox",
      region: "local-1",
      status: "healthy",
      grantedPermissions: [],
      createdAt: new Date().toISOString(),
    });
    const a = actor("t", "Tester");
    const created = await exec("project.applyBlueprint", a, { blueprint: "internal-tool", name: "Atlas" });
    projectId = (created.data as { projectId: string }).projectId;
    const env = await exec(
      "env.create",
      a,
      { name: "staging", class: "staging", connectionId: "conn-idem", region: "local-1" },
      { projectId }
    );
    environmentId = (env.data as { environmentId: string }).environmentId;
  });

  const planWithKey = async (key: string) =>
    (
      await runAction("deploy.plan", ctx(actor("t"), { projectId, environmentId }), {}, {
        mode: "execute",
        idempotencyKey: key,
      })
    ).result!;

  it("replays a keyed result instead of re-running the action", async () => {
    const first = await planWithKey("k1");
    const before = (first.data as { changeset: Changeset }).changeset.items.length;

    await exec("system.addService", actor("t"), { name: "extra", kind: "worker", image: "busybox:1" }, { projectId });

    const replay = await planWithKey("k1");
    expect((replay.data as { changeset: Changeset }).changeset.items.length).toBe(before);
    expect(replay.summary).toBe(first.summary);
  });

  it("evicts old keys instead of growing forever", async () => {
    const before = (await planWithKey("k1")).summary;
    // The cache holds 500 entries; push k1 out of the window.
    for (let i = 0; i < 520; i++) await planWithKey(`fill-${i}`);
    const after = (await planWithKey("k1")).summary;
    expect(after).not.toBe(before); // recomputed, so the manifest edit shows up
    expect(after).toMatch(/extra|added/);
  });
});
