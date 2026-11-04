import { describe, expect, it } from "vitest";
import { freshness, STALE_AFTER_MS } from "@/app/(product)/platform/_lib/freshness";
describe("stored state freshness", () => {
  const now = Date.parse("2026-10-01T00:00:00.000Z");
  it("marks reads older than the stated UI threshold stale", () => { expect(freshness(new Date(now - STALE_AFTER_MS - 1).toISOString(), now)).toBe("stale"); });
  it("recognizes a recent timestamp without claiming a new cloud read", () => { expect(freshness(new Date(now - STALE_AFTER_MS).toISOString(), now)).toBe("recent"); });
  it.each(["invalid", new Date(now + 1).toISOString()])("marks invalid or future time %s unknown", (time) => { expect(freshness(time, now)).toBe("unknown"); });
});
