#!/usr/bin/env node
/**
 * Decide whether a platform CI lane actually ran what it claims to, and say in
 * the job summary what it could not verify.
 *
 * This is the same lesson as `postgres-lane-report.mjs`, applied to the four
 * lanes added for the platform modules (`policy`, `tofu`, `workflows`,
 * `platform-postgres` in .github/workflows/ci.yml). Every one of them has tests
 * that SKIP, silently and green, when a tool or an environment variable is
 * missing:
 *
 *   tests/policy/parity.test.ts            describe.skipIf(!opaAvailable)
 *   tests/tofu/network.test.ts             describe.skipIf(!(ZENITH_TEST_TOFU_NETWORK && tofu))
 *   tests/tofu/runner.test.ts              it.skipIf(!hasTofu)
 *   tests/controlplane/**                  describe.each(LANES): the Postgres lane
 *                                          is simply absent without ZENITH_TEST_PLATFORM_PG_URL
 *
 * A green job in which the gated half never ran looks exactly like one in which
 * it did, so the job is told what it must have run and this script reads the
 * vitest JSON report to check. Zero passing tests in a required lane is a
 * failure, not a pass.
 *
 * ## "Required" is conditional on the implementation existing
 *
 * These jobs run `vitest --passWithNoTests`, so they are valid before the
 * workstreams that own their tests have landed. A requirement therefore carries
 * `whenExists`: a path, relative to the repository root, that marks the
 * implementation being present. Once it exists the requirement is live, and a
 * job whose tests vanished (deleted, renamed out of the filter, skipped) fails
 * rather than passing vacuously. Before it exists the row is reported as
 * "not yet required" — visible on the run, never implied green.
 *
 * ## How a test is matched
 *
 * By the path of the file it lives in, which is stable, except for the one lane
 * whose point is a runtime condition: `platform-postgres` must show tests that
 * ran against the PostgreSQL lane. `tests/controlplane/_support/harness.ts`
 * builds `describe.each(LANES)("<suite> [$name]")`, and vitest formats `$name`
 * with pretty-format, so a passing Postgres test is named
 * `leases ['postgres'] claims once` (verified against vitest's JSON output; the
 * unquoted `[postgres]` is accepted too). If that naming convention changes,
 * this script fails loudly with zero Postgres tests, which is the correct
 * direction to be wrong in.
 *
 * Usage:  node scripts/ci/lane-report.mjs <lane> <vitest-json-report> [--root <repo root>]
 * Lanes:  policy | tofu | workflows | platform-postgres
 * Exit:   0 every live requirement ran, 1 otherwise (or the report is unreadable),
 *         2 usage error.
 */
import fs from "node:fs";
import path from "node:path";
import { assertionMatches, requirementsFor } from "./gate-manifest.mjs";
import { reportFailures } from "../../tests/ci/assert-lane-report.mjs";

/* --------------------------------- matchers -------------------------------- */

const norm = (file) => String(file).replaceAll("\\", "/");
/** The exact file, at the end of an absolute or relative path. */
const file = (relative) => (a) => norm(a.file) === relative || norm(a.file).endsWith(`/${relative}`);
/** Anything under a directory. */
const under = (dir) => (a) => norm(a.file).startsWith(`${dir}/`) || norm(a.file).includes(`/${dir}/`);
/** The `[$name]` the platform harness gives its Postgres lane. */
const isPostgres = (a) => assertionMatches({ postgres: true }, a);
const both = (...fns) => (a) => fns.every((fn) => fn(a));

/* ---------------------------------- lanes ---------------------------------- */

/**
 * `required`      must have >= 1 passing test once `whenExists` is present.
 * `informational` counted and shown, never failing (the tests may not exist yet,
 *                 or may legitimately be in-process only).
 * `blocked`       what the lane does NOT verify. Stated so that an absent
 *                 guarantee is visible on the run rather than inferred.
 */
