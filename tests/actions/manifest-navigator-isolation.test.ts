/**
 * Two workspaces, and neither the Source editor nor the Navigator will touch
 * the other one's estate.
 *
 * Both actions here resolved a caller-supplied id out of the whole store:
 *
 *  - `project.updateManifest` looked its project up with `q.project`, which
 *    matches on id OR slug. Two tenants may both have a project slugged
 *    "atlas", so the id was not even needed — the slug alone could hand you a
 *    stranger's project, and this action REPLACES a project's entire system
 *    definition. Both projects below are slugged "atlas" on purpose: if the
 *    global lookup came back, these tests would fail on the slug case as well
 *    as the id case.
 *
 *  - `ops.investigate` resolved `environmentId` globally and then printed
 *    `env.name` into the plan summary. Read-only, viewer role, and a working
 *    name-disclosure oracle for another tenant's environments. A plan that
 *    renders is the leak; execute refusing afterwards would be too late.
 *
 * Both properties are asserted throughout: a foreign id is refused, and its
 * refusal is the same sentence a fabricated id gets — otherwise the refusal
 * itself confirms the object is real and the id space becomes enumerable.
 * Every negative has a positive control beside it, so a refusal that came from
 * something being broken rather than from tenancy would show up as a failure.
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

tempDataDir("zenith-manifest-nav-isolation-", { fast: true });
const { runAction } = await import("@/lib/actions/core");
const { db, resetDb } = await import("@/lib/db/store");
const { manifestHash } = await import("@/lib/actions/defs/project-manifest");
await import("@/lib/actions/defs");

const AT = "2026-09-01T10:00:00.000Z";

/* --------------------------------- fixture -------------------------------- */

const wsA: Workspace = { id: "ws-a", name: "Kepler Labs", slug: "kepler", createdAt: AT };
const wsB: Workspace = { id: "ws-b", name: "Orbital", slug: "orbital", createdAt: AT };

const ada: Actor = { type: "user", id: "u-ada", name: "Ada" };
const bo: Actor = { type: "user", id: "u-bo", name: "Bo" };

/** B's environment name. Distinctive so its appearance anywhere is provable. */
const B_ENV_NAME = "hades-prod";

const member = (id: string, workspaceId: string, name: string): Member => ({
  id,
  workspaceId,
  name,
  email: `${name.toLowerCase()}@zenith.test`,
  role: "admin",
});

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

/** Both slugged "atlas": the slug must never be what decides tenancy. */
const project = (id: string, workspaceId: string, name: string, service: string): Project => ({
  id,
  workspaceId,
  name,
  slug: "atlas",
  workingManifest: manifest(service),
  origin: { type: "blank" },
  createdAt: AT,
});

const environment = (
  id: string,
  projectId: string,
  connectionId: string,
  name: string
): Environment => ({
  id,
  projectId,
  name,
  class: "production",
  connectionId,
  region: "sim-a",
  policies: { approvalRequired: false, allowStatefulDeletion: false },
  baseDomain: `${projectId}.zenith.app`,
  createdAt: AT,
});

const revision = (id: string, projectId: string, service: string): Revision =>
  ({
    id,
    projectId,
    number: 1,
    manifest: manifest(service),
    message: "first",
    author: ada,
    createdAt: AT,
  }) as Revision;

/**
 * A failed deployment in each project, because that is the only thing
 * `ops.investigate` has to report on — without one the positive controls
 * would pass for the wrong reason (nothing to say, so nothing disclosed).
 */
const failedDeployment = (id: string, projectId: string, environmentId: string): Deployment =>
  ({
    id,
    projectId,
    environmentId,
    revisionId: `rev-${projectId}`,
    status: "failed",
    steps: [
      {
        id: `${id}-s1`,
        seq: 1,
        phase: "provision",
        title: "Create the service",
        targetId: "",
        status: "failed",
        error: "the provider refused the request",
      },
    ],
    outputs: [],
    changeSummary: "first deploy",
    estCostDeltaUsd: 0,
    actor: ada,
    createdAt: AT,
    endedAt: AT,
  }) as Deployment;

