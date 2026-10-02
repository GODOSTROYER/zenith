import { describe, expect, it } from "vitest";
import { createReconcileObserveActivity, reconcileObserveOnce } from "@/lib/reconcile";
import { ENV, harness, type Harness } from "./_support";

const deps = (h: Harness, extra: { autoRepair?: boolean } = {}) => ({
  ports: h.ports,
  loadEnvironment: async (workspaceId: string, environmentId: string) => {
    const env = h.backend.environments.get(environmentId);
    return env && env.workspaceId === workspaceId ? env : null;
  },
  loadGraph: h.backend.loadGraph,
  ...extra,
});

const lease = (environmentId = ENV.environmentId, scope = `reconcile:${environmentId}`) => ({ scope, holder: `reconcile-${environmentId}`, fenceToken: 7 });

describe("the Temporal reconcileObserve activity body", () => {
  it("returns counts only: drift means 'differs', unknown means 'could not tell'", async () => {
    const h = harness();
    h.world.patch("log_group/web", { presence: "missing" });
    h.world.patch("container_service/web", { attrs: { replicas: 3 }, expected: { replicas: 2 } });
    h.world.patch("network/main", { throws: new Error("socket hang up") });
    h.world.patch("subnet/private-a", { throws: Object.assign(new Error("denied"), { name: "AccessDenied" }) });
    const activity = createReconcileObserveActivity(deps(h));
    const out = await activity({ passId: "reconcile-env-prod", workspaceId: "ws-1", environmentId: "env-prod", lease: lease() });
    expect(out).toEqual({ drift: 2, unknown: 2 });
    expect(Object.keys(out).sort()).toEqual(["drift", "unknown"]); // nothing else crosses the workflow boundary
    // and the report really was persisted
    expect(h.backend.reportsOf("env-prod")).toHaveLength(1);
  });

  it("observes and reports only unless auto repair is explicitly enabled, and then only PROPOSES", async () => {
    const h = harness();
    h.world.patch("log_group/web", { presence: "missing" });
    await createReconcileObserveActivity(deps(h))({ passId: "reconcile-env-prod", workspaceId: "ws-1", environmentId: "env-prod", lease: lease() });
    expect(h.broker.proposals).toEqual([]);

    const g = harness();
    g.world.patch("log_group/web", { presence: "missing" });
    const result = await createReconcileObserveActivity(deps(g))({ passId: "reconcile-env-prod", workspaceId: "ws-1", environmentId: "env-prod", lease: lease(), allowAutoRepair: true });
    expect(g.broker.proposals).toHaveLength(1);
    expect(result.repairs).toMatchObject({ proposed: 1, started: 1, awaitingApproval: 0, denied: 0 });
    expect(result.repairs?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(g.world.operationCalls).toEqual([]); // proposed through the broker, never executed here
  });

  it.each(["require_approval", "deny", "throw"] as const)("proposal permission preserves the broker's %s authority", async (outcome) => {
    const h = harness();
    h.broker.script = outcome;
    h.world.patch("log_group/web", { presence: "missing" });
    const out = await createReconcileObserveActivity(deps(h))({ passId: "reconcile-env-prod", workspaceId: "ws-1", environmentId: "env-prod", lease: lease(), allowAutoRepair: true });
    expect(h.started).toEqual([]);
    expect(out.repairs).toMatchObject({ started: 0, awaitingApproval: outcome === "require_approval" ? 1 : 0, denied: outcome === "deny" ? 1 : 0, failed: outcome === "throw" ? 1 : 0 });
    expect(JSON.stringify(out)).not.toContain("log_group/web");
    expect(JSON.stringify(out)).not.toContain("broker unavailable");
  });

  it("configuration cannot enable proposals when the workflow did not request them", async () => {
    const h = harness();
    h.world.patch("log_group/web", { presence: "missing" });
    await createReconcileObserveActivity({ ...deps(h), options: { autoRepair: true } })({ passId: "reconcile-env-prod", workspaceId: "ws-1", environmentId: "env-prod", lease: lease(), allowAutoRepair: false });
    expect(h.broker.proposals).toEqual([]);
  });

  it("refuses a lease that is not this environment's reconcile lease, before reading anything", async () => {
    const h = harness();
    const activity = createReconcileObserveActivity(deps(h));
    for (const bad of [lease("env-prod", "env:env-prod"), lease("env-prod", "reconcile:env-other")])
      await expect(activity({ passId: "p", workspaceId: "ws-1", environmentId: "env-prod", lease: bad })).rejects.toMatchObject({ code: "invalid_input" });
    expect(h.world.observed).toEqual([]);
    expect(h.sessions).toEqual([]);
  });

  it("refuses an environment the controller does not know in this workspace", async () => {
    const h = harness();
    await expect(reconcileObserveOnce({ workspaceId: "ws-other", environmentId: "env-prod" }, deps(h))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(reconcileObserveOnce({ workspaceId: "ws-1", environmentId: "env-ghost" }, deps(h))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(reconcileObserveOnce({ workspaceId: "ws-1", environmentId: "env-ghost" }, { ...deps(h), loadEnvironment: async () => ENV })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("nothing deployed yet is zero drift, honestly labelled, and reads nothing", async () => {
    const h = harness();
    h.backend.graphs.clear();
    expect(await reconcileObserveOnce({ workspaceId: "ws-1", environmentId: "env-prod" }, deps(h))).toEqual({ drift: 0, unknown: 0, status: "nothing_to_reconcile", repairsProposed: 0 });
    expect(h.sessions).toEqual([]);
  });
});
