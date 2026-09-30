/**
 * The decision table, evaluated through the real committed wasm.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadPolicyEngine, type PolicyEngine } from "@/lib/policy";
import { SCENARIOS } from "./scenarios";
import { policyInput } from "./support";

let engine: PolicyEngine;

beforeAll(async () => {
  engine = await loadPolicyEngine();
});

describe("policy decision table", () => {
  it("has at least 30 scenarios with unique names", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(30);
    expect(new Set(SCENARIOS.map((s) => s.name)).size).toBe(SCENARIOS.length);
  });

  it.each(SCENARIOS.map((s) => [s.name, s] as const))("%s", async (_name, scenario) => {
    const result = await engine.evaluate(policyInput(scenario.capability, scenario.patch, scenario.workspace));
    const { decision } = result;

    expect(decision.outcome).toBe(scenario.outcome);
    expect(decision.reasons.map((r) => r.code).sort()).toEqual([...scenario.codes].sort());
    expect(decision.approval).toEqual(scenario.approval);
    expect(decision.constraints).toEqual(scenario.constraints);

    // Every reason names the rule that produced it and carries readable text.
    for (const reason of decision.reasons) {
      expect(reason.rule).toMatch(/^zenith\.(rules\.(deny|approval)\.[a-z_]+|decision\.allow)$/);
      expect(reason.message.length).toBeGreaterThan(10);
    }
    expect(decision.reasons.map((r) => r.code)).toEqual([...decision.reasons.map((r) => r.code)].sort());
  });
});
