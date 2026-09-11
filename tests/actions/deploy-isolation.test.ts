/**
 * The deploy actions, across a tenant boundary.
 *
 * `deploy.ts` used to route around the scoped resolvers in `_shared`: it kept a
 * local `requireDeployment` that read the whole store, and its approve, cancel
 * and rollback executes handed the caller's raw id straight to the engine, which
 * is authoritative and asks nothing. Five ways out of the tenant, one file:
 *
 *   1. approve/cancel PLAN — a foreign deployment's changeSummary, cost delta
 *      and environment name rendered to a stranger.
 *   2. approve EXECUTE — approves *and applies* a deployment in any workspace.
 *   3. cancel EXECUTE — strands someone else's in-flight deployment between two
 *      revisions.
 *   4. rollback PLAN — diffs a foreign revision into `details`, which renders
 *      another tenant's entire system to whoever asks for it.
 *   5. rollback EXECUTE — deploys a foreign workspace's manifest into our own
 *      live infrastructure. The worst of the five.
 *
 * Every case is asserted twice over. Plan and execute must BOTH refuse — a plan
 * that renders while execute refuses is still the disclosure, and an execute
 * that runs while the plan refuses is the breach. And the refusal for a real
 * foreign id has to be the same sentence as the refusal for an id that was
 * never real, or the refusal itself confirms the object exists and the id space
 * becomes enumerable across tenants.
 *
 * Positive controls sit beside every one of them: the same action, the same
 * shape, inside the caller's own workspace, succeeding. Without those a broken
 * action would pass this whole file by refusing everything.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ActionContext } from "@/lib/actions/core";
import type {
  Actor,
  CloudConnection,
  Deployment,
  Environment,
  Manifest,
  Member,
  Project,
  Revision,
  Workspace,
} from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-deploy-isolation-", { fast: true });
const { runAction } = await import("@/lib/actions/core");
const { db, q, resetDb } = await import("@/lib/db/store");
await import("@/lib/actions/defs");

const AT = "2026-09-01T10:00:00.000Z";

/* --------------------------------- fixture -------------------------------- */

const wsA: Workspace = { id: "ws-a", name: "Kepler Labs", slug: "kepler", createdAt: AT };
const wsB: Workspace = { id: "ws-b", name: "Orbital", slug: "orbital", createdAt: AT };

const ada: Actor = { type: "user", id: "u-ada", name: "Ada" };
const bo: Actor = { type: "user", id: "u-bo", name: "Bo" };

const member = (id: string, workspaceId: string, name: string): Member => ({
  id,
  workspaceId,
  name,
  email: `${name.toLowerCase()}@zenith.test`,
  role: "admin",
});

/** Named services, so anything that leaks out of B's system is legible. */
const manifest = (serviceName: string): Manifest => ({
  version: 1,
  services: [
    {
      id: `svc-${serviceName}`,
      name: serviceName,
      kind: "web",
      source: { type: "image", image: "ghcr.io/zenith/hello-web:1" },
      size: "small",
      replicas: 1,
      port: 3000,
      env: [],
      ownership: "managed",
    },
  ],
  resources: [],
  routes: [],
  bindings: [],
});

const connection = (id: string, workspaceId: string): CloudConnection => ({
  id,
  workspaceId,
  provider: "sandbox",
  label: "Sandbox",
  region: "sim-a",
  status: "healthy",
  grantedPermissions: [],
  createdAt: AT,
});

const project = (id: string, workspaceId: string, name: string, slug: string): Project => ({
  id,
  workspaceId,
  name,
  slug,
  workingManifest: manifest("api"),
  origin: { type: "blank" },
  createdAt: AT,
});

const environment = (
  id: string,
  projectId: string,
  connectionId: string,
  name: string,
  deployedRevisionId?: string
): Environment => ({
  id,
  projectId,
  name,
  class: "production",
  connectionId,
  region: "sim-a",
  // Approval is on for both, which is what makes the positive controls cheap:
  // a deployment parks at awaiting_approval, where approve and cancel both
  // have something real to do and no runner is left ticking.
  policies: { approvalRequired: true, allowStatefulDeletion: false },
  baseDomain: `${projectId}.zenith.app`,
  deployedRevisionId,
  createdAt: AT,
});

