# PROD-OPS-04 verification handoff: clean-host restore and recovery epochs

Branch `prod/ops-04-w5`, base c02c097e. Platform migration **44**. Built without running any test (build-only rule): only
`tsc --noEmit` and `eslint` on the changed files were run, both clean. Nothing here calls a cloud API; the rehearsal uses
real PostgreSQL (pg_dump/pg_restore) and, when its CLI exists, a Temporal dev server, both owned by the test.

Requirement: restore product/platform/agent/hosted/source stores, Temporal/artifacts/customer state and keys; consumed
approvals and mutations cannot resurrect; control-plane recovery is epoch-fenced (controlled epoch reconciliation and reopen
required). DUR-A left "operator continuation and recovery epochs" to this requirement.

## 1. What was built

### Recovery epoch (the fence)

`platform.recovery_epochs` (append-only, monotonic, durable) holds the epoch. `platform.current_recovery_epoch()` is the
DEFAULT of a new `recovery_epoch` column on `operations`, `approvals`, `durable_intents` and `external_effects`, so the
database stamps every row at insert. `platform.recovery_fence_floor()` (= epoch x 1e9 + 1) is the lowest fence token a lease
can receive, so a fence token carries its epoch. `bumpRecoveryEpoch` (one transaction, idempotent per restore run id, run by
the restore runbook and never from a request path) appends the next epoch and:

- expires every lease and lifts every fence counter to the new floor;
- turns every restored `running` operation `uncertain` (grants revoked, `operation.uncertain` event appended);
- turns every restored `pending` external effect `uncertain` (event `recovery_epoch`), leaves `accepted/uncertain/conflict`;
- turns claimed/dispatched saved-plan uses `uncertain`; revokes every unconsumed grant; cancels queued and times out
  claimed/running runner jobs and zenithd requests (outcome unknown, never re-queued);
- opens one `recovery_items` row per in-flight operation, intent and effect (with its prior state and the decisions allowed).

Every authority check now includes the epoch:

| Check | Change |
| --- | --- |
| `leases.acquire`, `acquireExecutionLease` insert | new lease starts at the floor; re-acquire is `greatest(fence + 1, floor)` |
| `approval-core.consumeApprovals`, `countUnconsumedApprovals`, `approvals.record` count | only current-epoch approvals count |
| `approvals.record` | refuses an operation stamped below the current epoch (`recovery_epoch_stale`) |
| `operations.claimForExecution` | refuses a stale operation before consuming anything (`recovery_epoch_stale`) |
| `outbox.claimDue`, `settleIntent` | only current-epoch intents; a pre-restore claim cannot settle |
| `outbox.adoptStartIntents`, `deriveApprovalSignals` | only for operations stamped with the current epoch |
| external effects | pending to uncertain at bump; `begin` already returns the existing effect, so nothing is re-created |

### Operator continuation

`src/lib/controlplane/recovery/index.ts`: `listRecoveryItems`, `getRecoveryItem`, `recoveryStatus`, `decideItem`.
A decision is bound to the exact subject state (`bindingDigest`), single-use, tenant-scoped and recorded with the human:

- operation `running` (now uncertain): `keep_uncertain` only;
- operation proposed/awaiting/approved/queued: `resume` = reopen with a FRESH approval round in the current epoch
  (approval_round + 1, `approval_required`, lease cleared; refused when a workflow start was already attempted or
  acknowledged, when effects of the operation are unresolved, or when it expired), `abandon` = `cancelOperation`;
- pending intent: `resume` re-stamps (delivery stays idempotent by intent id), `abandon` settles it `dead/superseded`;
- effect: `keep_uncertain` only (resolution stays the evidence-bound PROD-DUR-07 flow).

