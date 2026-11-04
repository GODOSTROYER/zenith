# CodeBuild launch authority

Written against branch `ws/prod-default-accepted-20261003`, based on reviewed authority guide source at `15ce74f81a4919d1d12780d1e7c95445595bbceb` (2026-10-03). This metadata refresh is source-only; prepared tests and live identity/provider limits below are not new runtime evidence. The [launch repository](../../../src/lib/controlplane/db/repos/build-launches.ts) and [current-role resolver](../../../src/lib/capabilities/current-product-roles.ts) supply the canonical authority boundary.

The permanent CodeBuild claim reads policy, environment settings and consumed
approval identities through a new `PlatformBrokerStore(tx)` attached to the same
PostgreSQL transaction that owns the launch locks and receipt insertion. It
constructs the canonical broker internally. A process-wide registered broker,
a memory store, or a test override cannot supply those reads to a production
claim. The public claim accepts only its SQL handle, immutable launch binding
and environment fence. It accepts no proof, approval boolean or broker callback.

## Lock and evaluation boundary

The existing order remains environment fence, running operation, succeeded
original plan use, verified provider/environment connection, managed resource
rows, and an existing launch receipt row. The final canonical evaluation happens
only after all those potentially blocking locks. It first captures the owning
SQL workspace policy and environment settings as detached, deeply frozen data:
exact scope, row presence/absence, version, complete policy parameters and
autonomy. Its fixed internal store reads return that same captured state to the
evaluator. The evaluator cannot mutate the final CAS inputs or silently refresh
a different state while checking approvers. It reuses the authentic broker
and policy evaluator, with the canonical scope resolver bound to the transaction,
canonical policy bundle loader and signer, and current product role resolver.
No signer key is read or grant issued by this read-only evaluation.

Platform policy, autonomy and approvals use the claimed transaction rather than
an outer pool. A supported pool size of one can therefore complete the claim;
it does not reserve its only connection and then wait for that connection again.
The final insertion/recovery CAS still checks the database clock, fence,
operation holder, execution lease, proposal/input/plan digests, approval round,
exact consumed human approval IDs and their expiry. BOTH insertion and retained
launch recovery additionally compare the captured settings to current owning SQL
rows: version and exact JSON parameters/autonomy must match, or the row must
still be absent. A foreign existing environment setting never becomes a default
of this workspace. A changed version, even with equal parameter values, refuses;
row creation/deletion refuses too. There is no reevaluation, refresh, retry or
policy-default substitution after a mismatch. The single SDK attempt is
made only after committing a newly inserted permanent claim. This correction
does not reopen ambiguous, expired-token or already dispatched launch identities.

## Current human membership

`currentProductRoleResolver` reads a user or delegated Navigator's exact human
membership when its role is validated. With the PostgreSQL product store it
performs a read-only `members` query filtered by both `workspace_id` and human
`id`, checks both returned identifiers and accepts only viewer, editor or admin.
A missing member resolves to none. A foreign or malformed row, inaccessible
store, query exception, cancellation or late response refuses with a fixed
sanitized error. There is no cached-member, session-claim, file-store or
empty-workspace fallback for a missing PostgreSQL member.

The query receives an abort signal. Every role call has an independent eight
second deadline; the claim also bounds the full approval-status evaluation to
eight seconds after acquiring its locks. A read client that ignores cancellation
cannot continue the receipt insertion from a late success. The claim transaction
returns a fixed build-unconfirmed refusal and releases its connection. This is
read-only cancellation, not cancellation or compensation of a provider build.

An integration retains the canonical live credential check and its capability,
project and environment restrictions. Fresh membership can lower its role; it
cannot restore a revoked credential or increase the access returned by the
canonical resolver. Principals without a delegated human retain their canonical
restrictions. Membership records are never written by this helper.