const revision = (id: string, projectId: string, number: number, service: string): Revision =>
  ({
    id,
    projectId,
    number,
    manifest: manifest(service),
    message: `r${number}`,
    author: ada,
    createdAt: AT,
  }) as Revision;

const deployment = (
  id: string,
  projectId: string,
  environmentId: string,
  fields: Partial<Deployment>
): Deployment =>
  ({
    id,
    projectId,
    environmentId,
    revisionId: `rev-${projectId}-2`,
    previousRevisionId: `rev-${projectId}-1`,
    status: "succeeded",
    steps: [],
    outputs: [],
    changeSummary: "1 changed",
    estCostDeltaUsd: 0,
    actor: ada,
    createdAt: AT,
    ...fields,
  }) as Deployment;

/**
 * Ada is an admin of A with no seat at all in B; Bo is an admin of B.
 *
 * B's deployment is parked at `awaiting_approval` on purpose. Both approve and
 * cancel would genuinely succeed against it — so when Ada is refused, the
 * refusal is about tenancy and not about the deployment being in a state that
 * happens to have nothing to do.
 *
 * A owns a second project as well. A revision of *that* project is a legitimate
 * object of Ada's, and rolling env-a back to it is still wrong: it describes a
 * system that was never in this environment, so the diff would be a fiction and
 * the deploy would be real.
 */
function seedTwo() {
  resetDb({
    workspaces: [wsA, wsB],
    members: [member("u-ada", wsA.id, "Ada"), member("u-bo", wsB.id, "Bo")],
    connections: [connection("conn-a", wsA.id), connection("conn-b", wsB.id)],
    projects: [
      project("prj-a", wsA.id, "Kepler Atlas", "atlas"),
      project("prj-a2", wsA.id, "Kepler Beacon", "beacon"),
      project("prj-b", wsB.id, "Orbital Atlas", "orbital-atlas"),
    ],
    environments: [
      environment("env-a", "prj-a", "conn-a", "production", "rev-prj-a-2"),
      environment("env-a2", "prj-a2", "conn-a", "beacon-prod"),
      environment("env-b", "prj-b", "conn-b", "orbital-prod", "rev-prj-b-2"),
    ],
    revisions: [
      revision("rev-prj-a-1", "prj-a", 1, "api"),
      revision("rev-prj-a-2", "prj-a", 2, "api"),
      revision("rev-prj-a2-1", "prj-a2", 1, "beacon-telemetry"),
      revision("rev-prj-b-1", "prj-b", 1, "orbital-secret-api"),
      revision("rev-prj-b-2", "prj-b", 2, "orbital-secret-api"),
    ],
    deployments: [
      deployment("dep-a", "prj-a", "env-a", { status: "succeeded", changeSummary: "1 changed" }),
      deployment("dep-b", "prj-b", "env-b", {
        status: "awaiting_approval",
        changeSummary: "orbital-secret-api rollout",
        estCostDeltaUsd: 4242,
      }),
    ],
  });
}

/* --------------------------------- helpers -------------------------------- */

const ctx = (actor: Actor, workspaceId: string, scope: Partial<ActionContext> = {}): ActionContext => ({
  workspaceId,
  actor,
  ...scope,
});

/** Ada, acting in her own workspace — where she really is an admin. */
const asAda = (scope: Partial<ActionContext> = {}) => ctx(ada, wsA.id, scope);
const asBo = (scope: Partial<ActionContext> = {}) => ctx(bo, wsB.id, scope);

const plan = async (actionId: string, c: ActionContext, input: unknown) =>
  (await runAction(actionId, c, input, { mode: "plan" })).plan!;

const execute = async (actionId: string, c: ActionContext, input: unknown) =>
  (await runAction(actionId, c, input, { mode: "execute" })).result!;

/** The exact sentences the shared resolvers produce. Absent and foreign share them. */
const notFound = {
  environment: (ref: string) =>
    `Environment "${ref}" does not exist. Pick one from the project's environment switcher.`,
  revision: (ref: string) => `Revision "${ref}" does not exist. Pick one from the project's history.`,
  deployment: (ref: string) =>
    `Deployment "${ref}" does not exist. Pick one from the environment's deployment history.`,
};

/**
 * Everything about B that a refusal — or a rendered plan — must never contain.
 * The id the caller typed is not on the list: they supplied it themselves.
 */
