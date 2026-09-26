/**
 * The Postgres lane report must recognise the authority contract rows the way
 * vitest actually names them. `describe.each(authorities)("$name", …)` runs
 * `$name` through pretty-format, so a string row arrives single-quoted:
 * `'PostgresAuthority' ledgers …`. The first CI execution of the lane failed
 * the job with 161 Postgres assertions passing because the matcher looked for
 * the unquoted spelling; this pins both spellings and the zero-run failure.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve("scripts/ci/postgres-lane-report.mjs");

type Assertion = { fullName: string; ancestorTitles: string[]; title: string; status: "passed" | "skipped" };

function report(assertions: Assertion[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-lane-report-"));
  const file = path.join(dir, "report.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      numTotalTests: assertions.length,
      testResults: [{ name: "tests/hosted/authority/contract/ledgers.test.ts", assertionResults: assertions }],
    })
  );
  return file;
}

function run(file: string): { status: number | null; out: string } {
  const child = spawnSync(process.execPath, [SCRIPT, file], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
  });
  return { status: child.status, out: `${child.stdout}\n${child.stderr}` };
}

const passed = (fullName: string): Assertion => ({
  fullName,
  ancestorTitles: [fullName.split(" ").slice(0, 2).join(" ")],
  title: fullName.split(" ").slice(2).join(" "),
  status: "passed",
});

const LIVE_MIGRATE = passed("migrate against the real Supabase project applies in order and is idempotent");
// The two agent lanes the job also intends to run; present in every "should pass" fixture.
const AGENT_LANES = [
  passed("AgentLinkPostgres credentials issue verify revoke"),
  passed("AgentControlPostgres claims exactly one of two racing connections"),
];
const PRODUCT_SQL_LANES = [
  passed("WorkspaceSharingPostgres transfers ownership atomically"),
  passed("WaitlistPostgres admits concurrent queue batches without duplication"),
];

describe("postgres lane report", () => {
  it("counts the Postgres row under vitest's quoted $name spelling", () => {
    const { status, out } = run(
      report([
        passed("'SqliteAuthority' ledgers quota counters hands each caller the total that committed"),
        passed("'PostgresAuthority' ledgers quota counters hands each caller the total that committed"),
        LIVE_MIGRATE,
        ...AGENT_LANES,
        ...PRODUCT_SQL_LANES,
      ])
    );
    expect(out).not.toContain("produced 0 passing tests");
    expect(status).toBe(0);
  });

  it("still accepts the unquoted spelling", () => {
    const { status } = run(
      report([passed("PostgresAuthority ledgers quota counters hands each caller the total"), LIVE_MIGRATE, ...AGENT_LANES, ...PRODUCT_SQL_LANES])
    );
    expect(status).toBe(0);
  });

  it("fails the job when only the SQLite row ran", () => {
    const { status, out } = run(
      report([passed("'SqliteAuthority' ledgers quota counters hands each caller the total"), LIVE_MIGRATE, ...AGENT_LANES, ...PRODUCT_SQL_LANES])
    );
    expect(out).toContain("produced 0 passing tests");
    expect(status).toBe(1);
  });

  it("does not mistake a row whose name merely contains the word", () => {
    const { status } = run(
      report([passed("'NotPostgresAuthorityAtAll' ledgers something"), LIVE_MIGRATE, ...AGENT_LANES, ...PRODUCT_SQL_LANES])
    );
    expect(status).toBe(1);
  });
});

describe("postgres lane report, agent lanes", () => {
  it("fails the job when an agent contract file ran zero tests", () => {
    const { status, out } = run(
      report([passed("'PostgresAuthority' ledgers quota counters hands each caller the total"), LIVE_MIGRATE, AGENT_LANES[0], ...PRODUCT_SQL_LANES])
    );
    expect(out).toContain("agent.agent_operations");
    expect(status).toBe(1);
  });
});

describe("postgres lane report, workspace sharing and waitlist", () => {
  it.each(PRODUCT_SQL_LANES)("fails when $fullName is skipped", (lane) => {
    const assertions = [
      passed("PostgresAuthority transactions commit"),
      LIVE_MIGRATE,
      ...AGENT_LANES,
      ...PRODUCT_SQL_LANES.map((entry) => entry === lane ? { ...entry, status: "skipped" as const } : entry),
    ];
    const { status, out } = run(report(assertions));
    expect(status).toBe(1);
    expect(out).toContain("produced 0 passing tests");
    expect(out).toContain(lane === PRODUCT_SQL_LANES[0] ? "workspace sharing and ownership" : "waitlist queue and batch admissions");
  });

  it("accepts quoted product SQL suite names", () => {
    const { status } = run(report([
      passed("PostgresAuthority transactions commit"), LIVE_MIGRATE, ...AGENT_LANES,
      passed("'WorkspaceSharingPostgres' transfers ownership atomically"),
      passed("'WaitlistPostgres' admits queue batches atomically"),
    ]));
    expect(status).toBe(0);
  });
});
