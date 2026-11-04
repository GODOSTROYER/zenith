/**
 * Requester/approver separation on `deploy.approve`.
 *
 * An approval gate is only a gate if the person who asked for the change is not
 * the person who lets it through. Until now `deploy.approve` asked only for the
 * admin role, so an admin could start a production deployment and approve it in
 * the next click — the "approval required" policy on a production environment
 * was a second button, not a second pair of eyes.
 *
 * The rule, for an environment of class `production`:
 *   - the admin approving must not be the actor who started the deployment;
 *   - unless they are the only admin member of the workspace, where there is
 *     nobody else to ask — then it is allowed, and the audit summary says
 *     "self-approved (sole admin)" so the record shows it was not a second pair
 *     of eyes;
 *   - non-production environments are unchanged.
 *
 * Plan and execute both: `runAction` can be called straight in execute mode, so
 * a refusal that only exists in plan mode is advice, not a policy.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ActionContext, ActionPlan } from "@/lib/actions/core";
import type { Actor } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-approve-sep-", { fast: true });
const { runAction } = await import("@/lib/actions/core");
const { db, q, readAudit, resetDb } = await import("@/lib/db/store");
await import("@/lib/actions/defs");

const WS = "ws-sep";
const user = (id: string, name: string): Actor => ({ type: "user", id, name });
const ADA = user("u-ada", "Ada");
const BOB = user("u-bob", "Bob");
const ELI = user("u-eli", "Eli");

const ctxFor = (actor: Actor, scope: Partial<ActionContext> = {}): ActionContext => ({
  workspaceId: WS,
  actor,
  ...scope,
});

const exec = async (actionId: string, actor: Actor, input: unknown, scope: Partial<ActionContext> = {}) =>
  (await runAction(actionId, ctxFor(actor, scope), input, { mode: "execute" })).result!;

const plan = async (actionId: string, actor: Actor, input: unknown, scope: Partial<ActionContext> = {}) =>
  (await runAction(actionId, ctxFor(actor, scope), input, { mode: "plan" })).plan as ActionPlan;

async function settle(deploymentId: string, ms = 20_000): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    const d = q.deployment(deploymentId)!;
    if (["succeeded", "failed", "cancelled", "rolled_back"].includes(d.status)) return d.status;
    if (Date.now() > deadline) throw new Error(`deployment stuck in ${d.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function members(admins: Actor[]): void {
  db().members = [
    ...admins.map((a) => ({
      id: a.id,
      workspaceId: WS,
      name: a.name,
      email: `${a.id}@x.dev`,
      role: "admin" as const,
    })),
    { id: ELI.id, workspaceId: WS, name: ELI.name, email: "eli@x.dev", role: "editor" as const },
  ];
}

let projectId = "";
/** Deploy as `who` to a fresh environment of `klass` and return the parked deployment's id. */
async function parked(who: Actor, klass: "production" | "staging"): Promise<{ id: string; environmentId: string }> {
  const made = await exec(
    "env.create",
    ELI,
    { name: `${klass}-${Math.random().toString(36).slice(2, 6)}`, class: klass, approvalRequired: true },
    { projectId }
  );
  expect(made.ok, made.error).toBe(true);
  const environmentId = (made.data as { environmentId: string }).environmentId;
  const applied = await exec("deploy.apply", who, {}, { projectId, environmentId });
  expect(applied.ok, applied.error).toBe(true);
  const data = applied.data as { deploymentId: string; status: string };
  expect(data.status).toBe("awaiting_approval");
  return { id: data.deploymentId, environmentId };
}

beforeEach(async () => {
  resetDb({
    workspaces: [{ id: WS, name: "Sep", slug: "sep", createdAt: new Date().toISOString() }],
  });
  members([ADA, BOB]);
  const created = await exec("project.applyBlueprint", ELI, { blueprint: "internal-tool", name: "Atlas" });
  expect(created.ok, created.error).toBe(true);
  projectId = (created.data as { projectId: string }).projectId;
});

