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
import { afterAll, describe, expect, it } from "vitest";
import { OAUTH_GRANT_POSTGRES_REQUIREMENTS } from "../../scripts/ci/gate-manifest.mjs";

const SCRIPT = path.resolve("scripts/ci/postgres-lane-report.mjs");

type Assertion = { fullName: string; ancestorTitles: string[]; title: string; status: string };
interface SyntheticFile { name: string; status: string; assertionResults: Assertion[] }
interface SyntheticReport { success: boolean; numTotalTests: number; numFailedTests: number; testResults: SyntheticFile[] }
const ownedDirectories: string[] = [];
afterAll(() => { for (const dir of ownedDirectories) fs.rmSync(dir, { recursive: true, force: true }); });

function writeFixture(value: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-lane-report-")); ownedDirectories.push(dir);
  const file = path.join(dir, "report.json"); fs.writeFileSync(file, JSON.stringify(value)); return file;
}
// Complete synthetic file/ancestry evidence exercises the summary CLI. It is
// never native PostgreSQL proof. Exact ancestry follows actual source suites;
// display fullName retains the original quoted/unquoted compatibility controls.
function report(assertions: Assertion[], mutate?: (value: SyntheticReport) => void): string {
  const files = new Map<string, SyntheticFile>();
  const add = (file: string, assertion: Assertion) => {
    const entry = files.get(file) ?? { name: file, status: "passed", assertionResults: [] };
    entry.assertionResults.push(assertion); files.set(file, entry);
  };
  for (const assertion of assertions) {
    let file = "tests/hosted/authority/contract/ledgers.test.ts", suite = assertion.ancestorTitles[0];
    if (/^'?PostgresAuthority'?(?:\s|$)/.test(assertion.fullName)) suite = "PostgresAuthority ledgers";
    if (assertion.fullName.includes("against the real Supabase project")) { file = "tests/scripts/migrate-hosted-to-postgres.test.ts"; suite = "migrate-hosted-to-postgres — against the real Supabase project"; }
    for (const [label, target] of [
      ["AgentLinkPostgres", "tests/agent-link/pg-contract.test.ts"],
      ["AgentControlPostgres", "tests/agent-control/pg-contract.test.ts"],
      ["WorkspaceSharingPostgres", "tests/db/contract/workspace-sharing.test.ts"],
      ["WaitlistPostgres", "tests/waitlist/pg-contract.test.ts"],
    ]) if (new RegExp(`^'?${label}'?(?:\\s|$)`).test(assertion.fullName)) { file = target; suite = label; }
    add(file, { ...assertion, ancestorTitles: [suite] });
  }
  // The legacy authority summary groups four canonical source files. Seed the
  // other three only when the supplied fixture actually contains its PG row.
  if (assertions.some(assertion => /^'?PostgresAuthority'?(?:\s|$)/.test(assertion.fullName))) {
    for (const name of ["access", "contract", "release"]) add(`tests/hosted/authority/contract/${name}.test.ts`, {
      fullName: "PostgresAuthority canonical synthetic contract", ancestorTitles: ["PostgresAuthority"], title: "canonical synthetic contract", status: "passed",
    });
  }
  for (const required of OAUTH_GRANT_POSTGRES_REQUIREMENTS) add(required.file, {
    fullName: `${required.suite} ${required.test}`, ancestorTitles: [required.suite], title: required.test, status: "passed",
  });
  const value: SyntheticReport = { success: true, numFailedTests: 0,
    numTotalTests: [...files.values()].reduce((sum, file) => sum + file.assertionResults.length, 0), testResults: [...files.values()] };
  mutate?.(value); return writeFixture(value);
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


const completeLegacy = () => [passed("PostgresAuthority ledgers canonical synthetic contract"), LIVE_MIGRATE, ...AGENT_LANES, ...PRODUCT_SQL_LANES];
const oauthEvidence = (value: SyntheticReport) => value.testResults.find(file => file.name === "tests/agent-control/pg-oauth-grants.test.ts")!;
describe("postgres lane report, canonical OAuth admission", () => {
  it("requires the complete 71-case native group alongside all nine prior source groups", () => {
    const { status, out } = run(report(completeLegacy()));
    expect(status).toBe(0); expect(out).toContain("71 native retained OAuth grant/schema controls");
    expect(out).toContain("upstream OAuth identity is modeled");
  });
  it.each([0, 35, 70])("refuses missing native OAuth literal identity at index %s even with passing siblings", index => {
    const { status, out } = run(report(completeLegacy(), value => {
      const file = oauthEvidence(value); file.assertionResults.splice(index, 1); value.numTotalTests--;
    }));
    expect(status).toBe(1); expect(out).toContain("Canonical PostgreSQL requirements failed");
    expect(out).toContain("71 native retained OAuth grant/schema controls");
  });
  it.each(["failed", "skipped", "pending", "todo", "unknown"])("refuses %s OAuth evidence even when the group remains nonzero", status => {
    const child = run(report(completeLegacy(), value => { oauthEvidence(value).assertionResults[0].status = status; }));
    expect(child.status).toBe(1); expect(child.out).toContain("Canonical PostgreSQL requirements failed");
  });
  it.each(["pglite", "foreign ancestry", "foreign file", "substituted title", "zero", "duplicate", "failed run", "failed file", "inconsistent counts", "empty fullName"])("refuses %s canonical OAuth report without weakening legacy checks", mode => {
    const child = run(report(completeLegacy(), value => {
      const file = oauthEvidence(value), row = file.assertionResults[0];
      if (mode === "pglite") row.ancestorTitles = ["OAuth resource grant journal [pglite]"];
      if (mode === "foreign ancestry") row.ancestorTitles = ["another journal [postgres]"];
      if (mode === "foreign file") file.name = "tests/agent-control-journal.test.ts";
      if (mode === "substituted title") row.title = "a modeled OAuth success";
      if (mode === "zero") { value.numTotalTests -= file.assertionResults.length; file.assertionResults = []; }
      if (mode === "duplicate") value.testResults.push(file);
      if (mode === "failed run") value.success = false;
      if (mode === "failed file") file.status = "failed";
      if (mode === "inconsistent counts") value.numTotalTests = 0;
      if (mode === "empty fullName") row.fullName = "";
    }));
    expect(child.status).toBe(1); expect(child.out).toContain("Canonical PostgreSQL requirements failed");
  });
  it("refuses a skipped canonical legacy assertion even with another passing assertion in that summary group", () => {
    const child = run(report(completeLegacy(), value => {
      const file = value.testResults.find(file => file.name === "tests/agent-control/pg-contract.test.ts")!;
      file.assertionResults[0].status = "skipped";
      file.assertionResults.push({ fullName: "AgentControlPostgres a passing sibling", ancestorTitles: ["AgentControlPostgres"], title: "a passing sibling", status: "passed" }); value.numTotalTests++;
    }));
    expect(child.status).toBe(1); expect(child.out).toContain("Canonical PostgreSQL requirements failed");
  });
  it.each([null, {}, { success: true, testResults: [null] }, { success: true, testResults: [{ name: "tests/agent-control/pg-oauth-grants.test.ts", status: "passed", assertionResults: [null] }] }])("refuses malformed report fixture %# with fixed summary failure", value => {
    const child = run(writeFixture(value)); expect(child.status).toBe(1); expect(child.out).toContain("Canonical PostgreSQL requirements failed");
  });
});
