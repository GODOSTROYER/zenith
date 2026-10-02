/** Synthetic reports test sanitization; they are never engine acceptance evidence. */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { countsFor, ENVIRONMENT_FINGERPRINT_EXCLUSIONS, main as sanitizeMain, preserveExecutionObservation, provenanceFor, sanitizedEvidence } from "../../scripts/ci/sanitize-evidence.mjs";
import { requirementsFor } from "../../scripts/ci/gate-manifest.mjs";
import { validateGate } from "../../scripts/ci/run-gate.mjs";
import { reportFailures } from "./assert-lane-report.mjs";

const root = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-sanitized-evidence-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

function reportFor(lane = "platform-postgres") {
  const files = new Map<string, { name: string; status: string; assertionResults: { fullName: string; ancestorTitles: string[]; status: string; failureMessages?: string[] }[] }>();
  for (const required of requirementsFor(lane, root)) {
    const name = path.resolve(root, required.file);
    const file = files.get(name) ?? { name, status: "passed", assertionResults: [] };
    file.assertionResults.push({ fullName: `${required.suite ?? "required scenario"} passes`, ancestorTitles: [required.suite ?? "required scenario"], status: "passed" });
    files.set(name, file);
  }
  return { success: true, testResults: [...files.values()] };
}

const provenance = provenanceFor(root, { NODE_ENV: "test", GATE_INPUT: "public contract" });

