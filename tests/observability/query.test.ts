import { describe, expect, it } from "vitest";
import {
  ObservabilityInputError,
  effectiveStepSec,
  normalizeRange,
  validateEventQuery,
  validateLogQuery,
  validateMetricQuery,
  validateTraceQuery,
} from "@/lib/observability/query";
import { ENV, WS, scope } from "./_fixtures";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const range = (fromMinAgo: number, toMinAgo = 0) => ({ from: iso(NOW - fromMinAgo * 60_000), to: iso(NOW - toMinAgo * 60_000) });

function issues(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ObservabilityInputError);
    return (e as ObservabilityInputError).issues;
  }
  throw new Error("expected ObservabilityInputError");
}

describe("time range validation", () => {
  it("accepts an ordered past range and canonicalizes to UTC ISO", () => {
    const r = normalizeRange({ from: "2026-09-30T13:00:00+02:00", to: "2026-09-30T11:30:00Z" }, NOW);
    expect(r.from).toBe("2026-09-30T11:00:00.000Z");
    expect(r.to).toBe("2026-09-30T11:30:00.000Z");
  });

  it("defaults `to` to now", () => {
    expect(normalizeRange({ from: iso(NOW - 60_000) }, NOW).to).toBe(iso(NOW));
  });

  it("rejects from >= to", () => {
    expect(issues(() => normalizeRange({ from: iso(NOW - 1000), to: iso(NOW - 1000) }, NOW))).toContain("range.from must be before range.to");
    expect(issues(() => normalizeRange({ from: iso(NOW - 1000), to: iso(NOW - 2000) }, NOW))).toContain("range.from must be before range.to");
  });

  it("rejects a range that starts in the future and one that ends beyond the clock-skew allowance", () => {
    expect(issues(() => normalizeRange({ from: iso(NOW + 5000), to: iso(NOW + 10_000) }, NOW)).join()).toMatch(/future/);
    expect(issues(() => normalizeRange({ from: iso(NOW - 1000), to: iso(NOW + 120_000) }, NOW))).toContain("range.to is in the future");
  });

  it("clamps a `to` within the skew allowance to now", () => {
    expect(normalizeRange({ from: iso(NOW - 60_000), to: iso(NOW + 30_000) }, NOW).to).toBe(iso(NOW));
  });

  it("allows exactly seven days and rejects more", () => {
    const week = 7 * 24 * 3600 * 1000;
    expect(() => normalizeRange({ from: iso(NOW - week), to: iso(NOW) }, NOW)).not.toThrow();
    expect(issues(() => normalizeRange({ from: iso(NOW - week - 1), to: iso(NOW) }, NOW))).toContain("range spans more than 7 days");
  });

  it("rejects timestamps that are not ISO-8601", () => {
    for (const bad of ["yesterday", "2026-09-30", "1700000000", "", "2026-13-45T00:00:00Z"]) {
      expect(() => normalizeRange({ from: bad, to: iso(NOW) }, NOW)).toThrow(ObservabilityInputError);
    }
  });
});

