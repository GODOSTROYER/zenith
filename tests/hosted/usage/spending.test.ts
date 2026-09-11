/**
 * The usage ledger, the rate table and the 50/75/90 % alerts.
 *
 * The behaviour worth pinning down: an alert fires **once** per workspace per
 * month per threshold however many times the check runs, builds pause at 90 %
 * and nothing else does, and a workspace with no envelope is never paused —
 * because zero is "nobody has approved a budget", not "the budget is nothing".
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-usage-spending-");
process.env.ZENITH_SPEND_ENVELOPE_USD = "100";

const { closeAuthority, openAuthority } = await import("@/lib/hosted/authority");
const {
  RATE_TABLE,
  SPEND_DISCLOSURE,
  buildsPaused,
  checkSpendThresholds,
  monthStart,
  recordUsage,
  spendAlertKey,
  spendingStatus,
  usageSummary,
  utcMonth,
} = await import("@/lib/hosted/usage");
const { seedApp } = await import("../backup/_ops-fixtures");

const a = openAuthority();
const app = await seedApp(a, { slug: "spend-app" });
let workspace = 0;

/** A fresh workspace id per test, so one test's crossings never leak into another. */
const nextWorkspace = (): string => `ws-spend-${++workspace}`;

afterAll(async () => {
  closeAuthority();
  removeDir(dataDir);
});

beforeEach(async () => {
  process.env.ZENITH_SPEND_ENVELOPE_USD = "100";
});

/** Spend `usd` this month, as an invoice figure (rate 1:1, so the arithmetic is visible). */
const spend = async (workspaceId: string, usd: number): Promise<void> => {
  await recordUsage({ workspaceId, kind: "provider_usd", amount: usd, note: "test invoice line" });
};

describe("the rate table", () => {
  it("prices each counter and says where every rate came from", async () => {
    const ws = nextWorkspace();
    await recordUsage({ workspaceId: ws, appId: app.id, kind: "requests", amount: 1_000_000 });
    await recordUsage({ workspaceId: ws, appId: app.id, kind: "build_ms", amount: 60_000 });
    await recordUsage({ workspaceId: ws, kind: "emails", amount: 250 });
    await recordUsage({ workspaceId: ws, kind: "provider_usd", amount: 7.5, note: "real invoice" });

    const summary = await usageSummary(ws, { since: await monthStart() });
    const byKind = Object.fromEntries(summary.byKind.map((row) => [row.kind, row]));

    expect(byKind.requests.estimatedUsd).toBeCloseTo(0.3, 10);
    expect(byKind.build_ms.estimatedUsd).toBeCloseTo(0.01, 10);
    expect(byKind.emails.estimatedUsd).toBeCloseTo(0.25, 10);
    expect(byKind.provider_usd.estimatedUsd).toBeCloseTo(7.5, 10);
    expect(summary.estimatedUsd).toBeCloseTo(0.3 + 0.01 + 0.25 + 7.5, 10);
    // The only number that is not an estimate is the one taken off an invoice.
    expect(summary.invoicedUsd).toBeCloseTo(7.5, 10);
    expect(summary.disclosure).toBe(SPEND_DISCLOSURE);

    for (const row of summary.byKind) expect(row.basis.length).toBeGreaterThan(20);
    expect(RATE_TABLE.build_ms.basis).toMatch(/placeholder/i);
    expect(RATE_TABLE.provider_usd.basis).toMatch(/Not an estimate/);
  });

  it("labels every estimate as an estimate wherever it is produced", async () => {
    const status = await spendingStatus(nextWorkspace());
    expect(status.disclosure).toBe(SPEND_DISCLOSURE);
    expect(SPEND_DISCLOSURE).toMatch(/invoices lag/);
  });
});

