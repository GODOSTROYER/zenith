/** Shared gate commands preserve required local engines and precisely scoped external acceptance. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assertionMatches, canonicalSuite, EXTERNAL_ACCEPTANCE, GATE_LANES, manifestFor, requirementsFor } from "../../scripts/ci/gate-manifest.mjs";
import { reportFailures } from "./assert-lane-report.mjs";

const root = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-manifest-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

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
    expect(requirements).toHaveLength(39);
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
