# MIX follow-up: producer output reader, and drift and migration signals in the mixed run

Branch `prod/mix-follow-w5`, base `c02c097e` (waves 1-4). Platform migration **42**. Build only: nothing here was executed
(typecheck and eslint only). Another machine runs every test below. Live cloud acceptance is not approved and not claimed; no
cloud API is called by any code or test added here.

Closes the two gaps `LIMITATIONS` and `PROD-MIX-03-04.md` named after the MIX-01..04 merge:
1. a consumer with cross-partition references was refused at start because no producer output reader existed;
2. OBS-01/reconcile drift and LIFE-10 migration classification were not fed into the MIX-04 ordering rules (`NO_SIGNALS`).

## 1. What was built

### 1.1 Producer output reader

After a producer child applies and its receipt is recorded, `materializeIncoming` (the join) asks the world for the producer's typed
outputs. The production world now supplies them.

| File | Role |
| --- | --- |
| `src/lib/execution/mixed/output-reader.ts` | `createProducerOutputReader`: turns readings into the closed `TypedOutput` documents the run orchestration validates. Plain values become `digest({type, value})` only; a secret becomes a vault reference plus a version digest; each output is recorded once per (plan, reference, producer receipt) with provenance; recorded outputs win on a retry (the source is not read again); a disagreeing re-read is a `conflict`. Unreadable, wrongly typed, secret-shaped-but-plain or foreign-vault readings refuse the whole batch with `ProducerOutputError` (fixed text, ids only). |
| `src/lib/execution/mixed/output-source.ts` | Production composition: `observationSource` (the producer's own post-apply observation), `platformOutputRecordStore`, `platformVaultPort` (existing sealed vault: `putSecretAsync`, backend `get`), `productionWorldHooks`. |
| `src/lib/controlplane/db/migrations/0042_mixed_output_records.ts` | `platform.mixed_output_records`: append-only (trigger), RLS on, anon/authenticated revoked, service role select/insert. Columns are digests, ids, address, output name, receipt digest, source digest, observation time and, for a secret, `secret_ref` + `secret_version_digest`. There is no column that can hold a value. FK to the plan and to the producer and consumer child plans. |
| `src/lib/controlplane/db/repos/mixed-output-records.ts` | `recordOutput` (idempotent for the same value digest, `conflict` for a different one, `not_found` for a foreign workspace), `getOutput`, `listOutputs`, `readProducerObservation`. |

Where the value comes from, stated precisely. The activity broker issues an activity grant only to a RUNNING operation, so a
finished child can no longer be given a brokered session by the mixed parent. The read-back therefore uses the observation the producing
child's own workflow already wrote while it ran: its post-apply `observeEnvironment` step reads every node through the brokered observe
session of the producing partition's connection and appends the observation to `platform.resource_observations`. The reader selects the
newest observation of the producer address that is present, not simulated, error free, taken between the child operation's creation and
its recorded receipt (`readProducerObservation`). `producerOutput` `externalId` reads the provider-side id; any other name reads the
portable attribute of that name when its state is `known`. If no such observation exists (the observe step is an optional workflow step, or a
later reconcile is the only read) the output is unreadable and the consumer is blocked with `outputs_unavailable`. It never starts on a guess.

Join changes (`src/lib/execution/mixed/orchestration-join.ts`): the producer output call now also passes the plan, the stored receipt and the
effect digest the run recorded for the producer; a `ProducerOutputError` becomes `blocked / outputs_unavailable` (the existing terminal
block reason). A changed parent digest that follows from the newly materialized value still goes through the existing path unchanged:
`consumeOutputs` returns `review_required` with the exact new parent digest, the join opens one review operation (a person's approval of exactly
that digest and the original child set, or a precise preauthorization); nothing is rebound on its own.

Wiring: `createMixedWorld` accepts the platform store (`ports.sql`) and then wires `childTypedOutputs` and `orderingSignals`. The worker
composition (`src/lib/workflows/mixed-activities.ts`) and the REST composition (`src/lib/execution/mixed/runtime.ts`) pass it, so
`referencesReady` is now true in production and a plan with cross-partition references is no longer refused at start. A world composed without
`sql` (contract tests with fakes) is unchanged.

### 1.2 Drift and migration signals in the ordering rules

| File | Role |
| --- | --- |
| `src/lib/controlplane/db/repos/mixed-signals.ts` | Read-only joins: `latestChildDriftReport` (newest `drift_reports` row of the child environment computed after the child operation was created), `childMigrationClasses` (`release_runs` of the child operation whose migration class is data, contract or unclassified, not refused or rolled back). |
| `src/lib/execution/mixed/signals.ts` | `driftClassesOf` (stored report to classes: a `changed` finding the report marks not repairable is `native_divergence`; every other finding is `unauthorized_change`; unobserved addresses are `unobserved`; a simulated report contributes nothing; expected variance was already removed by `applyFieldOwnership` when the report was stored), `readOrderingSignals`, `readRunSignals`, `platformOrderingSignals`. Contract and unclassified migrations are also reported as `contractMigrationChildIds`. |
| `src/lib/execution/mixed-orchestration/ordering-rules.ts` | `OrderingSignals.contractMigrationChildIds` (optional, additive); drift class `unobserved`; two new rules (below). |
| `src/app/api/platform/v1/operations/[id]/mixed-run/teardown/route.ts` | `release` now reads the real signals for every child of the run instead of `NO_SIGNALS`; a failed signal read refuses the release. |
| `orchestration-join.ts` `signalsFor` | exported; resolves each child's operation id so the reads are bounded to this child's run; used by every child `start`. |

New and reached rules (existing rules unchanged):
- `consumer_drift_unresolved` (teardown X): a downstream child that still stands (not recorded destroyed) and has unresolved drift blocks the teardown of its producer. Reached by `releaseTeardown` through the teardown route.
- `contract_migration_after_dependents` (start_child and migration): a child whose release run is a contract or unclassified migration may start only once every downstream child has succeeded. Reached at every child start through `recordChildStart`. A dependency edge that makes this impossible leaves the migration child blocked with the named rule; the operator then runs that migration as its own later step. This is a refusal, never a reorder.
- Already present and now fed real signals: `producer_drift_unresolved`, `migration_incomplete`, `one_migration_at_a_time`, `migration_in_flight`.

`drift_repair` and `migration` ordering kinds are still only evaluated by the pure function and its tests (nothing in the platform asks the mixed run to schedule a repair or a migration as a step); they receive the same signals shape.

## 2. Acceptance mapping

| Clause | Implementation | Tests |
| --- | --- | --- |
| Producer output reader exists and is wired | `output-reader.ts`, `output-source.ts`, `createMixedWorld({ sql })` in `mixed-activities.ts` and `runtime.ts` | `tests/controlplane/mixed-follow-up.test.ts` "the producer output reader through materializeIncoming" |
| Read through the producing partition's brokered session | observation written by the producer's own observe step inside its brokered observe session; window bounded by the child operation and its receipt; simulated, missing and errored reads ignored | same file (blocked with nothing read back, blocked when only a post-receipt read exists, ignores non-real observations, newest real in window, tenant scoped) |
| Typed outputs with provenance (child digest + address) | `TypedOutput` documents carry producer child, address, output name, connection, subplan and effect digest, receipt digest, artifact digest; recorded in `mixed_output_records` | `tests/execution/mixed/output-reader.test.ts` ("accepts ... passes the run's own validation", "records one row per reference and receipt"); `mixed-follow-up.test.ts` (row fields) |
| Vault references for secrets, never values | secret material sealed through the existing vault, only `{ref, versionDigest}` leaves; named vault entry must exist in this workspace; plain values digest only; DB shape check | `output-reader.test.ts` "secrets are vault references only"; `mixed-follow-up.test.ts` "keeps the secret shape in the database", raw row scan contains no value |
| Consumers start after outputs materialize | `materializeIncoming` (existing) now has a reader; unreadable outputs block | `mixed-follow-up.test.ts` |
| Changed materialized values go through review / new parent approval round | unchanged join path: `consumeOutputs` returns `review_required`, one review operation binds the exact new parent digest and original child set | `mixed-follow-up.test.ts` "records the read-back with provenance and ... opens the review of exactly that digest instead of starting" |
| Idempotent and tamper-evident | recorded output wins on retry; `conflict` for a differing value; append-only trigger; tenant scoped | `output-reader.test.ts`, `mixed-follow-up.test.ts` "the output record table" |
| Drift fed into ordering | `signalsFor` at every start, route at teardown release | `mixed-follow-up.test.ts` "refuses to start a consumer while its producer has unresolved drift, and starts it once the drift report is clean", "reads unresolved drift newer than the child operation"; `mixed-orchestration-signals.test.ts` |
| Block teardown of a producer while a consumer has drift | rule `consumer_drift_unresolved` | `mixed-orchestration-signals.test.ts` "teardown of a producer while a consumer has drift" |
| Contract migrations ordered after dependents update | rule `contract_migration_after_dependents`, `contractMigrationChildIds` from LIFE-10 classes | `mixed-orchestration-signals.test.ts` "contract migrations are ordered after their dependents", service refusal; `mixed-follow-up.test.ts` "reads data, contract and unclassified migrations" |

## 3. Verification commands (other machine)

```
npx vitest run tests/execution/mixed/output-reader.test.ts tests/execution/mixed-orchestration-signals.test.ts
npx vitest run tests/execution/mixed-orchestration.test.ts tests/execution/mixed-orchestration-service.test.ts tests/execution/mixed-orchestration-join.test.ts   # unchanged behaviour
npx vitest run tests/controlplane/mixed-follow-up.test.ts                                                       # PGlite lane (real platform SQL)
ZENITH_TEST_PLATFORM_PG_URL=<postgres url> npx vitest run tests/controlplane/mixed-follow-up.test.ts           # real PostgreSQL lane
npx vitest run tests/controlplane/mixed-parent-plans.test.ts tests/controlplane/mixed-runs.test.ts tests/controlplane/migrations.test.ts tests/controlplane/tenancy.test.ts tests/security/controlplane-sql-scoping.test.ts
npx tsc --noEmit -p . && npx eslint src/lib/execution/mixed src/lib/execution/mixed-orchestration src/lib/controlplane/db/repos/mixed-output-records.ts src/lib/controlplane/db/repos/mixed-signals.ts src/lib/controlplane/db/migrations/0042_mixed_output_records.ts "src/app/api/platform/v1/operations/[id]/mixed-run/teardown/route.ts" src/lib/workflows/mixed-activities.ts tests/execution/mixed tests/execution/mixed-orchestration-signals.test.ts tests/controlplane/mixed-follow-up.test.ts
```

Expected: all pass, zero skipped (the PostgreSQL lane only with the env var). `migrations.test.ts` and `tenancy.test.ts` need the shared-file updates in section 4 first.

## 4. Known gaps, things that may break first, shared-file updates

Gaps, stated plainly:
- **Tofu outputs are not captured.** The apply engine drops sensitive outputs and does not store values, and mapping a producer address to a tofu output name is driver specific. The reader supports a source that returns sensitive material (it is sealed into the vault, tested with a labelled contract source) but no production source returns one, so in production a secret output can only name an existing vault entry that the producer's observation reported as the value.
- **Observation window.** The read-back is only as good as the child's optional post-apply observe step. If that step did not run, or the driver does not report the declared attribute, the consumer ends `blocked / outputs_unavailable` (terminal for that parent run, nothing undone). A child that outlives the receipt time with a later observation is not read.
- **Values never reach the consumer's compiler.** Only digests and vault references are recorded, as before; `compilerReferenceCoverage` remains `unavailable`. The platform now proves the output exists, was read from the producer, and was reviewed; delivery of the value into the consumer's compile step is still the child plan's open job.
- **Signals are only as fresh as the latest reconcile/deploy observation.** A drift report older than the child operation is ignored; there is no on-demand drift read at child start. `unobserved` addresses block like drift (fail safe). Native-divergence detection from the stored report relies on `repairable: false` on a `changed` finding (the shape `applyFieldOwnership` writes).
- A contract migration that is also a producer in the same run (so its dependents wait for it) can never start; it stays blocked with `contract_migration_after_dependents`. That is intended: run it as its own step after the dependents updated.
- Drift repair and migration as scheduled steps of a mixed run are still not driven by any platform caller.
- Live multi-cloud acceptance (`ZENITH_LIVE_MIXED=1`) was not performed.

Things that may break first: `tests/controlplane/migrations.test.ts` (contiguity to 42 and the table inventory), `tests/controlplane/tenancy.test.ts` completeness, the PGlite resource/observation seeding in `mixed-follow-up.test.ts` (it inserts `platform.resources` and `resource_observations` rows directly through the repo functions), and the order-of-timestamps assumptions between the observation and the receipt (both from the database clock, taken in sequence).

Shared-file updates the assembler must make:
- Migrations inventory: version **42** `mixed_output_records`; table `platform.mixed_output_records` (select, insert; RLS enabled; no anon/authenticated access; append-only trigger). Emit supabase SQL and update `migrations.test.ts` expectations.
- `src/lib/sensitivedata/inventory.ts` (OPS-06): `platform.mixed_output_records`: owner `execution/mixed (MIX follow-up)`, classification `operational`, retention `ledger(OPS07)` like `mixed_child_receipts`, purpose "producer output records of mixed plans: digests, provenance and vault references", columns `secret_ref: plain("vault reference, no value")`, `value_digest: plain("digest of a non-secret value, or of a vault reference")`.
- Tenancy classification (`tenancy.test.ts`): tenant-scoped functions `mixedOutputRecords.recordOutput`, `.getOutput`, `.listOutputs`, `.readProducerObservation` (reads `resource_observations` joined to `operations`), `mixedSignals.latestChildDriftReport`, `.childMigrationClasses` (reads `drift_reports` and `release_runs`). All filter on `workspace_id`; no cross-tenant reads. Registered in `repos/index.ts` as `mixedOutputRecords` and `mixedSignals`.
- Gate manifest: unit `tests/execution/mixed/output-reader.test.ts`, `tests/execution/mixed-orchestration-signals.test.ts`; postgres lane `tests/controlplane/mixed-follow-up.test.ts` (the `tests/controlplane` directory entry covers it).
- Route inventory: no new routes.
- LIMITATIONS: replace "The platform has no producer output reader yet ... stays refused at start (`outputs_unavailable`), drift and migration observations are not fed into the ordering rules (`NO_SIGNALS`)" with: producer outputs are read back from the producing child's own post-apply observation (digests and vault references only, recorded append-only; a consumer stays blocked when nothing was read back; values still do not reach the consumer's compiler); drift (reconcile reports) and migration classes (release safety) now feed child starts and teardown release; the gaps listed above.
- Behaviour change to a verified contract, stated: the production world now carries `childTypedOutputs`, so `referencesReady` is true and a plan with cross-partition references is no longer refused at parent start with `plan_refused`; the refusal moved to the consumer's start (`outputs_unavailable`) when no read-back exists. The teardown route no longer passes `NO_SIGNALS`.

## 5. Suggested ledger implementationStatus

- PROD-MIX-03: `typed_scoped_outputs_producer_readback_recorded_with_provenance_vault_refs_review_on_new_materialization_built_contract_and_local_engine_tests_pending_values_to_consumer_compiler_and_live_acceptance_open`
- PROD-MIX-04: `failure_timeout_expiry_cancel_outage_drift_migration_signals_fed_contract_migration_after_dependents_consumer_drift_blocks_producer_teardown_built_contract_and_local_engine_tests_pending_live_acceptance_open`
