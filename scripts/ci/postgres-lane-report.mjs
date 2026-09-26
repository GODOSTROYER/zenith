#!/usr/bin/env node
/**
 * Decide whether the `postgres` job in .github/workflows/ci.yml actually
 * verified anything, and say — in the job summary — which lanes it could not.
 *
 * ## The problem this exists for
 *
 * Every live contract lane in this repository is gated on environment
 * variables and, when they are absent, *skips silently*:
 *
 *   tests/hosted/authority/contract/_factories.ts:79-80   ZENITH_CONTRACT_POSTGRES + SUPABASE_DB_URL
 *   tests/db/contract/factories.ts:31-34                  ZENITH_CONTRACT_POSTGRES + NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   tests/hosted/data/pg-contract.live.test.ts:38-41      the same three
 *   tests/hosted/artifacts/storage-store.test.ts:344-346  the same three
 *
 * The authority contract suites are `describe.each` over a factory table, so a
 * missing Postgres row does not skip a test — it removes it. The run is green
 * with the SQLite row alone, and a green run that exercised no Postgres looks
 * exactly like a green run that did. `postgresSkipReason()` exists
 * (`_factories.ts:83-88`) and is printed to the console, but a console line in
 * a nine-hundred-test log is not a gate.
 *
 * So this reads vitest's JSON report and requires, by name, that each lane the
 * job *intended* to run produced passing tests. Zero is a failure, not a pass.
 *
 * It also writes the blocked-lane table to $GITHUB_STEP_SUMMARY. A lane with no
 * credentials must be visible as BLOCKED on the run's own page — never absent,
 * never implied green.
 *
 * Usage:  node scripts/ci/postgres-lane-report.mjs <vitest-json-report>
 * Exit:   0 every intended lane ran, 1 otherwise (or the report is unreadable).
 */
import fs from "node:fs";

/**
 * The lanes this job intends to run, and how to recognise one in the report.
 *
 * `match` is applied to a test's full name. The authority contract files are
 * `describe.each(authorities)("$name", …)`, so every Postgres assertion's name
 * starts with the row name — which is precisely the thing that vanishes when
 * the factory table has one row. Vitest formats `$name` with pretty-format, so
 * a string row name arrives quoted: `'PostgresAuthority' ledgers …`. The first
 * CI run of this job failed on exactly that, with 161 Postgres assertions
 * passing; the matcher accepts both spellings and is pinned by
 * tests/ci/postgres-lane-report.test.ts.
 */
const ROW_NAME = /^'?PostgresAuthority'?(?:\s|$)/;
const INTENDED = [
  {
    id: "hosted-authority-contract",
    label: "tests/hosted/authority/contract/** (Postgres row)",
    match: (fullName) => ROW_NAME.test(fullName),
    why: "The hosted control authority over a direct Postgres connection (src/lib/hosted/authority/pg/client.ts).",
  },
  {
    id: "migrate-hosted-live",
    label: "tests/scripts/migrate-hosted-to-postgres.test.ts (live half)",
    match: (fullName) => fullName.includes("against the real Supabase project"),
    why: "The one-shot hosted migration, run for real: order, idempotence, and the three type conversions.",
  },
  {
    id: "agent-link-pg-contract",
    label: "tests/agent-link/pg-contract.test.ts (agent.agent_credentials, agent_link_codes, agent_rate_limits)",
    match: (fullName) => /^'?AgentLinkPostgres'?(?:\s|$)/.test(fullName),
    why: "The credential lifetime, the single-use device-code exchange, and the durable rate-limit window, against the real agent schema (supabase/migrations/0006_agent_link.sql).",
  },
  {
    id: "agent-control-pg-contract",
    label: "tests/agent-control/pg-contract.test.ts (agent.agent_operations)",
    match: (fullName) => /^'?AgentControlPostgres'?(?:\s|$)/.test(fullName),
    why: "The claim, the fence, the lease and the reconciliation, raced from two independent connections (supabase/migrations/0007_agent_control.sql).",
  },
  {
    id: "workspace-sharing-pg-contract",
    label: "tests/db/contract/workspace-sharing.test.ts (workspace sharing and ownership)",
    match: (fullName) => /^'?WorkspaceSharingPostgres'?(?:\s|$)/.test(fullName),
    why: "Workspace membership permissions and ownership transfers under concurrent requests (supabase/migrations/0008_workspace_ownership.sql).",
  },
  {
    id: "waitlist-pg-contract",
    label: "tests/waitlist/pg-contract.test.ts (waitlist queue and batch admissions)",
    match: (fullName) => /^'?WaitlistPostgres'?(?:\s|$)/.test(fullName),
    why: "Queue ordering, duplicate joins, service-role boundaries and concurrent batch admissions (supabase/migrations/0009_waitlist.sql).",
  },
];