describe("log query validation", () => {
  const base = { scope: scope(), range: range(30) };

  it("applies the default limit of 200 and caps at 1000", () => {
    expect(validateLogQuery(base, NOW).limit).toBe(200);
    expect(validateLogQuery({ ...base, limit: 50 }, NOW).limit).toBe(50);
    expect(validateLogQuery({ ...base, limit: 1000 }, NOW).limit).toBe(1000);
    expect(validateLogQuery({ ...base, limit: 50_000 }, NOW).limit).toBe(1000);
  });

  it("rejects a non-positive or fractional limit", () => {
    for (const limit of [0, -5, 1.5]) expect(() => validateLogQuery({ ...base, limit }, NOW)).toThrow(ObservabilityInputError);
  });

  it("is strict: unknown keys are rejected at every level", () => {
    expect(() => validateLogQuery({ ...base, sql: "drop" }, NOW)).toThrow(ObservabilityInputError);
    expect(() => validateLogQuery({ ...base, scope: { ...scope(), tenant: "other" } }, NOW)).toThrow(ObservabilityInputError);
    expect(() => validateLogQuery({ ...base, range: { ...base.range, tz: "UTC" } }, NOW)).toThrow(ObservabilityInputError);
  });

  it("requires scope identifiers and refuses ones with query syntax", () => {
    expect(() => validateLogQuery({ ...base, scope: { workspaceId: "", environmentId: ENV } }, NOW)).toThrow(ObservabilityInputError);
    expect(() => validateLogQuery({ ...base, scope: { workspaceId: WS, environmentId: 'env" }' } }, NOW)).toThrow(ObservabilityInputError);
  });

  it("validates addresses, dedupes and sorts them", () => {
    const q = validateLogQuery({ ...base, scope: scope({ addresses: ["service/web", "resource/db", "service/web"] }) }, NOW);
    expect(q.scope.addresses).toEqual(["resource/db", "service/web"]);
    for (const bad of ['service/"web"', "service/web; drop", "", "service/ web", "a".repeat(300)]) {
      expect(() => validateLogQuery({ ...base, scope: scope({ addresses: [bad] }) }, NOW)).toThrow(ObservabilityInputError);
    }
  });

  it("treats empty and whitespace-only text as no filter, keeps other text verbatim", () => {
    expect(validateLogQuery({ ...base, text: "" }, NOW).text).toBeUndefined();
    expect(validateLogQuery({ ...base, text: "   " }, NOW).text).toBeUndefined();
    expect(validateLogQuery({ ...base, text: ' a"b`c|d}e\n' }, NOW).text).toBe(' a"b`c|d}e\n');
  });

  it("refuses NUL and over-long text", () => {
    expect(() => validateLogQuery({ ...base, text: "a\u0000b" }, NOW)).toThrow(ObservabilityInputError);
    expect(() => validateLogQuery({ ...base, text: "x".repeat(257) }, NOW)).toThrow(ObservabilityInputError);
  });

  it("validates minSeverity", () => {
    expect(validateLogQuery({ ...base, minSeverity: "warn" }, NOW).minSeverity).toBe("warn");
    expect(() => validateLogQuery({ ...base, minSeverity: "loud" }, NOW)).toThrow(ObservabilityInputError);
  });

  it("returns a canonical range with `to` filled in", () => {
    const q = validateLogQuery({ scope: scope(), range: { from: iso(NOW - 60_000) } }, NOW);
    expect(q.range.to).toBe(iso(NOW));
  });
});

describe("metric query validation", () => {
  const base = { scope: scope(), range: range(60) };

  it("allows at most 20 metrics, at least 1, dedupes names", () => {
    const names = Array.from({ length: 20 }, (_, i) => `m${i}.x`);
    expect(validateMetricQuery({ ...base, metrics: names }, NOW).metrics).toHaveLength(20);
    expect(() => validateMetricQuery({ ...base, metrics: [...names, "extra"] }, NOW)).toThrow(ObservabilityInputError);
    expect(() => validateMetricQuery({ ...base, metrics: [] }, NOW)).toThrow(ObservabilityInputError);
    expect(validateMetricQuery({ ...base, metrics: ["cpu.utilization", "cpu.utilization"] }, NOW).metrics).toEqual(["cpu.utilization"]);
  });

  it("refuses metric names that are not portable identifiers", () => {
    for (const bad of ["CPU", "cpu utilization", 'cpu"}', "cpu.utilization{a=1}", "", "1cpu", "__proto__"]) {
      expect(() => validateMetricQuery({ ...base, metrics: [bad] }, NOW)).toThrow(ObservabilityInputError);
    }
  });

  it("picks a step: default about 120 points on a 60s grid, never more than 1440 points", () => {
    expect(effectiveStepSec(undefined, 60 * 60_000)).toBe(60);
    expect(effectiveStepSec(undefined, 7 * 86_400_000)).toBe(5040);
    expect(effectiveStepSec(1, 7 * 86_400_000)).toBe(Math.ceil((7 * 86_400) / 1440));
    expect(effectiveStepSec(600, 3600_000)).toBe(600);
    expect(validateMetricQuery({ ...base, metrics: ["cpu.utilization"] }, NOW).stepSec).toBe(60);
  });

  it("rejects an out-of-range step", () => {
    for (const stepSec of [0, -1, 86_401, 1.5]) expect(() => validateMetricQuery({ ...base, metrics: ["cpu.utilization"], stepSec }, NOW)).toThrow(ObservabilityInputError);
  });
});

describe("event and trace query validation", () => {
  it("event defaults to 200 and caps at 1000; trace defaults to 50 and caps at 200", () => {
    const base = { scope: scope(), range: range(10) };
    expect(validateEventQuery(base, NOW).limit).toBe(200);
    expect(validateEventQuery({ ...base, limit: 99_999 }, NOW).limit).toBe(1000);
    expect(validateTraceQuery(base, NOW).limit).toBe(50);
    expect(validateTraceQuery({ ...base, limit: 99_999 }, NOW).limit).toBe(200);
  });

  it("is strict", () => {
    expect(() => validateEventQuery({ scope: scope(), range: range(10), text: "x" }, NOW)).toThrow(ObservabilityInputError);
  });
});
