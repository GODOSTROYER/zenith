# Builder handoff: external-effect key repair, 7 October 2026

Fix commit: `cc9fb51bb639f1e7813a8ad4977b647b24e0d3ad`. Branch: `codex/production-2026-10-02`.
Last upstream check: already current at822e7867 before repair; check again before publishing.

## Current status

Native same-Mac migration and ledger checks plus compiler passed on9b568108;
see native acceptance successor below. No need to repeat completed repair merely
because older preparation entries said pending. Full9b CI finished14 passed /6 failed, all20 jobs terminal. Other known failures
stay open. All release states false.

## Change and upgrade contract

Published migration33 used PostgreSQL regex bounds `{1,256}`; PostgreSQL rejects
these when evaluating external-effect inserts. Migration42 replaces only the two
CHECK constraints with the original anchored ASCII alphabets and explicit
`char_length BETWEEN 1 AND 256`. Null idempotency tokens remain permitted.
One ALTER statement makes replacement atomic. No receipt deletion, privilege,
RLS, trigger, uniqueness, provider dispatch or approval-semantics changes.

New cumulative SQL: `supabase/migrations/0024_platform_core.sql`. Migration33,
all earlier migration modules and snapshots through0023 remain byte-identical.
Registry, emitter, bootstrap inventory and inventory assertion now include42/0024.
Exact SQL checksum: `3dcc8f12119594941f82dd749f5471fb2578f1d5c37ec09083491aa6dc91f4b2`.

This constraint replacement is conservatively classified as contract by existing
migration admission. User7October repair authorization is recorded in the exact
SQL approval registry. Existing schema41 upgrade still refuses without explicit
`ZENITH_ALLOW_CONTRACT_MIGRATIONS=42`. Stop and drain previous mutation writers,
apply, verify schema and then resume. Never enable flag permanently or bypass
LIFE10 admission. Fresh installations apply42 before using external-effect rows.
Supabase SQL is an operator path requiring the same drain; its historical
bootstrap does not substitute for in-process contract admission.

Version42 is now used by this repair. Any unmerged builder42 candidate must be
reconciled into a later additive migration before publishing; never renumber this
migration after publication or rewrite accepted history.

## Executed evidence and limits

- Independent source review accepted atomicity, bounds, history and authority.
- Focused tests:8 passed /0 failed /105 filtered siblings. Embedded PostgreSQL,
  not networked PostgreSQL. Includes41→42 gate refusal/admission, allowed1/255/256,
  punctuation/null, forbidden empty/257/newline/non-ASCII, exact SQL tampering,
  history/authority readback and reapplication. Historical-upgrade scratch fixtures
  explicitly admit42 and restore environment; refusal controls remain.
- Wider touched suites:87 passed /15 failed /11 skipped.14 stale gate-count
  assertions and maintenance-table tenant classification; no pass claim.
- Initial new regression failed once on wrong wrapper field; corrected to
  `sqlstate:23514` plus exact constraint name. Production assertion unchanged.
- Touched ESLint, emitted SQL check, diff check passed.64 historical files unchanged.
- Compiler failed exit134 at default2GiB heap. Larger retry blocked by storage.
- Native PostgreSQL, full combined gates and new exact-SHA CI remain pending.

Counts overlap. Ledger stays78 rows: 10 verified /
49 in progress /19 planned. Four release states false.
Sanitized receipt: `evidence/PROD-CI-08/2026-10-07-migration42-local.json`.

## Earlier preparation commands, now superseded where native acceptance passed

1. Restore disk above22GiB plus enough runtime growth margin. Latest20.66GiB;
   helper found no safe recovery. No Docker startup while below floor.
2. On owned disposable PostgreSQL16, run migration suite with
   `ZENITH_TEST_PLATFORM_PG_URL` and eight touched ESLint files. New41→42 test
   owns/drains its scratch database and exercises both refused and allowed upgrade.
   Run fresh emitted SQL/bootstrap and reapplication; inspect role/grant parity.
3. Re-run compiler serially with4GiB heap only after capacity permits. Preserve
   original exit134 failure evidence. Run actual effects ledger suites to confirm
   journal recovery; no cloud calls.
4. Run combined mandatory gates; inspect every CI job on pushed exact SHA. Expected
   migration repair closes only regex failures, not all current failures.
5. Continue default Mac acceptance after source and capacity blockers close.

## Remaining builder-owned findings

- `src/lib/controlplane/db/compat.ts:52`: numeric baseline validator uses
  `/^d{1,6}$/`, rejecting normal numeric baseline values. Not modified by repair.
- `tests/controlplane/migrations.test.ts`: `ops_maintenance` global operator table
  is included in tenant-table assertion; reconcile actual tenancy classification.
- `tests/ci/platform-coverage.test.ts`:14 predecessor/current mandatory counts are
  stale after incoming registry expansion. Preserve every required identity.
