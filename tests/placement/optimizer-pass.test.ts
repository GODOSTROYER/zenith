/**
 * Scheduled optimizer pass (PROD-COST-03): per-environment opt-in, durable
 * history across "restarts" (a fresh pass over the same store), proposal-only
 * submission through the real broker, and the opt-in settings repository.
 */
import { describe, expect, it } from "vitest";
import { loadDefaultCatalog, staticFieldOwnership, historyFromOperations, loadScaleOperations } from "@/lib/placement";
import { runOptimizerPass, type OptimizerPassPorts } from "@/lib/platform/optimizer-pass";
import { repos } from "@/lib/controlplane/db";
import type { ResourceGraph } from "@/lib/resources/types";
import type { ReconcileEnvironment } from "@/lib/reconcile/types";
import { closeSharedPgliteAfterAll, makeHarness, sharedDatabase, user, type Harness } from "../capabilities/support";
import { STACK_EDGES, node, stackNodes } from "./fixtures";
import { transferRequest } from "@/lib/ownership/registry";

closeSharedPgliteAfterAll();
const DAY = 86_400_000;

function setup(h: Harness, over: { services?: string[]; policy?: OptimizerPassPorts["policy"]; optedIn?: boolean; measured?: boolean } = {}): { ports: () => OptimizerPassPorts; env: ReconcileEnvironment } {
  const services = over.services ?? ["web"];
  const nodes = [
    ...stackNodes("aws", "us-east-1").filter((n) => n.address !== "service/web"),
    ...services.map((s) => node(`service/${s}`, "container_service", "aws", "us-east-1", { size: "standard", replicas: 3 })),
  ];
  const graph = { nodes, edges: STACK_EDGES } as unknown as ResourceGraph;
  const env: ReconcileEnvironment = { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envAProd, class: "production", provider: "aws", region: "us-east-1" };
  const owned = staticFieldOwnership(services.flatMap((s) => [{ address: `service/${s}`, field: "spec.size" }, { address: `service/${s}`, field: "spec.replicas" }]));
  // This memory-store fixture already declares both fields optimizer-owned.
  // Model that same authority at the real broker's guard, with exact approved
  // native-op transfers. Native receipt custody/races have their separate SQL lane.
  h.store.fieldOwnership = async scope => {
    if (scope.workspaceId !== env.workspaceId || scope.environmentId !== env.environmentId || scope.resourceId !== h.ids.resAWebProd) return undefined;
    const address = "service/web", nativeType = "aws:ecs_service";
    return { node: { address, nativeType, spec: { size: "standard", replicas: 3 } }, transfers: ["size", "replicas"].map(path => ({
      ...transferRequest({ address, resourceType: nativeType, path, from: "iac", to: "native-op" }),
      approvalId: `fixture-${path}-approval`, approvedAt: h.clock.now().toISOString(),
    })) };
  };
  return {
    env,
    ports: () => ({
      listOptedIn: async () => (over.optedIn === false ? [] : [{ workspaceId: env.workspaceId, environmentId: env.environmentId }]),
      loadEnvironment: async () => env,
      loadGraph: async () => graph,
      guard: { run: async (_e, fn) => ({ ran: true as const, value: await fn({}) }) },
      measurements:
        over.measured === false
          ? { load: async () => undefined }
          : {
              load: async () => ({
                measured: { usage: { egressGb: 200, requestsMillions: 20 }, windowDays: 30, observedAt: h.clock.now().toISOString(), source: "usage_meter" },
                utilization: Object.fromEntries(services.map((s) => [`service/${s}`, { cpuP95: 0.2, memoryP95: 0.2, sampleDays: 14 }])),
                constraints: { userRegions: ["us-east"] },
              }),
            },
      resources: async () => new Map(services.map((s, i) => [`service/${s}`, { resourceId: i === 0 ? h.ids.resAWebProd : `${h.ids.resAWebProd}_${s}`, serviceId: `svc-${s}` }])),
      ownership: owned,
      store: h.store,
      broker: h.broker,
      principal: user("bob"),
      catalog: loadDefaultCatalog(),
      now: () => h.clock.now(),
      policy: { minMonthlySavingsUsd: 0.01, minSavingsPct: 0.0001, ...over.policy },
    }),
  };
}