const B_SECRETS = [
  "Orbital",
  "orbital-prod",
  "orbital-secret-api",
  "orbital rollout",
  "4242",
  "Bo",
  "u-bo",
];

function revealsNothing(message: string) {
  expect(message).not.toMatch(/access|permitt|permission|not allowed|forbidden|denied|belongs to/i);
  expect(message).not.toMatch(/another workspace|other workspace|different workspace/i);
  for (const secret of B_SECRETS) expect(message).not.toContain(secret);
}

/** Nothing of B's system may appear anywhere in a plan Ada is shown. */
function planRevealsNothing(p: unknown) {
  const rendered = JSON.stringify(p);
  for (const secret of B_SECRETS) expect(rendered).not.toContain(secret);
}

/**
 * Everything of B's that a refused action might have touched, serialised. The
 * assertion is byte-identity, not "still exists": a cancel that only flipped a
 * status, or a rollback that pushed one revision into an environment, both show
 * up here as a changed string.
 */
const snapshotB = () =>
  JSON.stringify({
    deployments: db().deployments.filter((d) => d.projectId === "prj-b"),
    environments: db().environments.filter((e) => e.projectId === "prj-b"),
    projects: db().projects.filter((p) => p.workspaceId === wsB.id),
    revisions: db().revisions.filter((r) => r.projectId === "prj-b"),
  });

function expectBUntouched(before: string) {
  const after = snapshotB();
  // Parsed first, because a diff is readable; then the raw bytes.
  expect(JSON.parse(after)).toEqual(JSON.parse(before));
  expect(after).toBe(before);
}

/** A's own side of the house, for the rollback tests: nothing was deployed. */
const snapshotA = () =>
  JSON.stringify({
    deployments: db().deployments.filter((d) => d.projectId === "prj-a"),
    environments: db().environments.filter((e) => e.projectId === "prj-a"),
  });

async function settle(deploymentId: string, ms = 20_000): Promise<Deployment> {
  const deadline = Date.now() + ms;
  for (;;) {
    const d = q.deployment(deploymentId)!;
    if (["succeeded", "failed", "cancelled", "rolled_back"].includes(d.status)) return d;
    if (Date.now() > deadline) throw new Error(`deployment stuck in ${d.status}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** A real parked deployment of Ada's own, made the way a user makes one. */
async function parkedDeploymentInA(): Promise<string> {
  // env-a already runs the working copy, so give it something to deploy.
  const edited = await execute("system.addService", asAda({ projectId: "prj-a" }), {
    name: "worker",
    kind: "worker",
    image: "busybox:1",
  });
  expect(edited.ok).toBe(true);

  const applied = await execute("deploy.apply", asAda(), {
    projectId: "prj-a",
    environmentId: "env-a",
    message: "positive control",
  });
  expect(applied.ok, applied.error).toBe(true);
  const { deploymentId, status } = applied.data as { deploymentId: string; status: string };
  expect(status).toBe("awaiting_approval");
  return deploymentId;
}

beforeEach(seedTwo);

/* ------------------ 1 + 2 + 3: approve and cancel, by id ------------------- */

const DEPLOYMENT_ACTIONS = [
  { id: "deploy.approve", input: (deploymentId: string) => ({ deploymentId }) },
  { id: "deploy.cancel", input: (deploymentId: string) => ({ deploymentId }) },
];

describe("an admin of A cannot reach B's deployment by id", () => {
  for (const { id, input } of DEPLOYMENT_ACTIONS) {
    it(`${id} — plan is blocked with the not-found sentence, and discloses nothing`, async () => {
      const p = await plan(id, asAda(), input("dep-b"));
      expect(p.blocked).toBe(notFound.deployment("dep-b"));
      expect(p.details[0]).toBe(p.blocked);
      revealsNothing(p.blocked!);
      // Bypass 1 in full: not the changeSummary, not the cost delta, not the
      // environment name — none of it reaches the rendered plan.
      planRevealsNothing(p);
      expect(p.costDeltaUsd).toBe(0);
    });

    it(`${id} — execute refuses and leaves B byte-identical`, async () => {
      const before = snapshotB();
      const r = await execute(id, asAda(), input("dep-b"));
      expect(r.ok).toBe(false);
      expect(r.error).toBe(notFound.deployment("dep-b"));
      revealsNothing(r.error!);
      expectBUntouched(before);
      // Specifically: still parked, never claimed, and no runner started.
      expect(q.deployment("dep-b")!.status).toBe("awaiting_approval");
      expect(db().environments.find((e) => e.id === "env-b")!.activeDeploymentId).toBeUndefined();
    });

    it(`${id} — B's id reads exactly like an id that was never real`, async () => {
      const foreign = (await execute(id, asAda(), input("dep-b"))).error!;
      const fiction = (await execute(id, asAda(), input("dep-nope-000"))).error!;
      expect(foreign.replace("dep-b", "REF")).toBe(fiction.replace("dep-nope-000", "REF"));

      const foreignPlan = (await plan(id, asAda(), input("dep-b"))).blocked!;
      const fictionPlan = (await plan(id, asAda(), input("dep-nope-000"))).blocked!;
      expect(foreignPlan.replace("dep-b", "REF")).toBe(fictionPlan.replace("dep-nope-000", "REF"));
      // Plan and execute agree, so no surface can infer a difference between them.
      expect(foreignPlan).toBe(foreign);
    });
  }

  it("refuses even when B's deployment is named through a forged action context", async () => {
    const before = snapshotB();
    const r = await execute("deploy.approve", asAda({ projectId: "prj-b", environmentId: "env-b" }), {
      deploymentId: "dep-b",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(notFound.deployment("dep-b"));
    expectBUntouched(before);
  });
});

