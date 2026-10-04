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
import { EXECUTION_LEASE_TENANT_POSTGRES_REQUIREMENTS, AWS_BOOTSTRAP_READINESS_POSTGRES_REQUIREMENTS, MCP_DURABLE_ADMISSION_POSTGRES_REQUIREMENTS, MCP_START_SOURCE_AUTHORITY_POSTGRES_REQUIREMENTS, MCP_START_SOURCE_AUTHORITY_SDK_REQUIREMENTS, CORE_CHECKS, linuxGuestManifest, manifestFor, requirementId } from "../../scripts/ci/gate-manifest.mjs";
import { requirementsFor, TOFU_SUITES } from "./assert-lane-report.mjs";

interface Step {
  name?: string; run?: string; if?: string; shell?: string; id?: string;
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
    const assertion = gate(lane, `node scripts/ci/run-gate.mjs ${lane} --validate ${report} --require-execution`, "always()");
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
    const dispatchModes = ["expired approval", "revoked approver role", "new policy denial", "expiry after authority check", "expiry during role lookup"];
    const handoffCases = [
      "producer exits and loses its directory; another worker applies ORIGINAL bytes after a separate fresh check, then destroys",
      "fresh semantic drift refuses before dispatch and has no original/fresh fallback",
      "source/config/backend/address-map/lock/tool and operation swaps refuse before mutation",
      "tampering with the original after inspection refuses before apply and preserves uncertainty after dispatch",
      "stale original state serial refuses even when independent fresh semantic plan is unchanged, with no fallback",
      "source review completes, browser human approval is consumed, and destination destroys the associated ORIGINAL",
      "restore into a fresh PostgreSQL store with matching keys preserves the original; missing keys refuse",
      "fake cipher authority and arbitrary runner handles cannot mint production admission",
      "matching immutable source identity consumes original bytes and a different source digest refuses before dispatch",
      "independent saved binary with matching native private source binding applies the exact original once",
      "independent saved binary refuses committed private source revocation before original apply without a fresh fallback",
    ];
    const platformSuites = [
      { file: "tests/execution/apply.test.ts", suite: "dispatch current authority [postgres]", cases: dispatchModes.map((mode) => `refuses ${mode} after fresh replan and before durable dispatch`), sourceTitles: ["refuses %s after fresh replan and before durable dispatch", ...dispatchModes] },
      { file: "tests/tofu/plan-artifact-handoff.test.ts", suite: "authenticated original cross-worker handoff [postgres]", cases: handoffCases, sourceTitles: handoffCases },
      { file: "tests/security/plan-artifact-secrecy.test.ts", suite: "encrypted plan artifact secrecy [postgres]", cases: [], sourceTitles: ["sensitive read-only originals persist only ciphertext; key rotation, tenant domains and tampering fail closed"] },
    ];
    const platformManifest = manifestFor("platform-postgres", root);
    const platformNetwork = platformSuites.flatMap(({ file, suite, cases, sourceTitles }) => {
      const required = platformManifest.requirements.filter((requirement) => requirement.file === file);
      expect(required.map((requirement) => ({ suite: requirement.suite, test: requirement.test, postgres: requirement.postgres })), `${file}: exact mandatory PostgreSQL scenarios`).toEqual(
        (cases.length > 0 ? cases : [undefined]).map((test) => ({ suite, test, postgres: true }))
      );
      const source = fs.readFileSync(path.join(root, file), "utf8");
      for (const title of [suite, ...sourceTitles]) expect(source, `${file}: gated suite or case title drifted`).toContain(JSON.stringify(title));
      expect(platformManifest.files, `${file}: must execute in the canonical PostgreSQL lane`).toContain(file);
      expect(platformManifest.excludeFiles, `${file}: cannot be excluded from real-engine execution`).not.toContain(file);
      return required;
    });
    const tracked = new Set([...TOFU_SUITES.map(([file]) => file), ...platformNetwork.map((required) => required.file)]);
    for (const file of networkFiles) expect(tracked.has(file), `${file} needs a real-engine requirement`).toBe(true);
    for (const [file, suite] of TOFU_SUITES) expect(fs.readFileSync(path.join(root, file), "utf8"), `${file}: suite title drifted`).toContain(JSON.stringify(suite));
    expect(workflow.jobs.tofu.env?.ZENITH_TEST_TOFU_NETWORK).toBe("1");
    expect(platformManifest.env.ZENITH_TEST_TOFU_NETWORK).toBe("1");
    expect(platformManifest.tools).toEqual({ node: "22.23.3", postgres: "16.15", tofu: "1.12.5" });
    expect(workflow.jobs["platform-postgres"].env?.ZENITH_TEST_TOFU_NETWORK).toBe("1");
    expect(workflow.jobs["platform-postgres"].env?.ZENITH_TEST_PLATFORM_PG_URL).toBe("postgresql://postgres:zenith-ci-throwaway@127.0.0.1:5432/zenith_platform_ci");
  });

  it("executes all 71 accepted G2 native cases with their exact source and mandatory PostgreSQL flags", () => {
    const manifest = manifestFor("platform-postgres", root);
    const required = [...MCP_DURABLE_ADMISSION_POSTGRES_REQUIREMENTS, ...AWS_BOOTSTRAP_READINESS_POSTGRES_REQUIREMENTS];
    const ids = new Set(required.map(item => requirementId("platform-postgres", item)));
    expect(required).toHaveLength(71);
    expect(manifest.requirements.filter(item => ids.has(item.id))).toEqual(required.map(item => ({ ...item, id: requirementId("platform-postgres", item) })));
    expect(manifest.requirements).toHaveLength(624);
    expect(new Set(manifest.requirements.map(item => item.id)).size).toBe(624);
    expect(manifest.env).toMatchObject({
      ZENITH_TEST_MCP_DEPLOY_ADMISSION_REQUIRED: "1", ZENITH_TEST_DEFAULT_CURRENT_MEMBERSHIP_REQUIRED: "1",
      ZENITH_TEST_OPENED_HANDLE_REQUIRED: "1", ZENITH_TEST_AWS_PREFLIGHT_REQUIRED: "1",
    });
    for (const item of required) {
      expect(manifest.command.some(argument => argument === item.file || item.file.startsWith(`${argument}/`))).toBe(true);
      expect(manifest.excludeFiles).not.toContain(item.file);
    }
    expect(manifest.command).toContain("tests/platform/aws-bootstrap-preflight-admission.test.ts");
    expect(manifest.excludeFiles).toEqual([]);
    expect(manifest.command).not.toContain("--passWithNoTests");
  });

  it("requires every final MCP native and SDK case without substituting protocol evidence for PostgreSQL", () => {
    const manifest = manifestFor("platform-postgres", root);
    const pg = MCP_START_SOURCE_AUTHORITY_POSTGRES_REQUIREMENTS;
    const sdk = MCP_START_SOURCE_AUTHORITY_SDK_REQUIREMENTS;
    const required = [...pg, ...sdk];
    expect(pg).toHaveLength(72);
    expect(sdk).toHaveLength(17);
    const ids = new Set(required.map(item => requirementId("platform-postgres", item)));
    expect(manifest.requirements.filter(item => ids.has(item.id))).toEqual(required.map(item => ({ ...item, id: requirementId("platform-postgres", item) })));
    expect(manifest.env.ZENITH_TEST_MCP_START_SOURCE_AUTHORITY_REQUIRED).toBe("1");
    for (const item of required) {
      expect(manifest.command.some(argument => argument === item.file || item.file.startsWith(`${argument}/`))).toBe(true);
      expect(manifest.excludeFiles).not.toContain(item.file);
    }
    for (const item of pg) expect(item).toMatchObject({ backend: "postgres", suite: "MCP final start source authority [postgres; modeled external protocols]" });
    for (const item of sdk) {
      expect(item).toMatchObject({ suite: "default product client provenance [SDK protocol; no network]" });
      expect(item).not.toHaveProperty("postgres");
      expect(item).not.toHaveProperty("backend");
    }
    expect(manifest.requirements).toContainEqual(expect.objectContaining({ file: pg[0].file, suite: pg[0].suite, backend: "postgres", id: requirementId("platform-postgres", { file: pg[0].file, suite: pg[0].suite, backend: "postgres" }) }));
    expect(manifest.requirements).toHaveLength(624);
    expect(new Set(manifest.requirements.map(item => item.id)).size).toBe(624);
    expect(manifest.command).not.toContain("--passWithNoTests");
  });

  it("requires all seven tenant-qualified native lease controls in the existing PostgreSQL lane", () => {
    const manifest = manifestFor("platform-postgres", root);
    const required = EXECUTION_LEASE_TENANT_POSTGRES_REQUIREMENTS;
    expect(required).toHaveLength(7);
    const ids = new Set(required.map(item => requirementId("platform-postgres", item)));
    expect(manifest.requirements.filter(item => ids.has(item.id))).toEqual(required.map(item => ({ ...item, id: requirementId("platform-postgres", item) })));
    expect(manifest.env.ZENITH_TEST_FIRST_SOURCE_LEASE_REQUIRED).toBe("1");
    for (const item of required) {
      expect(item).toMatchObject({ file: "tests/controlplane/first-source-lease-binding.test.ts", suite: "first source worker lease binding [postgres]", postgres: true });
      expect(manifest.command.some(argument => argument === item.file || item.file.startsWith(`${argument}/`))).toBe(true);
      expect(manifest.excludeFiles).not.toContain(item.file);
    }
    expect(manifest.requirements).toHaveLength(624);
    expect(new Set(manifest.requirements.map(item => item.id)).size).toBe(624);
    expect(manifest.command).not.toContain("--passWithNoTests");
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
  const nativeCommand = [
    "set -euo pipefail",
    'attempt_id="$(node --input-type=module -e \'import { randomBytes } from "node:crypto"; console.log(randomBytes(16).toString("hex"))\')"',
    'echo "expected_attempt_id=$attempt_id" >> "$GITHUB_OUTPUT"',
    'ZENITH_GUEST_ATTEMPT_ID="$attempt_id" node scripts/ci/run-guest-file-write-gate.mjs --run',
  ].join("\n");

  it("vets and race-tests all Go packages including OCI", () => {
    expect(fs.existsSync(path.join(root, "go/internal/oci"))).toBe(true);
    gate("go", "go vet ./...", condition);
    const native = gate("go", nativeCommand, condition);
    expect(native.id).toBe("native_guest");
    expect(native.shell).toBe("bash");
    expect(native["working-directory"]).toBe(".");
    const manifest = linuxGuestManifest();
    expect(manifest.command).toEqual(["node", "scripts/ci/run-guest-file-write-gate.mjs", "--run"]);
    expect(manifest.steps.find((step) => step.id === "race")?.command).toEqual(["go", "test", "-json", "-race", "-count=1", "./..."]);
    expect(manifest.env.CGO_ENABLED).toBe("1");
    expect(manifest.env.GOTOOLCHAIN).toBe("local");
    expect(manifest.requiredPackages).toContain("github.com/GODOSTROYER/zenith/go/internal/oci");
    expect(manifest.allowedSkips.map(({ package: packageName, test }) => ({ package: packageName, test }))).toEqual([
      { package: "github.com/GODOSTROYER/zenith/go/internal/machine/ops", test: "TestRealSystemctlAndJournalctl" },
      { package: "github.com/GODOSTROYER/zenith/go/internal/runner/kinds", test: "TestRealOpenTofuPlanShowApply" },
      { package: "github.com/GODOSTROYER/zenith/go/internal/runner/kinds", test: "TestRealOpenTofuWithProviderAndLockfile" },
    ]);
  });

  it("regenerates and compares machine fixtures before TypeScript validates them", () => {
    const job = workflow.jobs.go;
    const regenerate = gate("go", nativeCommand, condition);
    const manifest = linuxGuestManifest();
    // The runner observes exits and validates complete JSON lifecycles; the
    // dedicated guest gate suite checks malformed, missing and skipped reports.
    expect(manifest.steps).toEqual([
      { id: "race", command: ["go", "test", "-json", "-race", "-count=1", "./..."] },
      { id: "goldens", command: ["go", "test", "-json", "-count=1", "./internal/machine/ops", "-run", "^TestResultGoldens$"] },
      { id: "golden-diff", command: ["git", "diff", "--exit-code", "--", "internal/machine/testdata/results"] },
      { id: "golden-status", command: ["git", "--no-optional-locks", "status", "--porcelain", "--", "internal/machine/testdata/results"] },
    ]);
    expect(manifest.goldenCases).toEqual([{
      package: "github.com/GODOSTROYER/zenith/go/internal/machine/ops",
      test: "TestResultGoldens/file.write-filesystem",
      id: "linux-guest:github.com/GODOSTROYER/zenith/go/internal/machine/ops:TestResultGoldens/file.write-filesystem",
    }]);
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
