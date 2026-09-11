/**
 * `allowStatefulDeletion` is a switch in Settings → Environments whose off
 * state promises: "A plan that would destroy a database, cache, queue or bucket
 * here is blocked before it starts."
 *
 * It did not. The flag was written to the store, rendered as a chip, and used
 * by one security rule — but nothing on the deploy path read it, so a plan that
 * dropped a Postgres resource planned clean and ran. The only thing between a
 * removed database and its data was whatever the provider happened to do
 * halfway through the deployment.
 *
 * These tests hold the switch to its wording: the refusal has to arrive in the
 * *plan*, before anything is applied, and it has to name the resource and the
 * way forward.
 *
 * Writing them turned up the second half of the same bug. The first version of
 * the fix blocked only the plan, and the execute test failed — `runAction` can
 * be called straight in execute mode, so a plan is a courtesy, not a gate. Both
 * paths are checked now, and the execute test is what proves it.
 *
 * The third case is the control: flip the switch on and the same plan is
 * allowed, so this cannot pass by deletion being broken in general.
 */
import { describe, expect, it, beforeAll } from "vitest";
import type { ActionContext, ActionPlan } from "@/lib/actions/core";
import type { Manifest } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-stateful-", { fast: true });
const { runAction } = await import("@/lib/actions/core");
const { resetDb, db, q, save } = await import("@/lib/db/store");
await import("@/lib/actions/defs");

const ctx: ActionContext = {
  workspaceId: "ws-test",
  actor: { type: "user", id: "you", name: "you" },
};

let projectId = "";
let environmentId = "";

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

/** Drop a node from the working manifest, the way the editor would. */
function removeResource(name: string): void {
  const project = q.project(projectId)!;
  const m = project.workingManifest as Manifest;
  const target = m.resources.find((r) => r.name === name);
  if (!target) throw new Error(`no resource named ${name}; have ${m.resources.map((r) => r.name).join(", ")}`);
  m.resources = m.resources.filter((r) => r.id !== target.id);
  m.bindings = m.bindings.filter((b) => b.to !== target.id && b.from !== target.id);
  save();
}

function setPolicy(allow: boolean): void {
  const env = db().environments.find((e) => e.id === environmentId)!;
  env.policies.allowStatefulDeletion = allow;
  save();
}

let statefulName = "";

beforeAll(async () => {
  resetDb({
    workspaces: [{ id: "ws-test", name: "Test", slug: "test", createdAt: new Date().toISOString() }],
  });
  // A blueprint with a database in it, deployed once so the resource is really
  // live — a deletion only exists relative to what is deployed.
  const created = await exec("project.applyBlueprint", { blueprint: "internal-tool", name: "Atlas" });
  expect(created.ok).toBe(true);
  const data = created.data as { projectId: string; environmentId: string };
  projectId = data.projectId;
  environmentId = data.environmentId;

  const applied = await exec("deploy.apply", {}, { projectId, environmentId });
  expect(applied.ok).toBe(true);
  await settle((applied.data as { deploymentId: string }).deploymentId);

  const live = q.revisionManifest(db().environments.find((e) => e.id === environmentId)!.deployedRevisionId!)!;
  const stateful = live.resources.find((r) => ["postgres", "redis", "object_store", "queue"].includes(r.kind));
  expect(stateful, "the blueprint must ship a data-bearing resource for this suite to mean anything").toBeDefined();
  statefulName = stateful!.name;
});

describe("allowStatefulDeletion gates the plan and the deploy", () => {
  it("blocks a plan that would destroy a data-bearing resource", async () => {
    setPolicy(false);
    removeResource(statefulName);

    const p = await plan("deploy.apply", {}, { projectId, environmentId });
    expect(p.blocked).toBeTruthy();
    // Names the resource, so the operator knows which one is at risk...
    expect(p.blocked).toContain(statefulName);
    // ...and names both ways forward, per the errors-name-their-fix law.
    expect(p.blocked).toContain("Settings → Environments");
    expect(p.blocked).toMatch(/editor/i);
  });

  it("refuses to execute it too, so the block is not advisory", async () => {
    setPolicy(false);
    const before = db().deployments.length;
    const result = await exec("deploy.apply", {}, { projectId, environmentId });
    expect(result.ok).toBe(false);
    expect(result.error).toContain(statefulName);
    // Nothing was started: a blocked plan must not leave a deployment behind.
    expect(db().deployments.length).toBe(before);
  });

  it("says nothing when the environment allows it — the switch really is the switch", async () => {
    setPolicy(true);
    const p = await plan("deploy.apply", {}, { projectId, environmentId });
    expect(p.blocked).toBeFalsy();
  });

  it("does not block a plan that removes nothing stateful", async () => {
    setPolicy(false);
    // Put the resource back; the only change left is whatever else the editor did.
    const project = q.project(projectId)!;
    project.workingManifest = q.revisionManifest(
      db().environments.find((e) => e.id === environmentId)!.deployedRevisionId!
    )!;
    save();
    const p = await plan("deploy.apply", {}, { projectId, environmentId });
    expect(p.blocked).toBeFalsy();
  });
});
