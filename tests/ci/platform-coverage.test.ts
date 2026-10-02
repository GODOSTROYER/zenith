/**
 * Parsed workflow gates cover the platform that exists. Suite discovery catches
 * narrower filters; mandatory evidence reports catch skipped real-engine tests.
 * Cloud APIs in platform e2e are still mocked, never live acceptance evidence.
 */
import fs from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import vitestConfig from "../../vitest.config";
import { CORE_CHECKS, manifestFor } from "../../scripts/ci/gate-manifest.mjs";
import { requirementsFor, TOFU_SUITES } from "./assert-lane-report.mjs";

interface Step {
  name?: string; run?: string; if?: string; shell?: string;
  env?: Record<string, unknown>;
  "working-directory"?: string; "continue-on-error"?: boolean;
}
interface Job { steps: Step[]; env?: Record<string, unknown>; if?: string; "continue-on-error"?: boolean }
const root = process.cwd();
const workflow = load(fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, Job> };

function testsUnder(directory: string): string[] {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const file = `${directory}/${entry.name}`;
    return entry.isDirectory() ? testsUnder(file) : /\.test\.tsx?$/.test(file) ? [file] : [];
  });
}

function gate(jobName: string, command: string, condition?: string): Step {
  const job = workflow.jobs[jobName];
  expect(job, `${jobName} must remain a mandatory CI job`).toBeDefined();
  expect(job.if).toBeUndefined();
  expect(job["continue-on-error"]).toBeUndefined();
  const matches = job.steps.filter((step) => step.run?.trim() === command);
  expect(matches, `${jobName} must run ${command}`).toHaveLength(1);
  expect(matches[0].if).toBe(condition);
  expect(matches[0]["continue-on-error"]).toBeUndefined();
  return matches[0];
}

describe("platform suite coverage", () => {
  it("runs both Vitest projects with every Node and DOM suite included", () => {
    gate("verify", "node scripts/ci/run-gate.mjs core --run --step unit");
    expect(CORE_CHECKS.find((check) => check.id === "unit")?.command).toEqual(["node", "node_modules/vitest/vitest.mjs", "run", "--project=node", "--project=dom", "--maxWorkers=1"]);
    const config = vitestConfig as { test?: { include?: string[]; exclude?: string[]; projects?: { test?: { name?: string; include?: string[]; exclude?: string[] } }[] } };
    expect(config.test?.include).toBeUndefined();
    expect(config.test?.exclude).toBeUndefined();
    expect(config.test?.projects).toHaveLength(2);
    for (const [name, extension] of [["node", "ts"], ["dom", "tsx"]]) {
      const project = config.test?.projects?.find((candidate) => candidate.test?.name === name);
      expect(project?.test?.include).toEqual([`tests/**/*.test.${extension}`]);
      expect(project?.test?.exclude).toBeUndefined();
    }
  });

  it.each(["agent-v3", "cli", "placement", "platform-ui", "security", "ci"])("keeps tests/%s behind the unfiltered unit gate", (directory) => {
    expect(testsUnder(`tests/${directory}`).length).toBeGreaterThan(0);
    gate("verify", "node scripts/ci/run-gate.mjs core --run --step unit");
    expect(CORE_CHECKS.find((check) => check.id === "unit")?.command).toEqual(["node", "node_modules/vitest/vitest.mjs", "run", "--project=node", "--project=dom", "--maxWorkers=1"]);
  });

  it.each([
    ["verify", "node scripts/ci/run-gate.mjs core --run --step lint"], ["verify", "node scripts/ci/run-gate.mjs core --run --step typecheck"],
    ["policy", "npm run policy:check"],
    ["generated", "npm run platform:emit-sql -- --check"],
    ["generated", "npx tsx scripts/docs/capability-matrix.ts --check"],
    ["generated", "npx vitest run tests/docs --maxWorkers=2"],
    ["ledger", "node scripts/build/ledger.mjs --check"],
  ])("requires %s: %s", (job, command) => { gate(job, command); });

  it.each([["postgres", "postgres"], ["policy", "policy"], ["tofu", "tofu"], ["workflows", "workflows"], ["platform-postgres", "platform"]])("requires real-engine evidence in %s even when Vitest fails", (lane, reportName) => {
    const job = workflow.jobs[lane];
    const report = `.data-ci-lane/${reportName}-lane.json`;
    const assertion = gate(lane, `node scripts/ci/run-gate.mjs ${lane} --validate ${report}`, "always()");
    const manifest = manifestFor(lane, root);
    expect(manifest.report).toBe(report);
    const suiteSteps = job.steps.filter((step) => step.run === `node scripts/ci/run-gate.mjs ${lane} --run`);
    expect(suiteSteps).toHaveLength(1);
    const suites = suiteSteps[0];
    expect(suites.if).toBeUndefined();
    expect(suites["continue-on-error"]).toBeUndefined();
    expect(manifest.command).not.toContain("--passWithNoTests");
    expect(manifest.command).toContain(`--outputFile.json=${report}`);
    expect(manifest.command).toContain("--no-file-parallelism");
    expect(manifest.command).toContain("--maxWorkers=1");
    expect(job.steps.indexOf(assertion)).toBeGreaterThan(job.steps.indexOf(suites));
    const filters = manifest.files;
    for (const required of requirementsFor(lane, root)) {
      expect(filters.some((filter) => required.file === filter || required.file.startsWith(`${filter}/`)), `${lane} must execute ${required.file}`).toBe(true);
    }
  });

  it("checks every network-gated file and the actual gated suite titles", () => {
    const networkFiles = testsUnder("tests").filter((file) => /process\.env\.ZENITH_TEST_TOFU_NETWORK\s*(?:===|!==)/.test(fs.readFileSync(path.join(root, file), "utf8")));
    expect(networkFiles.length).toBeGreaterThan(0);
    const tracked = new Set(TOFU_SUITES.map(([file]) => file));
    for (const file of networkFiles) expect(tracked.has(file), `${file} needs a real-engine requirement`).toBe(true);
    for (const [file, suite] of TOFU_SUITES) expect(fs.readFileSync(path.join(root, file), "utf8"), `${file}: suite title drifted`).toContain(JSON.stringify(suite));
    expect(workflow.jobs.tofu.env?.ZENITH_TEST_TOFU_NETWORK).toBe("1");
  });

  it("exports the Temporal variable its helper reads and enables e2e/time skipping/history checks", () => {
    const job = workflow.jobs.workflows;
    expect(job.env?.ZENITH_COMPOSE_TEMPORAL_MODE).toBe("time-skipping");
    expect(job.env?.ZENITH_TEST_TEMPORAL_DOWNLOAD).toBe("1");
    expect(job.env?.ZENITH_SEC_TEMPORAL).toBe("1");
    const installer = job.steps.find((step) => step.name === "Install pinned Temporal CLI");
    expect(installer?.run).toContain('echo "ZENITH_TEST_TEMPORAL_CLI=$RUNNER_TEMP/temporal-cli/temporal" >> "$GITHUB_ENV"');
    expect(fs.readFileSync(path.join(root, "tests/workflows/support.ts"), "utf8")).toContain("process.env.ZENITH_TEST_TEMPORAL_CLI");
    const requirements = requirementsFor("workflows", root).map((required) => required.file);
    for (const file of ["tests/platform/deploy-e2e.test.ts", "tests/workflows/approval-time.test.ts", "tests/security/workflow-history.test.ts"]) expect(requirements).toContain(file);
  });

  it("requires migrations, capability contracts and reconciliation to exercise Postgres", () => {
    const requirements = requirementsFor("platform-postgres", root);
    for (const file of ["tests/controlplane/migrations.test.ts", "tests/capabilities/store-contract.test.ts", "tests/reconcile/platform.test.ts"]) expect(requirements).toContainEqual(expect.objectContaining({ file, postgres: true, id: expect.stringContaining(`platform-postgres:${file}:`) }));
    expect(requirements).toContainEqual(expect.objectContaining({ file: "tests/controlplane/migrations.test.ts", suite: "migrator [postgres]", postgres: true }));
    expect(requirements).toContainEqual(expect.objectContaining({ file: "tests/controlplane/migrations.test.ts", suite: "migrator [postgres] concurrency and fail-closed open", backend: "postgres" }));
  });
});