- Approval semantic guard failures, historical standing-grant fixture compatibility,
  Azure/OCI driver failures and generated operator-guide drift remain outside this
  migration change. Never relax guards to clear these failures.
- Default OBS02/MACH04/operator journey and full native container acceptance remain
  open. No cloud/DNS/privateGitHubApp authorization; no release promotion.

## Post-publication follow-up

Publication39364bf4 started three exact-SHA CI runs:37663153252(main),
37663153110(native platforms),37663152996(native workers). PostgreSQL/bootstrap
passed; complete job set remains pending. Generated lane reported103 passed /
7 failed /0 skipped: six prior documentation failures plus a missed42 inventory
row introduced by this repair. Inventory/count/checksum correction now passes
its exact focused documentation test:1 passed /0 failed /58 filtered siblings.
No assertions weakened; final corrected publication requires fresh exact-SHA CI.

Fresh five effects suites on39364bf4:89 passed /2 failed /0 skipped (embedded
PostgreSQL/protocol fixtures, not live providers). Ledger35/0/0, build-launch13/0/0,
routes13/0/0; provider-resolvers10/1/0 and resolvers18/1/0. Remaining failures:
Azure ACR Tasks readback HTTP404 and cleanup readback returns present where
unavailable was expected. Preserve as builder findings; migration regex errors
no longer appear in these suites. Counts overlap other lanes and are not summed.

## Current native acceptance successor

Tested `9b56810829ecf1467ce2c20571bc060af1f39144` on this Mac after disk recovered
above 22 GiB. Compiler passed with a 4 GiB heap in 53.97 seconds; minimum free
space remained above the floor. Original exit134 attempt remains recorded.

Installed PostgreSQL 16.15 native ARM64 server package. Homebrew additionally
installed json-c0.19 and upgraded its xz dependency to5.8.4; prior xz keg retained.
Other existing prerequisites and project package manifests/lockfile stayed unchanged.
No Homebrew service was started. Two uniquely owned,
loopback-only temporary servers used 32 MB shared buffers and 25 connections.
This is a SQL fixture topology, not default Supabase or product authorization proof.

Migration acceptance: 9 passed / 0 failed / 48 filtered siblings: four real
networked PostgreSQL cases, four embedded engine cases and one pure contract case.
Actual schema41 upgrade, missing-drain refusal, exact256 boundaries, history and
authority preservation, fresh SQL, reapplication and narrow role grants passed.
Ledger/build-launch acceptance: 96 passed / 0 failed / 0 skipped, comprising
48 networked PostgreSQL cases and 48 embedded cases. Counts overlap earlier
runs; never sum them. Both servers stopped, both data/socket directories removed,
installer-created unused default cluster removed, private connection file deleted.
Server binaries retained for reuse. Docker stayed stopped and untouched.

Native receipt: `evidence/PROD-CI-08/2026-10-07-migration42-native.json`.
Earlier resource-blocked statements are historical, superseded for these SQL and
compiler checks only. Default Mac stack still needs image/swap headroom; no API,
browser, cloud, packaged-container or release approval is established here.
Final9b CI is complete14/6; original broader failures stay open.

## Current next steps for builder

1. Fetch same branch normally; preserve42/0024 and use a later additive version
   for any separate new migration. Do not weaken its contract/drain admission.
2. Address remaining approved-semantics bindings, historical standing-grant fixtures,
   provider/cleanup readbacks, global-maintenance tenancy assertion, strict gate
   count projections and existing six operator-guide regressions in owned lanes.
3. Run mandatory combined gates on that repaired source. Native SQL/compiler evidence
   above applies to9b only; rerun relevant scopes when their inputs change.
4. Restore image/swap headroom before default Mac composition. No live cloud,
   privateGitHubApp/DNS or production/retention authority was granted.

## Complete exact-source CI verdict

All20 jobs on9b568108 inspected:14 passed /6 failed. Unit21569/175/1610;
platform3705/41/15; workflows1302/29/0; tofu4315/5/19; intents154/2/0;
generated104/6/0. Counts are passed/failed/skipped and overlap. Compared with
prior c02/822 case identities,207 platform and85 unit failures resolved, no new
normalized failure identities. Workflow two Azure journal cases resolved. Never
sum these improvements across overlapping lanes. Unit job44m23s (unit41m01s)
ended with real test failures, within45-minute limit; no timeout claim.
Smoke/Gimbal downstream steps were skipped after unit failure, separate from1610
unit test skips. NativeLinuxAMD64 and ARM64 each22/22 with allsix cleanup flags;
WindowsACL and Linuxsystemd scoped harness checks passed. No Mac default journey,
live cloud or production sign-off inferred.

[Every job and exact counts](CI-2026-10-07-9b568108.md).
This following documentation/evidence publication has identical non-doc source;
its own CI remains separate and must be inspected on its exact SHA. Do not report
it green using9b's results. Safe resume: list runs for published HEAD, inspect each
job and append any new findings; retain9b report as its own historical source.