describe("sanitized evidence boundary", () => {
  it("exports count-only requirement evidence bound to commit, dependencies, source and environment", () => {
    const evidence = sanitizedEvidence("platform-postgres", reportFor(), root, provenance);
    expect(evidence.verdict).toBe("passed");
    expect(evidence.required).toHaveLength(39);
    expect(evidence.provenance.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(evidence.provenance.sourceBindingComplete).toBe(true);
    expect(evidence.provenance.environment.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.provenance.lockfileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.provenance.dependencies).toContainEqual(expect.objectContaining({ name: "vitest", installed: expect.stringMatching(/^\d+\.\d+\.\d+/) }));
    expect(evidence.required[0]).not.toHaveProperty("suite");
    expect(evidence.required[0]).not.toHaveProperty("fullName");
  });

  it("never copies provider-format keys from failure messages, full names, arbitrary file paths or environment values", () => {
    // Provider-looking values exist only in memory at runtime.
    const secret = ["AK", "IA"].join("") + randomBytes(8).toString("hex").toUpperCase();
    const sourceSecret = ["gh", "p_"].join("") + randomBytes(20).toString("hex");
    const report = reportFor();
    report.testResults[0].assertionResults[0].fullName += `\n${secret} ${sourceSecret}`;
    report.testResults[0].assertionResults[0].failureMessages = [`leaked ${secret} ${sourceSecret}`];
    report.testResults[0].assertionResults[0].status = "failed";
    report.testResults.push({ name: `/untrusted/${secret}/${sourceSecret}.test.ts`, status: "failed", assertionResults: [{ fullName: secret, ancestorTitles: [sourceSecret], status: "failed", failureMessages: [secret] }] });
    const binding = provenanceFor(root, { API_KEY: secret, SOURCE_TOKEN: sourceSecret });
    const evidence = sanitizedEvidence("platform-postgres", report, root, binding);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(sourceSecret);
    expect(serialized).not.toContain("failureMessages");
    expect(serialized).not.toContain("API_KEY");
    expect(evidence.verdict).toBe("failed");
    expect(evidence.required.every((required: { status: string }) => required.status === "unverified")).toBe(true);
  });

  it("changes provenance digests when reports or environment inputs differ", () => {
    const report = reportFor();
    const first = sanitizedEvidence("platform-postgres", report, root, provenanceFor(root, { INPUT: "first" }));
    const second = sanitizedEvidence("platform-postgres", report, root, provenanceFor(root, { INPUT: "second" }));
    expect(first.provenance.environment.sha256).not.toBe(second.provenance.environment.sha256);
    report.testResults[0].assertionResults[0].status = "pending";
    expect(sanitizedEvidence("platform-postgres", report, root, provenance).reportSha256).not.toBe(first.reportSha256);
  });

  it("keeps genuinely external acceptance unverified alongside a passed ordinary gate", () => {
    const evidence = sanitizedEvidence("workflows", reportFor("workflows"), root, provenance);
    expect(evidence.verdict).toBe("passed");
    expect(evidence.externalAcceptance).toEqual([expect.objectContaining({ id: "external-temporal-mtls", status: "unverified", releaseBlocker: expect.stringContaining("unverified") })]);
  });

  it("does not trust summary totals from a malformed report", () => {
    const report = { ...reportFor(), numTotalTests: 99999, numPassedTests: 99999 };
    const evidence = sanitizedEvidence("platform-postgres", report, root, provenance);
    expect(evidence.verdict).toBe("failed");
    expect(evidence.counts.total).toBe(39);
    expect(evidence.counts.passed).toBe(39);
  });

  it("binds untracked source bytes and explicitly identifies a dirty worktree", () => {
    const checkout = fs.mkdtempSync(path.join(scratch, "untracked-checkout-"));
    expect(spawnSync("git", ["init", "--quiet", checkout]).status).toBe(0);
    fs.writeFileSync(path.join(checkout, "untracked-source.ts"), "first source revision");
    const first = provenanceFor(checkout, {});
    fs.writeFileSync(path.join(checkout, "untracked-source.ts"), "second source revision");
    const second = provenanceFor(checkout, {});
    expect(first.worktreeDirty).toBe(true);
    expect(second.worktreeDirty).toBe(true);
    expect(first.untrackedContentSha256).not.toBe(second.untrackedContentSha256);
    expect(first.sourceBindingComplete).toBe(false); // No commit in this synthetic checkout.
  });

  it("preserves a failed command observation when a later validation sees passing assertions", () => {
    const input = path.join(scratch, "execution-failed-report.json");
    const output = path.join(scratch, "execution-failed-evidence.json");
    fs.writeFileSync(input, JSON.stringify(reportFor()));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(validateGate("platform-postgres", input, output, root, 1)).toBe(1);
      expect(validateGate("platform-postgres", input, output, root)).toBe(1);
      expect(sanitizeMain(["platform-postgres", input, output])).toBe(1);
      expect(validateGate("platform-postgres", input, output, root)).toBe(1);
      expect(JSON.parse(fs.readFileSync(output, "utf8"))).toMatchObject({ verdict: "failed", execution: { exitCode: 1, observed: true } });
      // A newly observed successful command supersedes the previous attempt.
      expect(validateGate("platform-postgres", input, output, root, 0)).toBe(0);
      expect(JSON.parse(fs.readFileSync(output, "utf8"))).toMatchObject({ verdict: "passed", execution: { exitCode: 0, observed: true } });
    } finally { error.mockRestore(); log.mockRestore(); }
  });

  it("preserves a failed invocation across changed GitHub step output handles in both evidence writers", () => {
    const input = path.join(scratch, "step-transition-report.json");
    const output = path.join(scratch, "step-transition-evidence.json");
    fs.writeFileSync(input, JSON.stringify(reportFor()));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const name of ENVIRONMENT_FINGERPRINT_EXCLUSIONS) vi.stubEnv(name, path.join(scratch, "execution-" + name));
      expect(validateGate("platform-postgres", input, output, root, 1)).toBe(1);
      const executed = JSON.parse(fs.readFileSync(output, "utf8"));
      for (const name of ENVIRONMENT_FINGERPRINT_EXCLUSIONS) vi.stubEnv(name, path.join(scratch, "validation-" + name));
      expect(validateGate("platform-postgres", input, output, root)).toBe(1);
      expect(sanitizeMain(["platform-postgres", input, output])).toBe(1);
      const validated = JSON.parse(fs.readFileSync(output, "utf8"));
      expect(validated).toMatchObject({ verdict: "failed", execution: { exitCode: 1, observed: true } });
      expect(validated.provenance.environment.sha256).toBe(executed.provenance.environment.sha256);
      expect(validated.provenance.environment.excludedKeys).toEqual(["GITHUB_ACTION", "GITHUB_ENV", "GITHUB_PATH", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY", "GITHUB_STATE"]);
    } finally { vi.unstubAllEnvs(); error.mockRestore(); log.mockRestore(); }
  });

  it.each(["ZENITH_TEST_PLATFORM_PG_URL", "API_KEY", "PATH", "GITHUB_SHA", "GITHUB_REPOSITORY", "GITHUB_REF", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"])("retains the real %s execution input in environment binding", (name) => {
    const first = provenanceFor(root, { [name]: "first-input" });
    const second = provenanceFor(root, { [name]: "second-input" });
    const candidate = sanitizedEvidence("platform-postgres", reportFor(), root, second);
    const previous = { ...sanitizedEvidence("platform-postgres", reportFor(), root, first), execution: { exitCode: 1, observed: true } };
    expect(first.environment.sha256).not.toBe(second.environment.sha256);
    expect(preserveExecutionObservation(candidate, previous)).toBeUndefined();
    expect(candidate.execution).toEqual({ exitCode: null, observed: false });
  });

  it.each(["report", "manifest", "tracked-source", "untracked-source", "environment", "installed-version", "locked-version"])("does not reuse a prior failed invocation when the %s binding changed", (binding) => {
    const baseline = sanitizedEvidence("platform-postgres", reportFor(), root, provenance);
    const previous = { ...structuredClone(baseline), execution: { exitCode: 1, observed: true } };
    const candidate = structuredClone(baseline);
    switch (binding) {
      case "report": candidate.reportSha256 = "different-report"; break;
      case "manifest": candidate.manifestSha256 = "different-manifest"; break;
      case "tracked-source": candidate.provenance.trackedChangesSha256 = "different-source"; break;
      case "untracked-source": candidate.provenance.untrackedContentSha256 = "different-untracked-source"; break;
      case "environment": candidate.provenance.environment.sha256 = "different-environment"; break;
      case "installed-version": candidate.provenance.dependencies[0].installed = "0.0.1"; break;
      case "locked-version": candidate.provenance.dependencies[0].locked = "0.0.1"; break;
    }
    expect(preserveExecutionObservation(candidate, previous)).toBeUndefined();
    expect(candidate.execution).toEqual({ exitCode: null, observed: false });
    expect(candidate.verdict).toBe("passed");
  });

  it("reports installed and locked versions independently instead of treating expectations as measurements", () => {
    const checkout = fs.mkdtempSync(path.join(scratch, "dependency-versions-"));
    fs.mkdirSync(path.join(checkout, "node_modules/vitest"), { recursive: true });
    fs.writeFileSync(path.join(checkout, "node_modules/vitest/package.json"), JSON.stringify({ version: "1.2.3" }));
    fs.writeFileSync(path.join(checkout, "package-lock.json"), JSON.stringify({ packages: { "node_modules/vitest": { version: "4.5.6" } } }));
    expect(provenanceFor(checkout, {}).dependencies).toContainEqual({ name: "vitest", installed: "1.2.3", locked: "4.5.6" });
    const evidence = sanitizedEvidence("platform-postgres", reportFor(), root, provenance);
    expect(evidence.expectedTools).toEqual({ node: "22.23.3", postgres: "16.15" });
    expect(evidence).not.toHaveProperty("measuredTools");
  });

  it("counts unknown and skipped states explicitly without retaining their payload", () => {
    expect(countsFor([{ status: "passed" }, { status: "failed" }, { status: "pending" }, { status: "todo" }, { status: "skipped" }, { status: "sensitive unknown state" }])).toEqual({ total: 6, passed: 1, failed: 1, skipped: 3, unknown: 1 });
  });

  it("CLI writes sanitized failure evidence and its diagnostics never include report payloads", () => {
    const secret = ["gh", "p_"].join("") + randomBytes(20).toString("hex");
    const report = reportFor();
    report.testResults[0].assertionResults[0].status = "failed";
    report.testResults[0].assertionResults[0].fullName += secret;
    report.testResults[0].assertionResults[0].failureMessages = [secret];
    const input = path.join(scratch, "report.json");
    const output = path.join(scratch, "evidence.json");
    fs.writeFileSync(input, JSON.stringify(report));
    const result = spawnSync(process.execPath, [path.join(root, "scripts/ci/run-gate.mjs"), "platform-postgres", "--validate", input, "--evidence", output], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, NODE_ENV: "test", API_KEY: secret } });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}${fs.readFileSync(output, "utf8")}`).not.toContain(secret);
    expect(JSON.parse(fs.readFileSync(output, "utf8")).verdict).toBe("failed");
  });

  it.each(["missing", "malformed"])("the runner records %s evidence as failed, never zero-test success", (kind) => {
    const input = path.join(scratch, kind + ".json");
    const output = path.join(scratch, kind + "-evidence.json");
    if (kind === "malformed") fs.writeFileSync(input, "untrusted-invalid-json-canary");
    const result = spawnSync(process.execPath, [path.join(root, "scripts/ci/run-gate.mjs"), "platform-postgres", "--validate", input, "--evidence", output], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("untrusted-invalid-json-canary");
    expect(JSON.parse(fs.readFileSync(output, "utf8"))).toMatchObject({ verdict: "failed", counts: { total: 0 } });
  });
});

describe("strict malformed and expected-failure evidence", () => {
  const required = [{ file: "tests/platform/expected-failure.test.ts", suite: "expected failure contract" }];
  function report() { return { success: true, testResults: [{ name: path.resolve(root, required[0].file), status: "passed", assertionResults: [{ fullName: "expected failure contract rejection is asserted", ancestorTitles: [required[0].suite], status: "passed" }] }] }; }

  it("accepts an expected-failure scenario only when Vitest reports its assertion passed", () => {
    expect(reportFailures(required, report(), root)).toEqual([]);
  });

  it.each(["failed", "skipped", "pending", "todo", "unknown"])("rejects a %s expected-failure scenario", (status) => {
    const value = report(); value.testResults[0].assertionResults[0].status = status;
    expect(reportFailures(required, value, root).length).toBeGreaterThan(0);
  });

  it("rejects missing expected-failure assertions even with an unrelated passed unit assertion", () => {
    const value = report(); value.testResults[0].assertionResults[0].ancestorTitles = ["unit suite"];
    expect(reportFailures(required, value, root)).toHaveLength(1);
  });

  it("rejects duplicate assertions rather than counting a replayed record twice", () => {
    const value = report(); value.testResults[0].assertionResults.push(value.testResults[0].assertionResults[0]);
    expect(reportFailures(required, value, root)).toEqual(["Duplicate Vitest assertion evidence"]);
  });

  it.each([null, {}, { success: true, testResults: [null] }, { success: true, testResults: [{ name: required[0].file, status: "passed", assertionResults: [null] }] }, { success: true, testResults: [{ name: required[0].file, status: "passed", assertionResults: [{ fullName: "", status: "passed" }] }] }, { success: true, testResults: [{ name: required[0].file, status: "passed", assertionResults: [{ fullName: "assertion", status: "passed", ancestorTitles: [null] }] }] }])("rejects malformed report structures without exposing arbitrary content: %j", (value) => {
    expect(reportFailures(required, value, root).length).toBeGreaterThan(0);
  });

  it("rejects a missing parameterized backend suite even when another suite in the same file passed", () => {
    const requirements = requirementsFor("platform-postgres", root).filter((required: { file: string }) => required.file === "tests/capabilities/tenancy.test.ts");
    const value = reportFor();
    const file = value.testResults.find((file) => file.name.endsWith("tests/capabilities/tenancy.test.ts"))!;
    file.assertionResults.shift();
    expect(reportFailures(requirements, value, root)).toHaveLength(1);
  });
});
