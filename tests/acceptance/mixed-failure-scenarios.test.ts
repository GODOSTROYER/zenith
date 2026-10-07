/**
 * PROD-MIX-07: failure-injection scenarios for mixed runs, SIMULATION level. They drive the real orchestration reducer (and, for the
 * revoked-connection scenario, the real authority re-verification) through an outage, a revoked partition connection, a blackholed
 * endpoint and an expired approval. This proves the platform's own recovery contract (partial apply is reported, dependents are
 * blocked, an indeterminate child is reconciled before it is retried, nothing is compensated or destroyed automatically). It does NOT
 * prove a provider outage or a live recovery: that is scripts/acceptance/mixed/live-recovery.ts, gated and deferred.
 */
import { describe, expect, it } from "vitest";
import { reverifyAuthority } from "@/lib/execution/mixed/verify";
import { SCENARIO_IDS, blackholeTimeout, expiryWithPartialApply, outageMidChain, revokedPartitionConnection, runAllScenarios, simulationWorldOf, type SimulationWorld } from "../../scripts/acceptance/mixed/failure-scenarios";
import { NOW, PARENT, world } from "../execution/fakes/mixed-fixture";
import { PARENT_ENV, WS, connection, plan } from "../execution/mixed/_fixtures";

/** The gcp child's real authority record and the real re-verification against a connection in the given state. */
function authority(): NonNullable<SimulationWorld["authority"]> {
  const parent = plan();
  const gcp = parent.children.find((c) => c.authority.provider === "gcp")!;
  return (_childId, mode) => reverifyAuthority({ workspaceId: WS, parentEnvironmentId: PARENT_ENV, child: gcp, connection: connection("gcp", { status: mode === "revoked" ? "revoked" : "verified" }) });
}

const sim = (over: Partial<Parameters<typeof simulationWorldOf>[1]> = {}): SimulationWorld => simulationWorldOf(world().view, { parentOperationId: PARENT, now: NOW, authority: authority(), ...over });

describe("failure scenarios over the real state machine", () => {
  it("runs every scenario, and every assertion each one states holds", () => {
    const reports = runAllScenarios(sim());
    expect(reports.map((r) => r.id)).toEqual([...SCENARIO_IDS]);
    for (const report of reports) {
      expect(report.level, report.id).toBe("simulation");
      expect(report.assertions.length, report.id).toBeGreaterThanOrEqual(4);
      expect(report.assertions.filter((a) => !a.pass).map((a) => a.name), report.id).toEqual([]);
      expect(report.ok, report.id).toBe(true);
      expect(report.runbook.length, report.id).toBeGreaterThan(0);
    }
  });

  it("an outage mid-chain blocks the dependent, keeps the finished producer, needs reconciliation and completes after a reconciled retry", () => {
    const report = outageMidChain(sim());
    const names = report.assertions.map((a) => a.name);
    expect(names).toContain("a retry before reconciliation is refused");
    expect(names).toContain("the run completes with every child applied once");
    expect(report.ok).toBe(true);
    expect(report.runbook).toEqual(["confirm-blast-radius", "reconcile-indeterminate-child", "retry-after-reconcile"]);
  });

  it("a blackholed child times out, and a late receipt is evidence rather than a reason to rerun", () => {
    const report = blackholeTimeout(sim());
    expect(report.ok).toBe(true);
    expect(report.assertions.map((a) => a.name)).toContain("a late receipt is accepted as evidence and unblocks the run");
  });

  it("an expired approval stops new starts without withdrawing what is applied, and never proposes anything automatically", () => {
    const report = expiryWithPartialApply(sim());
    expect(report.ok).toBe(true);
    expect(report.assertions.map((a) => a.name)).toContain("the next step is a human-approved teardown proposal or a fresh plan, never an automatic one");
  });

  it("a revoked connection is refused by the real re-verification before anything starts, and a verified one passes", () => {
    const report = revokedPartitionConnection(sim());
    expect(report.ok).toBe(true);
    const world2 = sim();
    expect(() => world2.authority!("any", "revoked")).toThrow();
    expect(() => world2.authority!("any", "healthy")).not.toThrow();
  });

  it("holds for a different child timeout and approval window", () => {
    for (const over of [{ childTimeoutMs: 60_000 }, { childTimeoutMs: 3_600_000, expiresInMinutes: 600 }, { expiresInMinutes: 30 }]) {
      for (const report of runAllScenarios(sim(over))) expect(report.assertions.filter((a) => !a.pass).map((a) => a.name), `${report.id} ${JSON.stringify(over)}`).toEqual([]);
    }
  });
});

describe("the scenarios are not vacuous", () => {
  it("the revoked scenario fails when no real authority check is wired", () => {
    const report = revokedPartitionConnection(sim({ authority: undefined }));
    expect(report.ok).toBe(false);
    expect(report.assertions.some((a) => !a.pass && a.name.includes("authority re-verification"))).toBe(true);
  });

  it("the revoked scenario fails when the 'revoked' connection is not actually refused", () => {
    const report = revokedPartitionConnection(sim({ authority: () => undefined }));
    expect(report.ok).toBe(false);
    expect(report.assertions.some((a) => !a.pass && a.name.includes("revoked connection makes authority re-verification refuse"))).toBe(true);
  });

  it("reports are plain data and say they are simulations", () => {
    const text = JSON.stringify(runAllScenarios(sim()));
    expect(text).toContain("simulation");
    expect(text).not.toMatch(/live_sandbox|passed_live/);
  });
});