Reachability: `GET /api/platform/v1/recovery` (viewer, human-bound credentials allowed) and
`POST /api/platform/v1/recovery/items/:id/decide` (browser session, admin, human only; `bearer-paths.ts` classifies both),
through `src/lib/platform/recovery.ts` (composition with the broker's role resolver) and `recovery-service.ts`. CLI break-glass:
`npm run ops:recovery -- continue list|resume|abandon|keep`.

### Backup manifest and restore runbook

`src/lib/ops/recovery/`: `manifest.ts` (manifest, SHA-256 per file, self digest, `verifyBackupDirectory`), `backup.ts`
(`captureBackup`: one pg_dump under an exported snapshot together with row counts, schema version and epoch; file store
allowlist; hosted bundle; artifact index; Temporal inventory), `restore.ts` (`runRestore`: verify, gates, keys, empty target,
atomic pg_restore, forward migrate, count check, epoch bump, product/hosted/artifact placement, Temporal termination,
report), `process.ts` (no password on a command line, scrubbed output, injectable runner), `report.ts` (RPO/RTO from recorded
instants, provisional targets, `registerRecoveryMeasurementSink` extension point, JSON report). CLI `scripts/ops/recovery.ts`
(`npm run ops:recovery`): `backup`, `verify`, `restore`, `status`, `continue`. Runbook: `docs/platform/operations/RESTORE-RUNBOOK.md`.

Store coverage in the manifest: platform (captured, one dump with agent / product public / hosted schemas when they live in
the same database), source and plan artifacts (covered by the platform dump, tables listed), product file store (allowlisted
files), hosted (sealed ZBK1 bundle handed to `hosted:restore`, or the hosted schema), artifacts (index, bytes on request),
Temporal (open-workflow and namespace inventory, optional dev-server db file; open op workflows terminated at restore),
customer state (referenced: requires `--confirm-customer-state`), keys (OPS-05 key ids and roles, checked on the target host
before anything is restored).

### Files

New: `src/lib/controlplane/db/migrations/0044_recovery_epochs.ts`, `src/lib/controlplane/recovery/index.ts`,
`src/lib/platform/recovery.ts`, `src/lib/platform/recovery-service.ts`, `src/app/api/platform/v1/recovery/route.ts`,
`src/app/api/platform/v1/recovery/items/[id]/decide/route.ts`, `src/lib/ops/recovery/{manifest,process,backup,restore,report}.ts`,
`scripts/ops/recovery.ts`, `docs/platform/operations/RESTORE-RUNBOOK.md`, tests (section 3).
Changed: `migrations/index.ts` (register 44), `repos/leases.ts`, `repos/operations.ts`, `repos/approval-core.ts`,
`repos/approvals.ts`, `outbox/index.ts`, `_lib/bearer-paths.ts`, `package.json` (`ops:recovery`).

### Behaviour changes to verified code (explicit)

In epoch 0 (any database that was never restored) behaviour is identical: floors are 1, every stamp equals the epoch, every
`recovery_epoch = platform.current_recovery_epoch()` predicate is true. What does change: the SQL of `acquire`,
`acquireExecutionLease`, `consumeApprovals`, `countUnconsumedApprovals`, `approvals.record`, `claimForExecution`, `claimDue`,
`settleIntent`, `adoptStartIntents` and `deriveApprovalSignals` now calls `platform.current_recovery_epoch()` /
`recovery_fence_floor()`, so these functions require schema 44 (an N build on schema 43 already fails closed with
`schema_behind`; N-1 on 44 works because the columns default). Guard order is unchanged: the epoch checks sit inside the
existing authority/claim steps (quota, DUR-A, DUR-B, DUR-C, DUR-D, provider call).

## 2. Acceptance mapping

| Clause | Implementation | Tests |
| --- | --- | --- |
| Restore product/platform/agent/hosted/source stores | `captureBackup` + `runRestore` (one dump, per-component manifest status, file store allowlist, hosted bundle hand-off, atomic pg_restore, count verification) | recovery-manifest (integrity, gates), recovery-rehearsal (real pg_dump/pg_restore, count facts) |
| Temporal | inventory in the backup; `--terminate-temporal` kills the lost timeline's `op-*`/`reconcile-*` workflows | recovery-rehearsal "temporal" (real dev server) |
| Artifacts / customer state | artifact index (+ optional bytes) verified at restore; customer state `referenced` with explicit confirmation | recovery-manifest gates; rehearsal (artifact component `not_applicable`; index path is untested, see gaps) |
| Keys | manifest key ids; the target host must hold each before restore | recovery-manifest "lacks a key id", rehearsal keys refusal |
| Consumed approvals/mutations cannot resurrect | approval epoch stamp + claim/record refusal; effect pending to uncertain; intents held; leases fenced; grants and jobs closed | recovery-epoch (approvals, effects, intents, leases, grants), recovery-rehearsal (consumed-after-snapshot approval) |
| Epoch reconciliation/reopen required | `recovery_items` + `decideItem` (resume reopens with a fresh round, abandon, keep uncertain), CLI + API | recovery-epoch (continuation), recovery-service |
| RPO/RTO measurement | `report.ts`, restore report JSON, `status` continuation measurement | recovery-manifest "RPO / RTO measurement", rehearsal (measured values) |
| No privileged fallback / secrets | no password in argv or any artifact; browser-only human decisions; no destructive default (empty target only) | recovery-manifest "tool hygiene", rehearsal "writes no connection string" |

## 3. Verification commands (verifier machine)

Node 22. PGlite lane (no external services):

```
npx vitest run tests/ops/recovery-manifest.test.ts tests/platform/recovery-service.test.ts tests/controlplane/recovery-epoch.test.ts
```

Real PostgreSQL (needs a role with CREATEDB; the suites use scratch databases and never bump the shared platform schema):

```
ZENITH_TEST_PLATFORM_PG_URL=postgres://...:PORT/db npx vitest run tests/controlplane/recovery-epoch.test.ts
```

Rehearsal (real pg_dump/pg_restore of the server's major version; optional absolute `ZENITH_TEST_PG_DUMP_BIN` /
`ZENITH_TEST_PG_RESTORE_BIN`; Temporal part needs the CLI via `ZENITH_TEST_TEMPORAL_CLI` or PATH):

```
ZENITH_TEST_RECOVERY_REQUIRED=1 ZENITH_TEST_PLATFORM_PG_URL=postgres://...:PORT/db npx vitest run tests/ops/recovery-rehearsal.test.ts
```

Without the switch a missing prerequisite skips with the reason (never counted as a pass).

Regression of areas touched (must still pass unchanged):

```
npx vitest run tests/controlplane tests/capabilities tests/runners tests/platform tests/effects tests/ops tests/docs
```

Expected: all pass; the recovery rehearsal skips only when its prerequisites are absent and not required. Expected first
checks: the rehearsal's report shows epoch 3 (observed 2 + 1), counts `operationsMadeUncertain 1, operationsHeld 2,
effectsMadeUncertain 1, intentsHeld 1`, `continuation.opened 5`.

## 4. Known gaps, things that may break first, shared-file updates

Honest limits:

1. **Not run.** Likeliest first failures: PGlite accepting `lock table ... in exclusive mode` and data-modifying CTEs that
   feed a later CTE (`bumpRecoveryEpoch` effects step); `set transaction isolation level repeatable read` as the first
   statement of the backup transaction under the pooled executor; `pg_restore --single-transaction` ACL statements when the
   target server lacks a role present at the source (use `--no-privileges`); the Temporal CLI `workflow list --output json`
   shape (the parser accepts a JSON array; anything else records `openWorkflows: null`); the SQL id expression for
   `recovery_items` (`sha256(convert_to(...))`, same technique as the outbox).
2. **Post-snapshot work is invisible.** Operations, approvals and effects created after the backup are not in the restored
   database; the epoch cannot replay or see them. Providers may hold changes the ledger does not know. The runbook says to
   reconcile providers for the RPO window; no automation does it.
3. **Epoch collision across a lost live system** is avoided only when the operator supplies `--observed-epoch` or the backup
   manifest recorded it; with neither, the new epoch is one past the restored database's own. A stale worker of the lost
   system still cannot act on the restored database (it holds a token from a different timeline and the restored leases are
   all expired), but two restores from the same backup with no observed epoch reuse the same epoch number.
4. Item coverage: workflow-start intents are permanent tombstones and are covered through their operation (a `resume` is
   refused when a start was attempted); plan artifact uses, grants, runner jobs and zenithd requests are closed in bulk without
   per-item decisions; the signed-request nonce window (10 minutes) is not restored, so a request replayed inside it after
   a restore is not recognised (unchanged from RECOVERY.md section 4.6).
5. The hosted SQLite store restore is a hand-off to the existing `hosted:restore`/`hosted:reopen` (it needs its own data
   directory and `ZENITH_BACKUP_KEY`); the artifact-index placement and the product file store placement have no real-engine
   test in the rehearsal (the rehearsal declares both `not_applicable`).
6. Customer OpenTofu state is never copied; the restore needs an explicit human confirmation and verifies nothing about the
   customer bucket.
7. No UI page: the work list is an API and CLI surface. The browser decision endpoint exists and is classified browser-only.
8. RPO/RTO targets are provisional (OPS-01 is not in this base); verdicts compare only configured provisional targets.
9. Live cloud acceptance and any hosted-cluster restore rehearsal are not approved or performed.

Shared-file updates for the assembler:

- **Migrations inventory:** migration 44 `recovery_epochs` (expand-only: 2 tables, 2 functions, 4 defaulted columns, triggers);
  regenerate emitted SQL and the Supabase migration; `PLATFORM_SCHEMA_VERSION` expectations in
  `tests/controlplane/migrations.test.ts`; `scripts/ci/apply-supabase-migrations.sh`.
- **Sensitive-data inventory (`src/lib/sensitivedata/inventory.ts`):** `platform.recovery_epochs` (system-level, operational,
  append-only ledger; actor and reason are operator-supplied text of at most 200/500 characters, no secrets) and
  `platform.recovery_items` (workspace-owned, operational, ledger retention; `ref` is an operation/intent/effect id,
  `decided_by` a user id, `decision_reason` operator text). Existing tables gain a plain integer column `recovery_epoch`.
- **Tenancy classification:** no function was added to `db/repos`, so `tests/controlplane/tenancy.test.ts` is unaffected.
  Store functions in `src/lib/controlplane/recovery/index.ts`: workspace-scoped (every statement names `workspace_id`):
  `recoveryStatus`, `listRecoveryItems`, `getRecoveryItem`, `decideItem` (its cascades use `cancelOperation` and statements
  that name the workspace). System-level by design, listed for `controlplane-sql-scoping`: `bumpRecoveryEpoch` (a restore is
  one event for the whole database: leases, running operations, effects, plan uses, grants, runner jobs, zenithd requests,
  item inserts), `currentRecoveryEpoch`, `listRecoveryEpochs`, and `measureContinuation` in `src/lib/ops/recovery/report.ts`
  (operator view). The outbox sweeps remain cross-tenant exactly as before.
- **Gate manifest (`scripts/ci/gate-manifest.mjs`):** add `tests/controlplane/recovery-epoch.test.ts` (platform-postgres, needs
  CREATEDB), `tests/platform/recovery-service.test.ts` and `tests/ops/recovery-manifest.test.ts` (PGlite/unit lanes), and
  `tests/ops/recovery-rehearsal.test.ts` in a lane with PostgreSQL 16, matching pg_dump/pg_restore and the Temporal CLI, with
  `ZENITH_TEST_RECOVERY_REQUIRED=1`.
- **Route count:** two new platform routes (`GET /recovery`, `POST /recovery/items/[id]/decide`); `bearer-paths.ts` is already
  updated by this branch.
- **Docs:** `docs/platform/operations/RESTORE-RUNBOOK.md` is new. `RECOVERY.md` sections 3 and 4.6 are superseded in part
  (fence tokens are now monotonic across a restore, approvals no longer resurrect) and should link to it; that file has a
  committed guide-input pin checked by `tests/docs/operator-docs.test.ts`, so the assembler must update text and pin together.
  `docs/LIMITATIONS.md`: replace "operator continuation and recovery epochs remain open" and `PROD-DUR-01/02` note 4b with the
  status below; keep the post-snapshot-invisibility limit.
- `package.json` gained `ops:recovery`; the env names `ZENITH_RPO_TARGET_SECONDS`, `ZENITH_RTO_TARGET_SECONDS`,
  `ZENITH_PG_DUMP_BIN`, `ZENITH_PG_RESTORE_BIN`, `ZENITH_TEMPORAL_BIN` are read only by the recovery tooling.

## 5. Suggested ledger implementationStatus

`implementation_complete_verification_pending: recovery epoch (append-only, monotonic, stamped by the database, carried by
fence tokens) fences leases, approvals, execution claim, intents and effects; restore bump makes running work and pending
effects uncertain and opens operator-decided continuation items (API, browser-only decision, CLI); backup manifest with
per-file digests, atomic clean-host restore runbook with key, count and empty-target gates, RPO/RTO report; PGlite and real
PostgreSQL/Temporal rehearsal tests written, not run; live hosted/cloud restore and OPS-01 targets not performed.`
