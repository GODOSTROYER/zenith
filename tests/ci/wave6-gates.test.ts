import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WAVE6, commandsForRequirement, wave6Manifest } from "../../scripts/ci/wave6-gates.mjs";
import { manifestFor } from "../../scripts/ci/gate-manifest.mjs";
import { reportFailures } from "./assert-lane-report.mjs";

describe("closed Wave 6 integration registry", () => {
  it("keeps each assembled test and requirement registered exactly once", () => {
    expect(new Set(WAVE6.files).size).toBe(WAVE6.files.length);
    expect(new Set(WAVE6.gatedCases.map((item: { id: string }) => item.id)).size).toBe(WAVE6.gatedCases.length);
    for (const file of WAVE6.files) expect(fs.existsSync(file), file).toBe(true);
    const ledger = JSON.parse(fs.readFileSync("docs/build/production/ledger.json", "utf8"));
    for (const row of ledger.requirements.filter((item: { implementationStatus: string }) => item.implementationStatus === "implementation_complete_verification_pending")) {
      const plan = commandsForRequirement(row.id);
      expect(plan.status).toBe("implementation_complete_verification_pending");
      expect(plan.commands.length, row.id).toBeGreaterThan(0);
    }
  });
  it("exposes owner-run lanes through the canonical manifest without enabling credentials or gates", () => {
    for (const lane of new Set(WAVE6.gatedCases.map((item: { lane: string }) => item.lane))) {
      expect(manifestFor(`wave6-${lane}`).requirements).toEqual(wave6Manifest(`wave6-${lane}`).requirements);
      expect(manifestFor(`wave6-${lane}`).env).toEqual({});
    }
  });
  it("rejects missing, skipped, failed and wrong-title evidence for every gated identity", () => {
    for (const item of WAVE6.gatedCases) {
      const accepted = { success: true, testResults: [{ name: path.resolve(item.file), status: "passed", assertionResults: [{ fullName: item.fullName, title: item.test, ancestorTitles: [item.ancestorSuite, item.suite].filter(Boolean), status: "passed" }] }] };
      expect(reportFailures([item], accepted, process.cwd()), item.id).toEqual([]);
      const wrongTitle = structuredClone(accepted); wrongTitle.testResults[0].assertionResults[0].title += " unrelated";
      expect(reportFailures([item], wrongTitle, process.cwd())).toHaveLength(1);
      for (const status of ["skipped", "pending", "failed"]) {
        const report = { success: true, testResults: [{ name: path.resolve(item.file), status: "passed", assertionResults: [{ fullName: item.fullName, title: item.test, ancestorTitles: [item.suite], status }] }] };
        expect(reportFailures([item], report, process.cwd()).length, item.id).toBeGreaterThan(0);
      }
      expect(reportFailures([item], { success: true, testResults: [] }, process.cwd())).toHaveLength(1);
    }
  });
});