/**
 * Lanes that exist, are not run here, and must not be mistaken for passing.
 *
 * The first three are the honest answer to "why not just run every contract
 * lane against the container": they do not speak Postgres. They speak
 * PostgREST — `@supabase/supabase-js` over HTTP — so a bare Postgres container
 * satisfies none of their preconditions. Faking a URL would make them fail, not
 * pass, and faking a PostgREST would be testing the fake.
 */
const BLOCKED = [
  {
    lane: "tests/db/contract/** (PostgREST product store; direct-SQL sharing suite runs above)",
    reason:
      "Needs PostgREST: the factory builds `PostgresStore`, which talks to NEXT_PUBLIC_SUPABASE_URL with SUPABASE_SERVICE_ROLE_KEY over HTTP (tests/db/contract/factories.ts:31-34). A bare Postgres container cannot serve it.",
    unblocks: "A Supabase project, or a PostgREST container in front of this database.",
  },
  {
    lane: "tests/hosted/data/pg-contract.live.test.ts",
    reason:
      "Same: `hostedPgClient()` is a supabase-js client and the suite probes `rpc('app_record_update_atomic')` over PostgREST (pg-contract.live.test.ts:38-41,60-74).",
    unblocks: "A Supabase project with the `hosted` schema exposed, or PostgREST.",
  },
  {
    lane: "tests/hosted/artifacts/storage-store.test.ts (live bucket)",
    reason: "Needs a Supabase Storage bucket and service-role key (storage-store.test.ts:344-346).",
    unblocks: "Supabase credentials plus the `zenith-artifacts` bucket.",
  },
  {
    lane: "Cloudflare / D1 runtime",
    reason:
      "No workflow touches it and no credential exists. ZENITH_RUNTIME=cloudflare has zero acceptance evidence.",
    unblocks: "ZENITH_CF_ACCOUNT_ID / _NAMESPACE / _PROBE_URL and ZENITH_CF_API_TOKEN.",
  },
  {
    lane: "E2B build runner (live)",
    reason:
      "Provider-side egress enforcement, VM teardown and inter-job contamination are unverified; only the local policy is tested.",
    unblocks: "E2B_API_KEY and a published template digest.",
  },
  {
    lane: "Docker build runner (live image)",
    reason:
      "CI's `hosted` job runs ZENITH_BUILD_RUNNER=recipe-local, which has no network policy at all. The docker runner's isolation flags are asserted statically, never executed.",
    unblocks: "A CI lane that builds docker/recipe and runs one job through the docker runner.",
  },
  {
    lane: "SMTP / invitation delivery",
    reason: "No mail credentials in CI; delivery is exercised against doubles only.",
    unblocks: "A disposable SMTP sink and its credentials.",
  },
  {
    lane: "S3 / Supabase Storage backup-restore drill",
    reason:
      "`npm run hosted:backup-live-check` is wired to LocalStack locally and to nothing in CI, so no RPO/RTO is measured.",
    unblocks: "A LocalStack service container in this workflow, or real bucket credentials.",
  },
  {
    lane: "OAuth provider sign-in",
    reason: "No provider client ids or secrets in CI; the provider paths run against doubles.",
    unblocks: "Test-tenant credentials for each provider.",
  },
];

/* --------------------------------- plumbing -------------------------------- */

const reportPath = process.argv[2];
if (!reportPath) {
  console.error("::error::usage: node scripts/ci/postgres-lane-report.mjs <vitest-json-report>");
  process.exit(1);
}

