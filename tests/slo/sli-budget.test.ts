/**
 * PROD-OPS-01: SLI computation from the OPS-02 metric catalog, error budgets, burn rates and the delta
 * accounting that feeds the durable samples. Pure: no database.
 */
import { describe, expect, it } from "vitest";
import { METRIC_CATALOG } from "@/lib/ops/telemetry/catalog";
import { MetricsRegistry } from "@/lib/ops/telemetry/metrics";
import { sloDefinitions, type RatioLike } from "@/lib/slo/definitions";
import { budgetState, burnRate, evaluateBurnAlerts, MIN_EVENTS_FOR_ALERT, ratioStatus } from "@/lib/slo/budget";
import { apiSampleEntries } from "@/lib/slo/recorder";
import { apiAvailabilityFromSnapshot, apiLatencyFromSnapshot, apiLatencyQuantileFromSnapshot, counterDelta, quantile } from "@/lib/slo/sli";

/** A registry with the catalog's own instrument definitions, so the test reads the same names and labels production does. */
function registry(): { r: MetricsRegistry; requests: ReturnType<MetricsRegistry["counter"]>; duration: ReturnType<MetricsRegistry["histogram"]> } {
  const r = new MetricsRegistry();
  const meta = (name: string) => METRIC_CATALOG.find((m) => m.name === name)!;
  return {
    r,
    requests: r.counter("zenith_api_requests_total", meta("zenith_api_requests_total").help, meta("zenith_api_requests_total").labels),
    duration: r.histogram("zenith_api_request_duration_seconds", meta("zenith_api_request_duration_seconds").help, meta("zenith_api_request_duration_seconds").labels),
  };
}

const availability = sloDefinitions().objectives.find((o) => o.id === "control_plane_availability") as RatioLike;
const latency = sloDefinitions().objectives.find((o) => o.id === "api_latency") as RatioLike;

describe("SLIs from the metric registry", () => {
  it("availability counts 5xx as bad and everything else, 429 included, as served", () => {
    const { r, requests } = registry();
    requests.inc({ tenant: "a", route_class: "/x", method: "GET", status_class: "2xx" }, 90);
    requests.inc({ tenant: "a", route_class: "/x", method: "GET", status_class: "4xx" }, 6);
    requests.inc({ tenant: "b", route_class: "/y", method: "POST", status_class: "5xx" }, 4);
    expect(apiAvailabilityFromSnapshot(r.snapshot())).toEqual({ good: 96, total: 100 });
  });

  it("returns zero counts, not NaN, when nothing has been recorded", () => {
    expect(apiAvailabilityFromSnapshot(new MetricsRegistry().snapshot())).toEqual({ good: 0, total: 0 });
    expect(apiLatencyFromSnapshot(new MetricsRegistry().snapshot(), 0.5)).toMatchObject({ good: 0, total: 0 });
  });

  it("latency counts requests within the threshold bucket and rounds the threshold down to a bound", () => {
    const { r, duration } = registry();
    for (const s of [0.01, 0.2, 0.4, 0.5]) duration.observe({ route_class: "/x", method: "GET" }, s);
    for (const s of [0.6, 3]) duration.observe({ route_class: "/x", method: "GET" }, s);
    expect(apiLatencyFromSnapshot(r.snapshot(), 0.5)).toEqual({ good: 4, total: 6, effectiveThresholdSeconds: 0.5 });
    // 0.7 is between bounds 0.5 and 1: the 0.6 s request is NOT counted fast, because its bucket straddles 0.7
    expect(apiLatencyFromSnapshot(r.snapshot(), 0.7)).toMatchObject({ good: 4, total: 6, effectiveThresholdSeconds: 0.5 });
    expect(apiLatencyFromSnapshot(r.snapshot(), 0.001)).toMatchObject({ good: 0, effectiveThresholdSeconds: null });
  });

  it("estimates a process-local p95 as the upper bound of the bucket that holds it", () => {
    const { r, duration } = registry();
    for (let i = 0; i < 95; i++) duration.observe({ route_class: "/x", method: "GET" }, 0.02);
    for (let i = 0; i < 5; i++) duration.observe({ route_class: "/x", method: "GET" }, 2);
    expect(apiLatencyQuantileFromSnapshot(r.snapshot(), 0.95)).toBe(0.025);
    expect(apiLatencyQuantileFromSnapshot(r.snapshot(), 0.99)).toBe(2.5);
    expect(apiLatencyQuantileFromSnapshot(new MetricsRegistry().snapshot(), 0.95)).toBeNull();
  });

  it("nearest-rank quantile", () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([4, 1, 3, 2], 0.5)).toBe(2);
    expect(quantile([4, 1, 3, 2], 0.95)).toBe(4);
  });
});

