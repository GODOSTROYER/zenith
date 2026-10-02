/** Synthetic reports test sanitization; they are never engine acceptance evidence. */
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { countsFor, effectiveEnvironmentFor, environmentDiagnosticsFor, environmentInventoryFor, environmentInventoryPath, ENVIRONMENT_FINGERPRINT_EXCLUSIONS, executionReceiptFor, executionReceiptPath, main as sanitizeMain, preserveExecutionObservation, provenanceFor, readEnvironmentInventory, sanitizedEvidence, writeEnvironmentInventory, writeExecutionReceipt } from "../../scripts/ci/sanitize-evidence.mjs";
import { manifestFor, requirementsFor } from "../../scripts/ci/gate-manifest.mjs";
import { validateGate } from "../../scripts/ci/run-gate.mjs";
import { reportFailures } from "./assert-lane-report.mjs";
import { executionBindingFixture } from "./execution-binding-fixture.mjs";

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

const fixtureEnvironment = { NODE_ENV: "test", GATE_INPUT: "public contract" };
const provenance = provenanceFor(root, fixtureEnvironment);

function comparisonFor(receipt: ReturnType<typeof executionReceiptFor>, originEnv: Record<string, string | undefined>, currentEnv = originEnv) {
  const output = path.join(scratch, `helper-inventory-${randomBytes(8).toString("hex")}.json`);
  writeEnvironmentInventory(output, environmentInventoryFor(originEnv));
  return environmentDiagnosticsFor(receipt, readEnvironmentInventory(output), environmentInventoryFor(currentEnv));
}

