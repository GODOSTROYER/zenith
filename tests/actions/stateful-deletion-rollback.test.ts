/**
 * `allowStatefulDeletion` has to hold on every path that can replace an
 * environment's deployed revision, not only `deploy.apply`.
 *
 * The apply path decides the block from the working copy's diff against what is
 * live. `deploy.rollback` and `deploy.promote` deploy an *older* saved revision
 * through the same engine, and used to skip the check: a rollback whose target
 * predates a database (or queue, cache, bucket) planned clean and ran, and the
 * engine's provider then dropped the resource. "Rollback restores the system
 * definition, not the data" is exactly why the same wall applies there.
 *
 * Both actions are checked in plan mode (the disabled button and its reason)
 * and in execute mode (`runAction` can be called straight in execute mode, so a
 * plan is a courtesy, not a gate). The controls: flipping the switch on lets the
 * same rollback through, and a rollback that removes nothing stateful is never
 * blocked.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { ActionContext, ActionPlan } from "@/lib/actions/core";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-stateful-rb-", { fast: true });
const { runAction } = await import("@/lib/actions/core");
const { resetDb, db, q, save } = await import("@/lib/db/store");
await import("@/lib/actions/defs");

const ctx: ActionContext = {
  workspaceId: "ws-test",
  actor: { type: "user", id: "you", name: "you" },
};

async function exec(actionId: string, input: unknown, scope: Partial<ActionContext> = {}) {
  const { result } = await runAction(actionId, { ...ctx, ...scope }, input, { mode: "execute" });
  return result!;
}

async function plan(actionId: string, input: unknown, scope: Partial<ActionContext> = {}) {
  const { plan } = await runAction(actionId, { ...ctx, ...scope }, input, { mode: "plan" });
  return plan as ActionPlan;
}

async function settle(deploymentId: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const d = q.deployment(deploymentId)!;
    if (["succeeded", "failed", "cancelled", "rolled_back"].includes(d.status)) return;
    if (Date.now() > deadline) throw new Error(`deployment stuck in ${d.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function deploy(environmentId: string): Promise<string> {
  const applied = await exec("deploy.apply", {}, { projectId, environmentId });
  expect(applied.ok, applied.error).toBe(true);
  await settle((applied.data as { deploymentId: string }).deploymentId);
  return (applied.data as { revisionId: string }).revisionId;
}

function setPolicy(environmentId: string, allow: boolean): void {
  db().environments.find((e) => e.id === environmentId)!.policies.allowStatefulDeletion = allow;
  save();
}

const deployedOf = (environmentId: string) => q.environment(environmentId)!.deployedRevisionId;

let projectId = "";
let stagingId = "";
let previewId = "";
/** Live in staging first, without the cache. */
let withoutCache = "";
/** Live in preview: the same system plus a redis "cache". Staging is moved to it too. */
let withCache = "";

beforeAll(async () => {
  resetDb({
    workspaces: [{ id: "ws-test", name: "Test", slug: "test", createdAt: new Date().toISOString() }],
  });
  const created = await exec("project.applyBlueprint", { blueprint: "internal-tool", name: "Atlas" });
  expect(created.ok).toBe(true);
  const data = created.data as { projectId: string; environmentId: string };
  projectId = data.projectId;
  stagingId = data.environmentId;

  // r1 (no cache) goes to staging. Then a cache is added and r2 goes to a second
  // environment and to staging, so staging has a stateful resource live that r1
  // does not have.
  withoutCache = await deploy(stagingId);

  const added = await exec("system.addResource", { name: "cache", kind: "redis" }, { projectId });
  expect(added.ok, added.error).toBe(true);

  const made = await exec("env.create", { name: "preview", class: "staging" }, { projectId });
  expect(made.ok, made.error).toBe(true);
  previewId = (made.data as { environmentId: string }).environmentId;
  withCache = await deploy(previewId);
  expect(await deploy(stagingId)).not.toBe(withoutCache);

  const live = q.revisionManifest(deployedOf(stagingId)!)!;
  expect(live.resources.some((r) => r.name === "cache" && r.kind === "redis")).toBe(true);
});