const LANES = {
  policy: {
    title: "OPA policy lane",
    required: [
      {
        label: "tests/policy/parity.test.ts (the wasm agrees with the OPA interpreter)",
        match: file("tests/policy/parity.test.ts"),
        whenExists: "policy/rego",
        why: "Needs the pinned `opa` binary (ZENITH_OPA_BIN); the suite is skipped, silently, when it is absent.",
      },
      {
        label: "tests/policy/** (bundle, engine, scenarios)",
        match: under("tests/policy"),
        whenExists: "policy/rego",
        why: "The policy suites did not run at all.",
      },
    ],
    informational: [],
    blocked: [
      {
        lane: "Other OPA versions",
        reason: "The bundle is compiled and compared with exactly one OPA (1.19.1, linux/amd64 static); another version is a different artifact (policy/build.mjs).",
      },
      {
        lane: "Policy correctness beyond the written scenarios",
        reason: "This lane proves the compiled bundle is the committed one and that the wasm agrees with the interpreter; it does not prove the rules encode what the business intends where no scenario says so.",
      },
    ],
  },

  tofu: {
    title: "OpenTofu lane",
    required: [
      {
        label: "tests/tofu/network.test.ts (real providers through the committed lockfiles)",
        match: file("tests/tofu/network.test.ts"),
        whenExists: "src/lib/tofu/runner.ts",
        why: "Gated on ZENITH_TEST_TOFU_NETWORK=1 and a tofu binary (ZENITH_TOFU_BIN); skipped, silently, without both.",
      },
      {
        label: "tests/tofu/runner.test.ts (the runner against a real tofu)",
        match: file("tests/tofu/runner.test.ts"),
        whenExists: "src/lib/tofu/runner.ts",
        why: "Several cases are skipIf(!hasTofu); without the binary they vanish into the skipped count.",
      },
    ],
    informational: [
      { label: "tests/providers/aws/drivers (AWS drivers, mocked SDK)", match: under("tests/providers/aws/drivers") },
    ],
    blocked: [
      {
        lane: "Real cloud APIs",
        reason: "No cloud credentials exist in this job and nothing in tests/tofu calls a cloud API (tests/tofu/network.test.ts header). Providers are installed and schemas loaded; an AWS apply is not exercised here. See live-acceptance.yml.",
      },
      {
        lane: "Registry availability",
        reason: "The lane installs providers from registry.opentofu.org. An outage fails the job rather than skipping it; the plugin cache only softens repeat runs.",
      },
    ],
  },

  workflows: {
    title: "Temporal workflows lane",
    required: [
      {
        label: "tests/workflows/** (workflows on a real Temporal dev server)",
        match: under("tests/workflows"),
        whenExists: "src/lib/workflows/definitions",
        why: "The tests start their own dev server from ZENITH_TEMPORAL_CLI; if it is missing they skip or fail to start.",
      },
    ],
    informational: [],
    blocked: [
      {
        lane: "Temporal Cloud or a clustered server",
        reason: "Only `temporal server start-dev` (single process, in-memory) is used. Persistence, multi-worker contention, namespace auth and TLS are not exercised (ledger blocker B-TEMPORAL-CLOUD).",
      },
      {
        lane: "Replay compatibility across deploys",
        reason: "Only what tests/workflows replays is covered; histories from a previous release are not available to this job.",
      },
    ],
  },

  "platform-postgres": {
    title: "Platform PostgreSQL lane",
    required: [
      {
        label: "tests/controlplane/** (any test)",
        match: under("tests/controlplane"),
        whenExists: "src/lib/controlplane/db",
        why: "The control-store suites did not run at all, though the implementation exists.",
      },
      {
        label: "tests/controlplane/** (the PostgreSQL half of describe.each(LANES))",
        match: both(under("tests/controlplane"), (a) => isPostgres(a)),
        whenExists: "src/lib/controlplane/db",
        why: "Every suite also runs on PGlite, so a job with ZENITH_TEST_PLATFORM_PG_URL unset is green having touched no Postgres. The Postgres lane is named `[postgres]` by tests/controlplane/_support/harness.ts.",
      },
    ],
    informational: [
      { label: "tests/capabilities/**", match: under("tests/capabilities") },
      { label: "tests/runners/**", match: under("tests/runners") },
    ],
    blocked: [
      {
        lane: "Supabase's deployed role graph, PostgREST and RLS as a non-bypass role",
        reason: "The container is bare PostgreSQL 16.15 and the suites connect as its superuser, which bypasses row level security. Tenant isolation proven here is the `workspace_id` scoping in SQL, not RLS.",
      },
      {
        lane: "Connection poolers and other PostgreSQL versions",
        reason: "No Supavisor/PgBouncer in front of the database, and only the pinned 16.15 image is used.",
      },
    ],
  },
};

/* --------------------------------- plumbing -------------------------------- */

const args = process.argv.slice(2);
const rootFlag = args.indexOf("--root");
const root = rootFlag >= 0 ? args[rootFlag + 1] : process.cwd();
const positional = args.filter((arg, index) => !arg.startsWith("--") && !(rootFlag >= 0 && index === rootFlag + 1));
const [laneName, reportPath] = positional;
const lane = Object.hasOwn(LANES, laneName ?? "") ? LANES[laneName] : undefined;

if (!lane || !reportPath || (rootFlag >= 0 && !root)) {
  console.error(
    `::error::usage: node scripts/ci/lane-report.mjs <${Object.keys(LANES).join("|")}> <vitest-json-report> [--root <repo root>]`
  );
  process.exit(2);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
} catch {
  // An unreadable report means the run did not get far enough to write one. It
  // must not be reported as "nothing was skipped".
  console.error("::error::Could not read the vitest JSON report; evidence is unavailable or invalid.");
  process.exit(1);
}

