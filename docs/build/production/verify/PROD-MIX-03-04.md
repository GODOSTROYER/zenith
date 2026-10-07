# PROD-MIX-03 Typed scoped dependency outputs and PROD-MIX-04 Distributed failure and teardown order: verification notes

Built only; nothing here was executed (typecheck and eslint on the changed files only). Another machine runs every test below. Branch `prod/mix-03-04-w4b`, base `ad78c593` (wave 3), platform migration **44** (versions 37 to 43 belong to sibling wave-4 workers; the assembler fills them in).

## 1. What was built

Audit first. The base already holds the pure partition planner (`src/lib/execution/mixed-partitions.ts`: typed `PartitionReference` contracts, `ReferenceProvenance`, secret reference shape, `planMixedPartitions`, `classifyMixedPlanChange`, `teardownOrder`) and non-executable child custody (`mixed-child-admission.ts`, migration 14). It plans; it never runs, records no child outcome, and has no timeout, expiry, cancellation, outage, reconciliation or teardown behaviour, and no way for a person to pre-cover a materialization. This work adds exactly that, in separate modules with a narrow join, and reuses the planner's provenance checks and change classification instead of re-implementing them.

### Modules (`src/lib/execution/mixed-orchestration/`)

| File | Purpose |
| --- | --- |
| `child-view.ts` | **The join with MIX-01/02.** `ParentPlanView` (children: id, connection, subplan digest, effect digest, `dependsOn`, node ownership; references: typed contract, producer/consumer child, `materialized`). `parentViewOf(plan, references)` derives it from a `MixedPartitionPlan` and re-checks every planned reference's contract digest against the supplied inventory. Nothing else imports the planner's partition types. |
| `order.ts` | Deterministic dependency order, explicit cycle refusal naming the members, upstream/downstream sets. |
| `outputs.ts` (MIX-03) | `TypedOutput`: declared type, scope (workspace, environment, exact consumer child and its connection), provenance (producer child id, subplan digest, effect digest, resource address, output name, connection, receipt digest, artifact digest), `valueDigest`, and for a secret only `{ref: vault:..., versionDigest}`. Closed schema: an extra or secret-looking key is refused as `secret_value`, an inline secret never parses. `validateOutput` requires the producer to have SUCCEEDED in the run with that very receipt and effect digest. `assessOutputConsumption` re-plans with the outputs applied (planner provenance checks) and classifies with `classifyMixedPlanChange`: `unchanged`, `preauthorized`, or `review_required` (the exact new `requiredParentDigest`, DUR-B). |
| `decision.ts` | Issued-decision brand: only `assessOutputConsumption` can create a decision, the run reducer accepts a `rebind` only for an issued one. |
| `preauthorization.ts` (MIX-03) | Precise output preauthorization: one parent operation, one reference and its contract digest, consumer and producer subplan digests, the parent's desired-inputs digest, value type, for a secret the exact vault reference (any version of it), optional value pin; 1 to 10 uses (atomic), 5 minutes to 7 days; created and revoked only by a human admin with their own browser session; lapses when revoked, expired, spent, or its creator stops being admin. Memory store + service functions with audit events. |
| `run.ts` (MIX-04) | Durable parent-run state machine (pure reducer). Per child: status, attempts, effect knowledge (`none`/`possible`/`present`), `reconciliationRequired`, receipt, rebinds with their authority, blocked-by root causes. Events: start, succeed, fail, outage, tick (child timeout and expiry), cancel, cancel_confirmed, reconciled, retry, rebind. `summarizeRun` returns `atomicity: "none"`, `automaticCompensation: "never"`, completed/failed/indeterminate/in-flight/blocked/not-started lists, children left applied, and next-step codes. |
| `ordering-rules.ts` (MIX-04) | Drift, migration, start and teardown ordering rules (see section 2). |
| `teardown.ts` (MIX-04) | Teardown PROPOSAL in reverse dependency order, ownership and outside-dependent checks, verification of a human admin approval of an `infrastructure.destroy` operation bound to the step's addresses, one step released at a time, outcomes recorded. `brokerTeardownApprovalPort` reads the destroy operation, its non-simulated plan evidence and its approvals from the broker store. |
| `run-store.ts` | `MixedRunStore` port: platform repo store (re-validates state on read) and `MemoryMixedRunStore` with identical rules. |
| `service.ts` | Tenant-scoped durable operations with version compare-and-set and bounded retry: `openMixedRun`, `readMixedRun`, `recordChildEvent`, `tickMixedRun`, `cancelMixedRun`, `sweepDueMixedRuns`, `consumeOutputs`, `proposeTeardown`, `releaseTeardown`, `syncTeardownStep`. |
| `platform.ts`, `sweep.ts`, `index.ts` | Production composition (platform stores, broker store, `platform.resources` ownership/dependents lookup), the housekeeping sweep entry, public exports. |

