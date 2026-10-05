/**
 * Bounded economic optimizer (PROD-COST-03): measured baseline, estimate
 * labelling, thresholds, hysteresis/cooldown, window bounds, transfer / latency /
 * residency constraints, field ownership, and submission through the real
 * capability broker (proposal only, never execution).
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPTIMIZER_POLICY,
  OptimizerInputError,
  loadDefaultCatalog,
  optimizeEconomics,
  refuseUnknownFieldOwnership,
  staticFieldOwnership,
  submitOptimizationProposals,
  type FieldOwnershipCheck,
  type MeasuredUsage,
  type OptimizationHistoryEntry,
  type OptimizerInput,
  type PlacementConstraints,
} from "@/lib/placement";
import { makeHarness, user } from "../capabilities/support";
import { STACK_EDGES, node, stackNodes } from "./fixtures";

const catalog = loadDefaultCatalog();
const NOW = "2026-10-05T00:00:00.000Z";
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString();

const MEASURED: MeasuredUsage = { usage: { egressGb: 200, requestsMillions: 20, storageGb: 10, dbStorageGb: 20 }, windowDays: 30, observedAt: NOW, source: "usage_meter" };
const CONSTRAINTS: PlacementConstraints = { userRegions: ["us-east"], latencyTargetMs: 400 };
const OWNED = staticFieldOwnership([
  { address: "service/web", field: "spec.size" },
  { address: "service/web", field: "spec.replicas" },
]);
const LOOSE = { minMonthlySavingsUsd: 0.01, minSavingsPct: 0.0001 };

function base(over: Partial<OptimizerInput> = {}): OptimizerInput {
  return {
    graph: { nodes: stackNodes("aws", "us-east-1", { web: { size: "standard", replicas: 3 } }), edges: STACK_EDGES },
    catalog,
    constraints: CONSTRAINTS,
    measured: MEASURED,
    utilization: { "service/web": { cpuP95: 0.2, memoryP95: 0.2, sampleDays: 14 } },
    ownership: OWNED,
    policy: LOOSE,
    now: NOW,
    ...over,
  };
}

const codes = (r: Awaited<ReturnType<typeof optimizeEconomics>>) => r.skipped.map((s) => s.code);

describe("measured baseline and estimate labelling", () => {
  it("refuses to propose without measured usage", async () => {
    const r = await optimizeEconomics(base({ measured: undefined }));
    expect(r.proposals).toEqual([]);
    expect(codes(r)).toEqual(["no_measured_baseline"]);
  });

  it("labels every saving an estimate and carries the baseline, catalog version and exclusions", async () => {
    const r = await optimizeEconomics(base());
    expect(r.proposals.length).toBeGreaterThan(0);
    for (const p of r.proposals) {
      expect(p.savings.label).toBe("estimate");
      expect(p.savings.monthlyUsd).toBeGreaterThan(0);
      expect(p.savings.catalogVersion).toBe(catalog.version);
      expect(p.savings.baselineMonthlyUsd).toBe(r.baselineMonthlyUsd);
      expect(p.savings.afterMonthlyUsd).toBeLessThan(p.savings.baselineMonthlyUsd);
      expect(p.savings.excluded.length).toBeGreaterThan(0);
      expect(p.baseline).toMatchObject({ source: "usage_meter", windowDays: 30 });
      expect(p.evidence.ownership.every((o) => o.owner === "zenith")).toBe(true);
    }
  });

  it("is deterministic", async () => {
    expect(await optimizeEconomics(base())).toEqual(await optimizeEconomics(base()));
  });

  it("refuses every proposal when the model baseline does not reconcile with the billed figure", async () => {
    const r = await optimizeEconomics(base({ measured: { ...MEASURED, billedMonthlyUsd: 1 } }));
    expect(r.proposals).toEqual([]);
    expect(codes(r)).toEqual(["baseline_unreconciled"]);
  });

  it("accepts a baseline that reconciles with the billed figure", async () => {
    const first = await optimizeEconomics(base());
    const r = await optimizeEconomics(base({ measured: { ...MEASURED, billedMonthlyUsd: first.baselineMonthlyUsd! * 1.05 } }));
    expect(r.proposals.length).toBeGreaterThan(0);
    expect(r.proposals[0]!.baseline.modelVsBilledPct).toBeDefined();
  });
});

describe("field ownership", () => {
  it("defaults to refusing changes when ownership is unknown", async () => {
    const r = await optimizeEconomics(base({ ownership: undefined }));
    expect(r.proposals).toEqual([]);
    expect(codes(r)).toContain("ownership_refused");
    expect(refuseUnknownFieldOwnership.check({ address: "a", field: "b" })).toMatchObject({ owner: "unknown" });
  });

  it("refuses externally owned fields and does not downscale what it does not own", async () => {
    const external = staticFieldOwnership([{ address: "service/web", field: "spec.replicas" }], [{ address: "service/web", field: "spec.size" }]);
    const r = await optimizeEconomics(base({ ownership: external }));
    expect(r.proposals.every((p) => p.changes.every((c) => c.field === "spec.replicas"))).toBe(true);
    expect(r.skipped.find((s) => s.code === "ownership_refused")?.message).toMatch(/externally owned/);
  });

  it("accepts an async registry implementation", async () => {
    const asyncCheck: FieldOwnershipCheck = { check: async (ref) => (ref.address === "service/web" ? { owner: "zenith" } : { owner: "unknown" }) };
    expect((await optimizeEconomics(base({ ownership: asyncCheck }))).proposals.length).toBeGreaterThan(0);
  });

  it("never changes referenced or external resources", async () => {
    const nodes = stackNodes("aws", "us-east-1", { web: { size: "standard", replicas: 3 } }).map((n) => (n.address === "service/web" ? { ...n, ownership: "referenced" as const } : n));
    const r = await optimizeEconomics(base({ graph: { nodes, edges: STACK_EDGES } }));
    expect(r.proposals.find((p) => p.addresses.includes("service/web"))).toBeUndefined();
    expect(codes(r)).toContain("not_managed");
  });
});

describe("thresholds, hysteresis and cooldown", () => {
  it("skips a saving below the minimum", async () => {
    const r = await optimizeEconomics(base({ policy: { minMonthlySavingsUsd: 1_000_000 } }));
    expect(r.proposals).toEqual([]);
    expect(codes(r)).toContain("below_threshold");
  });

  it("requires utilization measurements and enough sample days", async () => {
    expect(codes(await optimizeEconomics(base({ utilization: {} })))).toContain("no_utilization");
    const few = await optimizeEconomics(base({ utilization: { "service/web": { cpuP95: 0.2, memoryP95: 0.2, sampleDays: 2 } } }));
    expect(few.proposals).toEqual([]);
    expect(codes(few)).toContain("insufficient_samples");
  });

  it("keeps a downscale clear of the upscale trigger", async () => {
    // 50% cpu on standard would project to 100% on small, far above the 60% ceiling.
    const r = await optimizeEconomics(base({ utilization: { "service/web": { cpuP95: 0.5, memoryP95: 0.2, sampleDays: 14 } } }));
    expect(r.proposals.find((p) => p.kind === "rightsize_size")).toBeUndefined();
    expect(codes(r)).toContain("hysteresis_ceiling");
  });

  it("rejects a policy with no hysteresis band", async () => {
    await expect(optimizeEconomics(base({ policy: { downscaleCeiling: 0.8, upscaleTrigger: 0.8 } }))).rejects.toBeInstanceOf(OptimizerInputError);
    expect(DEFAULT_OPTIMIZER_POLICY.downscaleCeiling).toBeLessThan(DEFAULT_OPTIMIZER_POLICY.upscaleTrigger);
  });

  it("holds the replica floor for a single-failure tolerance", async () => {
    const nodes = stackNodes("aws", "us-east-1", { web: { size: "standard", replicas: 2 } });
    const r = await optimizeEconomics(base({ graph: { nodes, edges: STACK_EDGES }, constraints: { ...CONSTRAINTS, tolerateSingleFailure: true } }));
    expect(r.proposals.find((p) => p.kind === "rightsize_replicas")).toBeUndefined();
    expect(r.skipped.find((s) => s.code === "floor_reached" && s.kind === "rightsize_replicas")).toBeDefined();
  });

  it("applies a cooldown after a recorded change", async () => {
    const history: OptimizationHistoryEntry[] = [{ address: "service/web", field: "spec.size", kind: "rightsize_size", from: "performance", to: "standard", at: ago(2), status: "applied" }];
    const r = await optimizeEconomics(base({ history }));
    expect(r.proposals).toEqual([]);
    expect(codes(r)).toContain("cooldown");
    const later = await optimizeEconomics(base({ history: [{ ...history[0]!, at: ago(8) }] }));
    expect(later.proposals.length).toBeGreaterThan(0);
  });

  it("refuses to undo a recent change even after the cooldown", async () => {
    // size was raised small -> standard 10 days ago; going back to small is a reversal inside the 30-day lockout.
    const history: OptimizationHistoryEntry[] = [{ address: "service/web", field: "spec.size", kind: "rightsize_size", from: "small", to: "standard", at: ago(10), status: "applied" }];
    const r = await optimizeEconomics(base({ history }));
    expect(r.proposals.find((p) => p.kind === "rightsize_size")).toBeUndefined();
    expect(codes(r)).toContain("reversal_lockout");
  });

  it("does not flap: after a downscale is applied, the same measurements cannot trigger another change", async () => {
    const first = await optimizeEconomics(base({ policy: { ...LOOSE, maxChangesPerWindow: 10 } }));
    const size = first.proposals.find((p) => p.kind === "rightsize_size")!;
    expect(size.changes[0]).toMatchObject({ from: "standard", to: "small" });
    // After the change the same load shows twice the utilization (half the capacity): within the band, no further downscale, never an upscale.
    const nodes = stackNodes("aws", "us-east-1", { web: { size: "small", replicas: 3 } });
    const history: OptimizationHistoryEntry[] = [{ address: "service/web", field: "spec.size", kind: "rightsize_size", from: "standard", to: "small", at: ago(8), status: "applied" }];
    const second = await optimizeEconomics(base({ graph: { nodes, edges: STACK_EDGES }, history, utilization: { "service/web": { cpuP95: 0.4, memoryP95: 0.4, sampleDays: 14 } } }));
    expect(second.proposals.find((p) => p.changes.some((c) => c.field === "spec.size"))).toBeUndefined();
    expect(second.proposals.every((p) => p.changes.every((c) => !(c.field === "spec.size" && c.to === "standard")))).toBe(true);
  });
});

describe("bounded change size per window", () => {
  const twoServices = (): Partial<OptimizerInput> => ({
    graph: { nodes: [...stackNodes("aws", "us-east-1", { web: { size: "standard", replicas: 3 } }), node("service/worker", "container_service", "aws", "us-east-1", { size: "standard", replicas: 3 })], edges: STACK_EDGES },
    utilization: {
      "service/web": { cpuP95: 0.2, memoryP95: 0.2, sampleDays: 14 },
      "service/worker": { cpuP95: 0.2, memoryP95: 0.2, sampleDays: 14 },
    },
    ownership: staticFieldOwnership(["service/web", "service/worker"].flatMap((address) => [{ address, field: "spec.size" }, { address, field: "spec.replicas" }])),
  });

  it("limits the number of changes per window, counting history", async () => {
    const free = await optimizeEconomics(base({ ...twoServices(), policy: { ...LOOSE, maxChangesPerWindow: 5 } }));
    expect(free.proposals.length).toBeGreaterThanOrEqual(2);
    // one proposal per resource per run: a size step and a replica step on the same service never both ship
    expect(new Set(free.proposals.flatMap((p) => p.addresses)).size).toBe(free.proposals.length);
    const capped = await optimizeEconomics(base({ ...twoServices(), policy: { ...LOOSE, maxChangesPerWindow: 1 } }));
    expect(capped.proposals).toHaveLength(1);
    expect(codes(capped)).toContain("window_change_limit");
    const used = await optimizeEconomics(
      base({
        ...twoServices(),
        policy: { ...LOOSE, maxChangesPerWindow: 1 },
        history: [{ address: "resource/db", field: "spec.size", kind: "rightsize_size", from: "standard", to: "small", at: ago(1), status: "proposed" }],
      }),
    );
    expect(used.proposals).toEqual([]);
  });

  it("limits the total cost shift per window", async () => {
    const r = await optimizeEconomics(base({ policy: { ...LOOSE, maxChangesPerWindow: 10, maxWindowShiftPct: 0.0001 } }));
    expect(r.proposals).toEqual([]);
    expect(codes(r)).toContain("window_shift_limit");
  });

  it("takes one step at a time", async () => {
    const r = await optimizeEconomics(base({ policy: { ...LOOSE, maxChangesPerWindow: 10 } }));
    for (const p of r.proposals.filter((x) => x.kind !== "relocate_site")) {
      const c = p.changes[0]!;
      if (c.field === "spec.replicas") expect(Number(c.from) - Number(c.to)).toBe(1);
    }
  });
});

describe("transfer, latency and residency", () => {
  const EU_ONLY: PlacementConstraints = { userRegions: ["europe"], residency: ["eu"], latencyTargetMs: 400 };
  const ownAll = (addrs: string[]): FieldOwnershipCheck => ({ check: (r) => (addrs.includes(r.address) ? { owner: "zenith" } : { owner: "unknown" }) });
  const siteAddrs = stackNodes("aws", "eu-west-1").map((n) => n.address);

  it("never proposes a destination outside the residency constraint", async () => {
    const r = await optimizeEconomics(
      base({ graph: { nodes: stackNodes("aws", "eu-west-1"), edges: STACK_EDGES }, constraints: EU_ONLY, ownership: ownAll(siteAddrs), utilization: {}, policy: { ...LOOSE, maxChangesPerWindow: 10 } }),
    );
    for (const p of r.proposals.filter((x) => x.kind === "relocate_site")) {
      expect(p.evidence.residency?.destination).toMatch(/\((IE|BE|NL)\)/);
    }
    expect(r.skipped.some((s) => s.code === "residency")).toBe(true);
  });

  it("includes transfer cost, latency evidence and a payback for any relocation", async () => {
    const r = await optimizeEconomics(
      base({ graph: { nodes: stackNodes("aws", "us-east-1"), edges: STACK_EDGES }, constraints: { userRegions: ["us-east", "europe"], latencyTargetMs: 500 }, ownership: ownAll(siteAddrs), utilization: {}, policy: { ...LOOSE, maxChangesPerWindow: 10, maxPaybackMonths: 1000, maxLatencyRegressionMs: 1000 } }),
    );
    for (const p of r.proposals.filter((x) => x.kind === "relocate_site")) {
      expect(p.evidence.latency?.afterP95Ms).toBeLessThanOrEqual(500);
      expect(typeof p.savings.transferDeltaUsd).toBe("number");
      expect(p.savings.oneTimeCostUsd).toBeGreaterThanOrEqual(0);
      expect(p.changes.map((c) => c.address).sort()).toEqual(siteAddrs.slice().sort());
    }
  });

  it("refuses a relocation when latency cannot be verified or the target is missed", async () => {
    const noUsers = await optimizeEconomics(base({ graph: { nodes: stackNodes("aws", "us-east-1"), edges: STACK_EDGES }, constraints: { userRegions: [] }, ownership: ownAll(siteAddrs), utilization: {} }));
    expect(noUsers.proposals.filter((p) => p.kind === "relocate_site")).toEqual([]);
    expect(codes(noUsers)).toContain("latency_unverifiable");
    const tight = await optimizeEconomics(base({ graph: { nodes: stackNodes("aws", "us-east-1"), edges: STACK_EDGES }, constraints: { userRegions: ["us-east"], latencyTargetMs: 1 }, ownership: ownAll(siteAddrs), utilization: {} }));
    expect(tight.proposals.filter((p) => p.kind === "relocate_site")).toEqual([]);
  });

  it("does not move a site when ownership of region is unknown", async () => {
    const r = await optimizeEconomics(base({ graph: { nodes: stackNodes("aws", "us-east-1"), edges: STACK_EDGES }, ownership: undefined, utilization: {} }));
    expect(r.proposals).toEqual([]);
  });
});

describe("submission through the capability broker", () => {
  it("proposes service.scale and leaves the operation unexecuted", async () => {
    const h = await makeHarness({ kind: "memory" });
    const run = await optimizeEconomics(base({ policy: { ...LOOSE, maxChangesPerWindow: 5 } }));
    const rightsize = run.proposals.filter((p) => p.kind !== "relocate_site");
    expect(rightsize.length).toBeGreaterThan(0);
    const out = await submitOptimizationProposals(rightsize, {
      broker: h.broker,
      principal: user("bob"),
      scope: { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envAProd },
      serviceIdFor: (a) => (a === "service/web" ? h.ids.resAWebProd : undefined),
      now: NOW,
    });
    expect(out.refused).toEqual([]);
    expect(out.submitted).toHaveLength(rightsize.length);
    for (const s of out.submitted) {
      expect(s.capability).toBe("service.scale");
      expect(["awaiting_approval", "approved", "denied"]).toContain(s.operationStatus);
      expect(s.history.length).toBeGreaterThan(0);
    }
    // Replaying the same proposals creates no new operation and no new history.
    const again = await submitOptimizationProposals(rightsize, {
      broker: h.broker,
      principal: user("bob"),
      scope: { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envAProd },
      serviceIdFor: (a) => (a === "service/web" ? h.ids.resAWebProd : undefined),
      now: NOW,
    });
    expect(again.submitted.map((s) => s.operationId)).toEqual(out.submitted.map((s) => s.operationId));
    expect(again.submitted.every((s) => s.replayed && s.history.length === 0)).toBe(true);
  });
});

describe("only what an existing typed operation can carry", () => {
  it("routableOnly skips database sizing and relocation with an explicit reason", async () => {
    const r = await optimizeEconomics(
      base({
        routableOnly: true,
        utilization: { "service/web": { cpuP95: 0.2, memoryP95: 0.2, sampleDays: 14 }, "resource/db": { cpuP95: 0.1, memoryP95: 0.1, sampleDays: 14 } },
        ownership: staticFieldOwnership([{ address: "service/web", field: "spec.size" }, { address: "resource/db", field: "spec.size" }]),
      }),
    );
    expect(r.proposals.every((p) => p.addresses.every((a) => a === "service/web"))).toBe(true);
    expect(r.skipped.filter((s) => s.code === "unsupported_path").length).toBeGreaterThanOrEqual(2);
  });

  it("submission refuses a relocation instead of sending an input nothing consumes", async () => {
    const h = await makeHarness({ kind: "memory" });
    const out = await submitOptimizationProposals(
      [{ id: "opt_x", kind: "relocate_site", title: "Move aws/us-east-1 to aws/eu-west-1", changes: [{ address: "service/web", field: "region", from: "us-east-1", to: "eu-west-1" }], addresses: ["service/web"], baseline: { monthlyUsd: 1, source: "s", windowDays: 1, observedAt: NOW }, savings: { label: "estimate", monthlyUsd: 5, pct: 0.5, baselineMonthlyUsd: 10, afterMonthlyUsd: 5, catalogVersion: "v", priceConfidence: "verified", transferDeltaUsd: 0, oneTimeCostUsd: 0, basis: "", excluded: [] }, evidence: { ownership: [] }, risks: [] }],
      { broker: h.broker, principal: user("bob"), scope: { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envAProd }, serviceIdFor: () => "svc-web", now: NOW },
    );
    expect(out.submitted).toEqual([]);
    expect(out.refused[0]!.reason).toMatch(/no existing typed operation/);
  });
});
