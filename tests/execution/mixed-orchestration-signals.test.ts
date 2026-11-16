/**
 * Drift and migration signals in the mixed run's ordering rules (PROD-MIX-04 follow-up), at contract level.
 *
 * What runs: the pure mapping from a stored drift report to signal classes, the ordering rules that act on those signals
 * (a producer's teardown while a consumer has drift; a contract migration ordered after its dependents), and the run
 * service refusing a child start because of them. The platform reads that produce the signals (drift reports, release-run
 * migration classes) are exercised against the real SQL store in tests/controlplane/mixed-follow-up.test.ts. No cloud API is called.
 */
import { describe, expect, it } from "vitest";
import type { ChildDriftReport } from "@/lib/controlplane/db/repos/mixed-signals";
import { driftClassesOf, asOrderingSignals } from "@/lib/execution/mixed/signals";
import { MixedOrchestrationError, openMixedRun, readMixedRun, recordChildEvent, refusingParentReviewPort, type MixedRunDeps } from "@/lib/execution/mixed-orchestration";
import { evaluateOrdering, type OrderingSignals } from "@/lib/execution/mixed-orchestration/ordering-rules";
import { MemoryPreauthorizationStore } from "@/lib/execution/mixed-orchestration/preauthorization";
import { MemoryMixedRunStore } from "@/lib/execution/mixed-orchestration/run-store";
import { NOW, PARENT, WS, at, complete, finish, start, succeed, world } from "./fakes/mixed-fixture";

const NONE: OrderingSignals = { drift: [], migrationChildIds: [] };
const finding = (over: Record<string, unknown> = {}) => ({ address: "service/web", class: "changed", severity: "medium", repairable: true, autoRepairEligible: false, explanation: "x", ...over });
const report = (over: Partial<ChildDriftReport> = {}): ChildDriftReport => ({ computedAt: NOW.toISOString(), findings: [], unobserved: [], simulated: false, ...over }) as ChildDriftReport;

describe("drift classes of a stored report", () => {
  it("reads no drift from no report, a clean report or a simulated one", () => {
    expect(driftClassesOf(null)).toEqual([]);
    expect(driftClassesOf(report())).toEqual([]);
    expect(driftClassesOf(report({ simulated: true, findings: [finding()] as never }))).toEqual([]);
  });

  it("a repairable change, a missing resource or an unknown one is an unauthorized change", () => {
    expect(driftClassesOf(report({ findings: [finding()] as never }))).toEqual(["unauthorized_change"]);
    expect(driftClassesOf(report({ findings: [finding({ class: "missing" }), finding({ class: "unknown" }), finding({ class: "extra" })] as never }))).toEqual(["unauthorized_change"]);
  });

  it("a change the report marks not repairable is a native divergence, and both can be present", () => {
    expect(driftClassesOf(report({ findings: [finding({ repairable: false })] as never }))).toEqual(["native_divergence"]);
    expect(driftClassesOf(report({ findings: [finding({ repairable: false }), finding({ class: "missing" })] as never }))).toEqual(["native_divergence", "unauthorized_change"]);
  });

  it("an address the pass could not read at all is not clearance", () => {
    expect(driftClassesOf(report({ unobserved: ["resource/db"] }))).toEqual(["unobserved"]);
  });

  it("converts observed signals into the ordering signal shape", () => {
    expect(asOrderingSignals({ drift: [{ childId: "a", klass: "unobserved" }], migrationChildIds: ["a"], contractMigrationChildIds: ["a"] }))
      .toEqual({ drift: [{ childId: "a", klass: "unobserved" }], migrationChildIds: ["a"], contractMigrationChildIds: ["a"] });
  });
});

describe("teardown of a producer while a consumer has drift", () => {
  const w = world();
  const producerOnly = finish(w.state, w.view, w.ids.db, 1);

  it("is allowed with no signals and blocked while a consumer that still stands has unresolved drift", () => {
    expect(evaluateOrdering(producerOnly, { kind: "teardown", childId: w.ids.db }, NONE).allowed).toBe(true);
    for (const klass of ["unauthorized_change", "native_divergence", "unobserved"] as const) {
      const verdict = evaluateOrdering(producerOnly, { kind: "teardown", childId: w.ids.db }, { drift: [{ childId: w.ids.web, klass }], migrationChildIds: [] });
      expect(verdict.allowed).toBe(false);
      expect(verdict.blocks).toContainEqual({ rule: "consumer_drift_unresolved", childId: w.ids.db, blockedBy: w.ids.web });
    }
  });

  it("expected variance on a consumer does not block, and drift on the producer itself does not block its own teardown", () => {
    expect(evaluateOrdering(producerOnly, { kind: "teardown", childId: w.ids.db }, { drift: [{ childId: w.ids.web, klass: "expected_variance" }], migrationChildIds: [] }).allowed).toBe(true);
    expect(evaluateOrdering(producerOnly, { kind: "teardown", childId: w.ids.db }, { drift: [{ childId: w.ids.db, klass: "unauthorized_change" }], migrationChildIds: [] }).allowed).toBe(true);
  });

  it("an applied consumer is still named by the consumers-first rule, not hidden by the drift rule", () => {
    const all = complete(w).state;
    const verdict = evaluateOrdering(all, { kind: "teardown", childId: w.ids.web }, { drift: [{ childId: w.ids.fn, klass: "unauthorized_change" }], migrationChildIds: [] });
    expect(verdict.blocks).toContainEqual({ rule: "teardown_consumers_first", childId: w.ids.web, blockedBy: w.ids.fn });
  });
});

