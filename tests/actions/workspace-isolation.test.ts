/**
 * Two workspaces, and an id from one is worth nothing in the other.
 *
 * Role enforcement in `runAction` reads the caller's row in `ctx.workspaceId`
 * and nothing else, so it is only as narrow as the lookup that feeds it. When
 * the shared resolvers fetched a caller-supplied projectId or environmentId
 * out of the whole store, an admin of workspace A who came by one of B's ids
 * could plan and execute against B — deploys and deletions included. These
 * tests are the authorization matrix for that: every ID-bearing action, both
 * plan and execute, A's admin against B's objects.
 *
 * The second property matters as much as the first: a foreign id must be
 * indistinguishable from one that was never real. If the refusal said "you
 * don't have access", the refusal itself would confirm the object exists and
 * the id space would be enumerable across tenants. So every assertion here
 * compares the message for B's id against the message for pure nonsense, and
 * they have to be the same sentence.
 */
import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

process.env.ORRERY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-ws-isolation-"));
process.env.ORRERY_FAST = "1";

const { runAction } = await import("@/lib/actions/core");
const { db, resetDb } = await import("@/lib/db/store");
const {
  requireConnection,
  requireDeployment,
  requireEnvironment,
  requireProject,
  requireRevision,
} = await import("@/lib/actions/defs/_shared");
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
  email: `${name.toLowerCase()}@orrery.test`,
  role: "admin",
});

