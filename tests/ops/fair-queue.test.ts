/**
 * PROD-OPS-02: weighted-fair dequeue across tenants, and the bounded fair semaphore the worker uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FairSemaphore, WeightedFairQueue } from "@/lib/ops/fair-queue";
import { BackpressureError } from "@/lib/ops/errors";
import { HEAVY_ACTIVITIES, WorkerFairGate, activityScope } from "@/lib/ops/worker-gate";

function drain<T>(q: WeightedFairQueue<T>, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const next = q.shift();
    if (!next) break;
    out.push(next.tenant);
  }
  return out;
}

describe("WeightedFairQueue", () => {
  it("alternates equally weighted backlogged tenants instead of serving the deepest queue first", () => {
    const q = new WeightedFairQueue<number>({ maxPerTenant: 100, maxTotal: 200 });
    for (let i = 0; i < 50; i++) q.push("flood", i);
    for (let i = 0; i < 5; i++) q.push("small", i);
    const first10 = drain(q, 10);
    // The small tenant is fully served within the first 10 dequeues; FIFO would have starved it behind 50.
    expect(first10.filter((t) => t === "small")).toHaveLength(5);
    expect(first10.filter((t) => t === "flood")).toHaveLength(5);
  });

  it("serves contested capacity in proportion to weight", () => {
    const q = new WeightedFairQueue<number>({ maxPerTenant: 1000, maxTotal: 2000 });
    for (let i = 0; i < 400; i++) { q.push("gold", i, 3); q.push("basic", i, 1); }
    const served = drain(q, 400);
    const gold = served.filter((t) => t === "gold").length;
    const basic = served.filter((t) => t === "basic").length;
    expect(gold + basic).toBe(400);
    expect(gold / basic).toBeGreaterThan(2.7);
    expect(gold / basic).toBeLessThan(3.3);
  });

  it("gives an idle tenant no banked credit: a returning tenant does not jump the whole backlog", () => {
    const q = new WeightedFairQueue<number>({ maxPerTenant: 1000, maxTotal: 2000 });
    for (let i = 0; i < 100; i++) q.push("busy", i);
    drain(q, 50);
    for (let i = 0; i < 100; i++) q.push("returning", i);
    const next20 = drain(q, 20);
    const returning = next20.filter((t) => t === "returning").length;
    expect(returning).toBeGreaterThanOrEqual(9);
    expect(returning).toBeLessThanOrEqual(11); // fair share, not all 20
  });

  it("is hard-bounded per tenant and in total; a refused push buffers nothing", () => {
    const q = new WeightedFairQueue<number>({ maxPerTenant: 3, maxTotal: 5 });
    expect([1, 2, 3, 4].map((n) => q.push("a", n))).toEqual([true, true, true, false]);
    expect(q.push("b", 1)).toBe(true);
    expect(q.push("b", 2)).toBe(true);
    expect(q.push("c", 1)).toBe(false); // total of 5 reached
    expect(q.size).toBe(5);
    expect(q.depthOf("a")).toBe(3);
    expect(q.depthOf("c")).toBe(0);
    expect(q.tenantCount).toBe(2);
  });

  it("removes a cancelled item and forgets an emptied tenant", () => {
    const q = new WeightedFairQueue<{ id: number }>({ maxPerTenant: 5, maxTotal: 10 });
    const item = { id: 1 };
    q.push("a", item);
    expect(q.remove("a", item)).toBe(true);
    expect(q.remove("a", item)).toBe(false);
    expect(q.tenantCount).toBe(0);
    expect(q.shift()).toBeUndefined();
  });
});

describe("FairSemaphore", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("grants permits immediately while capacity lasts, then in weighted-fair order as permits free up", async () => {
    const sem = new FairSemaphore(1, { maxPerTenant: 50, maxTotal: 100 });
    const first = await sem.acquire("flood");
    const order: string[] = [];
    const waiters: Promise<void>[] = [];
    // The flooding tenant queues 4 first, then a second tenant queues 2 behind them.
    for (let i = 0; i < 4; i++) waiters.push(sem.acquire("flood", { maxWaitMs: 60_000 }).then((p) => { order.push("flood"); p.release(); }));
    for (let i = 0; i < 2; i++) waiters.push(sem.acquire("small", { maxWaitMs: 60_000 }).then((p) => { order.push("small"); p.release(); }));
    expect(sem.waitingCount).toBe(6);
    first.release();
    await Promise.all(waiters);
    // Under FIFO the small tenant would be last; here it is served alternately and finishes within the first 4.
    expect(order.slice(0, 4).filter((t) => t === "small")).toHaveLength(2);
    expect(sem.inFlight).toBe(0);
    expect(sem.waitingCount).toBe(0);
  });

  it("never fails a waiter that runs out of patience: it proceeds as bypassed", async () => {
    const sem = new FairSemaphore(1, { maxPerTenant: 5, maxTotal: 5 });
    const held = await sem.acquire("a");
    const waiting = sem.acquire("b", { maxWaitMs: 15_000 });
    await vi.advanceTimersByTimeAsync(15_000);
    const permit = await waiting;
    expect(permit.bypassed).toBe(true);
    expect(permit.waitedMs).toBeGreaterThanOrEqual(15_000);
    expect(sem.waitingCount).toBe(0);
    expect(sem.bypassed).toBe(1);
    permit.release();
    expect(sem.bypassed).toBe(0);
    held.release();
  });

  it("rejects with a 429-class BackpressureError only when its own bounded queue is full", async () => {
    const sem = new FairSemaphore(1, { maxPerTenant: 1, maxTotal: 2 });
    await sem.acquire("a");
    void sem.acquire("b", { maxWaitMs: 60_000 });
    await expect(sem.acquire("b", { maxWaitMs: 60_000 })).rejects.toBeInstanceOf(BackpressureError);
  });

  it("drops an aborted waiter from the queue", async () => {
    const sem = new FairSemaphore(1, { maxPerTenant: 5, maxTotal: 5 });
    await sem.acquire("a");
    const controller = new AbortController();
    const pending = sem.acquire("b", { maxWaitMs: 60_000, signal: controller.signal });
    expect(sem.waitingCount).toBe(1);
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    expect(sem.waitingCount).toBe(0);
  });
});

describe("WorkerFairGate", () => {
  it("derives tenant and operation from the first activity argument and defaults to the system tenant", () => {
    expect(activityScope([{ workspaceId: "ws_1", operationId: "op_9" }])).toEqual({ tenant: "ws_1", operationId: "op_9" });
    expect(activityScope([{ workspaceId: "bad id!" }])).toEqual({ tenant: "_system" });
    expect(activityScope(["string"])).toEqual({ tenant: "_system" });
    expect(activityScope([])).toEqual({ tenant: "_system" });
  });

  it("gates only heavy activities, so bookkeeping can never queue behind a saturated lane", async () => {
    vi.useFakeTimers();
    try {
      const gate = new WorkerFairGate({ activitySlots: 4, capacity: 1, maxWaitMs: 1000 });
      expect(HEAVY_ACTIVITIES.has("applyInfrastructure")).toBe(true);
      expect(HEAVY_ACTIVITIES.has("acquireLease")).toBe(false);
      let release!: () => void;
      const blocker = gate.run("applyInfrastructure", [{ workspaceId: "ws_a", operationId: "op_a" }], () => new Promise<string>((resolve) => { release = () => resolve("done"); }));
      await vi.advanceTimersByTimeAsync(0);
      expect(gate.semaphore.inFlight).toBe(1);
      // A light activity runs straight through while the only heavy permit is held.
      await expect(gate.run("acquireLease", [{ workspaceId: "ws_b" }], async () => "lease")).resolves.toBe("lease");
      // A second heavy activity waits, then runs anyway once its wait budget is spent.
      const second = gate.run("planInfrastructure", [{ workspaceId: "ws_b" }], async () => "plan");
      await vi.advanceTimersByTimeAsync(1000);
      await expect(second).resolves.toBe("plan");
      release();
      await expect(blocker).resolves.toBe("done");
      expect(gate.semaphore.inFlight).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("propagates the activity's own failure unchanged and still releases the permit", async () => {
    const gate = new WorkerFairGate({ activitySlots: 2, maxWaitMs: 1000 });
    await expect(gate.run("deployWorkloads", [{ workspaceId: "ws_a" }], async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(gate.semaphore.inFlight).toBe(0);
  });

  it("reserves a quarter of the slots for the light lane by default", () => {
    const gate = new WorkerFairGate({ activitySlots: 8, maxWaitMs: 1000 });
    expect(gate.semaphore.capacity).toBe(6);
    expect(new WorkerFairGate({ activitySlots: 1, maxWaitMs: 1000 }).semaphore.capacity).toBe(1);
  });

  it("uses tenant weights from the quota table", () => {
    const gate = new WorkerFairGate({ activitySlots: 8, maxWaitMs: 1000 });
    gate.setWeights(new Map([["ws_gold", 5]]));
    expect(gate.weightOf("ws_gold")).toBe(5);
    expect(gate.weightOf("ws_other")).toBe(1);
  });
});