describe("approve and cancel still work inside the caller's own workspace", () => {
  it("deploy.approve applies A's own parked deployment", async () => {
    const deploymentId = await parkedDeploymentInA();

    const p = await plan("deploy.approve", asAda(), { deploymentId });
    expect(p.blocked).toBeUndefined();

    const r = await execute("deploy.approve", asAda(), { deploymentId });
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/approved/i);
    expect(q.deployment(deploymentId)!.status).not.toBe("awaiting_approval");
    const done = await settle(deploymentId);
    expect(["succeeded", "failed"]).toContain(done.status);
    // B gained nothing from A's deploy.
    expect(q.deployment("dep-b")!.status).toBe("awaiting_approval");
  });

  it("deploy.cancel cancels A's own parked deployment", async () => {
    const deploymentId = await parkedDeploymentInA();

    const p = await plan("deploy.cancel", asAda(), { deploymentId });
    expect(p.blocked).toBeUndefined();

    const r = await execute("deploy.cancel", asAda(), { deploymentId });
    expect(r.ok).toBe(true);
    expect(q.deployment(deploymentId)!.status).toBe("cancelled");
    expect(q.deployment("dep-b")!.status).toBe("awaiting_approval");
  });

  it("lets B's own admin plan the same actions on the same id", async () => {
    for (const { id, input } of DEPLOYMENT_ACTIONS) {
      const p = await plan(id, asBo(), input("dep-b"));
      expect(p.blocked ?? "").not.toMatch(/does not exist/);
    }
  });
});

/* ------------------- 4 + 5: rollback, by target revision ------------------- */

