import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { SCENARIOS, parseScenarioList } from "../../scripts/acceptance/scenarios";
import { describeScenario } from "../../scripts/acceptance/runner";
import { SCENARIO_IDS } from "../../scripts/acceptance/types";
import { loadLiveConfig } from "../../scripts/acceptance/config";
import { context } from "./_helpers";

describe("complete, honest A–J catalogue", () => {
  it("includes A–J and preserves strict selection order", () => { expect(Object.keys(SCENARIOS)).toEqual([...SCENARIO_IDS]); expect(parseScenarioList("J,A,B")).toEqual(["J", "A", "B"]); for (const value of ["K", "A,A", "a", "A,", ""]) expect(() => parseScenarioList(value)).toThrow(); expect(SCENARIOS.J.runsLocally).toBe(true); });
  it.each(SCENARIO_IDS)("%s declares criteria, limits and exact dry-run actions without network", async (id) => {
    const c = await context("dry_run"); const d = SCENARIOS[id]; const config = loadLiveConfig({});
    expect(d.passCriteria.length).toBeGreaterThan(0); expect(new Set(d.passCriteria.map((p) => p.id)).size).toBe(d.passCriteria.length); expect(d.passCriteria.every((p) => !!p.text.trim())).toBe(true); expect(d.proves.length).toBeGreaterThan(0); expect(d.cannotProve.length).toBeGreaterThan(0); expect(Array.isArray(d.blockedOn)).toBe(true);
    const fetch = vi.fn(() => { throw new Error("network forbidden"); }); vi.stubGlobal("fetch", fetch);
    try { const r = await describeScenario(d, { plan: { runId: c.runId, config }, env: {}, config, earlier: [], inRun: [id] }, c.evidence); expect(r.steps.every((s) => s.actions.length > 0 && s.actions.every((a) => !!a.trim()))).toBe(true); expect(fetch).not.toHaveBeenCalled(); expect(c.evidence.checksFor(id)).toHaveLength(d.passCriteria.length); expect(c.evidence.checksFor(id).every((p) => p.status === "skipped")).toBe(true); }
    finally { vi.unstubAllGlobals(); }
  });
  it("all literal checker ids in scenario sources are declared", async () => {
    const names = ["a-autonomous-deploy", "b-incident-diagnosis", "c-approved-remediation", "d-drift", "e-restart-recovery", "f-credential-revocation", "g-kubernetes-deploy", "h-mcp", "i-managed-provider", "j-multicloud-planning"];
    for (let i = 0; i < names.length; i++) {
      const source = await readFile(`scripts/acceptance/scenarios/${names[i]}.ts`, "utf8"); const declared = new Set(SCENARIOS[SCENARIO_IDS[i]!].passCriteria.map((p) => p.id));
      for (const match of source.matchAll(/C\.(?:pass|fail|expect|skip)\(\s*ctx,\s*"([^"]+)"/g)) expect(declared.has(match[1]!)).toBe(true);
    }
  });
});