if (!report || typeof report !== "object" || !Array.isArray(report.testResults) || report.success !== true || report.testResults.some((entry) => !entry || typeof entry.name !== "string" || !Array.isArray(entry.assertionResults) || entry.assertionResults.some((assertion) => !assertion || typeof assertion.fullName !== "string" || !["passed", "failed", "pending", "skipped", "todo"].includes(assertion.status)))) {
  console.error("::error::Malformed or unsuccessful Vitest report.");
  process.exit(1);
}

const assertions = [];
for (const testFile of report.testResults ?? [])
  for (const assertion of testFile.assertionResults ?? [])
    assertions.push({
      file: testFile.name ?? "",
      fullName: assertion.fullName ?? [...(assertion.ancestorTitles ?? []), assertion.title ?? ""].join(" "),
      status: assertion.status ?? "unknown",
      ancestorTitles: assertion.ancestorTitles,
    });

const isSkipped = (a) => a.status === "pending" || a.status === "skipped" || a.status === "todo";
const passed = assertions.filter((a) => a.status === "passed");
const skipped = assertions.filter(isSkipped);
const failed = assertions.filter((a) => a.status === "failed");

const summaryFile = process.env.GITHUB_STEP_SUMMARY;
let summary = "";
const say = (line = "") => {
  summary += `${line}\n`;
};
const cell = (text) => String(text).replaceAll("|", "\\|").replaceAll("\n", " ");

/* ------------------------------- the verdict ------------------------------- */

const requirements = lane.required.map((req) => {
  const live = req.whenExists === undefined || fs.existsSync(path.resolve(root, req.whenExists));
  const ran = passed.filter(req.match).length;
  const lost = skipped.filter(req.match).length;
  return { ...req, live, ran, lost, ok: !live || ran > 0 };
});
const missing = requirements.filter((req) => !req.ok);
// Historical pre-implementation roots remain explicitly not-yet-required. In
// the actual checkout, summaries and the execution gate share strict contracts.
let strictFailures = [];
const testDirectory = laneName === "platform-postgres" ? "tests/controlplane" : `tests/${laneName}`;
if (fs.existsSync(path.join(root, testDirectory))) {
  try { strictFailures = reportFailures(requirementsFor(laneName, root), report, root); }
  catch { strictFailures = ["Canonical required source scenarios are unavailable or invalid"]; }
}
if (report.testResults.some((entry) => entry.status !== "passed") || failed.length > 0) strictFailures.push("Vitest files or assertions failed");
const names = report.testResults.map((entry) => norm(entry.name));
if (new Set(names).size !== names.length) strictFailures.push("Duplicate Vitest file evidence");

say(`## ${lane.title}`);
say();
say(`Total: **${passed.length} passed**, ${failed.length} failed, ${skipped.length} skipped, across ${(report.testResults ?? []).length} files.`);
say();
say("### What this job was required to run");
say();
say("| Requirement | Passing tests | Skipped | Verdict |");
say("|---|---:|---:|---|");
for (const req of requirements) {
  const verdict = !req.live ? `not yet required (\`${req.whenExists}\` does not exist)` : req.ok ? "RAN" : "**DID NOT RUN**";
  say(`| ${cell(req.label)} | ${req.ran} | ${req.lost} | ${verdict} |`);
}
say();

if (lane.informational.length > 0) {
  say("### Also run here (informational)");
  say();
  say("| Suite | Passing tests | Skipped |");
  say("|---|---:|---:|");
  for (const info of lane.informational)
    say(`| ${cell(info.label)} | ${passed.filter(info.match).length} | ${skipped.filter(info.match).length} |`);
  say();
}

for (const req of requirements.filter((r) => r.live && r.ok && r.lost > 0))
  console.log(`::warning::${req.lost} test(s) skipped in "${req.label}"; the rest of the lane ran.`);

say("### NOT verified by this job, and not green");
say();
say("| What | Why |");
say("|---|---|");
for (const row of lane.blocked) say(`| ${cell(row.lane)} | ${cell(row.reason)} |`);
say();

if (missing.length > 0) {
  say("> **This job failed.** " + missing.map((req) => `\`${req.label}\` produced no passing tests.`).join(" "));
  say("> A lane that ran none of the tests it exists for is not evidence of anything.");
}

if (summaryFile) fs.appendFileSync(summaryFile, summary);
else process.stdout.write(summary);

for (const req of missing) console.error(`::error::"${req.label}" produced 0 passing tests. ${req.why}`);

for (const failure of strictFailures) console.error(`::error::${failure}`);
process.exit(missing.length > 0 || strictFailures.length > 0 ? 1 : 0);