describe("contract migrations are ordered after their dependents", () => {
  const w = world();
  const dbDone = finish(w.state, w.view, w.ids.db, 1);
  const contract: OrderingSignals = { drift: [], migrationChildIds: [w.ids.web], contractMigrationChildIds: [w.ids.web] };

  it("holds a contract migration child until every dependent succeeded", () => {
    const verdict = evaluateOrdering(dbDone, { kind: "start_child", childId: w.ids.web }, contract);
    expect(verdict.allowed).toBe(false);
    expect(verdict.blocks).toContainEqual({ rule: "contract_migration_after_dependents", childId: w.ids.web, blockedBy: w.ids.fn });
    const migration = evaluateOrdering(dbDone, { kind: "migration", childId: w.ids.web }, contract);
    expect(migration.blocks).toContainEqual({ rule: "contract_migration_after_dependents", childId: w.ids.web, blockedBy: w.ids.fn });
  });

  it("lets it start once the dependents have updated", () => {
    const done = complete(w).state;
    expect(evaluateOrdering(done, { kind: "start_child", childId: w.ids.web }, contract).blocks.map((block) => block.rule)).not.toContain("contract_migration_after_dependents");
  });

  it("does not apply to an expand or data migration, or to a contract migration with no dependents", () => {
    expect(evaluateOrdering(dbDone, { kind: "start_child", childId: w.ids.web }, { drift: [], migrationChildIds: [w.ids.web] }).blocks.map((block) => block.rule)).not.toContain("contract_migration_after_dependents");
    expect(evaluateOrdering(complete(w).state, { kind: "start_child", childId: w.ids.fn }, { drift: [], migrationChildIds: [w.ids.fn], contractMigrationChildIds: [w.ids.fn] }).allowed).toBe(true);
  });

  it("an unclassified migration is handled like a contract migration (the signal reader reports both)", () => {
    expect(evaluateOrdering(dbDone, { kind: "start_child", childId: w.ids.web }, { drift: [], migrationChildIds: [w.ids.web], contractMigrationChildIds: [w.ids.web] }).allowed).toBe(false);
  });
});

describe("the run service acts on the signals before a child is claimed", () => {
  function deps(): MixedRunDeps {
    return { runs: new MemoryMixedRunStore(), preauthorizations: new MemoryPreauthorizationStore(), roles: {} as MixedRunDeps["roles"], teardownApprovals: { lookup: async () => null }, parentReview: refusingParentReviewPort, now: () => NOW };
  }

  async function opened() {
    const w = world();
    const run = deps();
    await openMixedRun(run, { workspaceId: WS, parentOperationId: PARENT, view: w.view, expiresAt: at(120), childTimeoutMs: 600_000 });
    let state = (await readMixedRun(run, WS, PARENT))!.state;
    await recordChildEvent(run, { workspaceId: WS, parentOperationId: PARENT, view: w.view, event: start(w.ids.db, state, 1), signals: NONE });
    await recordChildEvent(run, { workspaceId: WS, parentOperationId: PARENT, view: w.view, event: succeed(w.ids.db, 2), signals: NONE });
    state = (await readMixedRun(run, WS, PARENT))!.state;
    return { w, run, state };
  }
  const refusal = async (promise: Promise<unknown>): Promise<MixedOrchestrationError> => {
    let failure: unknown;
    try { await promise; } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(MixedOrchestrationError);
    return failure as MixedOrchestrationError;
  };

  it("names unresolved producer drift as the reason a start is refused, and leaves the child unclaimed", async () => {
    const { w, run, state } = await opened();
    const drifted: OrderingSignals = { drift: [{ childId: w.ids.db, klass: "unauthorized_change" }], migrationChildIds: [] };
    const error = await refusal(recordChildEvent(run, { workspaceId: WS, parentOperationId: PARENT, view: w.view, event: start(w.ids.web, state, 3), signals: drifted }));
    expect(error.code).toBe("ordering_blocked");
    expect(error.detail).toContain(`producer_drift_unresolved:${w.ids.db}`);
    expect((await readMixedRun(run, WS, PARENT))!.state.children[w.ids.web].status).toBe("pending");
  });

  it("names a contract migration that would run before its dependents, and records nothing", async () => {
    const { w, run, state } = await opened();
    const signals: OrderingSignals = { drift: [], migrationChildIds: [w.ids.web], contractMigrationChildIds: [w.ids.web] };
    const error = await refusal(recordChildEvent(run, { workspaceId: WS, parentOperationId: PARENT, view: w.view, event: start(w.ids.web, state, 3), signals }));
    expect(error.detail).toContain(`contract_migration_after_dependents:${w.ids.fn}`);
    expect((await readMixedRun(run, WS, PARENT))!.state.children[w.ids.web].status).toBe("pending");
  });

  it("a healthy chain with no signals is never blocked by the new rules", () => {
    const w = world();
    expect(evaluateOrdering(finish(w.state, w.view, w.ids.db, 1), { kind: "start_child", childId: w.ids.web }, NONE).blocks.map((block) => block.rule)).toEqual([]);
  });
});