function observe(lane: string, input: string, output: string, exitCode: number) {
  const raw = fs.readFileSync(input, "utf8");
  const env = effectiveEnvironmentFor(lane, root);
  fs.rmSync(environmentInventoryPath(output), { force: true });
  writeEnvironmentInventory(output, environmentInventoryFor(env));
  const origin = sanitizedEvidence(lane, JSON.parse(raw), root, provenanceFor(root, env), raw, manifestFor(lane, root, input));
  writeExecutionReceipt(output, executionReceiptFor(origin, exitCode));
}

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
      observe("platform-postgres", input, output, 1);
      const origin = fs.readFileSync(executionReceiptPath(output), "utf8");
      expect(validateGate("platform-postgres", input, output, root)).toBe(1);
      expect(sanitizeMain(["platform-postgres", input, output])).toBe(1);
      expect(validateGate("platform-postgres", input, output, root)).toBe(1);
      expect(JSON.parse(fs.readFileSync(output, "utf8"))).toMatchObject({ verdict: "failed", execution: { exitCode: 1, observed: true, binding: "matched" } });
      expect(fs.readFileSync(executionReceiptPath(output), "utf8")).toBe(origin);
      // A newly observed successful command supersedes the previous attempt.
      fs.rmSync(executionReceiptPath(output));
      observe("platform-postgres", input, output, 0);
      expect(validateGate("platform-postgres", input, output, root)).toBe(0);
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
      observe("platform-postgres", input, output, 1);
      expect(validateGate("platform-postgres", input, output, root)).toBe(1);
      const executed = JSON.parse(fs.readFileSync(output, "utf8"));
      for (const name of ENVIRONMENT_FINGERPRINT_EXCLUSIONS) vi.stubEnv(name, path.join(scratch, "validation-" + name));
      expect(validateGate("platform-postgres", input, output, root)).toBe(1);
      expect(sanitizeMain(["platform-postgres", input, output])).toBe(1);
      const validated = JSON.parse(fs.readFileSync(output, "utf8"));
      expect(validated).toMatchObject({ verdict: "failed", execution: { exitCode: 1, observed: true } });
      expect(validated.provenance.environment.sha256).toBe(executed.provenance.environment.sha256);
      expect(validated.provenance.environment.excludedKeys).toEqual(["GITHUB_ACTION", "GITHUB_ENV", "GITHUB_PATH", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY", "GITHUB_STATE", "GITHUB_ARTIFACTS", "GITHUB_ARTIFACTS_LIST"]);
    } finally { vi.unstubAllEnvs(); error.mockRestore(); log.mockRestore(); }
  });

  it.each(["ZENITH_TEST_PLATFORM_PG_URL", "API_KEY", "PATH", "GITHUB_SHA", "GITHUB_REPOSITORY", "GITHUB_REF", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "PRIVATE_ENGINE_SETTING", "github_artifacts", "_", "SHLVL", "PWD", "OLDPWD"])("fails changed %s execution authority even when the two measured artifact handles also drift", (name) => {
    const before = { GITHUB_ARTIFACTS: "first-handle", GITHUB_ARTIFACTS_LIST: "first-list", [name]: "first-input" };
    const after = { GITHUB_ARTIFACTS: "second-handle", GITHUB_ARTIFACTS_LIST: "second-list", [name]: "second-input" };
    const first = provenanceFor(root, before);
    const second = provenanceFor(root, after);
    const candidate = sanitizedEvidence("platform-postgres", reportFor(), root, second);
    const previous = executionReceiptFor(sanitizedEvidence("platform-postgres", reportFor(), root, first), 0);
    expect(first.environment.sha256).not.toBe(second.environment.sha256);
    const comparison = comparisonFor(previous, before, after);
    expect(comparison).toMatchObject({ complete: true, counts: { changed: 1, added: 0, removed: 0 } });
    expect(comparison.changes).not.toContainEqual(expect.objectContaining({ id: "GITHUB_ARTIFACTS" }));
    expect(comparison.changes).not.toContainEqual(expect.objectContaining({ id: "GITHUB_ARTIFACTS_LIST" }));
    expect(preserveExecutionObservation(candidate, previous, true, undefined, comparison)).toBe(0);
    expect(candidate.execution).toMatchObject({ exitCode: 0, observed: true, binding: "mismatch", checks: { effectiveEnvironmentSha256: false, environmentInventorySha256: false, environmentInventoryIntegrity: true } });
    expect(candidate.verdict).toBe("failed");
  });

  it.each(["report", "manifest", "tracked-source", "untracked-source", "environment", "installed-version", "locked-version"])("retains origin failure and unverifies execution when the %s binding changed", (binding) => {
    const baseline = sanitizedEvidence("platform-postgres", reportFor(), root, provenance);
    const previous = executionReceiptFor(baseline, 1);
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
    expect(preserveExecutionObservation(candidate, previous, false, undefined, comparisonFor(previous, fixtureEnvironment))).toBe(1);
    expect(candidate.execution).toMatchObject({ exitCode: 1, observed: true, binding: "mismatch" });
    expect(candidate.verdict).toBe("failed");
    expect(candidate.required.every((required: { status: string }) => required.status === "unverified")).toBe(true);
  });

  it("retains a different trusted lane's exact origin and fails the lane binding", () => {
    const previous = executionReceiptFor(sanitizedEvidence("policy", reportFor("policy"), root, provenance), 23);
    const candidate = sanitizedEvidence("platform-postgres", reportFor(), root, provenance);
    expect(preserveExecutionObservation(candidate, previous, false, undefined, comparisonFor(previous, fixtureEnvironment))).toBe(23);
    expect(candidate).toMatchObject({ verdict: "failed", execution: { observed: true, exitCode: 23, termination: "exit", binding: "mismatch", originReceipt: { lane: "policy", exitCode: 23 }, checks: { lane: false } } });
    const untrusted = { ...previous, lane: "untrusted-lane-payload" };
    const next = sanitizedEvidence("platform-postgres", reportFor(), root, provenance);
    expect(preserveExecutionObservation(next, untrusted)).toBeUndefined();
    expect(next.execution).toMatchObject({ observed: false, binding: "mismatch", originReceipt: null });
    expect(JSON.stringify(next)).not.toContain("untrusted-lane-payload");
  });

  it("never treats report-only validation as observed execution, and CI can require its receipt", () => {
    const input = path.join(scratch, "report-only.json");
    const output = path.join(scratch, "report-only-evidence.json");
    fs.writeFileSync(input, JSON.stringify(reportFor()));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(validateGate("platform-postgres", input, output, root)).toBe(0);
      expect(JSON.parse(fs.readFileSync(output, "utf8")).execution).toMatchObject({ observed: false, exitCode: null, binding: "missing" });
      expect(fs.existsSync(executionReceiptPath(output))).toBe(false);
      expect(validateGate("platform-postgres", input, output, root, { requireExecution: true })).toBe(1);
      expect(JSON.parse(fs.readFileSync(output, "utf8"))).toMatchObject({ verdict: "failed", execution: { observed: false, binding: "missing" } });
      expect(fs.existsSync(executionReceiptPath(output))).toBe(false);
    } finally { error.mockRestore(); log.mockRestore(); }
  });

  it.each(["malformed", "unknown-fields", "missing-fields"])("fails closed on a %s execution receipt without exporting its payload", (kind) => {
    const input = path.join(scratch, `invalid-${kind}.json`);
    const output = path.join(scratch, `invalid-${kind}-evidence.json`);
    const secret = ["gh", "p_"].join("") + randomBytes(20).toString("hex");
    fs.writeFileSync(input, JSON.stringify(reportFor()));
    observe("platform-postgres", input, output, 0);
    const value = JSON.parse(fs.readFileSync(executionReceiptPath(output), "utf8"));
    if (kind === "unknown-fields") value.error = secret;
    if (kind === "missing-fields") delete value.sourceSha256;
    const origin = kind === "malformed" ? secret : JSON.stringify(value);
    fs.writeFileSync(executionReceiptPath(output), origin);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(validateGate("platform-postgres", input, output, root)).toBe(1);
      expect(sanitizeMain(["platform-postgres", input, output])).toBe(1);
      const evidence = fs.readFileSync(output, "utf8");
      expect(evidence).not.toContain(secret);
      expect(JSON.parse(evidence)).toMatchObject({ verdict: "failed", execution: { observed: false, binding: "mismatch", originReceipt: null, receiptSha256: createHash("sha256").update(origin).digest("hex") } });
      expect(fs.readFileSync(executionReceiptPath(output), "utf8")).toBe(origin);
    } finally { error.mockRestore(); log.mockRestore(); }
  });

  it("records the failed canonical command across separate default-shell steps and an intermediary report", () => {
    const fixture = executionBindingFixture();
    try {
      expect(fixture.step("run").status).toBe(1);
      const origin = fs.readFileSync(fixture.receipt, "utf8");
      expect(JSON.parse(origin).exitCode).toBe(23);
      expect(fixture.step("lane-report").status).toBe(0);
      expect(fixture.step("validate", { flags: ["--require-execution"] }).status).toBe(1);
      expect(JSON.parse(fs.readFileSync(fixture.evidence, "utf8"))).toMatchObject({ verdict: "failed", counts: { passed: 1, failed: 0 }, execution: { observed: true, exitCode: 23, binding: "matched" } });
      expect(JSON.parse(fs.readFileSync(fixture.evidence, "utf8")).execution.originReceipt).toEqual(JSON.parse(origin));
      expect(JSON.parse(fs.readFileSync(fixture.evidence, "utf8")).execution.receiptSha256).toBe(createHash("sha256").update(origin).digest("hex"));
      expect(fixture.step("validate", { env: { SHLVL: "1" }, flags: ["--require-execution"] }).status).toBe(1);
      expect(JSON.parse(fs.readFileSync(fixture.evidence, "utf8"))).toMatchObject({ verdict: "failed", execution: { observed: true, exitCode: 23, binding: "mismatch", checks: { effectiveEnvironmentSha256: false, shellContextSha256: false } } });
      expect(fs.readFileSync(fixture.receipt, "utf8")).toBe(origin);
    } finally { fixture.cleanup(); }
  });

  it.each(["environment", "source", "lockfile", "report"])("unverifies a successful command when its later %s binding changes", (binding) => {
    const fixture = executionBindingFixture();
    try {
      expect(fixture.step("run", { env: { FIXTURE_EXIT: "0" } }).status).toBe(0);
      const origin = fs.readFileSync(fixture.receipt, "utf8");
      const env: Record<string, string> = { FIXTURE_EXIT: "0" };
      if (binding === "environment") env.API_KEY = "changed-sensitive-input";
      if (binding === "source") fs.appendFileSync(path.join(fixture.root, "tests/policy/receipt.test.ts"), "// source changed\n");
      if (binding === "lockfile") fs.writeFileSync(path.join(fixture.root, "package-lock.json"), JSON.stringify({ packages: {} }));
      if (binding === "report") fs.appendFileSync(path.join(fixture.root, ".data-ci-lane/policy-lane.json"), "\n");
      expect(fixture.step("validate", { env, flags: ["--require-execution"] }).status).toBe(1);
      expect(JSON.parse(fs.readFileSync(fixture.evidence, "utf8"))).toMatchObject({ verdict: "failed", execution: { observed: true, exitCode: 0, binding: "mismatch" } });
      expect(fs.readFileSync(fixture.receipt, "utf8")).toBe(origin);
    } finally { fixture.cleanup(); }
  });

  it("captures source before the command and rejects command-time source changes", () => {
    const fixture = executionBindingFixture();
    try {
      fs.appendFileSync(path.join(fixture.root, "node_modules/vitest/vitest.mjs"), '\nfs.appendFileSync("tests/policy/receipt.test.ts", "// changed during command\\n");\n');
      expect(fixture.step("run", { env: { FIXTURE_EXIT: "0" } }).status).toBe(1);
      expect(JSON.parse(fs.readFileSync(fixture.evidence, "utf8"))).toMatchObject({ verdict: "failed", execution: { observed: true, exitCode: 0, binding: "mismatch", checks: { sourceSha256: false } } });
    } finally { fixture.cleanup(); }
  });

  it.each(["assume-unchanged", "skip-worktree"])("rejects %s index flags that hide edited tracked source", (flag) => {
    const fixture = executionBindingFixture();
    try {
      const source = "tests/policy/receipt.test.ts";
      expect(spawnSync("git", ["update-index", `--${flag}`, source], { cwd: fixture.root }).status).toBe(0);
      fs.appendFileSync(path.join(fixture.root, source), "// hidden source edit\n");
      expect(spawnSync("git", ["diff", "--no-ext-diff", "--no-textconv", "--exit-code", "HEAD"], { cwd: fixture.root }).status).toBe(0);
      expect(fixture.step("run", { env: { FIXTURE_EXIT: "0" } }).status).toBe(1);
      const evidence = JSON.parse(fs.readFileSync(fixture.evidence, "utf8"));
      expect(evidence).toMatchObject({ verdict: "failed", provenance: { sourceBindingComplete: false, index: { inventoryComplete: true } }, execution: { observed: true, exitCode: 0, binding: "mismatch" } });
      expect(evidence.provenance.index[flag === "assume-unchanged" ? "assumeUnchanged" : "skipWorktree"]).toBe(1);
      expect(evidence.required.every((required: { status: string }) => required.status === "unverified")).toBe(true);
    } finally { fixture.cleanup(); }
  });

  it("retains the actual signal without manufacturing a command exit code", () => {
    const fixture = executionBindingFixture();
    const env = { FIXTURE_EXIT: "0", FIXTURE_SIGNAL: "SIGTERM" };
    try {
      expect(fixture.step("run", { env }).status).toBe(1);
      const origin = fs.readFileSync(fixture.receipt, "utf8");
      expect(JSON.parse(origin)).toMatchObject({ exitCode: null, termination: "signal", signal: "SIGTERM" });
      expect(fixture.step("validate", { env, flags: ["--require-execution"] }).status).toBe(1);
      expect(JSON.parse(fs.readFileSync(fixture.evidence, "utf8"))).toMatchObject({ verdict: "failed", counts: { passed: 1 }, execution: { observed: true, exitCode: null, termination: "signal", signal: "SIGTERM", binding: "matched" } });
      expect(fs.readFileSync(fixture.receipt, "utf8")).toBe(origin);
    } finally { fixture.cleanup(); }
  });

  it("records a real launch failure as unobserved execution and never copies its error", () => {
    const fixture = executionBindingFixture();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(fixture.step("run", { env: { FIXTURE_EXIT: "0" } }).status).toBe(0);
      const reportPath = ".data-ci-lane/policy-lane.json";
      const raw = fs.readFileSync(path.join(fixture.root, reportPath), "utf8");
      const env: NodeJS.ProcessEnv = { ...effectiveEnvironmentFor("policy", fixture.root), NODE_ENV: "test" };
      fs.rmSync(environmentInventoryPath(fixture.evidence));
      writeEnvironmentInventory(fixture.evidence, environmentInventoryFor(env));
      const origin = sanitizedEvidence("policy", JSON.parse(raw), fixture.root, provenanceFor(fixture.root, env), raw, manifestFor("policy", fixture.root, reportPath));
      const failed = spawnSync(path.join(fixture.root, "missing-canonical-command"), [], { cwd: fixture.root, env });
      expect(failed.status).toBeNull();
      expect(failed.error).toBeDefined();
      const secret = ["gh", "p_"].join("") + randomBytes(20).toString("hex");
      failed.error!.message += secret;
      fs.rmSync(fixture.receipt);
      writeExecutionReceipt(fixture.evidence, executionReceiptFor(origin, failed));
      const bytes = fs.readFileSync(fixture.receipt, "utf8");
      expect(bytes).not.toContain(secret);
      expect(JSON.parse(bytes)).toMatchObject({ exitCode: null, termination: "launch-failed", signal: null });
      expect(validateGate("policy", reportPath, fixture.evidence, fixture.root, { requireExecution: true })).toBe(1);
      const evidence = fs.readFileSync(fixture.evidence, "utf8");
      expect(evidence).not.toContain(secret);
      expect(JSON.parse(evidence)).toMatchObject({ verdict: "failed", execution: { observed: false, exitCode: null, termination: "launch-failed", signal: null, binding: "matched" } });
      expect(fs.readFileSync(fixture.receipt, "utf8")).toBe(bytes);
    } finally { fixture.cleanup(); error.mockRestore(); log.mockRestore(); }
  });

  it("normalizes only canonical effective manifest overrides for execution and validation", () => {
    const first = effectiveEnvironmentFor("platform-postgres", root, { ZENITH_FAST: "0", API_KEY: "first" });
    const second = effectiveEnvironmentFor("platform-postgres", root, { API_KEY: "first" });
    expect(first).toEqual(second);
    expect(first.ZENITH_FAST).toBe("1");
    expect(effectiveEnvironmentFor("platform-postgres", root, { API_KEY: "second" })).not.toEqual(first);
  });

  it.each(["omitted", "unrelated-origin"])("retains exact origin but rejects %s inventory authority in the direct helper", (kind) => {
    const candidate = sanitizedEvidence("policy", reportFor("policy"), root, provenance);
    const receipt = executionReceiptFor(candidate, 0);
    const comparison = kind === "omitted" ? undefined : comparisonFor(receipt, fixtureEnvironment);
    if (comparison) comparison.originSha256 = "0".repeat(64);
    expect(preserveExecutionObservation(candidate, receipt, true, undefined, comparison)).toBe(0);
    expect(candidate).toMatchObject({ verdict: "failed", execution: { observed: true, exitCode: 0, termination: "exit", binding: "mismatch", checks: { environmentInventoryIntegrity: false } } });
    expect(candidate.execution.originReceipt).toEqual(receipt);
    expect(candidate.required.every((required: { status: string }) => required.status === "unverified")).toBe(true);
  });

  it("accepts a direct helper's successful origin only with its complete bound inventory comparison", () => {
    const candidate = sanitizedEvidence("policy", reportFor("policy"), root, provenance);
    const receipt = executionReceiptFor(candidate, 0);
    const comparison = comparisonFor(receipt, fixtureEnvironment);
    expect(comparison).toMatchObject({ complete: true, status: "matched", originSha256: receipt.environmentInventorySha256 });
    expect(preserveExecutionObservation(candidate, receipt, true, undefined, comparison)).toBe(0);
    expect(candidate).toMatchObject({ verdict: "passed", execution: { observed: true, exitCode: 0, binding: "matched", checks: { environmentInventoryIntegrity: true } } });
  });

  it("exports exact official runner IDs and double-hashed unknown IDs without names, values or value hashes", () => {
    const nameSecret = ["gh", "p_"].join("") + randomBytes(20).toString("hex");
    const valueSecret = ["AK", "IA"].join("") + randomBytes(8).toString("hex").toUpperCase();
    const before = { GITHUB_RUN_ID: valueSecret, GITHUB_REF: "first-ref", [nameSecret]: valueSecret, REMOVED_INPUT: valueSecret, SHARED_INPUT: valueSecret };
    const after = { GITHUB_RUN_ID: "second-run", GITHUB_REF: "second-ref", [nameSecret]: "second-sensitive-value", ADDED_INPUT: valueSecret, SHARED_INPUT: valueSecret };
    const output = path.join(scratch, "diagnostic-evidence.json");
    writeEnvironmentInventory(output, environmentInventoryFor(before));
    const origin = sanitizedEvidence("policy", reportFor("policy"), root, provenanceFor(root, before));
    const receipt = executionReceiptFor(origin, 0);
    const current = sanitizedEvidence("policy", reportFor("policy"), root, provenanceFor(root, after));
    const inventory = readEnvironmentInventory(output);
    const comparison = environmentDiagnosticsFor(receipt, inventory, environmentInventoryFor(after));
    expect(comparison).toMatchObject({ complete: true, status: "changed", counts: { unchanged: 1, changed: 3, added: 1, removed: 1 }, truncated: false });
    expect(comparison.changes).toContainEqual({ id: "GITHUB_RUN_ID", status: "changed" });
    expect(comparison.changes).toContainEqual({ id: "GITHUB_REF", status: "changed" });
    const nameHash = createHash("sha256").update(nameSecret).digest("hex");
    const opaqueId = `opaque:${createHash("sha256").update(nameHash).digest("hex")}`;
    expect(comparison.changes).toContainEqual({ id: opaqueId, status: "changed" });
    preserveExecutionObservation(current, receipt, true, undefined, comparison);
    expect(current).toMatchObject({ verdict: "failed", execution: { exitCode: 0, observed: true, binding: "mismatch", checks: { effectiveEnvironmentSha256: false, environmentInventorySha256: false, environmentInventoryIntegrity: true } } });
    const serialized = JSON.stringify(current);
    for (const tainted of [nameSecret, valueSecret, "second-sensitive-value", "REMOVED_INPUT", "ADDED_INPUT", "SHARED_INPUT", nameHash, "valueSha256"]) expect(serialized).not.toContain(tainted);
    for (const entry of inventory.inventory!.entries) expect(serialized).not.toContain(entry.valueSha256);
    const raw = fs.readFileSync(environmentInventoryPath(output), "utf8");
    expect(raw).not.toContain(nameSecret);
    expect(raw).not.toContain(valueSecret);
    expect(receipt.environmentInventorySha256).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(fs.statSync(environmentInventoryPath(output)).mode & 0o777).toBe(0o600);
    expect(() => writeEnvironmentInventory(output, environmentInventoryFor(after))).toThrow();
    expect(fs.readFileSync(environmentInventoryPath(output), "utf8")).toBe(raw);
  });

  it.each(["missing", "malformed", "unknown-field", "tainted-key", "duplicate-key", "value-type", "digest-mismatch"])("fails a %s private inventory without exporting its payload or losing the observed origin", (kind) => {
    const input = path.join(scratch, `inventory-${kind}-report.json`);
    const output = path.join(scratch, `inventory-${kind}-evidence.json`);
    const secret = ["gh", "p_"].join("") + randomBytes(20).toString("hex");
    fs.writeFileSync(input, JSON.stringify(reportFor()));
    observe("platform-postgres", input, output, 0);
    const origin = fs.readFileSync(executionReceiptPath(output), "utf8");
    const inventory = JSON.parse(fs.readFileSync(environmentInventoryPath(output), "utf8"));
    if (kind === "unknown-field") inventory.error = secret;
    if (kind === "tainted-key") inventory.entries[0].keySha256 = secret;
    if (kind === "duplicate-key") inventory.entries.splice(1, 0, { ...inventory.entries[0] });
    if (kind === "value-type") inventory.entries[0].valueSha256 = { error: secret };
    if (kind === "digest-mismatch") inventory.entries[0].valueSha256 = "0".repeat(64);
    if (kind === "missing") fs.rmSync(environmentInventoryPath(output));
    else fs.writeFileSync(environmentInventoryPath(output), kind === "malformed" ? secret : JSON.stringify(inventory));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(validateGate("platform-postgres", input, output, root, { requireExecution: true })).toBe(1);
      expect(sanitizeMain(["platform-postgres", input, output])).toBe(1);
      const serialized = fs.readFileSync(output, "utf8");
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("valueSha256");
      expect(JSON.parse(serialized)).toMatchObject({ verdict: "failed", execution: { observed: true, exitCode: 0, binding: "mismatch", checks: { environmentInventoryIntegrity: false }, environmentComparison: { complete: false, changes: [] } } });
      expect(fs.readFileSync(executionReceiptPath(output), "utf8")).toBe(origin);
    } finally { error.mockRestore(); log.mockRestore(); }
  });

  it.each(["exit", "signal"])("retains a historical v1 %s origin but never accepts its missing inventory binding", (kind) => {
    const input = path.join(scratch, `historical-${kind}-report.json`);
    const output = path.join(scratch, `historical-${kind}-evidence.json`);
    fs.writeFileSync(input, JSON.stringify(reportFor()));
    observe("platform-postgres", input, output, 0);
    const historical = JSON.parse(fs.readFileSync(executionReceiptPath(output), "utf8"));
    historical.schemaVersion = 1;
    delete historical.environmentInventorySha256;
    if (kind === "signal") {
      historical.exitCode = null;
      historical.termination = "signal";
      historical.signal = "SIGTERM";
    }
    const origin = `${JSON.stringify(historical, null, 2)}\n`;
    fs.writeFileSync(executionReceiptPath(output), origin);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(validateGate("platform-postgres", input, output, root, { requireExecution: true })).toBe(1);
      expect(sanitizeMain(["platform-postgres", input, output])).toBe(1);
      const evidence = JSON.parse(fs.readFileSync(output, "utf8"));
      expect(evidence).toMatchObject({ verdict: "failed", execution: { observed: true, exitCode: historical.exitCode, termination: historical.termination, signal: historical.signal, binding: "mismatch", checks: { environmentInventorySha256: false, environmentInventoryIntegrity: false } } });
      expect(evidence.execution.originReceipt).toEqual(historical);
      expect(evidence.execution.originReceipt).not.toHaveProperty("environmentInventorySha256");
      expect(fs.readFileSync(executionReceiptPath(output), "utf8")).toBe(origin);
    } finally { error.mockRestore(); log.mockRestore(); }
  });

  it.each(["unknown-version", "string-version", "v1-extra-inventory", "v2-missing-inventory"])("rejects a %s receipt without exporting origin fields", (kind) => {
    const input = path.join(scratch, `version-${kind}-report.json`);
    const output = path.join(scratch, `version-${kind}-evidence.json`);
    fs.writeFileSync(input, JSON.stringify(reportFor()));
    observe("platform-postgres", input, output, 0);
    const invalid = JSON.parse(fs.readFileSync(executionReceiptPath(output), "utf8"));
    if (kind === "unknown-version") invalid.schemaVersion = 3;
    if (kind === "string-version") invalid.schemaVersion = "2";
    if (kind === "v1-extra-inventory") invalid.schemaVersion = 1;
    if (kind === "v2-missing-inventory") delete invalid.environmentInventorySha256;
    fs.writeFileSync(executionReceiptPath(output), JSON.stringify(invalid));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(validateGate("platform-postgres", input, output, root, { requireExecution: true })).toBe(1);
      expect(JSON.parse(fs.readFileSync(output, "utf8"))).toMatchObject({ verdict: "failed", execution: { observed: false, originReceipt: null, binding: "mismatch", environmentComparison: { complete: false, changes: [] } } });
    } finally { error.mockRestore(); log.mockRestore(); }
  });

  it("records a strict v2 receipt whose bound private inventory matches the effective command inputs", () => {
    const fixture = executionBindingFixture();
    try {
      expect(fixture.step("run", { env: { FIXTURE_EXIT: "0" } }).status).toBe(0);
      const origin = fs.readFileSync(fixture.receipt, "utf8");
      const inventory = fs.readFileSync(environmentInventoryPath(fixture.evidence), "utf8");
      expect(JSON.parse(origin)).toMatchObject({ schemaVersion: 2, environmentInventorySha256: createHash("sha256").update(inventory).digest("hex") });
      expect(fixture.step("validate", { env: { FIXTURE_EXIT: "0" }, flags: ["--require-execution"] }).status).toBe(0);
      expect(JSON.parse(fs.readFileSync(fixture.evidence, "utf8"))).toMatchObject({ verdict: "passed", execution: { observed: true, exitCode: 0, binding: "matched", originReceipt: { schemaVersion: 2 }, checks: { environmentInventorySha256: true, environmentInventoryIntegrity: true }, environmentComparison: { complete: true, status: "matched", changes: [] } } });
      expect(fs.readFileSync(fixture.receipt, "utf8")).toBe(origin);
      expect(fs.readFileSync(environmentInventoryPath(fixture.evidence), "utf8")).toBe(inventory);
    } finally { fixture.cleanup(); }
  });

  it.each([0, 23])("preserves exit %s across separate shell steps when only the two measured artifact handles drift", (exitCode) => {
    const fixture = executionBindingFixture();
    try {
      expect(fixture.step("run", { env: { FIXTURE_EXIT: String(exitCode), GITHUB_ARTIFACTS: "first-handle", GITHUB_ARTIFACTS_LIST: "first-list" } }).status).toBe(exitCode === 0 ? 0 : 1);
      const origin = fs.readFileSync(fixture.receipt, "utf8");
      const inventory = fs.readFileSync(environmentInventoryPath(fixture.evidence), "utf8");
      expect(fixture.step("validate", { env: { FIXTURE_EXIT: String(exitCode), GITHUB_ARTIFACTS: "second-handle", GITHUB_ARTIFACTS_LIST: "second-list" }, flags: ["--require-execution"] }).status).toBe(exitCode === 0 ? 0 : 1);
      const evidence = JSON.parse(fs.readFileSync(fixture.evidence, "utf8"));
      expect(evidence).toMatchObject({ verdict: exitCode === 0 ? "passed" : "failed", execution: { observed: true, exitCode, binding: "matched", checks: { shellContextSha256: true, shellLevelSha256: true, shellCommandSha256: true, effectiveEnvironmentSha256: true, environmentInventorySha256: true, environmentInventoryIntegrity: true }, environmentComparison: { complete: true, status: "matched", counts: { changed: 0, added: 0, removed: 0 }, changes: [] } } });
      expect(evidence.execution.originReceipt.exitCode).toBe(exitCode);
      expect(fs.readFileSync(fixture.receipt, "utf8")).toBe(origin);
      expect(fs.readFileSync(environmentInventoryPath(fixture.evidence), "utf8")).toBe(inventory);
    } finally { fixture.cleanup(); }
  });

  it("bounds private inventory reads and exported changes while retaining complete mismatch counts", () => {
    const before: Record<string, string> = {};
    const after: Record<string, string> = {};
    for (let index = 0; index < 129; index++) {
      before[`PRIVATE_INPUT_${index}`] = "first";
      after[`PRIVATE_INPUT_${index}`] = "second";
    }
    const output = path.join(scratch, "bounded-inventory-evidence.json");
    writeEnvironmentInventory(output, environmentInventoryFor(before));
    const receipt = executionReceiptFor(sanitizedEvidence("policy", reportFor("policy"), root, provenanceFor(root, before)), 0);
    const comparison = environmentDiagnosticsFor(receipt, readEnvironmentInventory(output), environmentInventoryFor(after));
    expect(comparison).toMatchObject({ complete: true, status: "changed", counts: { changed: 129 }, truncated: true });
    expect(comparison.changes).toHaveLength(128);
    expect(comparison.changes.every((change) => /^opaque:[a-f0-9]{64}$/.test(change.id))).toBe(true);
    fs.writeFileSync(environmentInventoryPath(output), "x".repeat(1024 * 1024 + 1));
    expect(readEnvironmentInventory(output)).toEqual({ inventory: null, sha256: null, status: "invalid" });
    const excessive: Record<string, string> = {};
    for (let index = 0; index < 4097; index++) excessive[`PRIVATE_INPUT_${index}`] = "value";
    expect(() => environmentInventoryFor(excessive)).toThrow("Environment inventory exceeds its bound");
  });

  it("rejects symlink and directory inventories before opening either target", () => {
    const realOutput = path.join(scratch, "regular-inventory.json");
    writeEnvironmentInventory(realOutput, environmentInventoryFor(fixtureEnvironment));
    const linkedOutput = path.join(scratch, "linked-inventory.json");
    fs.symlinkSync(environmentInventoryPath(realOutput), environmentInventoryPath(linkedOutput));
    const directoryOutput = path.join(scratch, "directory-inventory.json");
    fs.mkdirSync(environmentInventoryPath(directoryOutput));
    const open = vi.spyOn(fs, "openSync");
    try {
      for (const output of [linkedOutput, directoryOutput]) expect(readEnvironmentInventory(output)).toEqual({ inventory: null, sha256: null, status: "invalid" });
      expect(open).not.toHaveBeenCalled();
      expect(readEnvironmentInventory(realOutput).status).toBe("available");
    } finally { open.mockRestore(); }
  });

  it("rejects a FIFO inventory within a bounded isolated process without waiting for a writer", () => {
    const output = path.join(scratch, "fifo-inventory.json");
    expect(spawnSync("mkfifo", [environmentInventoryPath(output)], { timeout: 3000 }).status).toBe(0);
    const script = `import { readEnvironmentInventory } from ${JSON.stringify(path.join(root, "scripts/ci/sanitize-evidence.mjs"))}; process.stdout.write(JSON.stringify(readEnvironmentInventory(process.argv[1])));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script, output], { encoding: "utf8", timeout: 3000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ inventory: null, sha256: null, status: "invalid" });
  });

  it("rejects an opened descriptor that is nonregular and closes it without reading", () => {
    const output = path.join(scratch, "nonregular-descriptor-inventory.json");
    writeEnvironmentInventory(output, environmentInventoryFor(fixtureEnvironment));
    const stat = vi.spyOn(fs, "fstatSync").mockReturnValueOnce(fs.statSync(scratch));
    const read = vi.spyOn(fs, "readSync");
    const close = vi.spyOn(fs, "closeSync");
    try {
      expect(readEnvironmentInventory(output)).toEqual({ inventory: null, sha256: null, status: "invalid" });
      expect(read).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    } finally { stat.mockRestore(); read.mockRestore(); close.mockRestore(); }
  });

  it.each(["within-limit", "over-limit"])("rejects %s growth after the descriptor size check and closes it with bounded reads", (kind) => {
    const output = path.join(scratch, `growing-${kind}-inventory.json`);
    writeEnvironmentInventory(output, environmentInventoryFor(fixtureEnvironment));
    const target = environmentInventoryPath(output);
    const opened = fs.statSync(target);
    fs.appendFileSync(target, kind === "over-limit" ? "x".repeat(1024 * 1024 + 1) : " ");
    // A stale descriptor snapshot models growth immediately after fstat; all reads remain real.
    const stat = vi.spyOn(fs, "fstatSync").mockReturnValueOnce(opened);
    const read = vi.spyOn(fs, "readSync");
    const close = vi.spyOn(fs, "closeSync");
    try {
      expect(readEnvironmentInventory(output)).toEqual({ inventory: null, sha256: null, status: "invalid" });
      expect(read).toHaveBeenCalled();
      expect(read).toHaveBeenCalledWith(expect.any(Number), expect.any(Buffer), 0, 1024 * 1024 + 1, null);
      if (kind === "over-limit") expect(read).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    } finally { stat.mockRestore(); read.mockRestore(); close.mockRestore(); }
  });

  it("hashes malformed non-UTF8 inventory bytes exactly before decoding", () => {
    const output = path.join(scratch, "invalid-utf8-inventory.json");
    const raw = Buffer.from([0xff, 0xfe, 0x7b]);
    fs.writeFileSync(environmentInventoryPath(output), raw);
    const actualDigest = createHash("sha256").update(raw).digest("hex");
    expect(actualDigest).not.toBe(createHash("sha256").update(raw.toString("utf8")).digest("hex"));
    expect(readEnvironmentInventory(output)).toEqual({ inventory: null, sha256: actualDigest, status: "invalid" });
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

  /** Standard JSON reporter fields for separate it.each cases with one display title. */
  function repeatedDisplayReport() {
    const suite = "provider-dispatched Azure source preparation";
    const title = "clearly refuses missing storage bindings before downloading source";
    const assertion = { ancestorTitles: [suite], fullName: `${suite} ${title}`, title, status: "passed", duration: 1, failureMessages: [], meta: {} };
    return { success: true, numTotalTests: 2, numFailedTests: 0, testResults: [{ name: path.resolve(root, "tests/platform/source-bundle-azure.test.ts"), status: "passed", assertionResults: [assertion, { ...assertion, duration: 2 }] }] };
  }
  const repeatedRequired = [{ file: "tests/platform/source-bundle-azure.test.ts", suite: "provider-dispatched Azure source preparation" }];

  it("accepts distinct parameterized cases with identical display names in the actual standard JSON shape", () => {
    const value = repeatedDisplayReport();
    expect(value.testResults[0].assertionResults[0].fullName).toBe(value.testResults[0].assertionResults[1].fullName);
    expect(value.testResults[0].assertionResults[0]).not.toHaveProperty("testId");
    expect(reportFailures(repeatedRequired, value, root)).toEqual([]);
    expect(sanitizedEvidence("platform-postgres", reportFor(), root, provenance).validation.caseIdentity).toBe("not-exported-by-standard-vitest-json");
  });

  it.each(["failed", "pending", "skipped", "todo", "unknown"])("does not let a passing repeated display hide its %s sibling case", (status) => {
    const value = repeatedDisplayReport();
    value.testResults[0].assertionResults[1].status = status;
    expect(reportFailures(repeatedRequired, value, root)).toHaveLength(1);
  });

  it("does not let repeated case displays satisfy a missing distinct required suite", () => {
    const value = repeatedDisplayReport();
    expect(reportFailures([...repeatedRequired, { ...repeatedRequired[0], suite: "another required suite" }], value, root)).toHaveLength(1);
  });

  it("still rejects duplicate files containing legitimate repeated displays", () => {
    const value = repeatedDisplayReport();
    value.testResults.push(value.testResults[0]);
    expect(reportFailures(repeatedRequired, value, root)).toEqual(["Duplicate Vitest file evidence"]);
  });

  it("still checks report totals against every repeated case record", () => {
    const value = repeatedDisplayReport();
    value.numTotalTests = 1;
    expect(reportFailures(repeatedRequired, value, root)).toEqual(["Inconsistent Vitest report counts"]);
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