describe("deploy.rollback honours allowStatefulDeletion", () => {
  it("blocks the plan when the target revision drops a stateful resource", async () => {
    setPolicy(stagingId, false);
    const p = await plan("deploy.rollback", { environmentId: stagingId, toRevisionId: withoutCache });
    expect(p.blocked).toBeTruthy();
    // Same message shape as deploy.apply: names the resource and both ways out.
    expect(p.blocked).toContain("cache");
    expect(p.blocked).toContain("redis");
    expect(p.blocked).toContain("Settings → Environments");
    expect(p.blocked).toMatch(/Allow stateful deletion/);
    // The reason is rendered where a surface will look for it.
    expect(p.summary).toMatch(/cannot be rolled back/i);
    expect(p.details).toContain(p.blocked);
  });

  it("refuses to execute it too, and starts nothing", async () => {
    setPolicy(stagingId, false);
    const before = db().deployments.length;
    const liveBefore = deployedOf(stagingId);
    const result = await exec("deploy.rollback", { environmentId: stagingId, toRevisionId: withoutCache });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cache");
    expect(result.error).toContain("Settings → Environments");
    expect(db().deployments.length).toBe(before);
    expect(deployedOf(stagingId)).toBe(liveBefore);
  });

  it("refuses the implicit target as well (the previous revision)", async () => {
    setPolicy(stagingId, false);
    // The latest staging deployment's previousRevisionId is r1, the one without the cache.
    const before = db().deployments.length;
    const p = await plan("deploy.rollback", { environmentId: stagingId });
    expect(p.blocked).toContain("cache");
    const result = await exec("deploy.rollback", { environmentId: stagingId });
    expect(result.ok).toBe(false);
    expect(db().deployments.length).toBe(before);
  });

  it("does not block a rollback that removes nothing stateful", async () => {
    setPolicy(stagingId, false);
    // Preview runs r2 only, so a rollback there to r2 is a no-op diff, and a
    // rollback of staging to the revision it already runs removes nothing.
    const p = await plan("deploy.rollback", { environmentId: stagingId, toRevisionId: deployedOf(stagingId)! });
    expect(p.blocked).toBeFalsy();
  });

  it("allows the same rollback when the environment allows stateful deletion", async () => {
    setPolicy(stagingId, true);
    const p = await plan("deploy.rollback", { environmentId: stagingId, toRevisionId: withoutCache });
    expect(p.blocked).toBeFalsy();
    const result = await exec("deploy.rollback", { environmentId: stagingId, toRevisionId: withoutCache });
    expect(result.ok, result.error).toBe(true);
    await settle((result.data as { deploymentId: string }).deploymentId);
    expect(deployedOf(stagingId)).toBe(withoutCache);
    setPolicy(stagingId, false);
  });
});

describe("deploy.promote honours allowStatefulDeletion", () => {
  // Staging now runs r1 (no cache) and preview runs r2 (with the cache):
  // promoting r1 to preview would drop the cache there.
  it("blocks a promotion that drops a stateful resource from the target environment", async () => {
    setPolicy(previewId, false);
    expect(deployedOf(stagingId)).toBe(withoutCache);
    expect(deployedOf(previewId)).toBe(withCache);

    const input = { environmentId: previewId, sourceEnvironmentId: stagingId, revisionId: withoutCache };
    const p = await plan("deploy.promote", input);
    expect(p.blocked).toBeTruthy();
    expect(p.blocked).toContain("cache");
    expect(p.blocked).toContain("Settings → Environments");

    const before = db().deployments.length;
    const result = await exec("deploy.promote", input);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cache");
    expect(db().deployments.length).toBe(before);
    expect(deployedOf(previewId)).toBe(withCache);
  });

  it("promotes it when the target environment allows stateful deletion", async () => {
    setPolicy(previewId, true);
    const input = { environmentId: previewId, sourceEnvironmentId: stagingId, revisionId: withoutCache };
    expect((await plan("deploy.promote", input)).blocked).toBeFalsy();
    const result = await exec("deploy.promote", input);
    expect(result.ok, result.error).toBe(true);
    await settle((result.data as { deploymentId: string }).deploymentId);
    expect(deployedOf(previewId)).toBe(withoutCache);
  });
});