### Persistence, wiring

- `src/lib/controlplane/db/migrations/0044_mixed_runs.ts` (version 44, registered in `migrations/index.ts`): `mixed_runs` (CAS version trigger, immutable identity, never deleted, `open`/`next_deadline_at` for the sweep), `mixed_run_events` (append-only ledger by trigger), `mixed_output_preauthorizations` (all bounds NOT NULL and CHECKed, immutable except `uses` and one-way revocation). RLS enabled, anon/authenticated revoked, service_role grants.
- `repos/mixed-runs.ts`, `repos/mixed-output-preauthorizations.ts`, registered in `repos/index.ts`.
- **Housekeeping hook (additive, `src/lib/platform/housekeeping.ts`, one call inside the existing locked transaction):** `sweepMixedRunDeadlines` ticks every open run whose child timeout or approval expiry has passed, so timeout and expiry propagate with no executor running. It starts nothing and destroys nothing. The result shape of `housekeepingPass` is unchanged.
- REST (all in `bearer-paths.ts`): `GET /api/platform/v1/operations/:id/mixed-run` (state, summary, ledger; any member who can see the operation; bearer-capable), `POST .../mixed-run/cancel` (requester, the human an agent proposed it for, editor or admin; bearer-capable), `POST .../mixed-run/teardown` (`propose` / `release` / `sync`; editor or admin; browser-only), `GET|POST /api/platform/v1/mixed-output-preauthorizations` and `POST .../:id/revoke` (admin; browser-only).

## 2. Acceptance mapping

**PROD-MIX-03** "Typed outputs/secret references preserve provenance and scope; newly materialized effects require review unless precisely preauthorized."

| Clause | Implementation | Tests |
| --- | --- | --- |
| typed outputs | `TypedOutput` closed schema, type equals the reference contract's type | `tests/execution/mixed-orchestration.test.ts` "typed output contracts" (wrong type, unknown reference) |
| scope preserved | workspace, environment, consumer child and consumer connection must match the contract and the run | same file (4 scope refusals) |
| provenance preserved | producer child, address, output name, connection, subplan digest, effect digest and receipt must match the plan and the producer's recorded success | same file (6 provenance refusals, producer pending/failed/timed out) |
| secret references | vault reference plus version digest only; inline value, extra key, non-vault ref, shape mismatch, digest mismatch refused without echoing the value | same file "secret references"; planner secret rules reused |
| newly materialized effect requires review | consumer `effectDigest` changes; `review_required` with the exact new parent digest; rebind needs a person's approval of exactly that digest; started consumers can never be rebound | mixed-orchestration.test.ts "a new materialization needs review", "refuses a rebind ..."; mixed-orchestration-service.test.ts "consuming outputs" |
| unless precisely preauthorized | grant covers one reference with matching parent op, desired digest, contract, consumer and producer subplan digests, type (and exact vault ref); 14 widening variants fall back to review; uses reserved atomically; revoked, expired, spent or creator-demoted grants cover nothing | same files; `tests/controlplane/mixed-runs.test.ts` (SQL bounds, immutability, concurrency) |
| a person's decision | created/revoked by a human admin with a browser session (agents, editors, borrowed sessions, strangers refused), audited | mixed-orchestration-service.test.ts "output preauthorizations" |

**PROD-MIX-04** "Cycles, partial success, timeout, expiry, cancellation, outage, drift/migration/teardown order fail safely; no fictional transaction or destructive automatic compensation."

