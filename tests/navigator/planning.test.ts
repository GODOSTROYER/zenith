/**
 * What the Navigator promises before anything runs.
 *
 * Three of these are honesty rules rather than features: observe must not
 * plan, a node name is not a place to guess, and a connective inside a name is
 * not a clause boundary. The fourth is the role the run panel reads to disable
 * Run before the server refuses it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  emptyManifest,
  type Environment,
  type Manifest,
  type Project,
} from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-nav-plan-", { fast: true });
const { runAction } = await import("@/lib/actions/core");
const { registerAllActions } = await import("@/lib/actions/defs");
const { db, resetDb, save } = await import("@/lib/db/store");
const { createRun } = await import("@/lib/navigator/run");
const { fragments, parseGoal } = await import("@/lib/navigator/planner");
const { BLOCKED, CLARIFY, INVESTIGATE } = await import("@/lib/navigator/shared");

registerAllActions();

/* ------------------------------ pure planner ------------------------------ */

const manifest = (...names: string[]): Manifest => ({
  ...emptyManifest(),
  services: names.map((name, i) => ({
    id: `svc-${i}`,
    name,
    kind: "web" as const,
    source: { type: "image" as const, image: "ghcr.io/demo/web:1" },
    size: "small" as const,
    replicas: 1,
    port: 3000,
    env: [],
    ownership: "managed" as const,
  })),
});

const project = (...names: string[]): Project => ({
  id: "proj-1",
  workspaceId: "ws-1",
  name: "Atlas",
  slug: "atlas",
  workingManifest: manifest(...names),
  createdAt: new Date().toISOString(),
  origin: { type: "blank" },
});

const envs: Environment[] = [
  {
    id: "env-staging",
    projectId: "proj-1",
    name: "staging",
    class: "staging",
    connectionId: "conn-1",
    region: "local",
    policies: { approvalRequired: false, allowStatefulDeletion: false },
    baseDomain: "staging.atlas.zenith.app",
    createdAt: new Date().toISOString(),
  },
];

describe("a connective inside a node name is not a clause boundary", () => {
  it("keeps 'search-and-index' whole", () => {
    expect(fragments("restart search-and-index")).toEqual(["restart search-and-index"]);
    const steps = parseGoal("restart search-and-index", project("search-and-index"), envs);
    expect(steps.map((s) => s.actionId)).toEqual(["ops.restartService"]);
    expect(steps[0].input).toMatchObject({ serviceId: "search-and-index" });
  });

  it("still splits the connectives people actually type", () => {
    expect(fragments("add a worker and a queue, then deploy to staging")).toEqual([
      "add a worker",
      "a queue",
      "deploy to staging",
    ]);
    // a clause left holding the connective drops it rather than failing to parse
    expect(fragments("add a worker, and a queue")).toEqual(["add a worker", "a queue"]);
  });
});

describe("a fuzzy node match is confirmed, not assumed", () => {
  it("asks which node was meant instead of acting on the near one", () => {
    const steps = parseGoal("restart api", project("api-gateway", "web"), envs);
    expect(steps.map((s) => s.actionId)).toEqual([CLARIFY]);
    expect(steps[0].rationale).toMatch(/api-gateway/);
    // and it is not executable, so nothing can run against the guess
    expect(steps[0].needsApproval).toBe(false);
  });

  it("still accepts a match that differs only in case, spaces or dashes", () => {
    expect(parseGoal("restart API-Gateway", project("api-gateway"), envs)[0].input).toMatchObject({
      serviceId: "api-gateway",
    });
    expect(parseGoal("restart api gateway", project("api-gateway"), envs)[0].input).toMatchObject({
      serviceId: "api-gateway",
    });
  });

  it("accounts for both ends of a connect it could not resolve, each on its own terms", () => {
    // "apo" resembles nothing here; "cach" is inside "cache" — one step each,
    // blocked for the unknown one and a question for the guess.
    const steps = parseGoal("connect apo to cach", project("api", "cache"), envs);
    expect(steps.map((s) => s.actionId)).toEqual([BLOCKED, CLARIFY]);
    expect(steps[1].rationale).toMatch(/cache/);
  });
});

