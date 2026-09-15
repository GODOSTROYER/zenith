/**
 * Boot on a host that is not a long-lived file-store server.
 *
 * The pid lock, the engine's 250ms ticker and the alert evaluator's 15s pass
 * all serve a long-lived process. On Vercel there is no such process: an
 * instance is frozen between requests and owns its own `/tmp`, so a timer
 * either never fires or fires against storage nothing else will read. What
 * these assert is the gate itself — no interval handles, no lock file — and
 * that a normal `next dev` boot (no flag set) still starts both timers.
 *
 * `ZENITH_STORE=postgres` is the second gate, and the one that decides whether
 * a self-hosted install has a background at all: boot does no durable catch-up
 * there (it holds no snapshot and runs before any bearer is checked), the
 * engine ticker is off for the same reason, and what replaces both is the
 * in-process scheduler on a long-lived host and an external one on serverless.
 * Both halves are pinned here because a silent revert of either is a topology
 * that quietly stops deploying.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDataDir } from "../_support/data-dir";

const DATA = tempDataDir("zenith-serverless-boot-");
const { ensureBoot } = await import("@/lib/server/boot");
const { EVALUATION_INTERVAL_MS } = await import("@/lib/alerts");
const { SCHEDULER_INTERVAL_MS, cronSchedulerRunning, stopCronScheduler } = await import(
  "@/lib/server/cron"
);

type Globals = typeof globalThis & {
  __zenithBoot?: Promise<void>;
  __zenithTicker?: unknown;
  __zenithAlertTimer?: unknown;
};

/** Boot is memoised per process; a second scenario needs a clean slate. */
function forgetBoot(): void {
  const g = globalThis as Globals;
  for (const timer of [g.__zenithTicker, g.__zenithAlertTimer])
    if (timer) clearInterval(timer as ReturnType<typeof setInterval>);
  delete g.__zenithBoot;
  delete g.__zenithTicker;
  delete g.__zenithAlertTimer;
  stopCronScheduler();
}

beforeEach(forgetBoot);
afterEach(() => {
  forgetBoot();
  delete process.env.ZENITH_SERVERLESS;
  delete process.env.ZENITH_STORE;
  vi.restoreAllMocks();
});

const lockFile = () => path.join(DATA, ".zenith.lock");

/** The interval periods one boot asks for. 250ms is the engine's ticker, 15s the evaluator's. */
async function bootIntervals(): Promise<number[]> {
  const interval = vi.spyOn(global, "setInterval");
  await ensureBoot();
  const delays = interval.mock.calls.map(([, ms]) => ms as number);
  interval.mockRestore();
  return delays;
}

/**
 * The same, plus the `setTimeout(…, 0)` boot uses to schedule the alert-outbox
 * replay. That timeout is the observable edge of "boot did the durable
 * catch-up": it is the one thing boot defers rather than awaits, and it sits
 * below the Postgres early return.
 */
async function bootTimers(): Promise<{ intervals: number[]; replayScheduled: boolean }> {
  const interval = vi.spyOn(global, "setInterval");
  const timeout = vi.spyOn(global, "setTimeout");
  await ensureBoot();
  const intervals = interval.mock.calls.map(([, ms]) => ms as number);
  const replayScheduled = timeout.mock.calls.some(([, ms]) => ms === 0);
  interval.mockRestore();
  timeout.mockRestore();
  return { intervals, replayScheduled };
}

describe("boot on a serverless instance", () => {
  it("starts neither the engine ticker nor the alert evaluator, and claims nothing", async () => {
    process.env.ZENITH_SERVERLESS = "1";

    const delays = await bootIntervals();

    // The hosted job runner has its own lifecycle and is not part of this gate,
    // so the evaluator's period is what a timer count is asserted on.
    expect(delays).not.toContain(EVALUATION_INTERVAL_MS);
    const g = globalThis as Globals;
    expect(g.__zenithTicker).toBeUndefined();
    expect(g.__zenithAlertTimer).toBeUndefined();
    // Every instance has its own /tmp, so the lock could only ever name a
    // process that no longer exists.
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it("still starts both timers for a long-lived process", async () => {
    const delays = await bootIntervals();

    expect(delays).toContain(EVALUATION_INTERVAL_MS);
    expect(delays).toContain(250); // the engine ticker
    const g = globalThis as Globals;
    expect(g.__zenithTicker).toBeDefined();
    expect(g.__zenithAlertTimer).toBeDefined();
    expect(fs.existsSync(lockFile())).toBe(true);
    // The file store's own timers are the background here; the Postgres
    // scheduler must stay out of it.
    expect(cronSchedulerRunning()).toBe(false);
  });
});

describe("boot on ZENITH_STORE=postgres", () => {
  beforeEach(() => {
    process.env.ZENITH_STORE = "postgres";
  });

  it("starts the in-process scheduler instead of the ticker, on a long-lived host", async () => {
    const { intervals, replayScheduled } = await bootTimers();

    const g = globalThis as Globals;
    // No 250 ms ticker: a timer callback has no snapshot, so `db()` would
    // refuse and the throw would leave a `setInterval` uncaught.
    expect(g.__zenithTicker).toBeUndefined();
    expect(intervals).not.toContain(250);
    // No evaluator timer and no deferred outbox replay either — boot returns
    // before `engine.resumeInFlight()`, `replayOutbox()` and
    // `startAlertEvaluator()`, all of which read the store.
    expect(g.__zenithAlertTimer).toBeUndefined();
    expect(intervals).not.toContain(EVALUATION_INTERVAL_MS);
    expect(replayScheduled).toBe(false);
    // …and this is what does that work instead.
    expect(cronSchedulerRunning()).toBe(true);
    expect(intervals).toContain(SCHEDULER_INTERVAL_MS);
  });

  it("starts nothing at all on a serverless instance, where an external schedule ticks", async () => {
    process.env.ZENITH_SERVERLESS = "1";

    const { intervals, replayScheduled } = await bootTimers();

    const g = globalThis as Globals;
    expect(g.__zenithTicker).toBeUndefined();
    expect(g.__zenithAlertTimer).toBeUndefined();
    expect(replayScheduled).toBe(false);
    expect(cronSchedulerRunning()).toBe(false);
    expect(intervals).not.toContain(SCHEDULER_INTERVAL_MS);
  });
});