| Clause | Implementation | Tests |
| --- | --- | --- |
| cycles | `orderChildren` / `createRunState` refuse and name the members before anything is recorded; unknown, self and duplicate dependencies refused | mixed-orchestration.test.ts "dependency order and cycles" |
| partial success | per-child receipts and effect knowledge; outcome `partial` with children left applied; `atomicity: "none"`, `automaticCompensation: "never"` constants; dependents blocked with root cause | "run state machine" (partial success, blocked dependents, complete run) |
| timeout | `tick` moves an overdue child to `timed_out`, effects `possible`, reconciliation required, dependents blocked; a late receipt is accepted as evidence | same; service sweep test; SQL sweep and housekeeping test |
| expiry | pending/blocked children `expired`, in-flight children are not withdrawn, `nextRunnable` empty, starts refused | same |
| cancellation | pending cancelled, running `cancel_requested` (never claimed stopped), later success still recorded, retry refused after cancel; REST cancel propagates | same; `mixed-run/cancel` route helper tests |
| outage | `outage` is indeterminate like a timeout: reconcile, then retry | same |
| reconcile before retry | a child whose effects are `possible` cannot be retried or torn down until a `reconciled` event | same |
| drift/migration order | start blocked by unresolved producer drift (expected variance excepted) or an incomplete migration; one migration at a time; repair producers first; no repair beside in-flight or unreconciled neighbours; no teardown during a migration | "drift and migration ordering" |
| teardown order | reverse dependency order, a step waits for its applied consumers to be confirmed destroyed (failed and uncertain do not count), one step at a time | "teardown" |
| ownership | only `managed` nodes owned by this parent op and child; referenced/external retained; an outside dependent refuses the plan | "teardown" (ownership, outside dependents, retained) |
| human destructive approval | a step is released only against a destroy operation approved by a human admin for exactly the step's addresses (proposal digest bound, unexpired, unconsumed, no rejection); the destroy outcome is read from that operation's own status, never claimed by the caller | "release needs a verified human destructive approval" (16 refusals), service teardown tests, broker port tests |
| no destructive autonomy | no code path in this module destroys; teardown is a proposal released to the existing destroy path | by construction; constants asserted in summaries |

## 3. Verification commands (other machine)

```
npx vitest run tests/execution/mixed-orchestration.test.ts tests/execution/mixed-orchestration-service.test.ts
npx vitest run tests/execution/mixed-partitions.test.ts tests/controlplane/mixed-child-admission.test.ts   # base behaviour must be unchanged
npx vitest run tests/controlplane/mixed-runs.test.ts                                                       # PGlite lane
ZENITH_TEST_PLATFORM_PG_URL=<postgres url> npx vitest run tests/controlplane/mixed-runs.test.ts           # real PostgreSQL lane
npx vitest run tests/platform/housekeeping.test.ts tests/server/cron-housekeeping.test.ts tests/middleware/platform-bearer.test.ts
npx tsc --noEmit -p . && npx eslint src/lib/execution/mixed-orchestration src/app/api/platform/v1 src/lib/controlplane/db/repos src/lib/platform/housekeeping.ts tests/execution tests/controlplane/mixed-runs.test.ts
```

Expected: all pass, zero skipped (the PostgreSQL lane only with the env var). `platform-bearer.test.ts` must classify the five new route files (added to `bearer-paths.ts`). The housekeeping tests must stay green: the new hook is inert when no run is overdue.

Live acceptance is deferred by the user and not performed or claimed. Everything here is contract level plus the local engine; no cloud API is called.

## 4. Known gaps, things that may break first, shared-file updates

