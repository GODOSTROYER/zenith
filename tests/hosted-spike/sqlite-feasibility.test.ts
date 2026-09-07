import { describe, expect, it } from "vitest";
import { runSqliteFeasibility } from "../../scripts/hosted-spike/sqlite-feasibility";

describe("SQLite candidate runtime on the current filesystem", () => {
  it("supports the transaction, locking, revocation-read and backup primitives without opening application data", async () => {
    const report = await runSqliteFeasibility();
    expect(report.status, JSON.stringify(report)).toBe("locally_verified");
    expect(report.scratchRemoved).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual([
      "durability-pragmas", "foreign-key-refusal", "atomic-rollback", "committed-visibility",
      "busy-writer-refusal", "fresh-revocation-read", "wal-aware-backup", "reopen-after-close",
    ]);
    expect(report.checks.every((check) => check.status === "passed")).toBe(true);
    expect(report.sqliteVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
