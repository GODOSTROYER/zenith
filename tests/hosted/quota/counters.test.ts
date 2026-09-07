/**
 * Request quota counters: atomic, persisted, and reset at 00:00 UTC.
 *
 * The property that matters is not "the number goes up". It is that the number
 * a request is admitted or refused on is a number that *committed*, so two
 * writers cannot both see the same value and both be let through, and a
 * restart cannot forget what today already used.
 *
 * Workstream W8 (hosted R3).
 */
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-quota-counters-");

const { closeAuthority, createRepos, openAuthority, transact, utcDay } = await import("@/lib/hosted/authority");
const { admitRequest, quotaSummary, resetDayForTests } = await import("@/lib/hosted/quota");
const { seedApp } = await import("../backup/_ops-fixtures");

let a = openAuthority();
const app = seedApp(a, { slug: "quota-app" });

afterAll(() => {
  closeAuthority();
  removeDir(dataDir);
});

beforeEach(() => {
  resetDayForTests(app.id);
});

/** A second connection to the same file, with the same durability pragmas. */
function secondConnection() {
  const db = new DatabaseSync(a.path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return { db, repos: createRepos(db) };
}

describe("admitRequest", () => {
  it("admits up to the limit, then denies and counts the denial", () => {
    const limit = 3;
    const outcomes = [1, 2, 3, 4, 5].map(() => admitRequest(app.id, { limit }));

    expect(outcomes.map((o) => o.allowed)).toEqual([true, true, true, false, false]);
    expect(outcomes.map((o) => o.counter.requests)).toEqual([1, 2, 3, 4, 5]);
    // Every attempt counts as a request; only the refused ones count as denials.
    expect(outcomes.map((o) => o.counter.denied)).toEqual([0, 0, 0, 1, 2]);
    expect(outcomes[4].limit).toBe(3);
  });

  it("counts every request whatever its outcome, and admits exactly `limit` of them", () => {
    const limit = 10;
    for (let n = 0; n < 25; n++) admitRequest(app.id, { limit });
    const counter = a.repos.quotas.get(app.id, utcDay());
    expect(counter.requests).toBe(25);
    expect(counter.denied).toBe(15);
    expect(counter.requests - counter.denied).toBe(limit);
  });

  it("does not lose an increment when a second connection interleaves with it", () => {
    const other = secondConnection();
    try {
      // Interleaved at the statement level: without the single upsert (a
      // read-modify-write in JS instead) these two would repeatedly read the
      // same value and one of the two writes would be lost.
      for (let n = 0; n < 50; n++) {
        admitRequest(app.id, { limit: 1_000 });
        transact(other.db, () => other.repos.quotas.increment(app.id, utcDay(), false));
      }
      expect(a.repos.quotas.get(app.id, utcDay()).requests).toBe(100);
      // Both connections see the same committed number.
      expect(other.repos.quotas.get(app.id, utcDay()).requests).toBe(100);
    } finally {
      other.db.close();
    }
  });

  it("reads the committed count rather than an in-process counter", () => {
    const other = secondConnection();
    try {
      const limit = 5;
      expect(admitRequest(app.id, { limit }).allowed).toBe(true);
      // Another writer uses the rest of the day's allowance.
      transact(other.db, () => {
        for (let n = 0; n < 4; n++) other.repos.quotas.increment(app.id, utcDay(), false);
      });
      // This process never saw those four, and still refuses the sixth.
      const sixth = admitRequest(app.id, { limit });
      expect(sixth.counter.requests).toBe(6);
      expect(sixth.allowed).toBe(false);
    } finally {
      other.db.close();
    }
  });

  it("rolls over at 00:00 UTC and leaves yesterday's row alone", () => {
    const lateYesterday = new Date("2026-09-06T23:59:59.999Z");
    const earlyToday = new Date("2026-09-07T00:00:00.000Z");

    for (let n = 0; n < 4; n++) admitRequest(app.id, { limit: 3, now: lateYesterday });
    const first = admitRequest(app.id, { limit: 3, now: earlyToday });

    expect(first.allowed).toBe(true);
    expect(first.counter.day).toBe("2026-09-07");
    expect(first.counter.requests).toBe(1);
    expect(first.counter.denied).toBe(0);

    const yesterday = a.repos.quotas.get(app.id, "2026-09-06");
    expect(yesterday).toMatchObject({ day: "2026-09-06", requests: 4, denied: 1 });
  });

  it("keeps the day's count across an authority reopen", () => {
    for (let n = 0; n < 7; n++) admitRequest(app.id, { limit: 100 });
    const day = utcDay();

    closeAuthority();
    a = openAuthority();

    expect(a.repos.quotas.get(app.id, day)).toMatchObject({ requests: 7, denied: 0 });
    // And the next request continues from there rather than starting over.
    expect(admitRequest(app.id, { limit: 100 }).counter.requests).toBe(8);
  });

  it("refuses to count a request against an app that does not exist", () => {
    expect(() => admitRequest("00000000-0000-4000-8000-000000000000")).toThrowError(
      /No hosted app has the id/
    );
  });
});

describe("quotaSummary", () => {
  it("reports today's counter, the window and how the number is produced", () => {
    const now = new Date("2026-09-07T12:00:00.000Z");
    for (let n = 0; n < 3; n++) admitRequest(app.id, { limit: 2, now });
    for (let n = 0; n < 2; n++) admitRequest(app.id, { limit: 100, now: new Date("2026-09-05T12:00:00.000Z") });

    const summary = quotaSummary(app.id, { days: 7, now });
    expect(summary.today).toBe("2026-09-07");
    expect(summary.current).toMatchObject({ requests: 3, denied: 1 });
    expect(summary.days.map((day) => day.day)).toEqual(["2026-09-07", "2026-09-05"]);
    expect(summary.disclosure).toMatch(/reset at 00:00 UTC/);
    expect(summary.disclosure).toMatch(/not a provider's own metering/);
  });

  it("answers with a zeroed counter for a day with no traffic", () => {
    const summary = quotaSummary(app.id, { now: new Date("2030-01-01T00:00:00.000Z") });
    expect(summary.current).toMatchObject({ requests: 0, denied: 0, day: "2030-01-01" });
    expect(summary.days).toEqual([]);
  });
});