describe("production: the requester cannot approve their own deployment", () => {
  it("blocks the plan for the admin who started it, saying why and what to do", async () => {
    const dep = await parked(ADA, "production");
    const p = await plan("deploy.approve", ADA, { deploymentId: dep.id }, { projectId });
    expect(p.blocked).toBeTruthy();
    expect(p.blocked).toMatch(/started/i);
    expect(p.blocked).toMatch(/another admin/i); // names the way forward
    expect(p.blocked).toMatch(/Settings → Members/);
    expect(p.blocked).not.toMatch(/nothing to approve/); // not the "wrong status" reason
  });

  it("refuses to execute, leaves the deployment parked and the environment unleased", async () => {
    const dep = await parked(ADA, "production");
    const r = await exec("deploy.approve", ADA, { deploymentId: dep.id }, { projectId });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/another admin/i);
    expect(q.deployment(dep.id)!.status).toBe("awaiting_approval");
    expect(q.environment(dep.environmentId)!.activeDeploymentId).toBeUndefined();
    // The refusal is on the record, as an error rather than an approval.
    const entry = readAudit({ workspaceId: WS }).find((e) => e.actionId === "deploy.approve");
    expect(entry?.result).toBe("error");
    expect(entry?.summary ?? "").not.toMatch(/self-approved/);
  });

  it("lets a different admin approve it, and the deployment applies", async () => {
    const dep = await parked(ADA, "production");
    const p = await plan("deploy.approve", BOB, { deploymentId: dep.id }, { projectId });
    expect(p.blocked).toBeUndefined();
    const r = await exec("deploy.approve", BOB, { deploymentId: dep.id }, { projectId });
    expect(r.ok, r.error).toBe(true);
    expect(r.summary).not.toMatch(/self-approved/);
    expect(await settle(dep.id)).toBe("succeeded");
  });

  it("lets any admin approve a deployment an editor started", async () => {
    members([ADA, BOB]);
    const dep = await parked(ELI, "production");
    const r = await exec("deploy.approve", ADA, { deploymentId: dep.id }, { projectId });
    expect(r.ok, r.error).toBe(true);
  });

  it("never lets the Navigator approve the deployment it started", async () => {
    // The engine records a Navigator-started deployment as actor `navigator`.
    const made = await exec("env.create", ELI, { name: "nav-prod", class: "production" }, { projectId });
    const environmentId = (made.data as { environmentId: string }).environmentId;
    const applied = await runAction(
      "deploy.apply",
      ctxFor({ type: "navigator", id: "navigator", name: "Navigator" }, { projectId, environmentId, autonomy: "autonomous" }),
      {},
      { mode: "execute" }
    );
    const data = applied.result!.data as { deploymentId: string; status: string };
    expect(data.status).toBe("awaiting_approval");

    const self = await runAction(
      "deploy.approve",
      ctxFor({ type: "navigator", id: "navigator", name: "Navigator" }, { projectId, autonomy: "autonomous" }),
      { deploymentId: data.deploymentId },
      { mode: "execute" }
    );
    expect(self.result!.ok).toBe(false);
    expect(q.deployment(data.deploymentId)!.status).toBe("awaiting_approval");

    // A human admin approving the Navigator's deployment is the intended path.
    const human = await exec("deploy.approve", ADA, { deploymentId: data.deploymentId }, { projectId });
    expect(human.ok, human.error).toBe(true);
  });
});

describe("production: the sole admin may approve their own deployment, on the record", () => {
  it("allows it and says self-approved (sole admin) in the summary and the audit log", async () => {
    members([ADA]); // the only admin; Eli is an editor
    const dep = await parked(ADA, "production");

    const p = await plan("deploy.approve", ADA, { deploymentId: dep.id }, { projectId });
    expect(p.blocked).toBeUndefined();
    expect(p.details.join(" ")).toMatch(/self-approved \(sole admin\)/);

    const r = await exec("deploy.approve", ADA, { deploymentId: dep.id }, { projectId });
    expect(r.ok, r.error).toBe(true);
    expect(r.summary).toContain("self-approved (sole admin)");
    expect(await settle(dep.id)).toBe("succeeded");

    const entry = readAudit({ workspaceId: WS }).find((e) => e.actionId === "deploy.approve" && e.result === "ok");
    expect(entry?.summary).toContain("self-approved (sole admin)");
    expect(entry?.actor.id).toBe(ADA.id);
  });

  it("does not apply once a second admin exists", async () => {
    members([ADA]);
    const dep = await parked(ADA, "production");
    members([ADA, BOB]); // Bob is promoted before Ada approves
    const r = await exec("deploy.approve", ADA, { deploymentId: dep.id }, { projectId });
    expect(r.ok).toBe(false);
    expect(q.deployment(dep.id)!.status).toBe("awaiting_approval");
  });

  it("does not count as sole admin when it is somebody else's deployment", async () => {
    members([ADA]);
    const dep = await parked(ELI, "production");
    const r = await exec("deploy.approve", ADA, { deploymentId: dep.id }, { projectId });
    expect(r.ok, r.error).toBe(true);
    // Ada is the sole admin but not the requester: an ordinary approval.
    expect(r.summary).not.toMatch(/self-approved/);
  });
});

describe("non-production environments are unchanged", () => {
  it("lets an admin approve their own staging deployment, with no self-approval note", async () => {
    const dep = await parked(ADA, "staging");
    const p = await plan("deploy.approve", ADA, { deploymentId: dep.id }, { projectId });
    expect(p.blocked).toBeUndefined();
    expect(p.details.join(" ")).not.toMatch(/self-approved/);
    const r = await exec("deploy.approve", ADA, { deploymentId: dep.id }, { projectId });
    expect(r.ok, r.error).toBe(true);
    expect(r.summary).not.toMatch(/self-approved/);
    expect(await settle(dep.id)).toBe("succeeded");
  });
});
