/** Real-engine lanes fail closed on skipped, missing or malformed evidence. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { reportFailures, requirementsFor } from "./assert-lane-report.mjs";
import { assertionMatches } from "../../scripts/ci/gate-manifest.mjs";

const root = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-ci-engine-report-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

interface Requirement { file: string; suite?: string; test?: string; ancestorSuite?: string; postgres?: boolean }
interface Assertion { fullName: string; title?: string; status: string; ancestorTitles?: string[] }
interface FileResult { name: string; status: string; assertionResults: Assertion[] }

/** Synthetic execution reports exercise the gate, never claim engine execution. */
function evidence(requirements: Requirement[]) {
  const files = new Map<string, FileResult>();
  for (const required of requirements) {
    const name = path.resolve(root, required.file);
    const file = files.get(name) ?? { name, status: "passed", assertionResults: [] };
    const ancestors = [required.file, ...(required.ancestorSuite ? [required.ancestorSuite] : []), ...(required.suite ? [required.suite] : [])];
    const title = required.test ?? "passed";
    file.assertionResults.push({ fullName: `${required.ancestorSuite ? `${required.ancestorSuite} ` : ""}${required.suite ?? (required.postgres ? "contract [postgres]" : "scenario")} ${title}`, title, ancestorTitles: ancestors, status: "passed" });
    files.set(name, file);
  }
  return { success: true, testResults: [...files.values()] };
}

describe.each(["postgres", "policy", "tofu", "workflows", "platform-postgres"])("%s real-engine report gate", (lane) => {
  const requirements = requirementsFor(lane, root);

  it("accepts evidence only when every required scenario passed", () => {
    expect(requirements.length).toBeGreaterThan(0);
    expect(reportFailures(requirements, evidence(requirements), root)).toEqual([]);
  });

  it.each(["skipped", "pending", "todo", "failed", "unknown"])("rejects a %s required scenario even alongside passed unit tests", (status) => {
    const report = evidence(requirements);
    report.testResults[0].assertionResults[0].status = status;
    report.testResults[0].assertionResults.push({ fullName: "unrelated unit test", status: "passed" });
    expect(reportFailures(requirements, report, root).length).toBeGreaterThan(0);
  });

  it("rejects a file omitted by an incorrect Vitest path filter", () => {
    const report = evidence(requirements);
    report.testResults.shift();
    expect(reportFailures(requirements, report, root).length).toBeGreaterThan(0);
  });

  it("rejects duplicate file evidence and files with failed hooks", () => {
    const report = evidence(requirements);
    report.testResults[0].status = "failed";
    expect(reportFailures(requirements, report, root).length).toBeGreaterThan(0);
    report.testResults[0].status = "passed";
    report.testResults.push(report.testResults[0]);
    expect(reportFailures(requirements, report, root).length).toBeGreaterThan(0);
  });

  it("rejects an empty assertion list", () => {
    const report = evidence(requirements);
    report.testResults[0].assertionResults = [];
    expect(reportFailures(requirements, report, root).length).toBeGreaterThan(0);
  });

  it("normalizes Windows and POSIX path separators", () => {
    const report = evidence(requirements);
    for (const file of report.testResults) file.name = file.name.replaceAll("/", "\\");
    expect(reportFailures(requirements, report, root)).toEqual([]);
  });
});