const manifest = (serviceName: string): Manifest => ({
  version: 1,
  services: [
    {
      id: `svc-${serviceName}`,
      name: serviceName,
      kind: "web",
      source: { type: "image", image: "ghcr.io/orrery/hello-web:1" },
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

/**
 * Both projects are slugged "atlas" on purpose. `q.project` matches on id OR
 * slug, so a resolver that fetched globally and only then checked the
 * workspace would hand Ada the other tenant's row and refuse it — hiding her
 * own project behind a stranger's slug. Scoping the search is what avoids that.
 */
const project = (id: string, workspaceId: string, name: string): Project => ({
  id,
  workspaceId,
  name,
  slug: "atlas",
  workingManifest: manifest("api"),
  origin: { type: "blank" },
  createdAt: AT,
});

const environment = (id: string, projectId: string, connectionId: string): Environment => ({
  id,
  projectId,
  name: "production",
  class: "production",
  connectionId,
  region: "sim-a",
  policies: { approvalRequired: false, allowStatefulDeletion: false },
  baseDomain: `${projectId}.orrery.app`,
  createdAt: AT,
});

const revision = (id: string, projectId: string): Revision =>
  ({
    id,
    projectId,
    number: 1,
    manifest: manifest("api"),
    message: "first",
    author: ada,
    createdAt: AT,
  }) as Revision;

const deployment = (id: string, projectId: string, environmentId: string): Deployment =>
  ({
    id,
    projectId,
    environmentId,
    revisionId: `rev-${projectId}`,
    status: "succeeded",
    steps: [],
    outputs: [],
    changeSummary: "first deploy",
    estCostDeltaUsd: 0,
    actor: ada,
    createdAt: AT,
    endedAt: AT,
  }) as Deployment;

/**
 * Ada is an admin of A and has no seat at all in B; Bo is an admin of B. Each
 * workspace gets a project with two environments (so a delete is not refused
 * for being the last one), a revision and a deployment.
 */
function seedTwo() {
  resetDb({
    workspaces: [wsA, wsB],
    members: [member("u-ada", wsA.id, "Ada"), member("u-bo", wsB.id, "Bo")],
    connections: [connection("conn-a", wsA.id), connection("conn-b", wsB.id)],
    projects: [project("prj-a", wsA.id, "Kepler Atlas"), project("prj-b", wsB.id, "Orbital Atlas")],
    environments: [
      environment("env-a", "prj-a", "conn-a"),
      environment("env-a2", "prj-a", "conn-a"),
      environment("env-b", "prj-b", "conn-b"),
      environment("env-b2", "prj-b", "conn-b"),
    ],
    revisions: [revision("rev-prj-a", "prj-a"), revision("rev-prj-b", "prj-b")],
    deployments: [
      deployment("dep-a", "prj-a", "env-a"),
      deployment("dep-b", "prj-b", "env-b"),
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

const plan = async (actionId: string, c: ActionContext, input: unknown) =>
  (await runAction(actionId, c, input, { mode: "plan" })).plan!;

const execute = async (actionId: string, c: ActionContext, input: unknown) =>
  (await runAction(actionId, c, input, { mode: "execute" })).result!;

/** The exact sentences the resolvers produce. Absent and foreign share them. */
const notFound = {
  project: (ref: string) => `Project "${ref}" does not exist. Pick one from the workspace overview.`,
  environment: (ref: string) =>
    `Environment "${ref}" does not exist. Pick one from the project's environment switcher.`,
  revision: (ref: string) => `Revision "${ref}" does not exist. Pick one from the project's history.`,
  deployment: (ref: string) =>
    `Deployment "${ref}" does not exist. Pick one from the environment's deployment history.`,
  connection: (ref: string) =>
    `Cloud connection "${ref}" does not exist. Pick one in Settings → Connections, or connect an account there.`,
};

/**
 * Nothing in a refusal may hint that the object is real: no "access", no
 * workspace names, no object names. The id the caller already typed is fine —
 * they supplied it.
 */
function revealsNothing(message: string) {
  expect(message).not.toMatch(/access|permitt|permission|not allowed|forbidden|denied|belongs to/i);
  expect(message).not.toMatch(/another workspace|other workspace|different workspace/i);
  for (const secret of ["Orbital", "orbital", "Kepler", "kepler", "u-bo", "Bo"])
    expect(message).not.toContain(secret);
}

/* ------------------------------- the matrix ------------------------------- */

beforeEach(seedTwo);

/**
 * Every ID-bearing action, with the id supplied the two ways an action can
 * receive one: in the input, and in the action context.
 */
const PROJECT_ACTIONS: { id: string; input: (projectId: string) => unknown }[] = [
  { id: "project.delete", input: (projectId) => ({ projectId }) },
  { id: "env.create", input: (projectId) => ({ projectId, name: "staging", class: "staging" }) },
  {
    id: "system.addService",
    input: (projectId) => ({ projectId, name: "intruder", kind: "web", image: "busybox:1" }),
  },
  { id: "system.removeService", input: (projectId) => ({ projectId, serviceId: "api" }) },
];

const ENVIRONMENT_ACTIONS: { id: string; input: (environmentId: string) => unknown }[] = [
  { id: "env.delete", input: (environmentId) => ({ environmentId }) },
  { id: "env.updatePolicies", input: (environmentId) => ({ environmentId, approvalRequired: false }) },
  { id: "env.setBudget", input: (environmentId) => ({ environmentId, budgetUsdMonthly: 1 }) },
  { id: "deploy.plan", input: (environmentId) => ({ environmentId }) },
  { id: "deploy.apply", input: (environmentId) => ({ environmentId, message: "intrusion" }) },
  { id: "deploy.rollback", input: (environmentId) => ({ environmentId }) },
];

describe("an admin of A cannot reach B's project by id", () => {
  for (const { id, input } of PROJECT_ACTIONS) {
    it(`${id} — plan is blocked with the not-found sentence`, async () => {
      const p = await plan(id, asAda(), input("prj-b"));
      expect(p.blocked).toBe(notFound.project("prj-b"));
      expect(p.details[0]).toBe(p.blocked);
      revealsNothing(p.blocked!);
    });

    it(`${id} — execute refuses and changes nothing in B`, async () => {
      const before = JSON.stringify(db().projects.find((x) => x.id === "prj-b"));
      const r = await execute(id, asAda(), input("prj-b"));
      expect(r.ok).toBe(false);
      expect(r.error).toBe(notFound.project("prj-b"));
      revealsNothing(r.error!);
      // B is untouched: still there, still exactly as it was.
      expect(db().projects.map((x) => x.id)).toContain("prj-b");
      expect(JSON.stringify(db().projects.find((x) => x.id === "prj-b"))).toBe(before);
    });

    it(`${id} — B's id reads exactly like an id that was never real`, async () => {
      const foreign = (await execute(id, asAda(), input("prj-b"))).error!;
      const fiction = (await execute(id, asAda(), input("prj-nope-000"))).error!;
      expect(foreign.replace("prj-b", "REF")).toBe(fiction.replace("prj-nope-000", "REF"));
    });
  }
});

describe("an admin of A cannot reach B's environment by id", () => {
  for (const { id, input } of ENVIRONMENT_ACTIONS) {
    it(`${id} — plan is blocked with the not-found sentence`, async () => {
      const p = await plan(id, asAda(), input("env-b"));
      expect(p.blocked).toBe(notFound.environment("env-b"));
      revealsNothing(p.blocked!);
    });

    it(`${id} — execute refuses and leaves B's environment in place`, async () => {
      const before = JSON.stringify(db().environments.find((e) => e.id === "env-b"));
      const r = await execute(id, asAda(), input("env-b"));
      expect(r.ok).toBe(false);
      expect(r.error).toBe(notFound.environment("env-b"));
      revealsNothing(r.error!);
      expect(db().environments.map((e) => e.id)).toContain("env-b");
      expect(JSON.stringify(db().environments.find((e) => e.id === "env-b"))).toBe(before);
    });

    it(`${id} — B's id reads exactly like an id that was never real`, async () => {
      const foreign = (await execute(id, asAda(), input("env-b"))).error!;
      const fiction = (await execute(id, asAda(), input("env-nope-000"))).error!;
      expect(foreign.replace("env-b", "REF")).toBe(fiction.replace("env-nope-000", "REF"));
    });
  }
});

describe("a forged action context is refused the same way as forged input", () => {
  it("refuses ctx.projectId pointing at B", async () => {
    const r = await execute("system.addService", asAda({ projectId: "prj-b" }), {
      name: "intruder",
      kind: "web",
      image: "busybox:1",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(notFound.project("prj-b"));
    expect(db().projects.find((p) => p.id === "prj-b")!.workingManifest.services).toHaveLength(1);
  });

  it("refuses ctx.environmentId pointing at B", async () => {
    const r = await execute("deploy.apply", asAda({ environmentId: "env-b" }), {});
    expect(r.ok).toBe(false);
    expect(r.error).toBe(notFound.environment("env-b"));
    expect(db().deployments.filter((d) => d.environmentId === "env-b")).toHaveLength(1);
  });

  it("refuses B's project even when B's environment is named alongside it", async () => {
    const r = await execute("deploy.apply", asAda({ projectId: "prj-b", environmentId: "env-b" }), {});
    expect(r.ok).toBe(false);
    expect(r.error).toBe(notFound.environment("env-b"));
  });

  /**
   * The interesting mix: a real environment of your own, paired with someone
   * else's project. Both ids have to be checked, not just the first one that
   * resolves — otherwise B's manifest deploys into A's infrastructure.
   */
  it("refuses B's project even when paired with A's own environment", async () => {
    const r = await execute("deploy.apply", asAda(), { projectId: "prj-b", environmentId: "env-a" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(notFound.project("prj-b"));
    revealsNothing(r.error!);
    expect(db().deployments.filter((d) => d.environmentId === "env-a")).toHaveLength(1);
  });
});

describe("the refusal is about tenancy, not about the object being broken", () => {
  it("lets B's own admin plan the same action on the same ids", async () => {
    for (const { id, input } of PROJECT_ACTIONS) {
      const p = await plan(id, ctx(bo, wsB.id), input("prj-b"));
      expect(p.blocked ?? "").not.toMatch(/does not exist/);
    }
    for (const { id, input } of ENVIRONMENT_ACTIONS) {
      const p = await plan(id, ctx(bo, wsB.id), input("env-b"));
      expect(p.blocked ?? "").not.toMatch(/does not exist/);
    }
  });

  it("lets A's admin act on A's own ids", async () => {
    const r = await execute("system.addService", asAda({ projectId: "prj-a" }), {
      name: "worker",
      kind: "worker",
      image: "busybox:1",
    });
    expect(r.ok).toBe(true);
    expect(db().projects.find((p) => p.id === "prj-a")!.workingManifest.services).toHaveLength(2);
    // …and B gained nothing from it.
    expect(db().projects.find((p) => p.id === "prj-b")!.workingManifest.services).toHaveLength(1);
  });
});

describe("a slug shared between workspaces resolves inside the caller's own", () => {
  it("gives each admin their own project for the slug they both use", () => {
    expect(requireProject(asAda(), "atlas").id).toBe("prj-a");
    expect(requireProject(ctx(bo, wsB.id), "atlas").id).toBe("prj-b");
  });

  it("does not let a stranger's slug hide your own project", async () => {
    const r = await execute("system.addService", asAda(), {
      projectId: "atlas",
      name: "by-slug",
      kind: "worker",
      image: "busybox:1",
    });
    expect(r.ok).toBe(true);
    expect(db().projects.find((p) => p.id === "prj-a")!.workingManifest.services).toHaveLength(2);
    expect(db().projects.find((p) => p.id === "prj-b")!.workingManifest.services).toHaveLength(1);
  });
});

describe("the resolvers themselves, on every id-bearing object", () => {
  const aCtx = () => asAda();

  it("requireProject refuses B's id with the not-found sentence", () => {
    expect(() => requireProject(aCtx(), "prj-b")).toThrow(notFound.project("prj-b"));
    expect(() => requireProject(aCtx(), "prj-nope")).toThrow(notFound.project("prj-nope"));
    expect(requireProject(aCtx(), "prj-a").id).toBe("prj-a");
  });

  it("requireEnvironment refuses B's id transitively, through its project", () => {
    expect(() => requireEnvironment(aCtx(), "env-b")).toThrow(notFound.environment("env-b"));
    expect(() => requireEnvironment(aCtx(), "env-nope")).toThrow(notFound.environment("env-nope"));
    expect(requireEnvironment(aCtx(), "env-a").id).toBe("env-a");
  });

  it("requireRevision refuses B's id transitively, through its project", () => {
    expect(() => requireRevision(aCtx(), "rev-prj-b")).toThrow(notFound.revision("rev-prj-b"));
    expect(() => requireRevision(aCtx(), "rev-nope")).toThrow(notFound.revision("rev-nope"));
    expect(requireRevision(aCtx(), "rev-prj-a").id).toBe("rev-prj-a");
  });

  it("requireDeployment refuses B's id transitively, through its project", () => {
    expect(() => requireDeployment(aCtx(), "dep-b")).toThrow(notFound.deployment("dep-b"));
    expect(() => requireDeployment(aCtx(), "dep-nope")).toThrow(notFound.deployment("dep-nope"));
    expect(requireDeployment(aCtx(), "dep-a").id).toBe("dep-a");
  });

  it("requireConnection refuses B's id by its own workspaceId", () => {
    expect(() => requireConnection(aCtx(), "conn-b")).toThrow(notFound.connection("conn-b"));
    expect(() => requireConnection(aCtx(), "conn-nope")).toThrow(notFound.connection("conn-nope"));
    expect(requireConnection(aCtx(), "conn-a").id).toBe("conn-a");
  });

  it("resolves nothing at all without a workspace in scope, and names the fix", () => {
    const noWorkspace = { workspaceId: "", actor: ada } as ActionContext;
    expect(() => requireProject(noWorkspace, "prj-a")).toThrow(/No workspace in scope/);
    expect(() => requireProject(noWorkspace, "prj-a")).toThrow(/Pass workspaceId in the action context/);
    expect(() => requireEnvironment(noWorkspace, "env-a")).toThrow(/No workspace in scope/);
    expect(() => requireConnection(noWorkspace, "conn-a")).toThrow(/No workspace in scope/);
  });
});