function seedTwo() {
  resetDb({
    workspaces: [wsA, wsB],
    members: [member("u-ada", wsA.id, "Ada"), member("u-bo", wsB.id, "Bo")],
    connections: [connection("conn-a", wsA.id), connection("conn-b", wsB.id)],
    projects: [
      project("prj-a", wsA.id, "Kepler Atlas", "api"),
      project("prj-b", wsB.id, "Orbital Atlas", "ledger"),
    ],
    environments: [
      environment("env-a", "prj-a", "conn-a", "production"),
      environment("env-b", "prj-b", "conn-b", B_ENV_NAME),
    ],
    revisions: [revision("rev-prj-a", "prj-a", "api"), revision("rev-prj-b", "prj-b", "ledger")],
    deployments: [
      failedDeployment("dep-a", "prj-a", "env-a"),
      failedDeployment("dep-b", "prj-b", "env-b"),
    ],
  });
}

/* --------------------------------- helpers -------------------------------- */

const ctx = (
  actor: Actor,
  workspaceId: string,
  scope: Partial<ActionContext> = {}
): ActionContext => ({ workspaceId, actor, ...scope });

/** Ada, always acting in her own workspace — where she really is an admin. */
const asAda = (scope: Partial<ActionContext> = {}) => ctx(ada, wsA.id, scope);
/** Bo, admin of B. Every negative below is his legitimate action. */
const asBo = (scope: Partial<ActionContext> = {}) => ctx(bo, wsB.id, scope);

const plan = async (actionId: string, c: ActionContext, input: unknown) =>
  (await runAction(actionId, c, input, { mode: "plan" })).plan!;

const execute = async (actionId: string, c: ActionContext, input: unknown) =>
  (await runAction(actionId, c, input, { mode: "execute" })).result!;

/** The sentences `_shared` produces. Absent and foreign ids share them. */
const notFound = {
  project: (ref: string) => `Project "${ref}" does not exist. Pick one from the workspace overview.`,
  environment: (ref: string) =>
    `Environment "${ref}" does not exist. Pick one from the project's environment switcher.`,
};

/** Everything about B that a refusal must never contain. */
const B_SECRETS = ["Orbital", "orbital", "hades-prod", "ledger", "prj-b", "env-b", "u-bo"];

function revealsNothing(message: string) {
  expect(message).not.toMatch(/access|permitt|permission|not allowed|forbidden|denied|belongs to/i);
  expect(message).not.toMatch(/another workspace|other workspace|different workspace/i);
  for (const secret of B_SECRETS.filter((s) => s !== "prj-b" && s !== "env-b"))
    expect(message).not.toContain(secret);
}

/** Nothing anywhere in a rendered plan or result may name B. The id the caller
 *  typed is theirs already, so it is echoed back and excluded here. */
function payloadRevealsNothing(payload: unknown, typedId: string) {
  const json = JSON.stringify(payload).split(typedId).join("<typed>");
  for (const secret of B_SECRETS) expect(json).not.toContain(secret);
}

const projectOf = (id: string) => db().projects.find((p) => p.id === id)!;
const snapshotOf = (id: string) => structuredClone(projectOf(id).workingManifest);

/** The replacement manifest a save would install. Valid, and B's admin can
 *  install it — so a refusal is never about the payload. */
const intruder = manifest("intruder");

beforeEach(seedTwo);

/* -------------------- project.updateManifest — by input id ------------------ */