describe("evidence boundaries", () => {
  it.each(["missing title", "different title", "skipped", "omitted"])("rejects every exact PostgreSQL case with %s even when its suite and display name match", (failure) => {
    const requirements = requirementsFor("platform-postgres", root).filter((required: Requirement) => required.test !== undefined);
    expect(requirements.length).toBeGreaterThan(0);
    for (const required of requirements) {
      const report = evidence([required]);
      const assertion = report.testResults[0].assertionResults[0];
      if (failure === "missing title") delete assertion.title;
      else if (failure === "different title") assertion.title = "unrelated case";
      else if (failure === "skipped") assertion.status = "skipped";
      else report.testResults[0].assertionResults = [];
      expect(reportFailures([required], report, root), `${required.file}: ${required.test}`).toHaveLength(1);
    }
  });

  it.each(requirementsFor("tofu", root).filter((required: Requirement) => required.suite))("rejects skipped $file: $suite even when the other required suites and unit tests pass", (required) => {
    const requirements = requirementsFor("tofu", root);
    const report = evidence(requirements);
    const file = report.testResults.find((entry) => entry.name === path.resolve(root, required.file))!;
    const assertion = file.assertionResults.find((entry) => entry.ancestorTitles?.includes(required.suite!))!;
    assertion.status = "skipped";
    file.assertionResults.push({ fullName: "unrelated unit test", ancestorTitles: [required.file, "unit contracts"], status: "passed" });
    expect(reportFailures(requirements, report, root)).toEqual([`${required.file}: ${required.suite}: required scenarios did not all pass`]);
  });

  it.each([undefined, null, {}, { testResults: [] }, { success: false, testResults: [] }])("rejects malformed or unsuccessful reports: %j", (report) => {
    expect(reportFailures([{ file: "tests/platform/deploy-e2e.test.ts" }], report, root).length).toBeGreaterThan(0);
  });

  it("rejects a report with no requirements", () => {
    expect(reportFailures([], { success: true, testResults: [] }, root)).toEqual(["No required scenarios found"]);
  });

  it("does not let local activity tests stand in for skipped platform Temporal e2e", () => {
    const requirements = [{ file: "tests/platform/deploy-e2e.test.ts" }];
    const report = evidence(requirements);
    report.testResults[0].assertionResults = [
      { fullName: "composed deploy workflow (contract evidence) deploys", status: "skipped" },
      { fullName: "composed activities against local stores (no Temporal fallback) deploys", status: "passed" },
    ];
    expect(reportFailures(requirements, report, root)).toHaveLength(1);
  });

  it.each(["pglite", "memory"])("does not let %s count as Postgres evidence", (backend) => {
    const requirements = requirementsFor("platform-postgres", root).filter((required: Requirement) => required.postgres);
    const report = evidence(requirements);
    for (const file of report.testResults) {
      for (const assertion of file.assertionResults) {
        assertion.fullName = assertion.fullName.replace(/\[postgres\]/g, `[${backend}]`).replace(/\(postgres\)/g, `(${backend})`).replace(/\bon postgres$/g, `on ${backend}`);
        assertion.ancestorTitles = assertion.ancestorTitles?.map((title) => title.replace(/\[postgres\]/g, `[${backend}]`).replace(/\(postgres\)/g, `(${backend})`).replace(/\bon postgres$/g, `on ${backend}`));
      }
    }
    expect(reportFailures(requirements, report, root)).toHaveLength(requirements.length);
  });

  it("does not accept a similarly named suite or a file from another checkout", () => {
    const requirements = [{ file: "tests/tofu/network.test.ts", suite: "real provider" }];
    const report = evidence(requirements);
    report.testResults[0].assertionResults[0].fullName = "unrelated real provider passed";
    report.testResults[0].assertionResults[0].ancestorTitles = ["unrelated real provider"];
    expect(reportFailures(requirements, report, root)).toHaveLength(1);
    report.testResults[0].name = path.join(scratch, "tests/tofu/network.test.ts");
    expect(reportFailures(requirements, report, root)).toHaveLength(1);
  });

  it("rejects unknown lanes", () => {
    expect(() => requirementsFor("unknown", root)).toThrow("Unknown CI lane");
  });

  it("CLI returns nonzero for unreadable and invalid reports without printing their contents", () => {
    const invalid = path.join(scratch, "invalid.json");
    fs.writeFileSync(invalid, "untrusted-report-payload");
    // Explicit process environment; no credentials or unrelated application env.
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      ...Object.fromEntries(["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]])),
    };
    for (const report of [path.join(scratch, "missing.json"), invalid]) {
      const child = spawnSync(process.execPath, [path.resolve("tests/ci/assert-lane-report.mjs"), "tofu", report], { env, encoding: "utf8" });
      expect(child.status).toBe(1);
      expect(child.stderr).toContain("Cannot verify required scenarios");
      expect(child.stderr).not.toContain("untrusted-report-payload");
    }
    const unknown = spawnSync(process.execPath, [path.resolve("tests/ci/assert-lane-report.mjs"), "unknown", invalid], { env, encoding: "utf8" });
    expect(unknown.status).toBe(2);
  });
});


describe("registered PostgreSQL backend ancestry", () => {
  it.each(["external effect ledger (postgres)", "coding_agent_runs on postgres", "contract [postgres]"])("accepts complete trusted suite %s", suite => {
    expect(assertionMatches({ file: "tests/fixture.test.ts", suite, postgres: true }, { title: "case", fullName: `${suite} case`, ancestorTitles: [suite] })).toBe(true);
  });
  it.each(["external effect ledger (pglite)", "coding_agent_runs on pglite", "contract ['postgres]", "contract [postgres']", "contract on postgresql", "contract (postgres) injected"])("rejects ambiguous or non-PostgreSQL backend %s", suite => {
    expect(assertionMatches({ file: "tests/fixture.test.ts", suite, postgres: true }, { title: "case", fullName: `${suite} case`, ancestorTitles: [suite] })).toBe(false);
  });
  it("rejects a title-only backend claim and foreign suite ancestry", () => {
    const required = { file: "tests/fixture.test.ts", suite: "external effect ledger (postgres)", postgres: true };
    expect(assertionMatches(required, { title: "case (postgres)", fullName: "external effect ledger (postgres) case", ancestorTitles: ["external effect ledger (pglite)"] })).toBe(false);
    expect(assertionMatches(required, { title: "external effect ledger (postgres)", fullName: "external effect ledger (postgres)" })).toBe(false);
  });
});
