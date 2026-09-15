/**
 * The in-process scheduler a long-lived Postgres host runs on.
 *
 * That topology falls between the two the rest of the system is built for: the
 * engine's 250 ms ticker is gated off (a timer callback has no snapshot, so
 * `db()` refuses, and a throw from `setInterval` is a process exit), boot does
 * no durable catch-up for the same reason, and nothing outside a self-hosted
 * process is obliged to call `/api/internal/tick/*`. Without the scheduler a
 * deployment sits in `applying` for ever.
 *
 * What is pinned here is the contract that makes it safe to run work on a
 * timer at all:
 *
 *  1. it starts only where it is needed — not on serverless, not on the file
 *     store, and not twice;
 *  2. every pass holds a **primed cron snapshot**, and one it primed itself:
 *     the interval is created inside `boot()`, which the first request awaits,
 *     so the callback inherits that request's async context and would
 *     otherwise read one caller's tenant slice for the life of the process;
 *  3. passes are single-flight — an overrunning pass is never doubled up;
 *  4. a failing pass is logged, not thrown out of a timer callback.
 *
 * The passes themselves are `tests/api/internal-tick.test.ts`'s and the
 * routes'; here they are replaced at the `scheduledPasses` seam so what is
 * being measured is the scheduling, not the engine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-pg-scheduler-", { fast: true });
process.env.ZENITH_STORE = "postgres";
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "service-role-test-key";

/** A project that answers every select with no rows: the prime still happens. */
function emptyProject() {
  const chain: Record<string, unknown> = {};
  for (const name of ["select", "in", "or", "eq", "like", "order", "limit"])
    chain[name] = () => chain;
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(resolve({ data: [], error: null, count: 0 }));
  return { from: () => chain };
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => emptyProject() }));

const cron = await import("@/lib/server/cron");
const { requestSnapshot, runWithSnapshot } = await import("@/lib/db/request-snapshot");
const { log } = await import("@/lib/log");
const pg = await import("@/lib/db/postgres-store");

const engineResult = { deployments: 0, ticks: 0, remaining: 0, timedOut: false, ms: 0 };

/** Replace the three passes; return what each one saw in scope when it ran. */
function stubPasses(): { snapshots: unknown[]; names: string[] } {
  const snapshots: unknown[] = [];
  const names: string[] = [];
  vi.spyOn(cron.scheduledPasses, "engine").mockImplementation(async () => {
    names.push("engine");
    snapshots.push(requestSnapshot());
    return engineResult;
  });
  vi.spyOn(cron.scheduledPasses, "alerts").mockImplementation(async () => {
    names.push("alerts");
    return { changed: 0 };
  });
  vi.spyOn(cron.scheduledPasses, "outbox").mockImplementation(async () => {
    names.push("outbox");
    return { pending: 0 };
  });
  return { snapshots, names };
}

type G = typeof globalThis & { __zenithCronPassCount?: number };

beforeEach(() => {
  cron.stopCronScheduler();
  delete (globalThis as G).__zenithCronPassCount;
  pg.clearProcessSnapshot();
  pg.resetPgClient();
  process.env.ZENITH_STORE = "postgres";
  delete process.env.ZENITH_SERVERLESS;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cron.stopCronScheduler();
  vi.restoreAllMocks();
  delete process.env.ZENITH_SERVERLESS;
  process.env.ZENITH_STORE = "postgres";
});

