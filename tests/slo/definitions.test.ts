/**
 * PROD-OPS-01: the SLO definition file is versioned, every target is provisional, and nothing in the file or its
 * validator can express an accountable approval.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSloDefinitions, PROVISIONAL_LABEL, SloDefinitionError, sloDefinitions } from "@/lib/slo/definitions";

const FILE = path.resolve(__dirname, "../../deploy/slo/slo-definitions.json");
const raw = (): Record<string, unknown> => JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown>;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("committed definitions", () => {
  const defs = sloDefinitions();

  it("parses, is versioned, and states that approval is pending", () => {
    expect(defs.definitionVersion).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(defs.approval).toMatchObject({ status: "not_approved", pendingDecision: "DEC-BUSINESS" });
    expect(PROVISIONAL_LABEL).toBe("Provisional, not approved");
  });

  it("labels every target provisional and gives none an approver", () => {
    expect(defs.objectives.length).toBeGreaterThanOrEqual(8);
    for (const o of defs.objectives) expect(o.status, o.id).toBe("provisional");
    const text = readFileSync(FILE, "utf8");
    expect(text).not.toMatch(/"(approvedBy|approver|approvedAt|signedOffBy|owner)"/i);
  });

  it("carries the provisional defaults the requirement names", () => {
    const by = Object.fromEntries(defs.objectives.map((o) => [o.id, o]));
    expect(by.control_plane_availability).toMatchObject({ kind: "ratio", target: 0.995 });
    expect(by.api_latency).toMatchObject({ kind: "latency_ratio", target: 0.95, thresholdSeconds: 0.5 });
    expect(by.rpo).toMatchObject({ kind: "recovery_seconds", maxSeconds: 900 });
    expect(by.rto).toMatchObject({ kind: "recovery_seconds", maxSeconds: 14_400 });
    for (const id of ["dispatch_latency", "workflow_completion", "scheduler_health", "capacity"]) expect(by[id], id).toBeDefined();
  });

  it("burn alerts have a short window shorter than the long window", () => {
    for (const a of defs.burnAlerts) expect(a.shortWindow).not.toBe(a.longWindow);
    expect(defs.burnAlerts.map((a) => a.name)).toEqual(["fast", "slow", "ticket"]);
  });
});

describe("the validator refuses an approved-looking file", () => {
  it("refuses approval.status other than not_approved", () => {
    const d = clone(raw());
    (d.approval as Record<string, unknown>).status = "approved";
    expect(() => parseSloDefinitions(d)).toThrow(SloDefinitionError);
  });

  it("refuses an approver field on the approval block or on an objective", () => {
    const a = clone(raw());
    (a.approval as Record<string, unknown>).approvedBy = "someone";
    expect(() => parseSloDefinitions(a)).toThrow(/cannot record an approver/);
    for (const key of ["approvedBy", "approver", "signedOff", "owner"]) {
      const d = clone(raw());
      (d.objectives as Record<string, unknown>[])[0][key] = "someone";
      expect(() => parseSloDefinitions(d), key).toThrow(/approval field/);
    }
  });

  it("refuses a target that is not provisional, and unknown fields", () => {
    const a = clone(raw());
    (a.objectives as Record<string, unknown>[])[0].status = "committed";
    expect(() => parseSloDefinitions(a)).toThrow(/provisional/);
    const b = clone(raw());
    (b.objectives as Record<string, unknown>[])[0].extra = 1;
    expect(() => parseSloDefinitions(b)).toThrow(/not allowed/);
    const c = clone(raw());
    c.approvedAt = "2026-10-01";
    expect(() => parseSloDefinitions(c)).toThrow(/Unknown top-level/);
  });

  it("refuses out-of-range targets and duplicate ids", () => {
    const a = clone(raw());
    (a.objectives as Record<string, unknown>[])[0].target = 1.5;
    expect(() => parseSloDefinitions(a)).toThrow(/between/);
    const b = clone(raw());
    const objectives = b.objectives as Record<string, unknown>[];
    objectives[1] = { ...objectives[1], id: objectives[0].id };
    expect(() => parseSloDefinitions(b)).toThrow(/Duplicate/);
  });
});