describe("steps carry the role the executor will demand", () => {
  it("copies requiredRole from the registry so the UI can disable Run first", () => {
    const steps = parseGoal("deploy to staging", project("web"), envs);
    expect(steps.map((s) => s.requiredRole)).toEqual(["viewer", "editor"]);
  });

  it("gives the read-only investigate step the viewer role", () => {
    const steps = parseGoal("investigate the failed deployment", project("web"), envs);
    expect(steps[0].actionId).toBe(INVESTIGATE);
    expect(steps[0].requiredRole).toBe("viewer");
  });
});

/* ------------------------------ the store path ----------------------------- */

const WS = "ws-plan";
let projectId = "";

describe("observe never plans", () => {
  beforeEach(async () => {
    resetDb({
      workspaces: [{ id: WS, name: "Nav", slug: "nav", createdAt: new Date().toISOString() }],
      settings: { autonomy: "plan" },
    });
    const created = await runAction(
      "project.applyBlueprint",
      { workspaceId: WS, actor: { type: "user", id: "local", name: "Local" } },
      { blueprint: "internal-tool", name: "Atlas" },
      { mode: "execute" }
    );
    projectId = (created.result!.data as { projectId: string }).projectId;
  });

  it("refuses to plan at observe, names the fix, and persists nothing", async () => {
    db().settings.autonomy = "observe";
    save();
    await expect(createRun(projectId, "add a redis cache")).rejects.toThrow(/never plans/);
    await createRun(projectId, "add a redis cache").catch((e: Error) => {
      expect(e.message).toMatch(/Raise the dial to plan/);
    });
    expect(db().navigatorRuns).toHaveLength(0);
  });

  it("plans at the next notch up, which is what that notch promises", async () => {
    const { run } = await createRun(projectId, "add a redis cache");
    expect(run.steps.map((s) => s.actionId)).toEqual(["system.addResource"]);
    expect(db().navigatorRuns).toHaveLength(1);
  });
});

/* ------------------------------- investigate ------------------------------- */

describe("investigate is a registered read-only action", () => {
  it("is in the catalog as viewer / mutates:false, not a branch in the executor", () => {
    const action = registerAllActions().get(INVESTIGATE);
    expect(action).toBeDefined();
    expect(action!.requiredRole).toBe("viewer");
    expect(action!.mutates).toBe(false);
    expect(action!.risk).toBe("low");
  });

  it("labels the health it reports as simulated", async () => {
    resetDb({
      workspaces: [{ id: WS, name: "Nav", slug: "nav", createdAt: new Date().toISOString() }],
      settings: { autonomy: "approve" },
    });
    const created = await runAction(
      "project.applyBlueprint",
      { workspaceId: WS, actor: { type: "user", id: "local", name: "Local" } },
      { blueprint: "internal-tool", name: "Atlas" },
      { mode: "execute" }
    );
    const pid = (created.result!.data as { projectId: string }).projectId;

    // A failed deployment on an environment that is still serving an earlier
    // revision — the sentence that used to state simulated health as fact.
    const env = db().environments.find((e) => e.projectId === pid)!;
    env.deployedRevisionId = "rev-x";
    db().deployments.push({
      id: "dep-1",
      projectId: pid,
      environmentId: env.id,
      revisionId: "rev-x",
      status: "failed",
      changeSummary: "add a cache",
      estCostDeltaUsd: 0,
      steps: [],
      outputs: [],
      createdAt: new Date().toISOString(),
      actor: { type: "user", id: "local", name: "Local" },
    });
    save();

    const { result } = await runAction(
      INVESTIGATE,
      { workspaceId: WS, projectId: pid, actor: { type: "user", id: "local", name: "Local" } },
      { environmentId: env.id },
      { mode: "execute" }
    );
    expect(result!.ok).toBe(true);
    expect(result!.summary).toMatch(/simulated health/);
    // and it read the failure it was pointed at
    expect(result!.summary).toMatch(/add a cache/);
  });
});
