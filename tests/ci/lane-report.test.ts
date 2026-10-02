/**
 * `scripts/ci/lane-report.mjs` is the gate that stops the policy, tofu,
 * workflows and platform-postgres jobs from being green while having run none
 * of the tests they exist for. Every one of those lanes has suites that skip
 * silently when a tool or an environment variable is missing, so the failure
 * modes pinned here are the ones that would otherwise look like success: an
 * all-skipped file, a lane that ran only on PGlite, a filter that matched no
 * files, and a requirement that switched on the moment its implementation
 * appeared.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = path.resolve("scripts/ci/lane-report.mjs");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-lane-gate-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

type Status = "passed" | "failed" | "skipped" | "pending";
interface T {
  fullName: string;
  status?: Status;
}
interface F {
  /** path as vitest reports it: absolute, forward slashes (or backslashes on Windows) */
  name: string;
  tests: T[];
}

const t = (fullName: string, status: Status = "passed"): T => ({ fullName, status });

/** A vitest JSON report in the shape `--reporter=json` writes. */
function writeReport(files: F[]): string {
  const file = path.join(fs.mkdtempSync(path.join(scratch, "report-")), "report.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      success: true,
      numTotalTests: files.reduce((n, f) => n + f.tests.length, 0),
      testResults: files.map((f) => ({
        name: f.name,
        status: "passed",
        assertionResults: f.tests.map((x) => ({
          fullName: x.fullName,
          ancestorTitles: [x.fullName.slice(0, x.fullName.lastIndexOf(" "))],
          title: x.fullName.split(" ").slice(1).join(" "),
          status: x.status ?? "passed",
        })),
      })),
    })
  );
  return file;
}

/** A repository root containing exactly these paths: directories, or empty files when the name has an extension. */
function rootWith(...paths: string[]): string {
  const root = fs.mkdtempSync(path.join(scratch, "root-"));
  for (const entry of paths) {
    if (path.extname(entry)) {
      fs.mkdirSync(path.dirname(path.join(root, entry)), { recursive: true });
      fs.writeFileSync(path.join(root, entry), "");
    } else fs.mkdirSync(path.join(root, entry), { recursive: true });
  }
  return root;
}

function run(lane: string, report: string, root: string): { status: number | null; out: string } {
  const child = spawnSync(process.execPath, [SCRIPT, lane, report, "--root", root], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
  });
  return { status: child.status, out: `${child.stdout}\n${child.stderr}` };
}

const REPO = "/home/runner/work/zenith/zenith";
const cp = (file: string): string => `${REPO}/tests/controlplane/${file}`;

describe("lane report: platform-postgres", () => {
  const live = () => rootWith("src/lib/controlplane/db");

  it("passes when the control store ran on Postgres, under vitest's quoted $name spelling", () => {
    const { status, out } = run(
      "platform-postgres",
      writeReport([
        {
          name: cp("leases.test.ts"),
          tests: [t("leases ['pglite'] claims once"), t("leases ['postgres'] claims once")],
        },
      ]),
      live()
    );
    expect(out).not.toContain("produced 0 passing tests");
    expect(status).toBe(0);
  });

  it("still accepts the unquoted [postgres] spelling", () => {
    const { status } = run(
      "platform-postgres",
      writeReport([{ name: cp("leases.test.ts"), tests: [t("leases [postgres] claims once")] }]),
      live()
    );
    expect(status).toBe(0);
  });

  it("fails when everything ran on PGlite, which is what a missing ZENITH_TEST_PLATFORM_PG_URL looks like", () => {
    const { status, out } = run(
      "platform-postgres",
      writeReport([{ name: cp("leases.test.ts"), tests: [t("leases ['pglite'] claims once")] }]),
      live()
    );
    expect(status).toBe(1);
    expect(out).toContain("the PostgreSQL half of describe.each(LANES)");
    expect(out).toContain("produced 0 passing tests");
  });

  it("fails when tests/controlplane ran zero tests and the implementation exists (vitest --passWithNoTests)", () => {
    const { status, out } = run("platform-postgres", writeReport([]), live());
    expect(status).toBe(1);
    expect(out).toContain("tests/controlplane/** (any test)");
  });

  it("does not fail before the implementation exists, and says the requirement is not yet live", () => {
    const { status, out } = run("platform-postgres", writeReport([]), rootWith());
    expect(status).toBe(0);
    expect(out).toContain("not yet required");
    expect(out).toContain("src/lib/controlplane/db");
  });

  it("does not count Postgres-named tests from outside tests/controlplane", () => {
    const { status } = run(
      "platform-postgres",
      writeReport([
        { name: `${REPO}/tests/capabilities/broker.test.ts`, tests: [t("broker ['postgres'] grants")] },
        { name: cp("leases.test.ts"), tests: [t("leases ['pglite'] claims once")] },
      ]),
      live()
    );
    expect(status).toBe(1);
  });

  it("does not count skipped or failed Postgres tests as the lane having run", () => {
    const { status } = run(
      "platform-postgres",
      writeReport([
        {
          name: cp("leases.test.ts"),
          tests: [t("leases ['pglite'] claims once"), t("leases ['postgres'] claims once", "skipped"), t("leases ['postgres'] renews", "failed")],
        },
      ]),
      live()
    );
    expect(status).toBe(1);
  });

  it("normalises Windows path separators", () => {
    const { status } = run(
      "platform-postgres",
      writeReport([
        { name: "Z:\\repo\\tests\\controlplane\\leases.test.ts", tests: [t("leases ['postgres'] claims once")] },
      ]),
      live()
    );
    expect(status).toBe(0);
  });

  it("lists capabilities and runners as informational and never requires them", () => {
    const { status, out } = run(
      "platform-postgres",
      writeReport([
        { name: cp("leases.test.ts"), tests: [t("leases ['postgres'] claims once")] },
        { name: `${REPO}/tests/capabilities/catalog.test.ts`, tests: [t("catalog lists", "passed")] },
      ]),
      live()
    );
    expect(status).toBe(0);
    expect(out).toContain("tests/capabilities/**");
    expect(out).toContain("tests/runners/**");
  });

  it("always states what the lane does not verify", () => {
    const { out } = run(
      "platform-postgres",
      writeReport([{ name: cp("leases.test.ts"), tests: [t("leases ['postgres'] claims once")] }]),
      live()
    );
    expect(out).toContain("NOT verified by this job");
    expect(out).toContain("row level security");
  });
});

