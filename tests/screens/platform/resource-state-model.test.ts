/**
 * The rule under test: an attribute nobody read is unknown, never "matches".
 */
import { describe, expect, it } from "vitest";
import {
  compareAttributes,
  describeCounts,
  describeSignal,
  displayAttributeValue,
  driftLookup,
  notObservedText,
  tally,
  UNKNOWN_REASON_SENTENCE,
  type UnknownReason,
} from "@/components/platform/resource-state-model";
import { driftReport, node, observation } from "./fixtures";

const byPath = (rows: ReturnType<typeof compareAttributes>) => Object.fromEntries(rows.map((r) => [r.path, r]));

describe("compareAttributes", () => {
  it("matches only when observed is known, desired is specified and they are equal", () => {
    const rows = byPath(compareAttributes(node(), observation()));
    expect(rows.replicas.status).toBe("matches");
    expect(rows["health.path"].status).toBe("matches");
  });

  it("reports a known difference", () => {
    const rows = byPath(compareAttributes(node(), observation()));
    expect(rows.image).toMatchObject({ status: "differs", observed: { state: "known", value: "web:3" } });
  });

  it("never reports an unknown observed value as matching", () => {
    const rows = byPath(compareAttributes(node(), observation()));
    expect(rows.cpu.status).toBe("not_observed");
    expect(rows.cpu.observed).toMatchObject({ state: "unknown", reason: "access_denied" });
  });

  it("treats an attribute missing from the observation as not read", () => {
    const rows = byPath(compareAttributes(node(), observation()));
    // the desired `health.interval` was never part of the observation
    expect(rows["health.interval"].status).toBe("not_observed");
    expect(rows["health.interval"].observed).toMatchObject({ state: "unknown", reason: "not_read" });
  });

  it("with no observation at all, every desired attribute is not observed", () => {
    const rows = compareAttributes(node(), undefined);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.status).toBe("not_observed");
      expect(r.observed).toMatchObject({ state: "unknown", reason: "no_observation" });
    }
  });

  it("explains a missing or inaccessible resource instead of comparing", () => {
    const missing = compareAttributes(node(), observation({ presence: "missing" }));
    expect(missing.every((r) => r.status === "not_observed")).toBe(true);
    expect(missing[0].observed).toMatchObject({ reason: "resource_missing" });
    const hidden = compareAttributes(node(), observation({ presence: "inaccessible" }));
    expect(hidden[0].observed).toMatchObject({ reason: "resource_inaccessible" });
  });

  it("reports an observed attribute the configuration does not set", () => {
    const rows = byPath(
      compareAttributes(node({ spec: { replicas: 3 } }), observation({ attributes: { replicas: { state: "known", value: 3, observedAt: "t" }, region_zone: { state: "known", value: "a", observedAt: "t" } } }))
    );
    expect(rows.region_zone).toMatchObject({ status: "observed_only", desired: { specified: false } });
  });

  it("compares a whole top-level object when the observation names it", () => {
    const rows = byPath(
      compareAttributes(
        node({ spec: { health: { path: "/healthz", interval: 30 } } }),
        observation({ attributes: { health: { state: "known", value: { interval: 30, path: "/healthz" }, observedAt: "t" } } })
      )
    );
    expect(rows.health.status).toBe("matches");
    expect(rows["health.path"]).toBeUndefined();
  });

  it("does not equate a number with its string form", () => {
    const rows = byPath(
      compareAttributes(node({ spec: { replicas: 3 } }), observation({ attributes: { replicas: { state: "known", value: "3", observedAt: "t" } } }))
    );
    expect(rows.replicas.status).toBe("differs");
  });

  it("sorts by attribute name and tallies", () => {
    const rows = compareAttributes(node(), observation());
    expect(rows.map((r) => r.path)).toEqual([...rows.map((r) => r.path)].sort());
    const t = tally(rows);
    expect(t.matches + t.differs + t.notObserved + t.observedOnly).toBe(rows.length);
    expect(t.notObserved).toBeGreaterThanOrEqual(2);
  });
});

describe("notObservedText", () => {
  const reasons = Object.keys(UNKNOWN_REASON_SENTENCE) as UnknownReason[];
  it.each(reasons)("%s always yields 'Not observed (reason)'", (reason) => {
    const t = notObservedText(reason);
    expect(t).toMatch(/^Not observed \(.+\)$/);
    expect(t).not.toContain(reason.includes("_") ? reason : "\u0000"); // the code itself is not the explanation
  });
  it("appends bounded detail", () => {
    expect(notObservedText("error", "timeout talking to ecs")).toBe("Not observed (reading it failed): timeout talking to ecs");
    expect(notObservedText("error", "x".repeat(500)).length).toBeLessThan(260);
  });
});

describe("displayAttributeValue", () => {
  it("masks secret-looking attributes but shows references", () => {
    expect(displayAttributeValue("db_password", "hunter2")).toEqual({ text: "(sensitive)", masked: true });
    expect(displayAttributeValue("db_password", "vault:db/pw").masked).toBe(false);
    expect(displayAttributeValue("secretEnv", { secretRef: "vault:web/db" }).text).toBe("Secret reference vault:web/db");
    expect(displayAttributeValue("replicas", 3).text).toBe("3");
    expect(displayAttributeValue("note", "").text).toBe('""');
    expect(displayAttributeValue("tags", { a: 1 }).text).toBe('{"a":1}');
  });
});

describe("runtime helpers", () => {
  it("turns signals into sentences and never prints a bare code", () => {
    expect(describeSignal("target_unhealthy:2")).toBe("2 load balancer targets are unhealthy.");
    expect(describeSignal("target_unhealthy:1")).toBe("1 load balancer target is unhealthy.");
    expect(describeSignal("task_stopped:OutOfMemory")).toBe("A task stopped: OutOfMemory.");
    expect(describeSignal("crash_loop_backoff")).toBe("Crash loop backoff.");
    expect(describeSignal("image_pull:denied")).toBe("Image pull: denied.");
  });
  it("labels counts and drops non-finite ones", () => {
    expect(describeCounts({ desired: 3, running: 2, bad: Number.NaN })).toEqual([
      { label: "Desired", value: 3 },
      { label: "Running", value: 2 },
    ]);
  });
});

describe("driftLookup", () => {
  it("returns the worst finding, 'not checked' for unobserved, and none otherwise", () => {
    const lookup = driftLookup(
      driftReport({
        findings: [
          { address: "a", class: "changed", severity: "low", repairable: true, autoRepairEligible: true, explanation: "x" },
          { address: "a", class: "missing", severity: "high", repairable: true, autoRepairEligible: false, explanation: "y" },
        ],
        unobserved: ["b"],
      })
    );
    expect(lookup("a")).toMatchObject({ kind: "finding", finding: { severity: "high" } });
    expect(lookup("b")).toEqual({ kind: "not_checked" });
    expect(lookup("c")).toEqual({ kind: "none" });
  });
  it("without a report everything is 'none' (the column is simply not drawn)", () => {
    expect(driftLookup(undefined)("x")).toEqual({ kind: "none" });
  });
});
