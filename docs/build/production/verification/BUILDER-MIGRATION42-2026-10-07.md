# Builder handoff: external-effect key repair, 7 October 2026

Fix commit: `cc9fb51bb639f1e7813a8ad4977b647b24e0d3ad`. Branch: `codex/production-2026-10-02`.
Last upstream check: already current at822e7867 before repair; check again before publishing.

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

## Next executable steps

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
