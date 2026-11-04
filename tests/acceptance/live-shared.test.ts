import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reserveRunBudget, tagsMatch, inventoryEmpty, teardownUntilFailure } from "../../scripts/acceptance/live/shared";

describe("shared live acceptance controls, with local files and callbacks only", () => {
  it("shares a conservative cumulative cap and rejects duplicate runs across harnesses", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "zenith-budget-")), "budget.json");
    const reservation = { runId: "aws-1", planSha256: "a".repeat(64), usd: 6 };
    reserveRunBudget(file, reservation, 10);
    expect(() => reserveRunBudget(file, reservation, 10)).toThrow();
    expect(() => reserveRunBudget(file, { ...reservation, runId: "dns-1", usd: 5 }, 10)).toThrow();
    reserveRunBudget(file, { ...reservation, runId: "managed-1", usd: 4 }, 10);
    expect(JSON.parse(readFileSync(file, "utf8")).reservations).toHaveLength(2);
    writeFileSync(`${file}.lock`, "owned");
    expect(() => reserveRunBudget(file, { ...reservation, runId: "another" }, 20)).toThrow();
  });
  it("never interprets unreadable inventory or inherited ownership as safe", () => {
    expect(inventoryEmpty([])).toBe(true);
    for (const value of [null, undefined, {}, { length: 0 }, ["remaining"]]) expect(inventoryEmpty(value)).toBe(false);
    expect(tagsMatch({ Run: "ours" }, { Run: "ours" })).toBe(true);
    expect(tagsMatch(Object.create({ Run: "ours" }), { Run: "ours" })).toBe(false);
  });
  it("stops dependent teardown after failure and still supports independent cleanup", async () => {
    const called: number[] = [];
    expect(await teardownUntilFailure([1, 2, 3], async value => { called.push(value); return value !== 2; })).toBe(1);
    expect(called).toEqual([1, 2]);
    called.length = 0;
    await teardownUntilFailure([1, 2, 3], async value => { called.push(value); return value !== 2; }, false);
    expect(called).toEqual([1, 2, 3]);
  });
});
