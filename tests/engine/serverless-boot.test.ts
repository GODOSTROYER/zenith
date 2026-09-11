/**
 * Boot on a serverless instance.
 *
 * The pid lock, the engine's 250ms ticker and the alert evaluator's 15s pass
 * all serve a long-lived process. On Vercel there is no such process: an
 * instance is frozen between requests and owns its own `/tmp`, so a timer
 * either never fires or fires against storage nothing else will read. What
 * these assert is the gate itself — no interval handles, no lock file — and
 * that a normal `next dev` boot (no flag set) still starts both timers.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDataDir } from "../_support/data-dir";

const DATA = tempDataDir("zenith-serverless-boot-");
const { ensureBoot } = await import("@/lib/server/boot");
const { EVALUATION_INTERVAL_MS } = await import("@/lib/alerts");

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
}

beforeEach(forgetBoot);
afterEach(() => {
  forgetBoot();
  delete process.env.ZENITH_SERVERLESS;
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
  });
});
