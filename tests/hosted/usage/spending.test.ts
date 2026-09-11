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
const app = seedApp(a, { slug: "spend-app" });
let workspace = 0;

/** A fresh workspace id per test, so one test's crossings never leak into another. */
const nextWorkspace = (): string => `ws-spend-${++workspace}`;

afterAll(() => {
  closeAuthority();
  removeDir(dataDir);
});

beforeEach(() => {
  process.env.ZENITH_SPEND_ENVELOPE_USD = "100";
});

/** Spend `usd` this month, as an invoice figure (rate 1:1, so the arithmetic is visible). */
const spend = (workspaceId: string, usd: number): void => {
  recordUsage({ workspaceId, kind: "provider_usd", amount: usd, note: "test invoice line" });
};

describe("the rate table", () => {
  it("prices each counter and says where every rate came from", () => {
    const ws = nextWorkspace();
    recordUsage({ workspaceId: ws, appId: app.id, kind: "requests", amount: 1_000_000 });
    recordUsage({ workspaceId: ws, appId: app.id, kind: "build_ms", amount: 60_000 });
    recordUsage({ workspaceId: ws, kind: "emails", amount: 250 });
    recordUsage({ workspaceId: ws, kind: "provider_usd", amount: 7.5, note: "real invoice" });

    const summary = usageSummary(ws, { since: monthStart() });
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

  it("labels every estimate as an estimate wherever it is produced", () => {
    const status = spendingStatus(nextWorkspace());
    expect(status.disclosure).toBe(SPEND_DISCLOSURE);
    expect(SPEND_DISCLOSURE).toMatch(/invoices lag/);
  });
});

describe("thresholds", () => {
  it("crosses 50, 75 and 90 exactly once each, whatever the check is called", async () => {
    const ws = nextWorkspace();
    const month = utcMonth();

    expect(checkSpendThresholds(ws).crossed).toEqual([]);

    spend(ws, 50);
    expect(checkSpendThresholds(ws).crossed).toEqual([50]);
    // Called again at the same spend: nothing new.
    expect(checkSpendThresholds(ws).crossed).toEqual([]);

    spend(ws, 25);
    expect(checkSpendThresholds(ws).crossed).toEqual([75]);

    spend(ws, 15);
    expect(checkSpendThresholds(ws).crossed).toEqual([90]);
    expect(checkSpendThresholds(ws).crossed).toEqual([]);

    // One outbox row per threshold, under its stable key.
    for (const threshold of [50, 75, 90]) {
      const row = a.repos.outbox.getByKey(spendAlertKey(ws, month, threshold));
      expect(row?.kind).toBe("spend_alert");
      expect(row?.payload).toMatchObject({ workspaceId: ws, threshold, envelopeUsd: 100 });
    }

    // One event per threshold, deduped on the same key.
    const events = a.repos.events.listSince({ workspaceId: ws, event: "spend.threshold" }, { limit: 100 });
    expect(events.map((event) => event.props?.threshold).sort()).toEqual([50, 75, 90]);
    expect(events).toHaveLength(3);

    const status = spendingStatus(ws);
    expect(status.thresholds[50].crossed).toBe(true);
    expect(status.thresholds[50].crossedAt).toBeTruthy();
    expect(status.thresholds[90].crossed).toBe(true);
  });

  it("crosses several thresholds at once when spending jumps past them", () => {
    const ws = nextWorkspace();
    spend(ws, 95);
    expect(checkSpendThresholds(ws).crossed).toEqual([50, 75, 90]);
    expect(checkSpendThresholds(ws).crossed).toEqual([]);
  });

  it("raises nothing when no envelope is set", () => {
    process.env.ZENITH_SPEND_ENVELOPE_USD = "0";
    const ws = nextWorkspace();
    spend(ws, 10_000);
    const { crossed, status } = checkSpendThresholds(ws);
    expect(crossed).toEqual([]);
    expect(status.fraction).toBe(0);
    expect(a.repos.outbox.getByKey(spendAlertKey(ws, utcMonth(), 50))).toBeNull();
  });
});

describe("buildsPaused", () => {
  it("holds new builds at 90 % and says running apps are unaffected", () => {
    const ws = nextWorkspace();
    spend(ws, 89.99);
    expect(buildsPaused(ws).paused).toBe(false);

    spend(ws, 0.01);
    const verdict = buildsPaused(ws);
    expect(verdict.paused).toBe(true);
    expect(verdict.reason).toMatch(/keep running/);
    expect(verdict.reason).toMatch(/\$100\.00 monthly envelope/);
    expect(verdict.reason).toMatch(/90 %/);

    // Recorded once, however often the runner asks.
    buildsPaused(ws);
    buildsPaused(ws);
    const paused = a.repos.events.listSince({ workspaceId: ws, event: "build.paused" }, { limit: 10 });
    expect(paused).toHaveLength(1);
    expect(paused[0].outcome).toBe("denied");
  });

  it("never pauses a workspace with no envelope, and says why", () => {
    process.env.ZENITH_SPEND_ENVELOPE_USD = "0";
    const ws = nextWorkspace();
    spend(ws, 1_000_000);
    const verdict = buildsPaused(ws);
    expect(verdict.paused).toBe(false);
    expect(verdict.reason).toMatch(/ZENITH_SPEND_ENVELOPE_USD/);
    expect(a.repos.events.listSince({ workspaceId: ws, event: "build.paused" }, { limit: 10 })).toEqual([]);
  });

  it("counts only this month's usage against the envelope", () => {
    const ws = nextWorkspace();
    const lastMonth = new Date(Date.parse(monthStart()) - 5 * 24 * 60 * 60_000).toISOString();
    recordUsage({ workspaceId: ws, kind: "provider_usd", amount: 500, at: lastMonth });
    spend(ws, 10);

    const status = spendingStatus(ws);
    expect(status.estimatedUsd).toBeCloseTo(10, 10);
    expect(status.month).toBe(utcMonth());
    expect(status.buildsPaused.paused).toBe(false);
  });
});

describe("recordUsage", () => {
  it("refuses to record against an app that does not exist", () => {
    expect(() =>
      recordUsage({
        workspaceId: nextWorkspace(),
        appId: "00000000-0000-4000-8000-000000000000",
        kind: "requests",
        amount: 1,
      })
    ).toThrowError(/No hosted app has the id/);
  });

  it("stores what was measured, not what it costs", () => {
    const ws = nextWorkspace();
    const entry = recordUsage({ workspaceId: ws, appId: app.id, kind: "storage_bytes", amount: 1_073_741_824 });
    expect(entry.amount).toBe(1_073_741_824);
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
    const summary = usageSummary(ws, { since: monthStart() });
    expect(summary.byKind[0].amount).toBe(1_073_741_824);
    expect(summary.byKind[0].estimatedUsd).toBeCloseTo(0.75, 10);
  });
});