In file mode each human check reads the current `db()` object, which is the
single writer's authoritative product object. Stored roles take precedence.
The existing explicit local demo rule requires Supabase to be unconfigured;
the existing self-hosted empty-workspace bootstrap rule uses `membershipPolicy`.
Hosted mode's empty-workspace rule remains disabled. Missing workspaces and
malformed/duplicate selected members grant no new authority.

## Tests and evidence limits

The new PostgreSQL-only suite exercises the production default launcher and
captured actual-broker test launcher using a fresh pool with `max: 1`, valid
owning consumed approvals and an accepted SDK receipt. It also prepares a wrong
memory-policy positive counterexample: the authentic evaluator over that wrong
store accepts genuine approval IDs while the owning PostgreSQL policy denies.
The production claim must refuse without consulting that memory policy.

Resource wait proof uses a third independent observer handle, a fresh
transaction and `pg_stat_clear_snapshot()` for every poll. It binds the exact
claimant PID, exact blocker PID and resource-query text; all three backend PIDs
must differ. Observed `pg_blocking_pids` resource waiters are held while the approver is
demoted, requester removed, or owning PostgreSQL policy raises the approval
count or denies the region. The stale member snapshot remains admin. Operation,
fence and consumed approval TTLs stay live. After release the current authority
must refuse with zero StartBuild calls and zero launch inventory; an unchanged
control must produce exactly one accepted SDK receipt. Separate cases cover
captured isolated dependency replacement, foreign/malformed/inaccessible product
reads, cancelled late successes and expired consumed approvals.

Additional cases delay ONLY the approver membership read after policy evaluation.
An independent committed SQL statement changes two-person requirements, denies
the region, lowers autonomy, changes a same-value version, changes exact parameters/autonomy without
incrementing its version, deletes settings, or creates a previously absent
default/foreign environment row. Current human membership and all
operation/fence/approval TTLs remain valid. After the read completes, insertion
must refuse with zero SDK starts and zero inventory; unchanged configured and
absent-default controls succeed. Retained accepted-launch recovery exercises
the same version-only, same-version data, changed/absent and foreign-row
refusals alongside an unchanged control: it preserves the original receipt
and never sends a second SDK request. A recorded evaluator-call count proves
that the insertion and recovery cases do not refresh or retry policy evaluation.

The PostgreSQL repositories, evaluator, consumed approvals, transaction locks,
CAS and launch receipts are real in that suite. Product scope/membership reads,
policy bundle loading and AWS SDK responses are modeled. The membership unit
suite models scoped PostgREST reads, delayed demotion, unavailable/malformed
responses, deadline/cancellation, integration attenuation and current file reads.
Neither suite proves live Supabase/PostgREST/TLS, browser identity, live AWS
acceptance or authenticated original plan/apply custody. Its succeeded original
plan-use fixture is explicitly an adapter prerequisite fixture.

Product membership is observed through the separate canonical product authority,
not locked atomically with platform rows. A concurrent product membership change
after its last read is not covered by a fictional distributed transaction.
Local platform policy/autonomy changes committed during membership lookup are
covered by exact owning SQL checks in each final CAS statement; they are not
deferred as a remote product-store limitation. No live product-store approval contract is claimed by these source
changes. Actual Supabase fixtures remain subject to the existing permission
boundary. The process-wide broker APIs and other dispatchers are unchanged;
reviewing their transaction/current-role wiring is a separate integration task.

## Required verification after source integration

No runtime verification was performed by this author lane. The root owns the
serial runtime slot, source-bound fresh receipts, independent review and gate
manifest changes. Do not count a PostgreSQL-only suite skipped because its URL
is absent as evidence.

Use the pinned Node binary and a dedicated disposable PostgreSQL authority
whose URL is supplied as `ZENITH_TEST_PLATFORM_PG_URL`; do not point the suite at
a product or production database. Existing harnesses migrate only the platform
schema and isolate data with unique workspace IDs. After a root-owned fresh
install, this complete targeted driver forwards only the disposable PostgreSQL
URL and ordinary runtime paths. It does not inherit cloud, Supabase, signing or
other Zenith secrets, and it never prints the URL:

