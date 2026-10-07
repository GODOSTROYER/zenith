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

### 1.3 Round 2: cross-partition references work end to end

Supersedes the round-1 statements that tofu outputs were not captured, that non-secret values were digests only, and that values did not reach the consumer. Migration 42 is still the only migration (rewritten before merge: the record key is now `(plan, reference)`, no receipt column, plus a non-secret `value`).

1. **Capture inside the producer's apply.** `src/lib/execution/apply.ts`: while the producer's brokered deploy session is live and right after `applyVerifiedPlan` returns, the activity asks the typed-input port for the references consumers declared on this operation (`producerContract`) and calls `capture` with the engine's `tofu output -json` entries. A capture failure is logged and never fails an apply that happened (the consumer is then refused, not guessed). The engine (`src/lib/tofu/engine.ts`) gained `captureSensitiveOutputs`: only when a consumer declared a `secret_ref` reference does it return the sensitive values, in `sensitiveOutputs` (worker memory only, deleted before the activity returns); `outputs` and the evidence still carry names and sensitivity only.
2. **Non-secret values are stored.** `platform.mixed_output_records.value` (jsonb `{"v": scalar}`, bounded, plain class) beside the value digest and provenance (producer operation, address, output name, source `tofu_output` or `observation`, source digest, time). The table checks forbid a secret row with a value and a plain row without one.
3. **Secrets are sealed by the producer at capture.** The sensitive value goes into the workspace vault under a reference derived from plan, producer and reference ids (`secretOutputRef`); the record holds only `secret_ref` and `secret_version_digest`. A retried capture does not rotate the entry.
4. **Typed delivery to the consumer's compiler.** `src/lib/execution/typed-inputs.ts` (port and types), `src/lib/execution/mixed/typed-inputs.ts` (platform port). `loadExecContext` loads the consumer's `typedInputs` (refusing when a declared input has no recorded output of its succeeded producer). `CompileContext.input(name)` returns `${var.zenith_in_<name>}` and refuses an undeclared name; `assembleWorkspace({ inputs })` declares the variables: a non-secret input as the variable default (so it is in the config digest), a secret input as `sensitive = true` with no default (no workspace file can hold it). The secret value is read from the vault by `tofuSessionFor` at the consumer's own plan, apply and destroy session creation, under that operation's workspace, only for its declared inputs and only while the vault version still equals the recorded version digest, and reaches only the tofu child's environment (`TF_VAR_zenith_in_*`) through a dedicated `TofuSessionEnv.inputEnv` channel in the runner (name-checked, redacted, never in a plan view, evidence, result or log).
5. **DUR-B.** The consumer's executable semantics `configuration` component now includes the consumed inputs (names, types, value digests, secret ref and version digest) only when there are any: legacy digests are byte-identical. A changed producer output, or a rotated secret version, moves `configuration` and the dispatch re-check refuses (`SemanticsChangedError` naming `configuration`); a changed non-secret value also changes the reviewed workspace digest and is refused earlier.