/** Append to the job summary when GitHub gave us one; otherwise stdout. */
const summaryFile = process.env.GITHUB_STEP_SUMMARY;
let summary = "";
const say = (line = "") => {
  summary += `${line}\n`;
};

let report;
try {
  report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
} catch (error) {
  // An unreadable report is itself a failure: it means the run did not get far
  // enough to produce one, and we must not report that as "nothing skipped".
  console.error(
    `::error::Could not read the vitest JSON report at ${reportPath}: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
}

/**
 * Every assertion in the run, flattened.
 *
 * `fullName` in vitest's jest-compatible report is the ancestor titles and the
 * test title joined by a single space, so `describe.each(authorities)("$name")`
 * puts `PostgresAuthority` at its head — the thing that disappears when the
 * factory table has one row. `suite` is the outermost `describe`, used only for
 * grouping the skip warnings.
 */
const assertions = [];
for (const file of report.testResults ?? [])
  for (const assertion of file.assertionResults ?? [])
    assertions.push({
      file: file.name ?? "",
      suite: (assertion.ancestorTitles ?? [])[0] ?? assertion.title ?? file.name ?? "(unnamed)",
      fullName: assertion.fullName ?? [...(assertion.ancestorTitles ?? []), assertion.title ?? ""].join(" "),
      status: assertion.status ?? "unknown",
    });

const passed = assertions.filter((a) => a.status === "passed");
const skipped = assertions.filter((a) => a.status === "pending" || a.status === "skipped" || a.status === "todo");
const failed = assertions.filter((a) => a.status === "failed");

/* ------------------------------- the verdict ------------------------------- */

const results = INTENDED.map((lane) => {
  const ran = passed.filter((a) => lane.match(a.fullName)).length;
  const lost = skipped.filter((a) => lane.match(a.fullName)).length;
  return { ...lane, ran, lost, ok: ran > 0 };
});

const missing = results.filter((lane) => !lane.ok);

say("## PostgreSQL lane");
say();
say(`Total: **${passed.length} passed**, ${failed.length} failed, ${skipped.length} skipped, across ${(report.testResults ?? []).length} files.`);
say();
say("### Lanes this job intended to run");
say();
say("| Lane | Passing tests | Verdict |");
say("|---|---:|---|");
for (const lane of results) say(`| ${lane.label} | ${lane.ran} | ${lane.ok ? "RAN" : "**DID NOT RUN**"} |`);
say();

if (skipped.length > 0) {
  // Warnings, not failures: a test may be skipped for a legitimate reason
  // inside a lane that otherwise ran. The failure condition is a lane with
  // *zero* passing tests, which is checked above.
  say("### Skipped inside this job");
  say();
  const bySuite = new Map();
  for (const a of skipped) bySuite.set(a.suite, (bySuite.get(a.suite) ?? 0) + 1);
  say("| Suite | Skipped |");
  say("|---|---:|");
  for (const [suite, count] of [...bySuite].sort()) {
    say(`| ${suite} | ${count} |`);
    console.log(`::warning::${count} test(s) skipped in "${suite}" inside the postgres lane.`);
  }
  say();
}

say("### BLOCKED — not verified by this run, and not green");
say();
say("Each of these is a lane that exists in the repository and that nothing in CI executes.");
say("They are recorded here so that an absent lane is visible on the run, rather than inferred from silence.");
say();
say("| Lane | Why it cannot run here | What would unblock it |");
say("|---|---|---|");
for (const row of BLOCKED) say(`| ${row.lane} | ${row.reason} | ${row.unblocks} |`);
say();
for (const row of BLOCKED) console.log(`::warning::BLOCKED lane: ${row.lane} — ${row.reason}`);

if (missing.length > 0) {
  say("> **This job failed.** " + missing.map((lane) => `\`${lane.label}\` produced no passing tests.`).join(" "));
  say("> A Postgres lane that ran zero Postgres tests is not evidence of anything.");
}

if (summaryFile) fs.appendFileSync(summaryFile, summary);
else process.stdout.write(summary);

for (const lane of missing)
  console.error(
    `::error::Lane "${lane.label}" produced 0 passing tests. ${lane.why} ` +
      "Check ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL are exported to the vitest step."
  );

process.exit(missing.length > 0 ? 1 : 0);
