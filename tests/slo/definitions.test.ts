/**
 * PROD-OPS-01 / DEC-BUSINESS: the SLO definition file is versioned, records the owner's approval of launch ENGINEERING
 * TARGETS (never a contractual SLA), and the validator refuses every malformed or over-claiming variant while still
 * accepting the old unapproved shape.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSloDefinitions, PROVISIONAL_LABEL, SloDefinitionError, sloDefinitions, sloLabel, TARGET_LABEL } from "@/lib/slo/definitions";

const FILE = path.resolve(__dirname, "../../deploy/slo/slo-definitions.json");
const raw = (): Record<string, unknown> => JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown>;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const objectives = (d: Record<string, unknown>): Record<string, unknown>[] => d.objectives as Record<string, unknown>[];
const approval = (d: Record<string, unknown>): Record<string, unknown> => d.approval as Record<string, unknown>;

/** The old shape: not_approved plus every objective provisional. */
function unapproved(): Record<string, unknown> {
  const d = clone(raw());
  d.approval = { status: "not_approved", pendingDecision: "DEC-BUSINESS", note: "Custom, unapproved targets." };
  for (const o of objectives(d)) o.status = "provisional";
  delete d.nextMilestone;
  return d;
}

describe("committed definitions", () => {
  const defs = sloDefinitions();

  it("parses, is versioned, and records the owner's approval of engineering targets", () => {
    expect(defs.definitionVersion).toBe("2026-10-13.1");
    expect(defs.approval).toMatchObject({ status: "approved_targets", decision: "DEC-BUSINESS", approvedBy: "Arnav Bule", approvedAt: "2026-10-13", commitment: "engineering_target" });
    expect(sloLabel(defs)).toBe(TARGET_LABEL);
    expect(TARGET_LABEL).toBe("Approved launch target, not a contractual SLA");
    expect(PROVISIONAL_LABEL).toBe("Provisional, not approved");
  });

  it("labels every objective a target, never contractual, with no per-objective approver", () => {
    expect(defs.objectives.map((o) => o.id)).toEqual(["control_plane_availability", "managed_runtime_availability", "api_latency", "dispatch_latency", "workflow_completion", "scheduler_health", "capacity", "rpo", "rto"]);
    for (const o of defs.objectives) expect(o.status, o.id).toBe("target");
    const text = readFileSync(FILE, "utf8");
    expect(text).not.toMatch(/"(approver|signedOff|signedOffBy|owner)"/i);
    for (const o of defs.objectives) expect(`${o.title} ${o.sli}`, o.id).not.toMatch(/service[\s-]*credit|contractual|guarantee/i);
  });

  it("carries the approved targets", () => {
    const by = Object.fromEntries(defs.objectives.map((o) => [o.id, o]));
    expect(by.control_plane_availability).toMatchObject({ kind: "ratio", target: 0.999 });
    expect(by.control_plane_availability.sli).toMatch(/external probe/);
    expect(by.control_plane_availability.sli).toMatch(/customer API requests/);
    expect(by.managed_runtime_availability).toMatchObject({ kind: "ratio", category: "availability", target: 0.999 });
    expect(by.managed_runtime_availability.sli).toMatch(/Zenith-hosted \(fully managed\)/);
    expect(by.managed_runtime_availability.sli).toMatch(/supported production configurations/);
    expect(by.managed_runtime_availability.sli).toMatch(/\(BYOC\) workloads are outside/);
    expect(by.api_latency).toMatchObject({ kind: "latency_ratio", target: 0.95, thresholdSeconds: 0.5 });
    expect(by.dispatch_latency).toMatchObject({ kind: "latency_ratio", target: 0.95, thresholdSeconds: 30 });
    expect(by.dispatch_latency.sli).toMatch(/last required approval/);
    expect(by.workflow_completion).toMatchObject({ target: 0.95 });
    expect(by.scheduler_health).toMatchObject({ target: 0.99 });
    expect(by.capacity).toMatchObject({ minRequestsPerSecond: 25, maxP95Ms: 500, maxErrorRate: 0.005 });
    expect(by.rpo).toMatchObject({ kind: "recovery_seconds", maxSeconds: 900 });
    expect(by.rto).toMatchObject({ kind: "recovery_seconds", maxSeconds: 14_400 });
    expect(by.rpo.sli).toMatch(/explicitly covered data/);
    expect(by.rto.sli).toMatch(/explicitly covered data/);
    expect(by.rto.sli).toMatch(/not an allowance/);
  });

  it("states 99.99% as an aspiration that is not an objective", () => {
    expect(defs.nextMilestone).toEqual({ objective: "control_plane_availability", target: 0.9999, status: "aspiration" });
    expect(defs.objectives.some((o) => "target" in o && o.target === 0.9999)).toBe(false);
  });

  it("burn alerts have a short window shorter than the long window", () => {
    for (const a of defs.burnAlerts) expect(a.shortWindow).not.toBe(a.longWindow);
    expect(defs.burnAlerts.map((a) => a.name)).toEqual(["fast", "slow", "ticket"]);
  });
});