describe("project.updateManifest refuses another workspace's project", () => {
  it("plan is blocked with the not-found sentence and discloses nothing", async () => {
    const p = await plan("project.updateManifest", asAda(), {
      projectId: "prj-b",
      manifest: intruder,
    });
    expect(p.blocked).toBe(notFound.project("prj-b"));
    expect(p.details[0]).toBe(p.blocked);
    revealsNothing(p.blocked!);
    payloadRevealsNothing(p, "prj-b");
  });

  it("execute refuses and B's manifest stays byte-identical", async () => {
    const before = snapshotOf("prj-b");
    const bytes = JSON.stringify(before);

    const r = await execute("project.updateManifest", asAda(), {
      projectId: "prj-b",
      manifest: intruder,
    });

    expect(r.ok).toBe(false);
    expect(r.error).toBe(notFound.project("prj-b"));
    revealsNothing(r.error!);
    payloadRevealsNothing(r, "prj-b");
    expect(projectOf("prj-b").workingManifest).toEqual(before);
    expect(JSON.stringify(projectOf("prj-b").workingManifest)).toBe(bytes);
  });

  it("B's id reads exactly like an id that was never real", async () => {
    const foreignPlan = (
      await plan("project.updateManifest", asAda(), { projectId: "prj-b", manifest: intruder })
    ).blocked!;
    const fictionPlan = (
      await plan("project.updateManifest", asAda(), {
        projectId: "prj-nope-000",
        manifest: intruder,
      })
    ).blocked!;
    expect(foreignPlan.replace("prj-b", "REF")).toBe(fictionPlan.replace("prj-nope-000", "REF"));

    const foreign = (
      await execute("project.updateManifest", asAda(), { projectId: "prj-b", manifest: intruder })
    ).error!;
    const fiction = (
      await execute("project.updateManifest", asAda(), {
        projectId: "prj-nope-000",
        manifest: intruder,
      })
    ).error!;
    expect(foreign.replace("prj-b", "REF")).toBe(fiction.replace("prj-nope-000", "REF"));
  });

  /**
   * The concurrency token must not become the oracle the id no longer is:
   * a right hash and a wrong hash against a foreign project answer the same.
   */
  it("does not let expectedHash test whether a foreign project's copy matches", async () => {
    const right = manifestHash(projectOf("prj-b").workingManifest);
    const wrong = manifestHash(intruder);

    const a = await execute("project.updateManifest", asAda(), {
      projectId: "prj-b",
      manifest: intruder,
      expectedHash: right,
    });
    const b = await execute("project.updateManifest", asAda(), {
      projectId: "prj-b",
      manifest: intruder,
      expectedHash: wrong,
    });

    expect(a.error).toBe(notFound.project("prj-b"));
    expect(b.error).toBe(a.error);
    expect(a.summary).toBe(b.summary);
    expect(projectOf("prj-b").workingManifest).toEqual(snapshotOf("prj-b"));
  });
});

/* ------------------ project.updateManifest — by forged context ------------- */

describe("project.updateManifest treats a forged ctx.projectId like forged input", () => {
  it("plan is blocked with the same sentence", async () => {
    const p = await plan("project.updateManifest", asAda({ projectId: "prj-b" }), {
      manifest: intruder,
    });
    expect(p.blocked).toBe(notFound.project("prj-b"));
    revealsNothing(p.blocked!);
    payloadRevealsNothing(p, "prj-b");
  });

  it("execute refuses and B's manifest stays byte-identical", async () => {
    const before = snapshotOf("prj-b");
    const bytes = JSON.stringify(before);

    const r = await execute("project.updateManifest", asAda({ projectId: "prj-b" }), {
      manifest: intruder,
    });

    expect(r.ok).toBe(false);
    expect(r.error).toBe(notFound.project("prj-b"));
    revealsNothing(r.error!);
    expect(projectOf("prj-b").workingManifest).toEqual(before);
    expect(JSON.stringify(projectOf("prj-b").workingManifest)).toBe(bytes);
  });

  /** The fallback chain in full: neither half of `input ?? ctx` may resolve
   *  outside the caller's workspace, and input still wins when both are set. */
  it("refuses B's project in the context even when A's own project is in the input", async () => {
    const r = await execute("project.updateManifest", asAda({ projectId: "prj-b" }), {
      projectId: "prj-a",
      manifest: intruder,
    });
    expect(r.ok).toBe(true);
    expect(projectOf("prj-a").workingManifest.services.map((s) => s.name)).toEqual(["intruder"]);
    expect(projectOf("prj-b").workingManifest.services.map((s) => s.name)).toEqual(["ledger"]);
  });
});

