/**
 * PROD-OBS-03 in the reconciliation controller: every repair proposal passes
 * the stability port first (confirmed incident, then reservation) and fails
 * closed; the real platform adapter runs on PGlite.
 */
import { describe, expect, it } from "vitest";
import { openPlatformDb } from "@/lib/controlplane/db";
import { createPlatformStability } from "@/lib/reconcile/platform/stability";
import { stabilityObservations } from "@/lib/reconcile/core";
import { reconcileEnvironment, type ReconcilePorts, type ReconcileStability, type StabilityFindingObservation } from "@/lib/reconcile";
import type { DriftReport } from "@/lib/resources";
import { ENV, graph, harness, type Harness } from "./_support";

interface Spy {
  stability: ReconcileStability;
  observed: StabilityFindingObservation[][];
  admitted: string[];
  attached: [string, string][];
  released: string[];
}

function spy(over: Partial<ReconcileStability> & { confirmed?: boolean; allow?: boolean } = {}): Spy {
  const s: Spy = { stability: undefined as never, observed: [], admitted: [], attached: [], released: [] };
  s.stability = {
    async observe(_env, items) {
      s.observed.push([...items]);
      return new Map(over.confirmed === false ? [] : items.filter((i) => i.observation === "bad").map((i) => [`${i.address}|${i.class}`, { incidentId: `inc-${i.address}` }]));
    },
    async admit(_env, input) {
      s.admitted.push(input.address);
      return over.allow === false ? { allowed: false, codes: ["cooldown_active"] } : { allowed: true, attemptId: `att-${s.admitted.length}`, codes: [] };
    },
    async attach(_env, attemptId, operationId) { s.attached.push([attemptId, operationId]); },
    async release(_env, attemptId) { s.released.push(attemptId); },
    ...(over.observe ? { observe: over.observe } : {}),
    ...(over.admit ? { admit: over.admit } : {}),
  };
  return s;
}

const run = (h: Harness, stability: ReconcileStability) => reconcileEnvironment({ environment: ENV, graph: graph(), ports: { ...h.ports, stability } as ReconcilePorts });
const decision = (r: Awaited<ReturnType<typeof run>>, address: string) => r.repairs.find((d) => d.address === address);

describe("repair proposals pass the stability port, fail closed", () => {
  it("an unconfirmed incident proposes nothing (hysteresis)", async () => {
    const h = harness();
    h.world.patch("log_group/web", { presence: "missing" });
    const s = spy({ confirmed: false });
    const r = await run(h, s.stability);
    expect(decision(r, "log_group/web")).toMatchObject({ status: "skipped", reason: "stability_unconfirmed" });
    expect(h.broker.proposals).toEqual([]);
    expect(s.admitted).toEqual([]);
  });
  it("a store failure while observing proposes nothing", async () => {
    const h = harness();
    h.world.patch("log_group/web", { presence: "missing" });
    const s = spy({ observe: async () => { throw new Error("db down"); } });
    const r = await run(h, s.stability);
    expect(decision(r, "log_group/web")).toMatchObject({ status: "skipped", reason: "stability_unavailable" });
    expect(h.broker.proposals).toEqual([]);
  });
  it("a refused reservation proposes nothing and says why", async () => {
    const h = harness();
    h.world.patch("log_group/web", { presence: "missing" });
    const s = spy({ allow: false });
    const r = await run(h, s.stability);
    expect(decision(r, "log_group/web")).toMatchObject({ status: "skipped", reason: "stability_blocked", error: "cooldown_active" });
    expect(h.broker.proposals).toEqual([]);
  });
  it("a reservation that throws proposes nothing", async () => {
    const h = harness();
    h.world.patch("log_group/web", { presence: "missing" });
    const s = spy({ admit: async () => { throw new Error("db down"); } });
    const r = await run(h, s.stability);
    expect(decision(r, "log_group/web")).toMatchObject({ status: "skipped", reason: "stability_unavailable" });
    expect(h.broker.proposals).toEqual([]);
  });
  it("an admitted proposal reaches the broker and the attempt is bound to its operation", async () => {
    const h = harness();
    h.world.patch("log_group/web", { presence: "missing" });
    const s = spy();
    const r = await run(h, s.stability);
    expect(decision(r, "log_group/web")).toMatchObject({ status: "proposed", outcome: "allow" });
    expect(h.broker.proposals).toHaveLength(1);
    expect(s.attached).toEqual([["att-1", "op-1"]]);
    expect(s.released).toEqual([]);
  });
  it("a broker failure releases the reservation", async () => {
    const h = harness();
    h.world.patch("log_group/web", { presence: "missing" });
    h.broker.script = "throw";
    const s = spy();
    const r = await run(h, s.stability);
    expect(decision(r, "log_group/web")).toMatchObject({ status: "failed", reason: "broker_error" });
    expect(s.released).toEqual(["att-1"]);
    expect(s.attached).toEqual([]);
  });
  it("reports drift as bad, readable clean nodes as good and unreadable ones as unknown", async () => {
    const h = harness();
    h.world.patch("log_group/web", { presence: "missing" });
    const s = spy();
    await run(h, s.stability);
    const items = s.observed[0];
    expect(items.find((i) => i.address === "log_group/web")).toMatchObject({ observation: "bad", class: "missing" });
    expect(items.filter((i) => i.observation === "good").length).toBeGreaterThan(0);
  });
  it("stabilityObservations never counts unknown/inaccessible findings as bad or an unread node as good", () => {
    const node = (address: string) => ({ node: { address } as never, observation: { presence: "unknown" } });
    const report = { findings: [{ address: "a", class: "inaccessible", severity: "low" }, { address: "b", class: "unknown", severity: "low" }] } as unknown as DriftReport;
    expect(stabilityObservations(report, [node("a"), node("b"), node("c")]).map((i) => i.observation)).toEqual(["unknown", "unknown", "unknown"]);
  });
});