describe("cross-language Go gates", () => {
  const condition = "hashFiles('go/go.mod') != ''";

  it("vets and race-tests all Go packages including OCI", () => {
    expect(fs.existsSync(path.join(root, "go/internal/oci"))).toBe(true);
    gate("go", "go vet ./...", condition);
    gate("go", "go test -race -count=1 ./...", condition);
  });

  it("regenerates and compares machine fixtures before TypeScript validates them", () => {
    const job = workflow.jobs.go;
    const command = [
      "set -euo pipefail",
      "ZENITH_UPDATE_MACHINE_GOLDENS=1 go test -count=1 ./internal/machine/ops -run '^TestResultGoldens$'",
      "git diff --exit-code -- internal/machine/testdata/results",
      'test -z "$(git --no-optional-locks status --porcelain -- internal/machine/testdata/results)"',
    ].join("\n");
    const regenerate = gate("go", command, condition);
    expect(regenerate.shell).toBe("bash");
    const validate = gate("go", "npx vitest run tests/machines/go-results.test.ts --maxWorkers=2", condition);
    expect(validate["working-directory"]).toBe(".");
    expect(job.steps.indexOf(regenerate)).toBeLessThan(job.steps.indexOf(validate));
    const install = gate("go", "npm ci --ignore-scripts", condition);
    expect(install["working-directory"]).toBe(".");
    expect(job.steps.indexOf(install)).toBeLessThan(job.steps.indexOf(validate));
  });

  it("also runs the Go runner's real OpenTofu tests in the network lane", () => {
    const command = [
      "set -euo pipefail",
      'test "$(go env GOVERSION)" = "go1.27.1"',
      'ZENITH_TEST_TOFU="$ZENITH_TOFU_BIN" go -C go test -count=1 ./internal/runner/kinds -run \'^TestRealOpenTofu(PlanShowApply|WithProviderAndLockfile)$\'',
    ].join("\n");
    expect(gate("tofu", command).env?.GOTOOLCHAIN).toBe("local");
  });
});