```sh
/Users/saivedanthava/.codex/zenith-w8/tools/node-current/bin/node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
process.umask(0o077);
const env = { NODE_ENV: "test", PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` };
for (const name of ["HOME", "TMPDIR", "ZENITH_TEST_PLATFORM_PG_URL"]) {
  if (process.env[name]) env[name] = process.env[name];
}
if (!env.ZENITH_TEST_PLATFORM_PG_URL) throw new Error("Disposable PostgreSQL test authority is required; refusal is not a skipped pass.");
fs.mkdirSync(".data-ci-lane", { recursive: true, mode: 0o700 });
const targets = [
  ["tests/capabilities/current-product-roles.test.ts", "current-product-roles", 23],
  ["tests/controlplane/build-launch-broker-binding.test.ts", "build-launch-broker-binding", 44],
];
for (const [file, name, count] of targets) {
  const report = `.data-ci-lane/${name}.json`;
  fs.rmSync(report, { force: true });
  const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", file,
    "--maxWorkers=1", "--no-file-parallelism", "--reporter=default", "--reporter=json",
    `--outputFile.json=${report}`], { cwd: process.cwd(), env, stdio: "inherit" });
  if (result.status !== 0) process.exit(1);
  const parsed = JSON.parse(fs.readFileSync(report, "utf8"));
  if (parsed.success !== true || parsed.numTotalTests !== count || parsed.numPassedTests !== count
    || parsed.numFailedTests !== 0 || parsed.numPendingTests !== 0 || parsed.numTodoTests !== 0) {
    throw new Error("Current targeted test report did not prove all required cases.");
  }
}
NODE
```

The first suite independently needs no PostgreSQL URL and cannot attest live
membership transport. The second must execute all forty-four cases with zero
skips. Preserve exact report hashes and observed exit statuses; these targeted
reports supplement the mandatory canonical lane receipts.

After integrating the new PostgreSQL group and explicit required case names
into the canonical manifest/contract tests, run the full platform PostgreSQL
lane and revalidate its exact execution receipt:

```sh
node scripts/ci/run-gate.mjs platform-postgres --run --report .data-ci-lane/build-authority-platform-pg.json --evidence .data-ci-lane/build-authority-platform-pg-evidence.json
node scripts/ci/run-gate.mjs platform-postgres --validate .data-ci-lane/build-authority-platform-pg.json --require-execution --evidence .data-ci-lane/build-authority-platform-pg-evidence.json
```

Also run full TypeScript/lint checks, existing broker/product role suites,
CodeBuild PostgreSQL launch/expiry/terminal scenarios and Temporal historical
build replay/single-attempt cases on the integrated exact source. The root must
preserve current strict JSON/report validation, mandatory non-skipped groups,
secret stripping and single runtime-slot ownership.

## Outside-owned follow-ups

- Canonical gate manifest, gate contract tests and unit/workflow lane exclusion
  must classify the new PostgreSQL-only file and explicitly require every
  authority/waiter/one-connection case. No manifest was edited in this lane.
- The existing `product-adapters`, process-wide `platformBroker` and general
  `createExecutionBroker` remain unchanged. This final CodeBuild boundary is
  transaction-bound; other mutation/grant paths require their own review.
- Live PostgREST/TLS/product membership/browser identity and live provider
  custody/completion acceptance remain incomplete. No credentials or fake
  provider keys are introduced for them.

## Revision 2 review corrections

Revision 1 source and receipts are preserved. Revision 2 corrects the independent
review's cached/ambiguous waiter observation and local policy/autonomy staleness
during delayed human lookup. It changes only the owned repository, new launch
regression suite and this document; both current-role helper files keep their
exact revision 1 bytes. All source/runtime verification limits above still apply.