/* ------------------------------ the slug case ------------------------------ */

describe("a slug both workspaces use resolves inside the caller's own", () => {
  it("saves over A's atlas, never B's, when the caller says \"atlas\"", async () => {
    const bBefore = snapshotOf("prj-b");
    const bBytes = JSON.stringify(bBefore);

    const p = await plan("project.updateManifest", asAda(), {
      projectId: "atlas",
      manifest: intruder,
    });
    expect(p.blocked).toBeUndefined();

    const r = await execute("project.updateManifest", asAda(), {
      projectId: "atlas",
      manifest: intruder,
    });

    expect(r.ok).toBe(true);
    expect(projectOf("prj-a").workingManifest.services.map((s) => s.name)).toEqual(["intruder"]);
    expect(projectOf("prj-b").workingManifest).toEqual(bBefore);
    expect(JSON.stringify(projectOf("prj-b").workingManifest)).toBe(bBytes);
  });

  it("gives B's admin B's atlas for the same word", async () => {
    const r = await execute("project.updateManifest", asBo(), {
      projectId: "atlas",
      manifest: intruder,
    });
    expect(r.ok).toBe(true);
    expect(projectOf("prj-b").workingManifest.services.map((s) => s.name)).toEqual(["intruder"]);
    expect(projectOf("prj-a").workingManifest.services.map((s) => s.name)).toEqual(["api"]);
  });
});

/* ------------------- positive controls for the manifest save --------------- */

describe("the manifest refusal is about tenancy, not a broken action", () => {
  it("lets A's admin replace A's own working copy", async () => {
    const p = await plan("project.updateManifest", asAda(), {
      projectId: "prj-a",
      manifest: intruder,
    });
    expect(p.blocked).toBeUndefined();

    const r = await execute("project.updateManifest", asAda(), {
      projectId: "prj-a",
      manifest: intruder,
    });
    expect(r.ok).toBe(true);
    expect((r.data as { manifestHash: string }).manifestHash).toBe(manifestHash(intruder));
    expect(projectOf("prj-a").workingManifest.services.map((s) => s.name)).toEqual(["intruder"]);
  });

  /** The same payload, the same project id, from the admin who owns it: it
   *  lands. So every refusal above was the tenancy check and nothing else. */
  it("lets B's admin install that exact payload into prj-b", async () => {
    const p = await plan("project.updateManifest", asBo(), {
      projectId: "prj-b",
      manifest: intruder,
    });
    expect(p.blocked).toBeUndefined();

    const r = await execute("project.updateManifest", asBo(), {
      projectId: "prj-b",
      manifest: intruder,
    });
    expect(r.ok).toBe(true);
    expect(projectOf("prj-b").workingManifest.services.map((s) => s.name)).toEqual(["intruder"]);
  });
});

/* ---------------------------- ops.investigate ----------------------------- */

