import { describe, expect, it } from "vitest";
import { MemoryReconcileBackend, reconcilePass, type ReconcilePassOptions, type ReconcilePassPorts, type SchedulableEnvironment } from "@/lib/reconcile";
import { ENV, FakeBroker, HOUR, MIN, SESSION_CANARY, T0, World, Clock, tinyGraph } from "./_support";

interface Fleet {
  clock: Clock;
  backend: MemoryReconcileBackend;
  world: World;
  broker: FakeBroker;
  sessions: number;
  ports: ReconcilePassPorts;
  pass(opts?: ReconcilePassOptions): ReturnType<typeof reconcilePass>;
  /** advance the clock to the earliest nextRunAt of any environment */
  advanceToNextDue(): void;
}

function fleet(n: number, over: (i: number) => Partial<SchedulableEnvironment> = () => ({})): Fleet {
  const clock = new Clock(T0);
  const backend = new MemoryReconcileBackend({ now: clock.now });
  const world = new World();
  const broker = new FakeBroker(backend);
  const state = { sessions: 0 };
  for (let i = 0; i < n; i++) {
    const id = `env-${String(i).padStart(3, "0")}`;
    const g = tinyGraph(id, 2);
    backend.addEnvironment({ ...ENV, environmentId: id, ...over(i) }, g);
    world.allPresent(g, { size: "small" });
  }
  const ports = backend.passPorts({
    broker,
    driverFor: world.driverFor,
    withObserveSession: async (_r, fn) => {
      state.sessions++;
      return fn({ token: SESSION_CANARY });
    },
  });
  const f: Fleet = {
    clock,
    backend,
    world,
    broker,
    get sessions() {
      return state.sessions;
    },
    ports,
    pass: (opts = {}) => reconcilePass({ ports, ...opts }),
    advanceToNextDue: () => {
      const next = Math.min(...[...backend.schedules.values()].map((s) => Date.parse(s.nextRunAt)));
      clock.set(new Date(next).toISOString());
    },
  };
  return f;
}

const ids = (f: Fleet) => [...f.backend.environments.keys()];
const reported = (f: Fleet) => ids(f).filter((id) => f.backend.reportsOf(id).length > 0);