describe("delta accounting for the durable samples", () => {
  it("adds only what is new since the previous flush and takes a restarted counter whole", () => {
    expect(counterDelta(undefined, { good: 5, total: 6 })).toEqual({ good: 5, total: 6 });
    expect(counterDelta({ good: 5, total: 6 }, { good: 9, total: 11 })).toEqual({ good: 4, total: 5 });
    expect(counterDelta({ good: 50, total: 60 }, { good: 2, total: 2 })).toEqual({ good: 2, total: 2 });
  });

  it("apiSampleEntries produces both API indicators from one snapshot and one previous reading", () => {
    const { r, requests, duration } = registry();
    requests.inc({ tenant: "a", route_class: "/x", method: "GET", status_class: "2xx" }, 10);
    requests.inc({ tenant: "a", route_class: "/x", method: "GET", status_class: "5xx" }, 1);
    duration.observe({ route_class: "/x", method: "GET" }, 0.1);
    duration.observe({ route_class: "/x", method: "GET" }, 5);
    const first = apiSampleEntries(r.snapshot(), 0.5, {});
    expect(first.entries).toEqual([{ sli: "api_availability", good: 10, total: 11 }, { sli: "api_latency", good: 1, total: 2 }]);
    requests.inc({ tenant: "a", route_class: "/x", method: "GET", status_class: "2xx" }, 4);
    const second = apiSampleEntries(r.snapshot(), 0.5, { availability: first.availability, latency: first.latency });
    expect(second.entries[0]).toEqual({ sli: "api_availability", good: 4, total: 4 });
    expect(second.entries[1]).toEqual({ sli: "api_latency", good: 0, total: 0 });
  });
});

describe("error budget and burn rate", () => {
  it("burn rate is the error ratio over the budget fraction", () => {
    // target 99.5% -> budget 0.5%; 1% errors burns at 2x; exactly 0.5% burns at 1x
    expect(burnRate(availability, { good: 990, total: 1000 })).toBeCloseTo(2, 9);
    expect(burnRate(availability, { good: 995, total: 1000 })).toBeCloseTo(1, 9);
    expect(burnRate(availability, { good: 0, total: 0 })).toBeNull();
  });

  it("budget remaining is negative when overspent and null without data", () => {
    expect(budgetState(availability, { good: 9975, total: 10_000 }).remainingFraction).toBeCloseTo(0.5, 9);
    expect(budgetState(availability, { good: 9900, total: 10_000 }).remainingFraction).toBeCloseTo(-1, 9);
    expect(budgetState(availability, undefined)).toEqual({ remainingFraction: null, allowedBad: null, actualBad: 0 });
  });

  it("status needs data and compares the budget-window ratio to the target", () => {
    expect(ratioStatus(availability, { good: 0, total: 0 })).toBe("no_data");
    expect(ratioStatus(availability, { good: 996, total: 1000 })).toBe("meeting");
    expect(ratioStatus(availability, { good: 990, total: 1000 })).toBe("breaching");
  });

  const alerts = sloDefinitions().burnAlerts;
  const w = (good: number, total: number) => ({ good, total });
  const healthy = { "5m": w(100, 100), "30m": w(100, 100), "1h": w(1000, 1000), "6h": w(1000, 1000), "3d": w(1000, 1000) };

  it("fires the fast alert only when BOTH windows burn at 14.4x", () => {
    // 10% errors = 20x of a 0.5% budget on both windows
    const burning = { ...healthy, "1h": w(900, 1000), "5m": w(90, 100) };
    expect(evaluateBurnAlerts(availability, alerts, burning).find((a) => a.name === "fast")?.firing).toBe(true);
    // recovered: the short window is clean, so the alert stops even though the hour still shows the damage
    const recovered = { ...healthy, "1h": w(900, 1000), "5m": w(100, 100) };
    expect(evaluateBurnAlerts(availability, alerts, recovered).find((a) => a.name === "fast")?.firing).toBe(false);
    // a short spike with a clean long window does not fire
    const spike = { ...healthy, "5m": w(50, 100) };
    expect(evaluateBurnAlerts(availability, alerts, spike).find((a) => a.name === "fast")?.firing).toBe(false);
  });

  it("does not page on a handful of events", () => {
    const tiny = { "5m": w(0, 1), "30m": w(0, 1), "1h": w(0, MIN_EVENTS_FOR_ALERT - 1), "6h": w(0, 5), "3d": w(0, 5) };
    expect(evaluateBurnAlerts(availability, alerts, tiny).some((a) => a.firing)).toBe(false);
  });

  it("uses the latency objective's own budget (5%)", () => {
    // 8% slow requests: 1.6x of a 5% budget, below the 6x slow factor but above the 1x ticket factor
    const slow = { "5m": w(92, 100), "30m": w(920, 1000), "1h": w(920, 1000), "6h": w(9200, 10_000), "3d": w(9200, 10_000) };
    const states = Object.fromEntries(evaluateBurnAlerts(latency, alerts, slow).map((a) => [a.name, a.firing]));
    expect(states).toEqual({ fast: false, slow: false, ticket: true });
  });
});