Tofu output naming: a reference is carried by the output `<sanitized producer address>_<output>` (the drivers' own naming, e.g. `resource_db_endpoint`), else the bare `<output>` name. A missing output records nothing; a mistyped one refuses.

Honest limits of round 2: no shipped driver calls `ctx.input(...)` yet, so the delivery mechanism (variables, the secret channel, the digest binding) is complete and tested but a driver must opt in to consume a declared input; an undeclared request fails closed. The run's earlier observation fallback is kept for a producer whose apply captured nothing. Real tofu proof is `tests/tofu/typed-inputs.test.ts` (gated on a tofu binary, skipped with a reason otherwise); everything else is isolated fakes or the local SQL engine, no cloud. Sealing uses `putSecretAsync` (needs the secret key configured on the worker).

New files: `src/lib/execution/typed-inputs.ts`, `src/lib/execution/mixed/typed-inputs.ts`. Changed: `apply.ts`, `plan.ts`, `destroy.ts`, `desired.ts` (`tofuSessionFor`), `compile.ts`, `context.ts`, `ports.ts` (`typedInputs`), `semantics/collect.ts` and `semantics/digest.ts`, `drivers/types.ts` (`input`), `tofu/engine.ts`, `tofu/runner.ts`, `tofu/workspace.ts`, `platform/execution.ts` (composition), `mixed/output-reader.ts` (shared row preparation, record key), migration 42 and its repo. Tests: `tests/execution/mixed/typed-delivery.test.ts`, `tests/execution/mixed/typed-inputs-activities.test.ts`, `tests/tofu/typed-inputs.test.ts`, the SQL describe "typed inputs: capture at apply and delivery through the platform port" in `tests/controlplane/mixed-follow-up.test.ts`; `FakeTofu` gained `sensitiveOutputs` and input-channel recording.

Extra verification commands: `npx vitest run tests/execution/mixed tests/execution/mixed-orchestration-signals.test.ts tests/tofu/typed-inputs.test.ts tests/tofu/workspace.test.ts tests/tofu/runner.test.ts tests/execution/semantics.test.ts tests/execution/apply.test.ts tests/execution/compile-refs.test.ts tests/execution/destroy.test.ts`.

Behaviour changes to verified contracts, stated: `ExecContext` may carry `typedInputs`; `tofuSession` call sites use `tofuSessionFor` (identical result without secret inputs); `ApplyVerifiedResult` may carry `sensitiveOutputs` (only when requested); the record table key and `value` column (migration 42 is new on this branch, nothing to migrate).

### 1.4 Round 3: generic substitution of references in manifest fields

No driver has to call `ctx.input()`. A consumer manifest holds a reference as the marker `{{zenith.input.<name>}}` (name = `consumer.input` of a declared reference); `src/lib/execution/typed-substitution.ts` does the rest.

- **Non-secret input in any string value of a node spec** (env values, connection strings, URLs, allowlist entries, anywhere inside a larger string): `compileGraph` replaces the marker with a placeholder before the driver compiles and with the OpenTofu variable expression after (`${var.zenith_in_<name>}` in literal text, bare `var.zenith_in_<name>` where HCL evaluates it, decided per occurrence with the same scanner the reference resolution uses). The variable is declared with the value as its default, so the value is in the configuration digest. `CompiledGraph.usedInputs` reports what was used.
- **Secret input**: allowed only as the whole value of a `secretRef` (an env entry `{ key, secretRef }` and the secret node expansion makes from it). `requireExecutable` (the single place the executable graph is derived, so plan, dispatch re-check, secret sync, semantics and plan custody all see the same graph) rewrites it to the vault reference the producer sealed the value under, and turns that secret node into a managed vault secret. The provider's own mechanism then carries it (GCP Cloud Run `secret_key_ref` over a Secret Manager secret, Key Vault, ECS task secrets) and the existing `syncEnvironmentSecrets` writes the vault value into the provider secret store under the consumer's own grant and fence. The value is never in a graph, plan, variable or workspace file, and no tofu variable is declared for it. A secret input is declared as a sensitive variable (and offered on the input channel) only when a driver's compiled output actually uses it through `ctx.input`.
- **Refused at plan time** (`StepFailedError`, input name and node address only): a name the operation does not consume (and every marker of an operation that consumes nothing); a secret input anywhere except a `secretRef`; a non-secret input in a `secretRef`; a marker that is only part of a `secretRef`; a marker in an object key or a malformed one; a marker the driver did not carry into the node's own compiled output (the field cannot take it, so it would silently vanish); a secret marker that reaches the compiler unrewritten; a placeholder that survives substitution. A driver that cannot take a secret reference at all (AWS Lambda) refuses with its own compile error at plan time.
- **Day-two operations** of a consumer environment (a destroy, a drift repair, a re-plan that is not the adopted child operation) load the typed inputs of the environment's newest succeeded child (`findLatestChildOfOperationEnvironment`), so the markers in its manifest keep resolving and the environment stays operable; the same digests are bound in their semantics. This fallback path has no dedicated SQL test (it needs a consumer child driven to `succeeded`); the unit surface is covered.

Tests: `tests/execution/mixed/typed-substitution.test.ts` (real GCP Cloud Run driver through `compileGraph` for the Azure PG connection string as a secret reference and for the Azure host and AWS function URL as env, URL, connection string and allowlist values; the real AWS Lambda driver for the function URL reaching a function env var and for its own refusal of a secret; every refusal above), `tests/tofu/typed-substitution.test.ts` (real OpenTofu, gated on a binary: the references render into env values, a URL, a connection string and an allowlist through the declared variables, and a changed producer value moves the configuration digest so the reviewed plan no longer applies; the secret-in-non-secret-field refusal runs before any tofu starts), and the updated activity tests (a secret is declared and offered on the input channel only when used).

Not proven here: a live Cloud Run, Key Vault or ECS run, and the provider-side secret sync against a real cloud (live acceptance is not approved and not claimed). The GCP and AWS drivers are exercised at compile level only, as everywhere else in the provider contract tests.

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
- **Tofu outputs** are captured at the producer's apply (section 1.3); the earlier observation read-back remains only as a fallback.
- **Observation window.** The read-back is only as good as the child's optional post-apply observe step. If that step did not run, or the driver does not report the declared attribute, the consumer ends `blocked / outputs_unavailable` (terminal for that parent run, nothing undone). A child that outlives the receipt time with a later observation is not read.
- **Delivery to the compiler** is built (section 1.3) and no driver has to call `ctx.input(...)`: manifest references are substituted generically (section 1.4).
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