describe("where the scheduler starts", () => {
  it("starts on a long-lived Postgres host, once", () => {
    expect(cron.startCronScheduler()).toBe(true);
    expect(cron.cronSchedulerRunning()).toBe(true);
    // Idempotent: boot is called per process but `ensureBoot` is not the only
    // caller shape, and two intervals would mean two passes per period.
    expect(cron.startCronScheduler()).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not start on a serverless instance", () => {
    process.env.ZENITH_SERVERLESS = "1";
    expect(cron.startCronScheduler()).toBe(false);
    expect(cron.cronSchedulerRunning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start on the file store, which has its own timers", () => {
    process.env.ZENITH_STORE = "file";
    expect(cron.startCronScheduler()).toBe(false);
    expect(cron.cronSchedulerRunning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("what one scheduled tick does", () => {
  it("runs the passes inside a primed cron snapshot", async () => {
    const seen = stubPasses();
    cron.startCronScheduler();

    await vi.advanceTimersByTimeAsync(cron.SCHEDULER_INTERVAL_MS);

    // The first pass is a slow one: engine, then alerts, then the outbox.
    expect(seen.names).toEqual(["engine", "alerts", "outbox"]);
    const snapshot = seen.snapshots[0] as { scope: Set<string>; baseline: Map<string, unknown> };
    // A real snapshot, in scope, and the one `inCronScope()` primed — not
    // `undefined` (which is what `db()` refuses on) and not a request's.
    expect(snapshot).toBeDefined();
    expect(snapshot.baseline).toBeInstanceOf(Map);
    expect(snapshot).toBe(pg.currentSnapshot());
  });

  it("primes its own snapshot even when it inherited a request's", async () => {
    const seen = stubPasses();
    const foreign = { data: {}, baseline: new Map(), scope: new Set(["ws-someone-else"]) };

    // The shape the real hazard has: the interval is created while a request's
    // snapshot is in scope, so every callback inherits it.
    await runWithSnapshot(foreign, async () => {
      cron.startCronScheduler();
      await vi.advanceTimersByTimeAsync(cron.SCHEDULER_INTERVAL_MS);
    });

    expect(seen.snapshots).toHaveLength(1);
    expect(seen.snapshots[0]).not.toBe(foreign);
    expect(seen.snapshots[0]).toBe(pg.currentSnapshot());
  });

  it("runs alerts and the outbox every Nth pass, and the engine every time", async () => {
    const seen = stubPasses();
    cron.startCronScheduler();

    await vi.advanceTimersByTimeAsync(cron.SCHEDULER_INTERVAL_MS * cron.SCHEDULER_SLOW_EVERY);

    expect(seen.names.filter((n) => n === "engine")).toHaveLength(cron.SCHEDULER_SLOW_EVERY);
    expect(seen.names.filter((n) => n === "alerts")).toHaveLength(1);
    expect(seen.names.filter((n) => n === "outbox")).toHaveLength(1);
  });
});

/**
 * The request-path half of the same topology. `nudge()` used to be "serverless
 * only, because a server has its 250 ms ticker" — which stopped being true for
 * a long-lived Postgres host the moment that ticker was gated off. It is safe
 * there in a way it is not outside a request: `db()` is the caller's own
 * snapshot, and a long-lived process finishes the flush `save()` schedules.
 */
describe("nudge() where there is no ticker", () => {
  const nudgedAt = (): number | undefined =>
    (globalThis as { __zenithNudgeAt?: number }).__zenithNudgeAt;

  beforeEach(() => {
    delete (globalThis as { __zenithNudgeAt?: number }).__zenithNudgeAt;
  });

  it("runs on a long-lived Postgres host, inside the request's own snapshot", async () => {
    const snapshot = await pg.loadSnapshot(pg.pgClient(), null);
    snapshot.data.projects.push({
      id: "p-1",
      workspaceId: "ws-1",
      slug: "api",
      name: "API",
    } as never);
    snapshot.data.deployments.push({
      id: "d-1",
      projectId: "p-1",
      status: "applying",
      steps: [],
    } as never);

    runWithSnapshot(snapshot, () => cron.nudge("ws-1"));

    expect(nudgedAt()).toBeGreaterThan(0);
  });

  it("still does nothing on a long-lived file-store host", () => {
    process.env.ZENITH_STORE = "file";
    cron.nudge("ws-1");
    expect(nudgedAt()).toBeUndefined();
  });
});

describe("overlap and failure", () => {
  it("is single-flight: a pass that overruns its period is not doubled up", async () => {
    let release = (): void => undefined;
    const hang = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    let started = 0;
    vi.spyOn(cron.scheduledPasses, "engine").mockImplementation(async () => {
      started++;
      await hang;
      return engineResult;
    });
    vi.spyOn(cron.scheduledPasses, "alerts").mockResolvedValue({ changed: 0 });
    vi.spyOn(cron.scheduledPasses, "outbox").mockResolvedValue({ pending: 0 });

    cron.startCronScheduler();
    await vi.advanceTimersByTimeAsync(cron.SCHEDULER_INTERVAL_MS * 3);
    expect(started).toBe(1);
    // …and a direct call while one is in flight says so rather than starting a
    // second pass over the same rows.
    expect(await cron.runScheduledPass()).toBeNull();

    release();
    await vi.advanceTimersByTimeAsync(cron.SCHEDULER_INTERVAL_MS);
    expect(started).toBe(2);
  });

  it("logs a failing pass instead of throwing out of the timer callback", async () => {
    const errors = vi.spyOn(log, "error").mockImplementation(() => undefined);
    let calls = 0;
    vi.spyOn(cron.scheduledPasses, "engine").mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error("PostgREST is down");
      return engineResult;
    });
    vi.spyOn(cron.scheduledPasses, "alerts").mockResolvedValue({ changed: 0 });
    vi.spyOn(cron.scheduledPasses, "outbox").mockResolvedValue({ pending: 0 });

    cron.startCronScheduler();
    await vi.advanceTimersByTimeAsync(cron.SCHEDULER_INTERVAL_MS);

    expect(errors).toHaveBeenCalledWith(
      "scheduled pass failed",
      expect.objectContaining({ scope: "cron" })
    );
    // The scheduler survives its own failure: the next period runs again.
    await vi.advanceTimersByTimeAsync(cron.SCHEDULER_INTERVAL_MS);
    expect(calls).toBe(2);
  });
});