**Join with MIX-01/02 (what the assembler must do).** The partition executor (MIX-01/02) is the caller of the run service. Concretely:
1. After planning, build the view with `parentViewOf(plan, input.references)` and call `openMixedRun` once per parent operation (the parent approval's expiry becomes `expiresAt`).
2. For each runnable child (`nextRunnable`), call `recordChildEvent` with `start` and the child's reviewed effect digest, then drive the child workflow (which still passes DUR-A authority, DUR-B semantics, DUR-C custody and DUR-D effect ledger on its own); report `succeed` with the verified child receipt digest, or `fail` / `outage`.
3. Before a consumer starts, take the producer's verified output, build a `TypedOutput` and call `consumeOutputs` with the approved planner input; on `review_required` surface `decision.requiredParentDigest` for a parent approval round, then call again with `review: { approvalId }`; use `nextInput` as the next approved input.
4. If the partition model renames or reshapes `MixedPartitionPlan`, change only `parentViewOf`.
5. The executor must supply drift and migration observations as `signals` to `recordChildEvent` (start) and `releaseTeardown`; the REST teardown route supplies none (`NO_SIGNALS`) and so relies on the run's own state and the destroy approval.

**Not wired (stated, refused explicitly).**
- `ParentReviewPort` in the platform composition is `refusingParentReviewPort`: a changed parent digest needs a parent approval round bound to that digest, which belongs to the parent approval path that joins with MIX-02. Until then `consumeOutputs` returns `applied: false` with the decision for any change not covered by a preauthorization, and no consumer is rebound. Preauthorized and unchanged consumption works today.
- No executor calls `recordChildEvent` yet (execution of mixed graphs stays disabled in the base: `executionEnabled: false`). The state machine, store, REST read/cancel/teardown routes, sweep and preauthorization are real and reachable; the per-child driver is the join above.
- Resource ownership for teardown comes from `platform.resources` (`managed`, not deleted/planned). That table has no per-operation provenance column, so this proves "Zenith-managed in this environment", combined with the run's own receipts; it cannot prove which operation created a resource.
- The destroy approval binds the destroy operation's reviewed address list and proposal digest to the step; the destroy proposal itself does not carry a `mixedTeardown` reference, so the destroy operation is chosen by the person who calls `release`.
- A use of a preauthorization is spent when reserved; if the following state write fails (for example the consumer already started) the use is not returned.
- Output values are never stored or transported here: only digests and vault references. How the value reaches the consuming child's compiler input is the child plan's job (`compilerReferenceCoverage: "unavailable"` in the base).

**May break first.**
1. `tests/controlplane/migrations.test.ts`: contiguity (versions 37 to 43 absent on this branch alone) and the table inventory (`mixed_runs`, `mixed_run_events`, `mixed_output_preauthorizations`).
2. `tests/controlplane/tenancy.test.ts` completeness guard: add the functions below. `tests/security/controlplane-sql-scoping.test.ts` passes textually (every function names `workspace_id`); `mixedRuns.listDue` is deliberately cross-tenant system maintenance and selects only keys.
3. The housekeeping hook runs inside the existing transaction; a nested savepoint isolates a failing run, but a failure of `listDue` itself would fail the pass (same as the other sweeps).
4. `mixed-runs.test.ts` housekeeping test retries up to 10 times for the global housekeeping lease; on a shared PostgreSQL it can be starved by another suite.
5. Preauthorization creation in the browser needs the exact digests (contract, consumer and producer subplan, desired); the UI for that is not built (REST only).

**Shared-file updates the orchestrator must make.**
- Migrations inventory: version 44 `mixed_runs`; tables `mixed_runs` (select/insert/update), `mixed_run_events` (select/insert), `mixed_output_preauthorizations` (select/insert/update); RLS enabled; no anon/authenticated access. Emit supabase SQL after the 37 to 43 merge; renumber if another worker takes 44.
- Tenancy classification (`tenancy.test.ts`): tenant-scoped functions `mixedRuns.get`, `mixedRuns.create`, `mixedRuns.save`, `mixedRuns.listEvents`, `mixedOutputPreauthorizations.create`, `.get`, `.list`, `.revoke`, `.reserveUse`; system maintenance `mixedRuns.listDue` (returns workspace-qualified keys only, never content). All filter on `workspace_id`. Tenant tables: `mixed_runs`, `mixed_run_events`, `mixed_output_preauthorizations` (FK to `platform.operations(workspace_id, id)`).
- Gate manifest and platform coverage: `tests/execution/mixed-orchestration.test.ts`, `tests/execution/mixed-orchestration-service.test.ts` (unit); `tests/controlplane/mixed-runs.test.ts` (postgres lane via the `tests/controlplane` directory entry, `postgres: true`).
- Route inventory: five new route files (classified in `bearer-paths.ts`).
- LIMITATIONS: mixed runs record per-child outcomes and never claim atomicity or compensate; teardown is a human-approved proposal; review of a changed parent digest awaits the parent approval round; ownership evidence is the resource registry; live multi-cloud acceptance not performed.

## 5. Suggested ledger implementationStatus

- PROD-MIX-03: `typed_scoped_outputs_with_provenance_review_on_new_materialization_and_precise_preauthorization_built_contract_and_local_engine_tests_pending_parent_review_join_and_live_acceptance_open`
- PROD-MIX-04: `failure_timeout_expiry_cancel_outage_drift_migration_and_reverse_order_human_approved_teardown_built_contract_and_local_engine_tests_pending_executor_join_and_live_acceptance_open`