describe("platform stability adapter on PGlite", () => {
  const scope = { workspaceId: "ws-adapter", projectId: "proj-1", environmentId: "env-adapter" } as never;
  const repair = (n: number) => ({ capability: "drift.repair" as const, scope: { workspaceId: "ws-adapter", environmentId: "env-adapter" }, input: {}, reason: "r", idempotencyKey: `k${n}` });

  it("confirms drift only after three consecutive bad passes, then admits once and holds the cooldown", async () => {
    const db = await openPlatformDb({ kind: "pglite" });
    try {
      const stability = createPlatformStability(db);
      const bad: StabilityFindingObservation[] = [{ address: "log_group/web", class: "missing", severity: "low", observation: "bad" }];
      const t = (m: number) => new Date(Date.UTC(2026, 9, 5, 12, m));
      expect((await stability.observe(scope, bad, t(0))).size).toBe(0);
      expect((await stability.observe(scope, bad, t(1))).size).toBe(0);
      const confirmed = await stability.observe(scope, bad, t(2));
      const ref = confirmed.get("log_group/web|missing");
      expect(ref?.incidentId).toBeDefined();
      const again = await stability.observe(scope, bad, t(3));
      expect(again.get("log_group/web|missing")?.incidentId).toBe(ref?.incidentId);

      const first = await stability.admit(scope, { incidentId: ref!.incidentId, request: repair(1), address: "log_group/web" }, t(4));
      expect(first.allowed).toBe(true);
      const second = await stability.admit(scope, { incidentId: ref!.incidentId, request: repair(2), address: "log_group/web" }, t(5));
      expect(second.allowed).toBe(false);
      expect(second.codes).toEqual(expect.arrayContaining(["cooldown_active"]));
      await stability.release(scope, first.attemptId!, t(6));
    } finally {
      await db.close();
    }
  }, 60_000);

  it("clears the signal after five clean passes so a recurrence is a new incident", async () => {
    const db = await openPlatformDb({ kind: "pglite" });
    try {
      const stability = createPlatformStability(db);
      const bad: StabilityFindingObservation[] = [{ address: "log_group/web", class: "missing", severity: "low", observation: "bad" }];
      const good: StabilityFindingObservation[] = [{ address: "log_group/web", observation: "good" }];
      const t = (m: number) => new Date(Date.UTC(2026, 9, 5, 12, m));
      for (let i = 0; i < 3; i++) await stability.observe(scope, bad, t(i));
      for (let i = 0; i < 5; i++) await stability.observe(scope, good, t(10 + i));
      const rows = await db.query<{ status: string }>("select status from platform.incidents where workspace_id = 'ws-adapter'");
      expect(rows.map((r) => r.status)).toEqual(["resolved"]);
    } finally {
      await db.close();
    }
  }, 60_000);
});
