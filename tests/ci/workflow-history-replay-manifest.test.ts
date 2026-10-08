/** Activation and strict-report models only; never recorded Temporal history evidence. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { manifestFor, requirementsFor, workflowHistoryReplayStatus } from "../../scripts/ci/gate-manifest.mjs";
import { reportFailures } from "./assert-lane-report.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-replay-manifest-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const fixtureDirectory = path.join(root, "tests/fixtures/workflow-histories");
describe("workflow-history replay manifest", () => {
  it("is wired but not required before fixtures; an explicit invocation always selects the failing replay lane", () => {
    const manifest = manifestFor("workflow-history-replay", root);
    expect(manifest.required).toBe(false);
    expect(manifest.activationReason).toContain("needs replay:record");
    expect(manifest.env).toEqual({ ZENITH_REPLAY_LANE: "1" });
    expect(manifest.command).toContain("tests/workflows/history-replay.test.ts");
    expect(manifest.command).toContain("--maxWorkers=1");
    expect(manifest.command).not.toContain("tests/workflows/history-record.test.ts");
    expect(manifest.requirements).toHaveLength(10);
    expect(reportFailures(manifest.requirements, { success: true, testResults: [] }, root)).toHaveLength(10);
  });
  it("activates even for partial or malformed fixtures so they cannot silently disable the gate", () => {
    fs.mkdirSync(fixtureDirectory, { recursive: true });
    fs.writeFileSync(path.join(fixtureDirectory, "MANIFEST.json"), "malformed fixture model");
    expect(workflowHistoryReplayStatus(root).required).toBe(true);
    expect(manifestFor("workflow-history-replay", root).required).toBe(true);
    fs.rmSync(path.join(fixtureDirectory, "MANIFEST.json"));
    fs.writeFileSync(path.join(fixtureDirectory, "partial.json"), "{}");
    expect(workflowHistoryReplayStatus(root).required).toBe(true);
  });
  it("cannot disable replay by deleting the entire previously committed fixture directory", () => {
    const deleted = path.join(root, "deleted-fixture-model");
    expect(workflowHistoryReplayStatus(deleted, () => ["tests/fixtures/workflow-histories/MANIFEST.json"]).required).toBe(true);
    expect(workflowHistoryReplayStatus(deleted, () => []).required).toBe(false);
    expect(() => workflowHistoryReplayStatus(deleted, () => { throw new Error("Git inventory unavailable"); })).toThrow("unavailable");
  });
  it("requires every integrity/coverage assertion, actual replay and both negative nondeterminism controls", () => {
    const requirements = requirementsFor("workflow-history-replay", root);
    const files = [...new Set(requirements.map(required => required.file))];
    const report = { success: true, testResults: files.map(file => ({ name: path.join(root, file), status: "passed", assertionResults: requirements.filter(required => required.file === file).map(required => ({ title: required.test ?? "model passing case", fullName: `${required.suite ?? "audit"} ${required.test ?? "model passing case"}`, ancestorTitles: required.suite ? [required.suite] : [], status: "passed" })) })) };
    expect(reportFailures(requirements, report, root)).toEqual([]);
    for (const status of ["skipped", "pending", "failed"]) {
      const changed = structuredClone(report); changed.testResults[0].assertionResults[0].status = status;
      expect(reportFailures(requirements, changed, root).length).toBeGreaterThan(0);
    }
    const missingReplay = structuredClone(report);
    missingReplay.testResults[0].assertionResults = missingReplay.testResults[0].assertionResults.filter(assertion => !assertion.ancestorTitles.includes("committed workflow histories replay against the current bundle"));
    expect(reportFailures(requirements, missingReplay, root)).toHaveLength(1);
  });
});
