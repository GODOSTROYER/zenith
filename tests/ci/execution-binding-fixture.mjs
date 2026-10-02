/** Synthetic command receipt fixture; no engine acceptance, services or installed dependency edits. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

export function executionBindingFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-execution-binding-"));
  const write = (file, value) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  };
  for (const file of ["scripts/ci/gate-manifest.mjs", "scripts/ci/run-gate.mjs", "scripts/ci/sanitize-evidence.mjs", "scripts/ci/lane-report.mjs", "tests/ci/assert-lane-report.mjs"]) write(file, fs.readFileSync(path.join(sourceRoot, file)));
  write(".gitignore", "node_modules/\n.data-*/\n");
  write("tests/policy/receipt.test.ts", "// Synthetic trusted source requirement, never executed as engine acceptance.\n");
  write("package-lock.json", JSON.stringify({ packages: { "node_modules/vitest": { version: "0.0.0" } } }));
  write("node_modules/vitest/package.json", JSON.stringify({ version: "0.0.0", type: "module" }));
  write("node_modules/vitest/vitest.mjs", `import fs from "node:fs";
import path from "node:path";
const output = process.argv.find((arg) => arg.startsWith("--outputFile.json=")).slice("--outputFile.json=".length);
fs.writeFileSync(output, JSON.stringify({ success: true, testResults: [{ name: path.resolve("tests/policy/receipt.test.ts"), status: "passed", assertionResults: [{ fullName: "synthetic receipt assertion", status: "passed", ancestorTitles: [] }] }] }));
process.exitCode = Number(process.env.FIXTURE_EXIT);
if (process.env.FIXTURE_SIGNAL) process.kill(process.pid, process.env.FIXTURE_SIGNAL);
`);
  // All Git writes stay inside this disposable synthetic checkout.
  for (const args of [["init", "--quiet"], ["add", "."], ["-c", "user.name=Receipt Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Synthetic receipt fixture"]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error("Cannot initialize isolated receipt fixture");
  }
  const evidence = path.join(root, ".data-ci-lane/policy-evidence.json");
  const receipt = `${evidence}.execution.json`;
  const baseEnv = { PATH: process.env.PATH, FIXTURE_EXIT: "23", SHLVL: "0", GITHUB_SHA: "a".repeat(40), GITHUB_REPOSITORY: "fixture/receipt", GITHUB_REF: "refs/heads/fixture", GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1" };
  /**
   * @param {"run" | "validate" | "lane-report"} mode
   * @param {{ env?: Record<string, string>, flags?: string[] }} [options]
   */
  function step(mode, { env = {}, flags = [] } = {}) {
    const script = path.join(root, `.data-ci-lane/${mode}-step.sh`);
    const command = mode === "lane-report" ? ["scripts/ci/lane-report.mjs", "policy", ".data-ci-lane/policy-lane.json"] : ["scripts/ci/run-gate.mjs", ...(mode === "run" ? ["policy", "--run"] : ["policy", "--validate", ".data-ci-lane/policy-lane.json", ...flags])];
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, `${quote(process.execPath)} ${command.map(quote).join(" ")}\n`);
    const handles = Object.fromEntries(["GITHUB_ACTION", "GITHUB_ENV", "GITHUB_PATH", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY", "GITHUB_STATE"].map((key) => [key, path.join(root, `.data-ci-lane/${mode}-${key}`)]));
    // Matches the actual policy job's default bash -e {0} shell template.
    return spawnSync("bash", ["-e", script], { cwd: root, encoding: "utf8", env: { ...baseEnv, ...handles, ...env } });
  }
  return { root, evidence, receipt, step, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = executionBindingFixture();
  try {
    const first = fixture.step("run");
    const originBytes = fs.readFileSync(fixture.receipt, "utf8");
    const intermediary = fixture.step("lane-report");
    const second = fixture.step("validate", { flags: ["--require-execution"] });
    const matching = JSON.parse(fs.readFileSync(fixture.evidence, "utf8"));
    const third = fixture.step("validate", { env: { SHLVL: "1" }, flags: ["--require-execution"] });
    const changed = JSON.parse(fs.readFileSync(fixture.evidence, "utf8"));
    const result = {
      synthetic: true, runStatus: first.status, intermediaryStatus: intermediary.status, sameShellValidationStatus: second.status,
      changedShellValidationStatus: third.status, observedExitCode: changed.execution.exitCode,
      sameShellBinding: matching.execution.binding, changedShellBinding: changed.execution.binding,
      sameShellChecks: matching.execution.checks, changedShellChecks: changed.execution.checks,
      originReceiptUnchanged: fs.readFileSync(fixture.receipt, "utf8") === originBytes,
    };
    console.log(JSON.stringify(result, null, 2));
    if (result.runStatus !== 1 || result.intermediaryStatus !== 0 || result.sameShellValidationStatus !== 1 || result.changedShellValidationStatus !== 1 || result.observedExitCode !== 23 || result.sameShellBinding !== "matched" || result.changedShellBinding !== "mismatch" || !result.originReceiptUnchanged) process.exitCode = 1;
  } finally { fixture.cleanup(); }
}