describe("thresholds", () => {
  it("crosses 50, 75 and 90 exactly once each, whatever the check is called", async () => {
    const ws = nextWorkspace();
    const month = await utcMonth();

    expect((await checkSpendThresholds(ws)).crossed).toEqual([]);

    await spend(ws, 50);
    expect((await checkSpendThresholds(ws)).crossed).toEqual([50]);
    // Called again at the same spend: nothing new.
    expect((await checkSpendThresholds(ws)).crossed).toEqual([]);

    await spend(ws, 25);
    expect((await checkSpendThresholds(ws)).crossed).toEqual([75]);

    await spend(ws, 15);
    expect((await checkSpendThresholds(ws)).crossed).toEqual([90]);
    expect((await checkSpendThresholds(ws)).crossed).toEqual([]);

    // One outbox row per threshold, under its stable key.
    for (const threshold of [50, 75, 90]) {
      const row = await a.repos.outbox.getByKey(await spendAlertKey(ws, month, threshold));
      expect(row?.kind).toBe("spend_alert");
      expect(row?.payload).toMatchObject({ workspaceId: ws, threshold, envelopeUsd: 100 });
    }

    // One event per threshold, deduped on the same key.
    const events = await a.repos.events.listSince({ workspaceId: ws, event: "spend.threshold" }, { limit: 100 });
    expect((await events.map((event) => event.props?.threshold)).sort()).toEqual([50, 75, 90]);
    expect(events).toHaveLength(3);

    const status = await spendingStatus(ws);
    expect(status.thresholds[50].crossed).toBe(true);
    expect(status.thresholds[50].crossedAt).toBeTruthy();
    expect(status.thresholds[90].crossed).toBe(true);
  });

  it("crosses several thresholds at once when spending jumps past them", async () => {
    const ws = nextWorkspace();
    await spend(ws, 95);
    expect((await checkSpendThresholds(ws)).crossed).toEqual([50, 75, 90]);
    expect((await checkSpendThresholds(ws)).crossed).toEqual([]);
  });

  it("raises nothing when no envelope is set", async () => {
    process.env.ZENITH_SPEND_ENVELOPE_USD = "0";
    const ws = nextWorkspace();
    await spend(ws, 10_000);
    const { crossed, status } = await checkSpendThresholds(ws);
    expect(crossed).toEqual([]);
    expect(status.fraction).toBe(0);
    expect(await a.repos.outbox.getByKey(await spendAlertKey(ws, await utcMonth(), 50))).toBeNull();
  });
});

describe("buildsPaused", () => {
  it("holds new builds at 90 % and says running apps are unaffected", async () => {
    const ws = nextWorkspace();
    await spend(ws, 89.99);
    expect((await buildsPaused(ws)).paused).toBe(false);

    await spend(ws, 0.01);
    const verdict = await buildsPaused(ws);
    expect(verdict.paused).toBe(true);
    expect(verdict.reason).toMatch(/keep running/);
    expect(verdict.reason).toMatch(/\$100\.00 monthly envelope/);
    expect(verdict.reason).toMatch(/90 %/);

    // Recorded once, however often the runner asks.
    await buildsPaused(ws);
    await buildsPaused(ws);
    const paused = await a.repos.events.listSince({ workspaceId: ws, event: "build.paused" }, { limit: 10 });
    expect(paused).toHaveLength(1);
    expect(paused[0].outcome).toBe("denied");
  });

  it("never pauses a workspace with no envelope, and says why", async () => {
    process.env.ZENITH_SPEND_ENVELOPE_USD = "0";
    const ws = nextWorkspace();
    await spend(ws, 1_000_000);
    const verdict = await buildsPaused(ws);
    expect(verdict.paused).toBe(false);
    expect(verdict.reason).toMatch(/ZENITH_SPEND_ENVELOPE_USD/);
    expect(await a.repos.events.listSince({ workspaceId: ws, event: "build.paused" }, { limit: 10 })).toEqual([]);
  });

  it("counts only this month's usage against the envelope", async () => {
    const ws = nextWorkspace();
    const lastMonth = new Date(Date.parse(await monthStart()) - 5 * 24 * 60 * 60_000).toISOString();
    await recordUsage({ workspaceId: ws, kind: "provider_usd", amount: 500, at: lastMonth });
    await spend(ws, 10);

    const status = await spendingStatus(ws);
    expect(status.estimatedUsd).toBeCloseTo(10, 10);
    expect(status.month).toBe(await utcMonth());
    expect(status.buildsPaused.paused).toBe(false);
  });
});

describe("recordUsage", () => {
  it("refuses to record against an app that does not exist", async () => {
    await expect(recordUsage({
        workspaceId: nextWorkspace(),
        appId: "00000000-0000-4000-8000-000000000000",
        kind: "requests",
        amount: 1,
      })).rejects.toThrowError(/No hosted app has the id/);
  });

  it("stores what was measured, not what it costs", async () => {
    const ws = nextWorkspace();
    const entry = await recordUsage({ workspaceId: ws, appId: app.id, kind: "storage_bytes", amount: 1_073_741_824 });
    expect(entry.amount).toBe(1_073_741_824);
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
    const summary = await usageSummary(ws, { since: await monthStart() });
    expect(summary.byKind[0].amount).toBe(1_073_741_824);
    expect(summary.byKind[0].estimatedUsd).toBeCloseTo(0.75, 10);
  });
});
