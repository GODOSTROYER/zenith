import { describe, expect, it } from "vitest";
import type { Sql } from "@/lib/controlplane/types";
import { localUrl, seededEpoch } from "../../scripts/acceptance/maintenance/preconditions";

describe("maintenance rehearsal admission contracts", () => {
  it.each(["https://example.com", "http://127.0.0.1.example.com", "https://localhost.example.com", "file:///tmp/local"])("refuses external or non-HTTP endpoint %s", raw => {
    expect(() => localUrl(raw, ["http:", "https:"])).toThrow();
  });
  it("admits loopback endpoints without exporting user/password", () => {
    expect(localUrl("postgresql://fixture@127.0.0.1:55432/j4", ["postgresql:"]).hostname).toBe("127.0.0.1");
  });
  it.each([{ rows: [] }, { rows: [{ singleton: true, installed_at: "invalid", admitted: true }] }, { rows: [{ singleton: true, installed_at: new Date().toISOString(), admitted: false }] }])("refuses an absent, malformed or future migration epoch", async ({ rows }) => {
    const db = { query: async () => rows } as unknown as Sql;
    await expect(seededEpoch(db)).rejects.toThrow("Migration-seeded cleanup epoch");
  });
  it("uses the published singleton as a read-only precondition", async () => {
    const epoch = new Date().toISOString();
    const calls: string[] = [];
    const db = { query: async (sql: string) => { calls.push(sql); return [{ singleton: true, installed_at: epoch, admitted: true }]; } } as unknown as Sql;
    expect(await seededEpoch(db)).toBe(epoch);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^select /);
    expect(calls[0]).toContain("platform.cleanup_writer_epoch");
  });
});