describe("reconcilePass: a bounded, budgeted pass", () => {
  it("claims at most maxEnvironments per pass, and the rest wait for the next one", async () => {
    const f = fleet(12);
    const a = await f.pass({ maxEnvironments: 5 });
    expect(a).toMatchObject({ claimed: 5, reconciled: 5, saturated: true, failed: 0, deferred: 0, timedOut: false });
    expect(reported(f)).toHaveLength(5);
    const b = await f.pass({ maxEnvironments: 5 });
    expect(b).toMatchObject({ claimed: 5, reconciled: 5 });
    const c = await f.pass({ maxEnvironments: 5 });
    expect(c).toMatchObject({ claimed: 2, reconciled: 2, saturated: false });
    expect(reported(f)).toHaveLength(12);
    // everything is now scheduled in the future: an immediate pass has nothing to do
    expect(await f.pass()).toMatchObject({ claimed: 0, reconciled: 0 });
    expect(f.backend.claims.size).toBe(0);
  });

  it("answers counts, not prose, even when there is nothing to do", async () => {
    const r = await fleet(0).pass();
    expect(r).toMatchObject({ claimed: 0, reconciled: 0, nothingToReconcile: 0, busy: 0, ineligible: 0, failed: 0, deferred: 0, nudged: 0, driftDetected: 0, driftCleared: 0, openFindings: 0, unreadNodes: 0, repairsProposed: 0, repairsStarted: 0, saturated: false, timedOut: false });
    expect(typeof r.ms).toBe("number");
  });

  it("a zero budget claims nothing at all", async () => {
    const f = fleet(3);
    expect(await f.pass({ budgetMs: 0 })).toMatchObject({ claimed: 0, reconciled: 0 });
    expect(f.backend.claims.size).toBe(0);
    expect(f.backend.schedules.size).toBe(0);
  });

  it("stops starting environments when the budget is spent, releases what it claimed but did not reach, and those stay due", async () => {
    const f = fleet(4);
    for (const w of f.world.cloud.keys()) f.world.patch(w, { delayMs: 120 });
    const r = await f.pass({ budgetMs: 150, minStartMs: 50, environmentConcurrency: 1, maxEnvironments: 4 });
    expect(r.claimed).toBe(4);
    expect(r.reconciled).toBeGreaterThanOrEqual(1);
    expect(r.deferred).toBeGreaterThanOrEqual(1);
    expect(r.reconciled + r.deferred).toBe(4);
    expect(r.timedOut).toBe(true);
    expect(f.backend.claims.size).toBe(0); // deferred claims were released, not left to expire
    const done = reported(f).length;
    expect(done).toBe(r.reconciled);
    // the deferred ones are due right away on the next pass
    const next = await f.pass({ maxEnvironments: 10 });
    expect(next.reconciled).toBe(4 - done);
  });

  it("an environment that has begun is allowed to finish after the budget gate closes", async () => {
    const f = fleet(1);
    for (const w of f.world.cloud.keys()) f.world.patch(w, { delayMs: 100 });
    const r = await f.pass({ budgetMs: 60, minStartMs: 10 });
    expect(r.reconciled).toBe(1); // started at t=0, well inside the gate; finished after it
    expect(r.unreadNodes).toBe(0); // and nothing was reported unknown just because the gate closed
  });

  it("two passes running at once never reconcile the same environment twice", async () => {
    const f = fleet(6);
    for (const w of f.world.cloud.keys()) f.world.patch(w, { delayMs: 30 });
    const [a, b] = await Promise.all([f.pass({ maxEnvironments: 6 }), f.pass({ maxEnvironments: 6 })]);
    expect(a.reconciled + b.reconciled).toBe(6);
    for (const id of ids(f)) expect(f.backend.reportsOf(id), id).toHaveLength(1);
  });

  it("is deterministic: the same fleet and the same passes produce identical schedules, reports and events", async () => {
    const run = async () => {
      const f = fleet(9);
      f.world.patch("log_group/extra-0", { presence: "missing" });
      await f.pass({ maxEnvironments: 4 });
      f.clock.advance(6 * MIN);
      await f.pass({ maxEnvironments: 4 });
      return JSON.stringify({ s: [...f.backend.schedules.entries()].sort(), e: f.backend.events, r: [...f.backend.reports.entries()].sort() });
    };
    expect(await run()).toBe(await run());
  });
});