describe("lane report: tofu", () => {
  const root = () => rootWith("src/lib/tofu/runner.ts");
  const file = (name: string): string => `${REPO}/tests/tofu/${name}`;
  const ran = (): F[] => [
    { name: file("network.test.ts"), tests: [t("real provider install installs random")] },
    { name: file("runner.test.ts"), tests: [t("TofuRunner plans")] },
  ];

  it("passes when the network suite and the runner suite both ran", () => {
    expect(run("tofu", writeReport(ran()), root()).status).toBe(0);
  });

  it("fails when the network suite was skipped, which is what a missing ZENITH_TEST_TOFU_NETWORK looks like", () => {
    const report = writeReport([
      { name: file("network.test.ts"), tests: [t("real provider install installs random", "skipped")] },
      ran()[1],
    ]);
    const { status, out } = run("tofu", report, root());
    expect(status).toBe(1);
    expect(out).toContain("tests/tofu/network.test.ts");
  });

  it("fails when the runner suite ran nothing because tofu was not on the path", () => {
    const report = writeReport([ran()[0], { name: file("runner.test.ts"), tests: [t("TofuRunner plans", "skipped")] }]);
    expect(run("tofu", report, root()).status).toBe(1);
  });

  it("reports the AWS driver suites when they exist but does not require them", () => {
    const report = writeReport([
      ...ran(),
      { name: `${REPO}/tests/providers/aws/drivers/ecs.test.ts`, tests: [t("ecs driver plans")] },
    ]);
    const { status, out } = run("tofu", report, root());
    expect(status).toBe(0);
    expect(out).toContain("tests/providers/aws/drivers");
  });

  it("states that no cloud API is exercised", () => {
    expect(run("tofu", writeReport(ran()), root()).out).toContain("Real cloud APIs");
  });
});

describe("lane report: policy", () => {
  const root = () => rootWith("policy/rego");
  const policy = (name: string): string => `${REPO}/tests/policy/${name}`;

  it("passes when the parity suite and another policy suite ran", () => {
    const { status } = run(
      "policy",
      writeReport([
        { name: policy("parity.test.ts"), tests: [t("the wasm agrees with the OPA interpreter matches")] },
        { name: policy("engine.test.ts"), tests: [t("engine decides")] },
      ]),
      root()
    );
    expect(status).toBe(0);
  });

  it("fails when the parity suite was skipped because opa was not installed", () => {
    const { status, out } = run(
      "policy",
      writeReport([
        { name: policy("parity.test.ts"), tests: [t("the wasm agrees with the OPA interpreter matches", "skipped")] },
        { name: policy("engine.test.ts"), tests: [t("engine decides")] },
      ]),
      root()
    );
    expect(status).toBe(1);
    expect(out).toContain("ZENITH_OPA_BIN");
  });
});

describe("lane report: workflows", () => {
  it("does not fail before the workflow implementation exists (--passWithNoTests)", () => {
    const { status, out } = run("workflows", writeReport([]), rootWith());
    expect(status).toBe(0);
    expect(out).toContain("not yet required");
  });

  it("fails once the implementation exists and tests/workflows ran nothing", () => {
    expect(run("workflows", writeReport([]), rootWith("src/lib/workflows/definitions")).status).toBe(1);
  });

  it("passes once the implementation exists and a workflow test ran", () => {
    const report = writeReport([{ name: `${REPO}/tests/workflows/deploy.test.ts`, tests: [t("deploy workflow completes")] }]);
    expect(run("workflows", report, rootWith("src/lib/workflows/definitions")).status).toBe(0);
  });
});

describe("lane report: input handling", () => {
  it("exits 2 for an unknown lane", () => {
    const { status, out } = run("nonsense", writeReport([]), rootWith());
    expect(status).toBe(2);
    expect(out).toContain("usage");
  });

  it("does not treat an inherited property name as a lane", () => {
    expect(run("constructor", writeReport([]), rootWith()).status).toBe(2);
  });

  it("fails rather than reporting a clean lane when the report cannot be read", () => {
    const { status, out } = run("policy", path.join(scratch, "does-not-exist.json"), rootWith("policy/rego"));
    expect(status).toBe(1);
    expect(out).toContain("Could not read the vitest JSON report");
  });
});