describe("the validator accepts the approved file and the old unapproved shape", () => {
  it("accepts the committed file", () => {
    expect(parseSloDefinitions(raw()).approval.status).toBe("approved_targets");
  });

  it("still accepts not_approved with every objective provisional", () => {
    const parsed = parseSloDefinitions(unapproved());
    expect(parsed.approval).toMatchObject({ status: "not_approved", pendingDecision: "DEC-BUSINESS" });
    expect(parsed.objectives.every((o) => o.status === "provisional")).toBe(true);
    expect(sloLabel(parsed)).toBe(PROVISIONAL_LABEL);
  });

  it("accepts a full ISO timestamp as approvedAt", () => {
    const d = clone(raw());
    approval(d).approvedAt = "2026-10-13T09:30:00Z";
    expect(parseSloDefinitions(d).approval).toMatchObject({ approvedAt: "2026-10-13T09:30:00Z" });
  });
});

describe("the validator refuses malformed or over-claiming files", () => {
  it("requires approvedBy, an ISO approvedAt, the DEC-BUSINESS decision and the engineering_target commitment", () => {
    for (const [key, value, message] of [
      ["approvedBy", undefined, /approvedBy/],
      ["approvedBy", "   ", /approvedBy/],
      ["approvedAt", undefined, /approvedAt/],
      ["approvedAt", "13 October", /ISO date/],
      ["approvedAt", "2026-02-30", /calendar date/],
      ["decision", "DEC-OTHER", /DEC-BUSINESS/],
      ["commitment", "contractual_sla", /engineering_target/],
      ["commitment", undefined, /engineering_target/],
    ] as const) {
      const d = clone(raw());
      if (value === undefined) delete approval(d)[key]; else approval(d)[key] = value;
      expect(() => parseSloDefinitions(d), `${key}=${String(value)}`).toThrow(message);
    }
  });

  it("refuses an unknown approval status and an unknown approval field", () => {
    const a = clone(raw());
    approval(a).status = "approved";
    expect(() => parseSloDefinitions(a)).toThrow(SloDefinitionError);
    const b = clone(raw());
    approval(b).credits = "none";
    expect(() => parseSloDefinitions(b)).toThrow(/approval\.credits/);
  });

  it("refuses an unapproved file that carries an approver", () => {
    const d = unapproved();
    approval(d).approvedBy = "someone";
    expect(() => parseSloDefinitions(d)).toThrow(/cannot record an approver/);
  });

  it("refuses mixed files in both directions", () => {
    const a = clone(raw());
    objectives(a)[0].status = "provisional";
    expect(() => parseSloDefinitions(a)).toThrow(/must be "target"/);
    const b = unapproved();
    objectives(b)[0].status = "target";
    expect(() => parseSloDefinitions(b)).toThrow(/must be "provisional"/);
    const c = clone(raw());
    objectives(c)[2].status = "committed";
    expect(() => parseSloDefinitions(c)).toThrow(/status/);
  });

  it("refuses per-objective approval-like fields, in either state", () => {
    for (const key of ["approvedBy", "approver", "signedOff", "owner", "accountableOwner", "ratifiedAt"]) {
      for (const d of [clone(raw()), unapproved()]) {
        objectives(d)[0][key] = "someone";
        expect(() => parseSloDefinitions(d), key).toThrow(/approval field/);
      }
    }
  });

  it("refuses an objective that claims a service credit, a contract or a guarantee", () => {
    for (const phrase of ["Eligible for a service credit when missed.", "A contractual commitment.", "We guarantee this.", "Service-credits apply."]) {
      for (const field of ["sli", "title"]) {
        const d = clone(raw());
        objectives(d)[0][field] = `Requests served. ${phrase}`;
        expect(() => parseSloDefinitions(d), `${field}: ${phrase}`).toThrow(/contractual claim/);
      }
    }
  });

  it("lets the approval note say that a contractual SLA is not offered", () => {
    const d = clone(raw());
    expect(String(approval(d).note)).toMatch(/not a contractual SLA/);
    expect(String(approval(d).note)).toMatch(/no service credits/);
    expect(() => parseSloDefinitions(d)).not.toThrow();
  });

  it("refuses an invalid nextMilestone", () => {
    const variants: [string, (m: Record<string, unknown>) => void, RegExp][] = [
      ["status not aspiration", (m) => { m.status = "target"; }, /aspiration/],
      ["unknown objective", (m) => { m.objective = "nope"; }, /ratio objective/],
      ["a non-ratio objective", (m) => { m.objective = "capacity"; }, /ratio objective/],
      ["not stricter than the target", (m) => { m.target = 0.999; }, /stricter/],
      ["out of range", (m) => { m.target = 1.5; }, /between/],
      ["extra field", (m) => { m.since = "2026"; }, /not allowed/],
    ];
    for (const [name, mutate, message] of variants) {
      const d = clone(raw());
      mutate(d.nextMilestone as Record<string, unknown>);
      expect(() => parseSloDefinitions(d), name).toThrow(message);
    }
    const e = clone(raw());
    e.nextMilestone = "99.99%";
    expect(() => parseSloDefinitions(e)).toThrow(/nextMilestone must be an object/);
  });

  it("refuses unknown fields, out-of-range targets and duplicate ids", () => {
    const b = clone(raw());
    objectives(b)[0].extra = 1;
    expect(() => parseSloDefinitions(b)).toThrow(/not allowed/);
    const c = clone(raw());
    c.approvedAt = "2026-10-01";
    expect(() => parseSloDefinitions(c)).toThrow(/Unknown top-level/);
    const a = clone(raw());
    objectives(a)[0].target = 1.5;
    expect(() => parseSloDefinitions(a)).toThrow(/between/);
    const dup = clone(raw());
    objectives(dup)[1] = { ...objectives(dup)[1], id: objectives(dup)[0].id };
    expect(() => parseSloDefinitions(dup)).toThrow(/Duplicate/);
  });
});
