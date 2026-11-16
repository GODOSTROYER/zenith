/**
 * PROD-REL-01: the end-to-end acceptance scenario map. Contract level: it checks the map itself (every required scenario
 * is present, every mapped file exists, every live lane names a scope harness the manifest grants), not that any lane passed.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkScenarios, gateName, missingGates } from "../../scripts/release/acceptance-orchestrator";
import { REQUIRED_SCENARIO_IDS, SCENARIOS, allLaneFiles, type LiveLane } from "../../scripts/release/scenarios";
import { loadManifestFile } from "../../scripts/release/scope";
import { shippedManifestPath } from "./_support";

const root = process.cwd();
const liveLanes = SCENARIOS.flatMap((s) => s.lanes.filter((l): l is LiveLane => l.kind === "live_sandbox"));

describe("the scenario map", () => {
  it("lists every scenario the release requires", () => {
    const ids = SCENARIOS.map((s) => s.id);
    for (const required of REQUIRED_SCENARIO_IDS) expect(ids, required).toContain(required);
    expect(REQUIRED_SCENARIO_IDS).toEqual(expect.arrayContaining(["install", "private-source", "plan-approval", "dns-tls", "stateful-traffic", "update-rollback", "machine-schedules", "drift-repair", "revocation", "crash-partition", "rotation", "upgrade", "restore", "two-tenants", "export", "teardown"]));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("maps only to files that exist and checks clean", () => {
    expect(allLaneFiles().filter((f) => !existsSync(path.join(root, f)))).toEqual([]);
    expect(checkScenarios(root)).toEqual([]);
  });

  it("reports a missing file or a missing required scenario", () => {
    const broken = [{ ...SCENARIOS[0]!, lanes: [{ id: "x", kind: "contract" as const, files: ["tests/does/not/exist.test.ts"] }] }];
    const problems = checkScenarios(root, broken);
    expect(problems.some((p) => p.includes("tests/does/not/exist.test.ts"))).toBe(true);
    expect(problems.some((p) => p.includes('required scenario "teardown" is missing'))).toBe(true);
  });

  it("gives every scenario at least one local lane and ties each live lane to a granted scope harness", () => {
    const manifest = loadManifestFile(shippedManifestPath());
    for (const s of SCENARIOS) expect(s.lanes.some((l) => l.kind !== "live_sandbox"), s.id).toBe(true);
    for (const lane of liveLanes) {
      const grant = manifest.harnesses[lane.scopeHarness];
      expect(grant, `${lane.id} -> ${lane.scopeHarness}`).toBeDefined();
      expect(lane.gates.length, lane.id).toBeGreaterThan(0);
      expect(lane.deferredBecause.length, lane.id).toBeGreaterThan(10);
      for (const file of lane.files) expect(existsSync(path.join(root, file)), file).toBe(true);
    }
  });

  it("covers every ledger requirement this work owns", () => {
    const covered = new Set(SCENARIOS.flatMap((s) => s.requirements));
    for (const id of ["PROD-MIX-05", "PROD-MIX-06", "PROD-MIX-07", "PROD-REL-01", "PROD-REL-02", "PROD-REL-04"]) expect(covered, id).toContain(id);
  });

  it("the new live harness commands point at files that exist and the live lanes never run on their own", () => {
    for (const file of ["scripts/acceptance/mixed/live-run.ts", "scripts/acceptance/mixed/live-recovery.ts", "tests/live/mixed-connectivity.live.test.ts"]) expect(existsSync(path.join(root, file)), file).toBe(true);
    const source = readFileSync(path.join(root, "scripts/release/acceptance-orchestrator.ts"), "utf8");
    expect(source).toContain("includeLive");
  });
});

describe("gates", () => {
  it("parses gate names and values and ignores annotations", () => {
    expect(gateName("ZENITH_LIVE_MIXED=1")).toEqual({ name: "ZENITH_LIVE_MIXED", value: "1" });
    expect(gateName("ZENITH_LIVE_MIXED_API_URL")).toEqual({ name: "ZENITH_LIVE_MIXED_API_URL" });
    const lane = liveLanes.find((l) => l.id === "mixed-traffic-live")!;
    expect(missingGates(lane, {})).toContain("ZENITH_LIVE_MIXED=1");
    expect(missingGates(lane, { ZENITH_LIVE_MIXED: "true" })).toContain("ZENITH_LIVE_MIXED=1");
    const aws = liveLanes.find((l) => l.id === "aws-live-a")!;
    expect(missingGates(aws, {}).some((g) => g.includes("("))).toBe(false);
  });
});