describe("reconcilePass: scheduling across passes", () => {
  it("persists the next run (5 minutes plus the environment's own jitter) and climbs the ladder while stable", async () => {
    const f = fleet(1);
    const steps: number[] = [];
    for (let i = 0; i < 6; i++) {
      await f.pass();
      const s = f.backend.schedules.get("env-000");
      steps.push(s?.stepIndex ?? -1);
      f.advanceToNextDue();
    }
    expect(steps).toEqual([0, 1, 2, 3, 3, 3]);
    const s = f.backend.schedules.get("env-000");
    expect(s?.lastChangedAt).toBe(T0); // only the first run saw a change
    expect(s?.consecutiveFailures).toBe(0);
  });

  it("a change resets the ladder; clearing it climbs again", async () => {
    const f = fleet(1);
    for (let i = 0; i < 4; i++) {
      await f.pass();
      f.advanceToNextDue();
    }
    expect(f.backend.schedules.get("env-000")?.stepIndex).toBe(3);
    f.world.patch("log_group/extra-0", { presence: "missing" });
    const r = await f.pass();
    expect(r.driftDetected).toBe(1);
    expect(f.backend.schedules.get("env-000")?.stepIndex).toBe(0);
    f.advanceToNextDue();
    // still drifting and unchanged: climbs, but open drift caps at 60 minutes
    for (let i = 0; i < 5; i++) {
      await f.pass();
      f.advanceToNextDue();
    }
    expect(f.backend.schedules.get("env-000")?.stepIndex).toBe(2);
  });

  it("a deploy signal pulls a backed-off environment forward and resets its ladder", async () => {
    const f = fleet(1);
    for (let i = 0; i < 4; i++) {
      await f.pass();
      if (i < 3) f.advanceToNextDue();
    }
    const before = f.backend.schedules.get("env-000");
    expect(before?.stepIndex).toBe(3); // next run is three hours away
    const at = new Date(f.clock.now().getTime() + 10 * MIN).toISOString();
    f.backend.deploys.push({ workspaceId: "ws-1", environmentId: "env-000", at });
    f.clock.advance(11 * MIN);
    const r = await f.pass();
    expect(r).toMatchObject({ nudged: 1, claimed: 0 }); // pulled forward, but not yet due
    const after = f.backend.schedules.get("env-000");
    expect(after?.stepIndex).toBe(0);
    expect(Date.parse(after?.nextRunAt ?? "")).toBeGreaterThanOrEqual(Date.parse(at) + 5 * MIN);
    expect(Date.parse(after?.nextRunAt ?? "")).toBeLessThan(Date.parse(at) + 6 * MIN + 1);
    expect(Date.parse(after?.nextRunAt ?? "")).toBeLessThan(Date.parse(before?.nextRunAt ?? ""));
    // a nudge for the same deploy again changes nothing
    await f.pass();
    expect(f.backend.schedules.get("env-000")?.nextRunAt).toBe(after?.nextRunAt);
    // and once it is due, it is reconciled
    f.clock.set(after?.nextRunAt ?? "");
    expect(await f.pass()).toMatchObject({ claimed: 1, reconciled: 1 });
  });

  it("a signal source that fails never fails the pass", async () => {
    const f = fleet(2);
    const ports = { ...f.ports, signals: { deploysSince: async () => Promise.reject(new Error("db blip")) } };
    const r = await reconcilePass({ ports });
    expect(r).toMatchObject({ reconciled: 2, nudged: 0, failed: 0 });
  });

  it("serves environments with recent deploys and open incidents first when the pass cannot take everything", async () => {
    const f = fleet(8, (i) => ({
      ...(i === 6 ? { lastDeployAt: T0 } : {}),
      ...(i === 7 ? { openIncidents: 2 } : {}),
    }));
    const r = await f.pass({ maxEnvironments: 2 });
    expect(r.reconciled).toBe(2);
    expect(reported(f).sort()).toEqual(["env-006", "env-007"]);
  });
});

describe("reconcilePass: who is reconciled", () => {
  it("does not reconcile sandbox environments unless configured, or environments without a verified connection", async () => {
    const f = fleet(4, (i) => [{}, { class: "sandbox" as const, connection: undefined }, { connection: undefined }, { connection: { id: "c", status: "revoked" as const } }][i]);
    const r = await f.pass();
    expect(r).toMatchObject({ claimed: 4, reconciled: 1, ineligible: 3 });
    expect(reported(f)).toEqual(["env-000"]);
    expect(f.sessions).toBe(1); // nothing else ever asked for credentials
    for (const id of ["env-001", "env-002", "env-003"]) expect(f.backend.schedules.get(id)).toMatchObject({ stepIndex: 3, lastOutcome: "ineligible" });

    const g = fleet(2, (i) => (i === 1 ? { class: "sandbox" as const, connection: undefined } : {}));
    expect(await g.pass({ includeSandbox: true })).toMatchObject({ reconciled: 2, ineligible: 0 });
  });

  it("skips an environment while a mutation holds it, looks again soon, and reports nothing for it", async () => {
    const f = fleet(2);
    f.backend.mutating.add("env-000");
    const r = await f.pass();
    expect(r).toMatchObject({ reconciled: 1, busy: 1 });
    expect(f.backend.reportsOf("env-000")).toEqual([]);
    const s = f.backend.schedules.get("env-000");
    expect(s).toMatchObject({ stepIndex: 0, lastOutcome: "busy" });
    expect(Date.parse(s?.nextRunAt ?? "") - f.clock.now().getTime()).toBeLessThan(6 * MIN);
    // and the moment the deploy is done it is reconciled
    f.backend.mutating.delete("env-000");
    f.clock.advance(6 * MIN);
    expect((await f.pass()).reconciled).toBeGreaterThanOrEqual(1);
    expect(f.backend.reportsOf("env-000")).toHaveLength(1);
  });

  it("an environment another pass is already working on is released untouched", async () => {
    const f = fleet(1);
    f.backend.holdLease("env-000");
    const r = await f.pass();
    expect(r).toMatchObject({ claimed: 1, busy: 1, reconciled: 0 });
    expect(f.backend.claims.size).toBe(0);
    expect(f.backend.schedules.has("env-000")).toBe(false); // schedule untouched: still never scheduled, so due
    f.backend.holdLease("env-000", false);
    expect(await f.pass()).toMatchObject({ reconciled: 1 });
  });

  it("nothing deployed yet is not an error and is not drift, and it backs off", async () => {
    const f = fleet(1);
    f.backend.graphs.clear();
    const r = await f.pass();
    expect(r).toMatchObject({ claimed: 1, nothingToReconcile: 1, reconciled: 0, failed: 0 });
    expect(f.backend.reportsOf("env-000")).toEqual([]);
    expect(f.backend.schedules.get("env-000")).toMatchObject({ lastOutcome: "nothing_to_reconcile", stepIndex: 1 });
  });
});