describe("an admin of A cannot roll back to B's revision", () => {
  const foreignTarget = { environmentId: "env-a", toRevisionId: "rev-prj-b-1" };

  it("plan refuses with the not-found sentence and never diffs B's system", async () => {
    const p = await plan("deploy.rollback", asAda(), foreignTarget);
    expect(p.blocked).toBe(notFound.revision("rev-prj-b-1"));
    expect(p.details).toEqual([p.blocked]);
    revealsNothing(p.blocked!);
    // Bypass 4: the diff is what rendered the whole foreign system. It is gone.
    planRevealsNothing(p);
    expect(p.costDeltaUsd).toBe(0);
    expect(p.requiresApproval).toBe(false);
  });

  it("execute refuses, and deploys nothing into A or B", async () => {
    const beforeB = snapshotB();
    const beforeA = snapshotA();

    const r = await execute("deploy.rollback", asAda(), foreignTarget);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(notFound.revision("rev-prj-b-1"));
    revealsNothing(r.error!);

    expectBUntouched(beforeB);
    // Bypass 5 is about OUR infrastructure: no deployment was created, and
    // env-a is still on the revision it was on.
    expect(snapshotA()).toBe(beforeA);
    expect(q.deploymentsOf("env-a").map((d) => d.id)).toEqual(["dep-a"]);
    expect(db().environments.find((e) => e.id === "env-a")!.deployedRevisionId).toBe("rev-prj-a-2");
  });

  it("B's revision id reads exactly like an id that was never real", async () => {
    const foreign = (await execute("deploy.rollback", asAda(), foreignTarget)).error!;
    const fiction = (
      await execute("deploy.rollback", asAda(), {
        environmentId: "env-a",
        toRevisionId: "rev-nope-000",
      })
    ).error!;
    expect(foreign.replace("rev-prj-b-1", "REF")).toBe(fiction.replace("rev-nope-000", "REF"));

    const foreignPlan = (await plan("deploy.rollback", asAda(), foreignTarget)).blocked!;
    expect(foreignPlan).toBe(foreign);
  });

  it("refuses B's environment paired with B's revision, without naming either", async () => {
    const before = snapshotB();
    const r = await execute("deploy.rollback", asAda(), {
      environmentId: "env-b",
      toRevisionId: "rev-prj-b-1",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(notFound.environment("env-b"));
    revealsNothing(r.error!);
    expectBUntouched(before);
  });
});

/**
 * The same guard, one step in from the tenant boundary. Both objects are Ada's,
 * so nothing is being hidden from her — but a revision of another project
 * describes a different system, and rolling this environment back to it would
 * deploy something that was never here off the back of a nonsense diff.
 */
describe("a revision from another project of your own is refused too", () => {
  const crossProject = { environmentId: "env-a", toRevisionId: "rev-prj-a2-1" };

  it("plan is blocked, and does not render the other project's system", async () => {
    const p = await plan("deploy.rollback", asAda(), crossProject);
    expect(p.blocked).toMatch(/belongs to a different project/);
    expect(p.blocked).toContain("production");
    expect(JSON.stringify(p)).not.toContain("beacon-telemetry");
    expect(p.costDeltaUsd).toBe(0);
  });

  it("execute refuses with the same sentence the plan showed, and deploys nothing", async () => {
    const beforeA = snapshotA();
    const blocked = (await plan("deploy.rollback", asAda(), crossProject)).blocked!;
    const r = await execute("deploy.rollback", asAda(), crossProject);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(blocked);
    expect(snapshotA()).toBe(beforeA);
    expect(q.deploymentsOf("env-a").map((d) => d.id)).toEqual(["dep-a"]);
  });
});

describe("rollback still works inside the caller's own project", () => {
  it("plans a rollback to A's own earlier revision", async () => {
    const p = await plan("deploy.rollback", asAda(), {
      environmentId: "env-a",
      toRevisionId: "rev-prj-a-1",
    });
    expect(p.blocked).toBeUndefined();
    expect(p.summary).toMatch(/Roll production back to revision 1/);
    expect(p.requiresApproval).toBe(true);
  });

  it("executes a rollback to A's own earlier revision", async () => {
    const r = await execute("deploy.rollback", asAda(), {
      environmentId: "env-a",
      toRevisionId: "rev-prj-a-1",
    });
    expect(r.ok).toBe(true);
    const { deploymentId, revisionId, status } = r.data as {
      deploymentId: string;
      revisionId: string;
      status: string;
    };
    expect(revisionId).toBe("rev-prj-a-1");
    // env-a requires approval, so the rollback parks rather than applying.
    expect(status).toBe("awaiting_approval");
    expect(q.deployment(deploymentId)!.projectId).toBe("prj-a");
    // …and B is exactly where it was.
    expect(q.deployment("dep-b")!.status).toBe("awaiting_approval");
    expect(db().deployments.filter((d) => d.projectId === "prj-b")).toHaveLength(1);
  });

  it("still derives the previous revision when no target is named", async () => {
    const p = await plan("deploy.rollback", asAda(), { environmentId: "env-a" });
    expect(p.blocked).toBeUndefined();
    expect(p.summary).toMatch(/Roll production back to revision 1/);
  });

  it("says there is nothing to roll back to when the environment has no history", async () => {
    const p = await plan("deploy.rollback", asAda(), { environmentId: "env-a2" });
    expect(p.blocked).toMatch(/has no earlier revision to roll back to/);
    const r = await execute("deploy.rollback", asAda(), { environmentId: "env-a2" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(p.blocked);
  });
});
