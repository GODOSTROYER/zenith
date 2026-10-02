/** Shared gate commands preserve required local engines and precisely scoped external acceptance. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assertionMatches, canonicalSuite, EXTERNAL_ACCEPTANCE, GATE_LANES, manifestFor, requirementId, requirementsFor } from "../../scripts/ci/gate-manifest.mjs";
import { reportFailures } from "./assert-lane-report.mjs";

const root = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-manifest-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
const ecsGrantFile = "tests/platform/ecs-replica-repair-grants.test.ts";
const ecsFiles = ["tests/execution/ecs-replica-repair.test.ts", "tests/providers/aws/drivers/compute/ecs-replica-repair-read.test.ts", ecsGrantFile, "tests/workflows/ecs-replica-repair.test.ts"];
const ecsPostgresSuites = ["initial planning authority", "planning policy denial", "browser plan approval", "resumed planning authority", "stricter approval policy", "immutable repair evidence"];
const ecsPostgresRequirements = () => requirementsFor("platform-postgres", root).filter((required) => required.file === ecsGrantFile);
const ecsGrantReport = (outer = "replica repair authority [postgres]") => ({
  success: true,
  testResults: [{ name: path.resolve(root, ecsGrantFile), status: "passed", assertionResults: ecsPostgresSuites.map((suite) => ({
    fullName: `${outer} ${suite} scenario`, ancestorTitles: [outer, suite], status: "passed",
  })) }],
});

describe("canonical gate manifest", () => {
  it.each(Object.keys(GATE_LANES))("%s uses serial commands, stable unique IDs and retained prerequisites", (lane) => {
    const manifest = manifestFor(lane, root);
    expect(manifest.command).toContain("--maxWorkers=1");
    expect(manifest.command).toContain("--no-file-parallelism");
    expect(manifest.command).toContain(`--outputFile.json=${manifest.report}`);
    expect(manifest.prerequisites.length).toBeGreaterThan(1);
    expect(new Set(manifest.requirements.map((required: { id: string }) => required.id)).size).toBe(manifest.requirements.length);
    expect(manifest.requirements).toEqual(requirementsFor(lane, root));
    expect(manifestFor(lane, root, "captured.json").command).toContain("--outputFile.json=captured.json");
  });

  it("keeps real local codec/destroy replay required with their engine flag enabled", () => {
    const manifest = manifestFor("workflows", root);
    expect(manifest.env.ZENITH_TEST_TEMPORAL).toBe("1");
    for (const file of ["tests/workflows/codec-replay.test.ts", "tests/workflows/destroy-replay.test.ts"]) {
      expect(manifest.requirements).toContainEqual(expect.objectContaining({ file }));
      expect(manifest.excludeFiles).not.toContain(file);
    }
  });

  it("requires every source-bundle suite, including the pinned real public GitHub read", () => {
    const manifest = manifestFor("workflows", root);
    const suites = manifest.requirements.filter((required: { file: string }) => required.file === "tests/platform/source-bundle.test.ts");
    expect(suites).toHaveLength(4);
    expect(suites).toContainEqual(expect.objectContaining({ suite: "live public GitHub source (opt-in network)" }));
    expect(manifest.env).toMatchObject({ ZENITH_TEST_SOURCE_GITHUB: "1", ZENITH_TEST_SOURCE_REPO: "https://github.com/GODOSTROYER/zenith", ZENITH_TEST_SOURCE_REF: "37be7340536ccb68ae4bb49294e8ab3799d1f01b" });
    expect(manifest.excludeFiles).toEqual(["tests/workflows/mtls-live.test.ts"]);
  });

  it("declares mTLS prerequisites and an unverified release blocker rather than a pass", () => {
    expect(EXTERNAL_ACCEPTANCE).toHaveLength(1);
    expect(EXTERNAL_ACCEPTANCE[0]).toMatchObject({ file: "tests/workflows/mtls-live.test.ts", wholeFile: true });
    expect(EXTERNAL_ACCEPTANCE[0].prerequisites).toContain("ZENITH_TEMPORAL_TLS_KEY_FILE");
    expect(EXTERNAL_ACCEPTANCE[0].releaseBlocker).toContain("unverified");
    expect(requirementsFor("workflows", root).some((required: { file: string }) => required.file === EXTERNAL_ACCEPTANCE[0].file)).toBe(false);
  });

  it("covers direct PG-only suites and each parameterized backend suite independently", () => {
    const requirements = requirementsFor("platform-postgres", root);
    expect(requirements).toHaveLength(45);
    expect(requirements.filter((required) => required.file !== ecsGrantFile)).toHaveLength(39);
    expect(requirements).toContainEqual(expect.objectContaining({ file: "tests/controlplane/open.test.ts", suite: "platformDb() against PostgreSQL", backend: "postgres" }));
    expect(requirements).toContainEqual(expect.objectContaining({ file: "tests/controlplane/executor.test.ts", suite: "cross-engine shape identity", backend: "postgres" }));
    expect(requirements.filter((required: { file: string }) => required.file === "tests/capabilities/tenancy.test.ts")).toHaveLength(5);
  });

  it("requires both the fresh/reapply/checksum/rollback/emitted-SQL migrator and PostgreSQL concurrency suites", () => {
    const requirements = requirementsFor("platform-postgres", root).filter((required) => required.file === "tests/controlplane/migrations.test.ts");
    expect(requirements.map((required) => required.suite)).toEqual(["migrator [postgres]", "migrator [postgres] concurrency and fail-closed open"]);
    const report = {
      success: true,
      testResults: [{ name: path.resolve(root, "tests/controlplane/migrations.test.ts"), status: "passed", assertionResults: requirements.map((required) => ({ fullName: required.suite + " scenario", ancestorTitles: [required.suite], status: "passed" })) }],
    };
    expect(reportFailures(requirements, report, root)).toEqual([]);
    report.testResults[0].assertionResults.shift();
    expect(reportFailures(requirements, report, root)).toHaveLength(1);
  });

  it.each(["pglite", "skipped", "failed"])("rejects %s replacement of the real fresh migration suite even when concurrency passed", (replacement) => {
    const requirements = requirementsFor("platform-postgres", root).filter((required) => required.file === "tests/controlplane/migrations.test.ts");
    const assertions = requirements.map((required) => ({ fullName: required.suite + " scenario", ancestorTitles: [required.suite ?? ""], status: "passed" }));
    if (replacement === "pglite") {
      assertions[0].ancestorTitles = ["migrator ['pglite']"];
      assertions[0].fullName = "migrator ['pglite'] scenario";
    } else assertions[0].status = replacement;
    expect(reportFailures(requirements, { success: true, testResults: [{ name: path.resolve(root, requirements[0].file), status: "passed", assertionResults: assertions }] }, root)).toHaveLength(1);
  });

  it("retains fresh dependency installation and all core command exits", () => {
    expect(manifestFor("fresh", root).steps[0]).toEqual({ id: "install", command: ["npm", "ci", "--ignore-scripts"] });
    expect(manifestFor("core", root).steps.map((step: { id: string }) => step.id)).toEqual(["typecheck", "lint", "unit", "smoke", "gimbal"]);
  });

  it("exports a usable CLI without treating inherited object properties as lanes", () => {
    const script = path.resolve(root, "scripts/ci/gate-manifest.mjs");
    const result = spawnSync(process.execPath, [script, "external-acceptance"], { encoding: "utf8" });
    const group = JSON.parse(result.stdout).groups[0];
    expect(result.status).toBe(0);
    expect(group.status).toBe("unverified");
    expect(group.command).toContain("--testNamePattern");
    for (const lane of ["constructor", "unknown"]) {
      expect(() => manifestFor(lane, root)).toThrow("Unknown CI lane");
      expect(spawnSync(process.execPath, [script, lane], { encoding: "utf8" }).status).toBe(2);
    }
  });
});

describe("mandatory ECS replica repair gates", () => {
  it("executes both adapter contracts explicitly and pins all four focal files without duplicate requirements", () => {
    const workflow = manifestFor("workflows", root);
    for (const file of ecsFiles.slice(0, 2)) expect(workflow.command).toContain(file);
    for (const file of ecsFiles) {
      expect(workflow.requirements.filter((required) => required.file === file)).toHaveLength(file === ecsFiles[0] ? 3 : 1);
    }
    expect(manifestFor("platform-postgres", root).command).toContain(ecsGrantFile);
    expect(ecsPostgresRequirements().map((required) => required.suite)).toEqual(ecsPostgresSuites);
    for (const required of ecsPostgresRequirements()) {
      expect(required).toMatchObject({ ancestorSuite: "replica repair authority [postgres]", postgres: true });
    }
  });

  it("preserves every existing PostgreSQL requirement ID and binds new IDs to the exact outer suite", () => {
    for (const required of requirementsFor("platform-postgres", root).filter((item) => item.file !== ecsGrantFile)) {
      const suffix = createHash("sha256").update(`${required.suite ?? ""}:${required.postgres ?? false}`).digest("hex").slice(0, 12);
      expect(required.id).toBe(`platform-postgres:${required.file}:${suffix}`);
    }
    const required = ecsPostgresRequirements()[0];
    expect(requirementId("platform-postgres", { ...required, ancestorSuite: "other [postgres]" })).not.toBe(required.id);
    expect(assertionMatches({ ...required, postgres: true, ancestorSuite: "replica repair authority [pglite]" }, {
      fullName: "scenario", ancestorTitles: ["replica repair authority [pglite]", required.suite ?? ""],
    })).toBe(false);
  });

  it.each(["[postgres]", "['postgres']", '["postgres"]', "[ 'postgres' ]"])("accepts all six behaviors with genuine complete outer %s labels", (label) => {
    expect(reportFailures(ecsPostgresRequirements(), ecsGrantReport(`replica repair authority ${label}`), root)).toEqual([]);
  });

  it.each(["pglite", "failed", "skipped", "malformed"])("rejects %s grant evidence despite passing sibling behaviors", (failure) => {
    const report = ecsGrantReport();
    const assertion = report.testResults[0].assertionResults[0];
    if (failure === "pglite") assertion.ancestorTitles[0] = "replica repair authority [pglite]";
    else if (failure === "malformed") assertion.fullName = "";
    else assertion.status = failure;
    expect(reportFailures(ecsPostgresRequirements(), report, root).length).toBeGreaterThan(0);
  });

  it.each(ecsPostgresSuites)("requires the %s behavior independently", (missing) => {
    const report = ecsGrantReport();
    report.testResults[0].assertionResults = report.testResults[0].assertionResults.filter((assertion) => assertion.ancestorTitles[1] !== missing);
    expect(reportFailures(ecsPostgresRequirements(), report, root)).toHaveLength(1);
  });

  it.each(["other repair authority [postgres]", "replica repair authority ['postgres\"]", "replica repair authority [postgres-replica]", "replica repair authority [pglite]"])("rejects wrong or malformed outer %s even with a postgres test title", (outer) => {
    const report = ecsGrantReport(outer);
    for (const assertion of report.testResults[0].assertionResults) assertion.fullName += " mentions [postgres]";
    expect(reportFailures(ecsPostgresRequirements(), report, root)).toHaveLength(6);
  });

  it("rejects matching outer PostgreSQL ancestry when only leaf titles claim the required behavior", () => {
    const report = ecsGrantReport();
    for (const assertion of report.testResults[0].assertionResults) assertion.ancestorTitles = ["replica repair authority [postgres]", "other behavior"];
    expect(reportFailures(ecsPostgresRequirements(), report, root)).toHaveLength(6);
  });

  it.each(ecsFiles)("retains mandatory requirements when trusted source %s is deleted", (deleted) => {
    const sourceRoot = fs.mkdtempSync(path.join(scratch, "deleted-ecs-"));
    for (const directory of ["tests/workflows", "tests/platform", "tests/controlplane", "tests/capabilities", "tests/reconcile"]) {
      fs.cpSync(path.join(root, directory), path.join(sourceRoot, directory), { recursive: true });
    }
    for (const file of ecsFiles) {
      fs.mkdirSync(path.dirname(path.join(sourceRoot, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(sourceRoot, file));
    }
    const beforeWorkflows = requirementsFor("workflows", sourceRoot);
    const beforePostgres = requirementsFor("platform-postgres", sourceRoot);
    fs.unlinkSync(path.join(sourceRoot, deleted));
    const workflows = requirementsFor("workflows", sourceRoot);
    const postgres = requirementsFor("platform-postgres", sourceRoot);
    expect(workflows).toEqual(beforeWorkflows);
    expect(postgres).toEqual(beforePostgres);
    const required = workflows.filter((item) => item.file === deleted);
    expect(required.length).toBeGreaterThan(0);
    expect(reportFailures(required, { success: true, testResults: [] }, sourceRoot)).toHaveLength(required.length);
    if (deleted === ecsGrantFile) {
      const sql = postgres.filter((item) => item.file === ecsGrantFile);
      expect(sql).toHaveLength(6);
      expect(reportFailures(sql, { success: true, testResults: [] }, sourceRoot)).toHaveLength(6);
    }
  });
});

describe("stable backend ancestry", () => {
  it.each(["[postgres]", "['postgres']", '["postgres"]', "[ 'postgres' ]"])("accepts complete %s suite labels", (label) => {
    const assertion = { fullName: `leases ${label} passed`, ancestorTitles: ["leases " + label], status: "passed" };
    expect(assertionMatches({ suite: "leases [postgres]", postgres: true }, assertion)).toBe(true);
    expect(canonicalSuite("leases " + label)).toBe("leases [postgres]");
  });

  it.each(["['postgres\"]", "[postgres-replica]", "['pglite']", "[memory]"])("rejects %s and does not trust a postgres mention in a test title", (label) => {
    expect(assertionMatches({ suite: "leases [postgres]", postgres: true }, { fullName: `leases ${label} mentions [postgres]`, ancestorTitles: ["leases " + label] })).toBe(false);
  });

  it("accepts old unstructured backend evidence only if ancestry is unavailable", () => {
    expect(assertionMatches({ postgres: true }, { fullName: "leases ['postgres'] passed" })).toBe(true);
    expect(assertionMatches({ postgres: true }, { fullName: "leases [pglite] mentions [postgres]", ancestorTitles: ["leases [pglite]"] })).toBe(false);
  });

  it("normalizes quoted PostgresAuthority rows by exact ancestor identity", () => {
    for (const suite of ["PostgresAuthority", "'PostgresAuthority'", '"PostgresAuthority"']) {
      expect(assertionMatches({ suite: "PostgresAuthority" }, { fullName: suite + " contract", ancestorTitles: [suite] })).toBe(true);
    }
    expect(assertionMatches({ suite: "PostgresAuthority" }, { fullName: "OtherPostgresAuthority contract", ancestorTitles: ["OtherPostgresAuthority"] })).toBe(false);
  });

  it.each(["skipped", "failed", "pending", "todo", "unknown"])("rejects a %s scenario inside a mixed source file even when all other source suites passed", (status) => {
    const requirements = requirementsFor("workflows", root).filter((required: { file: string }) => required.file === "tests/platform/source-bundle.test.ts");
    const assertions = requirements.map((required) => ({ fullName: required.suite + " scenario", ancestorTitles: [required.suite], status: "passed" }));
    assertions[3].status = status;
    const report = { success: true, testResults: [{ name: path.resolve(root, requirements[0].file), status: "passed", assertionResults: assertions }] };
    expect(reportFailures(requirements, report, root).length).toBeGreaterThan(0);
  });

  it("rejects a missing live source scenario despite passing local source assertions", () => {
    const requirements = requirementsFor("workflows", root).filter((required: { file: string }) => required.file === "tests/platform/source-bundle.test.ts");
    const assertions = requirements.slice(0, 3).map((required) => ({ fullName: required.suite + " scenario", ancestorTitles: [required.suite], status: "passed" }));
    expect(reportFailures(requirements, { success: true, testResults: [{ name: path.resolve(root, requirements[0].file), status: "passed", assertionResults: assertions }] }, root)).toHaveLength(1);
  });
});