describe("reconcilePass: failures are isolated", () => {
  it("one environment that throws does not stop the others, and it retries on its own short ladder", async () => {
    const f = fleet(3);
    const ports = { ...f.ports, loadGraph: async (e: { environmentId: string }) => (e.environmentId === "env-001" ? Promise.reject(new Error("store unavailable")) : f.backend.graphs.get(e.environmentId) ?? null) };
    const r = await reconcilePass({ ports });
    expect(r).toMatchObject({ claimed: 3, reconciled: 2, failed: 1 });
    expect(f.backend.schedules.get("env-001")).toMatchObject({ lastOutcome: "failed", consecutiveFailures: 1 });
    expect(f.backend.claims.size).toBe(0);
  });

  it("if persisting the schedule fails, the claim is left to expire and the environment is retried after that", async () => {
    const f = fleet(1);
    const failing = { ...f.ports, state: { ...f.ports.state, complete: async () => Promise.reject(new Error("write failed")) } };
    const r = await reconcilePass({ ports: failing });
    expect(r).toMatchObject({ claimed: 1, failed: 1 });
    expect(f.backend.claims.size).toBe(1);
    expect(await f.pass()).toMatchObject({ claimed: 0 }); // still claimed
    f.clock.advance(2 * HOUR); // claim expired
    expect(await f.pass()).toMatchObject({ claimed: 1, reconciled: 1 });
  });

  it("tallies what the controller did: drift, unread nodes and repair proposals", async () => {
    const f = fleet(2);
    f.world.patch("log_group/extra-0", { presence: "missing" });
    f.world.patch("log_group/web", { throws: new Error("socket hang up") });
    f.broker.script = "require_approval";
    const r = await f.pass();
    // per environment: one missing node (proposal needs approval) and one unreadable node
    expect(r).toMatchObject({ reconciled: 2, driftDetected: 4, openFindings: 4, unreadNodes: 2, repairsProposed: 2, repairsAwaitingApproval: 2, repairsStarted: 0 });
    f.broker.script = "allow";
  });
});

describe("reconcilePass: tenancy", () => {
  it("environments of different workspaces reconcile side by side, each into its own records", async () => {
    const f = fleet(2, (i) => ({ workspaceId: i === 0 ? "ws-1" : "ws-2" }));
    await f.pass();
    expect(f.backend.eventsOf("env-000").every((e) => e.workspaceId === "ws-1")).toBe(true);
    expect(f.backend.reportsOf("env-001")).toHaveLength(1);
    expect(() => f.backend.addEnvironment({ ...ENV, workspaceId: "ws-1", environmentId: "env-001" })).toThrowError(/not found in this workspace/);
  });
});