describe("scheduled optimizer pass", () => {
  it("does nothing for a tenant that has not opted in", async () => {
    const h = await makeHarness({ kind: "memory" });
    const r = await runOptimizerPass(setup(h, { optedIn: false }).ports());
    expect(r).toMatchObject({ environments: 0, proposed: 0 });
    expect((await h.store.listOperations(h.ids.wsA, { capability: "service.scale" })).items).toHaveLength(0);
  });

  it("skips and counts an environment with no measurements instead of using defaults", async () => {
    const h = await makeHarness({ kind: "memory" });
    const r = await runOptimizerPass(setup(h, { measured: false }).ports());
    expect(r).toMatchObject({ environments: 1, noMeasurements: 1, proposed: 0 });
  });

  it("proposes through the broker without executing, and a restart does not re-propose (history is durable)", async () => {
    const h = await makeHarness({ kind: "memory" });
    // Let the higher-saving size step fit; the default spending cap otherwise selects replicas.
    const policy = { maxWindowShiftPct: 1 };
    const first = await runOptimizerPass(setup(h, { policy }).ports());
    expect(first.proposed).toBe(1);
    const ops = (await h.store.listOperations(h.ids.wsA, { capability: "service.scale" })).items;
    expect(ops).toHaveLength(1);
    expect(["awaiting_approval", "approved", "denied"]).toContain(ops[0]!.status);
    expect((ops[0]!.proposal.input as { optimizer?: { field: string } }).optimizer?.field).toBe("spec.size");
    // a brand new ports object over the same store: nothing is carried in memory
    h.clock.advance(1 * DAY);
    const second = await runOptimizerPass(setup(h, { policy }).ports());
    expect(second.proposed).toBe(0);
    expect((await h.store.listOperations(h.ids.wsA, { capability: "service.scale" })).items).toHaveLength(1);
  });

  it("holds the per-window change bound across restarts (cooldown disabled to isolate it)", async () => {
    const h = await makeHarness({ kind: "memory" });
    const policy = { maxChangesPerWindow: 1, cooldownMs: 0 };
    expect((await runOptimizerPass(setup(h, { policy }).ports())).proposed).toBe(1);
    expect((await runOptimizerPass(setup(h, { policy }).ports())).proposed).toBe(0);
    expect((await h.store.listOperations(h.ids.wsA, { capability: "service.scale" })).items).toHaveLength(1);
  });

  it("counts a failing environment and keeps going", async () => {
    const h = await makeHarness({ kind: "memory" });
    const p = setup(h).ports();
    const r = await runOptimizerPass({
      ...p,
      loadGraph: async () => {
        throw new Error("store down");
      },
    });
    expect(r.failed).toBe(1);
  });

  it("reports busy when the environment guard does not run", async () => {
    const h = await makeHarness({ kind: "memory" });
    const p = setup(h).ports();
    const r = await runOptimizerPass({ ...p, guard: { run: async () => ({ ran: false as const, reason: "mutation_in_flight" as const }) } });
    expect(r.busy).toBe(1);
  });
});

describe("durable history from operation records", () => {
  const scope = (h: Harness) => ({ workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envAProd, resourceId: h.ids.resAWebProd });

  it("includes a manual scale as cooldown evidence with an unknown from", async () => {
    const h = await makeHarness({ kind: "memory" });
    await h.broker.propose({ capability: "service.scale", scope: scope(h), input: { operation: "scale", serviceId: "svc-web", replicas: 2 }, idempotencyKey: "manual-scale-0001" }, user("bob"));
    const ops = await loadScaleOperations(h.store, h.ids.wsA, h.ids.envAProd, new Date(Date.now() - DAY).toISOString());
    const hist = historyFromOperations(ops, (id) => (id === h.ids.resAWebProd ? "service/web" : undefined));
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ address: "service/web", field: "spec.replicas", from: "unknown", to: 2 });
  });

  it("refuses an incomplete bounded read", async () => {
    const h = await makeHarness({ kind: "memory" });
    for (let i = 0; i < 3; i++) {
      await h.broker.propose({ capability: "service.scale", scope: scope(h), input: { operation: "scale", serviceId: "svc-web", replicas: i + 1 }, idempotencyKey: `bulk-scale-000${i}` }, user("bob"));
    }
    await expect(loadScaleOperations(h.store, h.ids.wsA, h.ids.envAProd, new Date(Date.now() - DAY).toISOString(), { pageSize: 1, maxPages: 2 })).rejects.toThrow(/bounded read/);
  });
});

describe("optimizer opt-in settings (real PGlite platform store)", () => {
  it("defaults to disabled, is tenant scoped, versioned and listable", async () => {
    const db = await sharedDatabase("pglite");
    const ws = `ws_${Math.random().toString(36).slice(2, 8)}`;
    const other = `${ws}_x`;
    const env = `env_${ws}`;
    expect(await repos.optimizerSettings.getOptimizerSettings(db, ws, env)).toMatchObject({ enabled: false, version: 0, isDefault: true });
    const on = await repos.optimizerSettings.putOptimizerSettings(db, { workspaceId: ws, environmentId: env, enabled: true, updatedBy: "admin", expectedVersion: 0 });
    expect(on).toMatchObject({ enabled: true, version: 1 });
    await expect(repos.optimizerSettings.putOptimizerSettings(db, { workspaceId: ws, environmentId: env, enabled: false, updatedBy: "admin", expectedVersion: 0 })).rejects.toMatchObject({ code: "conflict" });
    await expect(repos.optimizerSettings.putOptimizerSettings(db, { workspaceId: other, environmentId: env, enabled: true, updatedBy: "evil" })).rejects.toMatchObject({ code: "tenant_mismatch" });
    expect(await repos.optimizerSettings.getOptimizerSettings(db, other, env)).toMatchObject({ enabled: false, isDefault: true });
    expect((await repos.optimizerSettings.listOptedInEnvironments(db, 100)).some((e) => e.environmentId === env && e.workspaceId === ws)).toBe(true);
    await repos.optimizerSettings.putOptimizerSettings(db, { workspaceId: ws, environmentId: env, enabled: false, updatedBy: "admin" });
    expect((await repos.optimizerSettings.listOptedInEnvironments(db, 100)).some((e) => e.environmentId === env)).toBe(false);
  });
});