describe("ops.investigate refuses another workspace's environment", () => {
  it("plan is blocked and never names the environment", async () => {
    const p = await plan("ops.investigate", asAda(), {
      projectId: "prj-a",
      environmentId: "env-b",
    });
    expect(p.blocked).toBe(notFound.environment("env-b"));
    expect(p.details[0]).toBe(p.blocked);
    revealsNothing(p.blocked!);
    expect(JSON.stringify(p)).not.toContain(B_ENV_NAME);
    payloadRevealsNothing(p, "env-b");
  });

  it("execute refuses and never names the environment", async () => {
    const r = await execute("ops.investigate", asAda(), {
      projectId: "prj-a",
      environmentId: "env-b",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(notFound.environment("env-b"));
    revealsNothing(r.error!);
    expect(JSON.stringify(r)).not.toContain(B_ENV_NAME);
    payloadRevealsNothing(r, "env-b");
  });

  it("B's environment id reads exactly like an id that was never real", async () => {
    const foreignPlan = (
      await plan("ops.investigate", asAda(), { projectId: "prj-a", environmentId: "env-b" })
    ).blocked!;
    const fictionPlan = (
      await plan("ops.investigate", asAda(), { projectId: "prj-a", environmentId: "env-nope-000" })
    ).blocked!;
    expect(foreignPlan.replace("env-b", "REF")).toBe(fictionPlan.replace("env-nope-000", "REF"));

    const foreign = (
      await execute("ops.investigate", asAda(), { projectId: "prj-a", environmentId: "env-b" })
    ).error!;
    const fiction = (
      await execute("ops.investigate", asAda(), {
        projectId: "prj-a",
        environmentId: "env-nope-000",
      })
    ).error!;
    expect(foreign.replace("env-b", "REF")).toBe(fiction.replace("env-nope-000", "REF"));
  });

  it("refuses B's project id too, before any environment is considered", async () => {
    const p = await plan("ops.investigate", asAda(), { projectId: "prj-b" });
    expect(p.blocked).toBe(notFound.project("prj-b"));
    payloadRevealsNothing(p, "prj-b");

    const r = await execute("ops.investigate", asAda(), { projectId: "prj-b" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(notFound.project("prj-b"));
    payloadRevealsNothing(r, "prj-b");
  });

  it("refuses a forged ctx.projectId the same way", async () => {
    const p = await plan("ops.investigate", asAda({ projectId: "prj-b" }), {});
    expect(p.blocked).toBe(notFound.project("prj-b"));

    const r = await execute("ops.investigate", asAda({ projectId: "prj-b" }), {});
    expect(r.ok).toBe(false);
    expect(r.error).toBe(notFound.project("prj-b"));
    payloadRevealsNothing(r, "prj-b");
  });

  /** A forged ctx.environmentId is not a second way in: the report stays
   *  inside A's project and says nothing about B either way. */
  it("does not let a forged ctx.environmentId widen the report", async () => {
    const r = await execute("ops.investigate", asAda({ environmentId: "env-b" }), {
      projectId: "prj-a",
    });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("production");
    payloadRevealsNothing(r, "env-b");
  });
});

/* ------------------ positive controls for the name oracle ------------------ */

describe("the environment name really is on the disclosure path", () => {
  /**
   * If these two failed, the refusals above would prove nothing: they show the
   * plan summary and the report both print the environment's name for the
   * admin entitled to see it — which is exactly what a foreign id used to buy.
   */
  it("shows B's admin the name in the plan summary", async () => {
    const p = await plan("ops.investigate", asBo(), { projectId: "prj-b", environmentId: "env-b" });
    expect(p.blocked).toBeUndefined();
    expect(p.summary).toContain(B_ENV_NAME);
  });

  it("shows B's admin the name in the executed report", async () => {
    const r = await execute("ops.investigate", asBo(), {
      projectId: "prj-b",
      environmentId: "env-b",
    });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain(B_ENV_NAME);
  });

  it("still investigates A's own environment for A's admin", async () => {
    const p = await plan("ops.investigate", asAda(), {
      projectId: "prj-a",
      environmentId: "env-a",
    });
    expect(p.blocked).toBeUndefined();
    expect(p.summary).toContain("production");

    const r = await execute("ops.investigate", asAda(), {
      projectId: "prj-a",
      environmentId: "env-a",
    });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("production");
  });

  it("still investigates a whole project when no environment is named", async () => {
    const r = await execute("ops.investigate", asAda(), { projectId: "prj-a" });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("production");
  });
});
