# PROD-MACH-03 Signed automation and scheduling: verification notes

Built only; nothing here was executed (typecheck and eslint on the changed files only).

## 1. What was built

Audit result first: the Go runner / zenithd already verify signed capability grants and signed machine requests, and the machine plane already has one entry point (`executeMachineOperation`) with per-request grant, evidence and at-most-once dispatch. Nothing existed for versioned scripts/runbooks, windows, schedules of machine work, run cancellation or a runbook audit trail. Runbook steps are executed as ordinary signed machine requests through the existing path, so no Go change was needed and no `go/internal/machine` file was touched.

New code (all additive):

- `src/lib/machines/runbooks/definition.ts`: strict runbook schema. Each step is one implemented machine operation whose args are parsed by the executor's own `parseMachineArgs` and stored in parsed form (static, no templating, credential-looking values refused). `classifyRunbook` classifies by operation only; `machine.exec` and `container.exec` are always `critical`/escape-hatch, and `argvClassification` is the constant `never_classified_safe`. Target schema (resource-scoped, unique, at most 25).
- `signing.ts`: `zenith-runbook+jwt` EdDSA signature by the control-plane signer over workspace, runbook id, version and the canonical definition digest. Verification pins keys, rejects foreign `typ` and embedded-key headers, re-derives the digest from the stored definition. One fixed error message.
- `policy.ts`: `bindingDigestOf` (the immutable effect an approver approves: workspace, runbook, version, definition digest, sorted targets, bounds, windows, whole schedule) and `evaluateRunbookGate` (read-only: allow; mutating or raw exec: needs an unexpired approval bound to that digest from someone other than the requester). Raw-exec approvals are capped at 24 h, others 7 days, and a run approval never outlives the run deadline.
- `schedule.ts`: pure UTC window and cadence math; bounded search; a slot never runs late (grace at most 5 min) nor past its window; hard caps on duration (6 h), targets (25) and parallelism (5).
- `service.ts`: publish (monotonic immutable versions), requestRun, approveRun (human principal only, not the requester), cancelRun, createSchedule / approveSchedule / pause / resume / cancel, and `tickSchedules` (durable, idempotent, multi-instance safe: unique (schedule, slot) run plus compare-and-set cursor; missed and blocked slots are audited, never run late).
- `runner.ts`: `executeRunbookRun` (claim with lease, re-verify signature and digest pin, re-check the approval gate, per-step cancel/deadline/abort checks, in-flight abort, at-most-once step custody row written before dispatch, uncertain never re-dispatched, per-target onFailure, bounded parallel targets) and `createMachineStepExecutor` (wraps `executeMachineOperation`; needs a broker-issued grant per step via the `grantFor` port, so policy and per-step approval of critical capabilities still apply; no privileged fallback).
- `audit.ts`: per-subject append-only hash chain (`verifyAuditChain`); detail is bounded and scrubbed.
- `ports.ts`, `memory-store.ts`, `index.ts`: store port, in-memory store, barrel.
- `src/lib/controlplane/db/migrations/0017_machine_runbooks.ts` plus one-line additive registration in `migrations/index.ts`: six `platform.machine_runbook_*` tables, RLS on, anon/authenticated revoked, versions/approvals/audit immutable by trigger, approver <> requester check, unique schedule slot.
- `src/lib/controlplane/db/repos/machine-runbooks.ts`: Postgres `RunbookStore` (`createPlatformRunbookStore`). Not added to `repos/index.ts` (shared registry).

Tests: `tests/machines/runbooks.test.ts` (memory store, real Ed25519), `tests/controlplane/machine-runbooks.test.ts` (SQL store on PGlite and PostgreSQL lanes).

## 2. Acceptance mapping

Acceptance: "Versioned signed scripts/runbooks, bounded targets/windows/cancellation/audit; raw exec remains approved high-risk escape hatch, argv parsing never claimed sandbox."

| Clause | Implementation | Tests |
| --- | --- | --- |
| Versioned | `service.publish`, immutable (version, digest) rows, DB trigger | runbooks.test.ts "publishes immutable monotonically numbered versions"; machine-runbooks.test.ts "versions are immutable" |
| Signed | `signing.ts`; verified at request, approve, tick and every run | runbooks.test.ts "signing" (tamper, version, tenant, key, typ, malformed); "does not run when the stored definition no longer matches"; "schedule whose runbook version fails verification blocks" |
| Bounded targets | `parseRunbookTargets` (resource-scoped, unique, <= 25), binding digest includes targets | "targets must be resource-scoped"; "approval for one binding does not satisfy a different target set" |
| Bounded windows | `schedule.ts`, `adHocDeadline`, run deadline | "schedule math" group; "the deadline stops further steps"; "unbounded schedules are rejected" |
| Cancellation | `cancelRun`, store `requestCancel`, runner poll + abort of the in-flight step | "cancel moves a pending run"; "cancellation aborts the in-flight step"; SQL "claim is exclusive ... cancel is conditional" |
| Audit | hash-chained append-only `machine_runbook_audit`, events for publish/request/approve/cancel/schedule/slot/step/finish | "verifiable audit chain"; SQL "concurrent audit appends keep one unbroken hash chain" |
| Raw exec remains approved high-risk escape hatch | `classifyRunbook` critical + approval required, 24 h approval cap, separate approver; per-step broker grant for `machine.exec` still applies | "classifies by operation"; "mutating and raw exec runs wait for an independent approver"; "raw-exec schedule only runs inside its 24 h approval" |
| argv parsing never claimed sandbox | no argv inspection; `argvClassification: "never_classified_safe"` | "a harmless-looking argv is classified exactly like a dangerous one" |
| Durable scheduling | SQL schedules, unique (schedule, slot), CAS cursor, missed/blocked audit | "durable schedule tick" group; SQL "a schedule slot becomes at most one run" |
| At-most-once | step custody row before dispatch | "uncertain step ... never re-dispatched"; "crashed run reclaimed after its lease"; SQL "step custody is at-most-once" |

## 3. Verification commands (other machine)

```
npx vitest run tests/machines/runbooks.test.ts
npx vitest run tests/controlplane/machine-runbooks.test.ts          # PGlite lane
ZENITH_TEST_PLATFORM_PG_URL=<postgres url> npx vitest run tests/controlplane/machine-runbooks.test.ts   # adds real PostgreSQL lane
npx vitest run tests/controlplane/migrations.test.ts                 # after the inventory updates below
npx tsc --noEmit -p . && npx eslint src/lib/machines/runbooks src/lib/controlplane/db/repos/machine-runbooks.ts tests/machines/runbooks.test.ts tests/controlplane/machine-runbooks.test.ts
```

Expected: all pass, zero skipped (the PostgreSQL lane only appears with the env var). No Go or OPA changes.

## 4. Known gaps and shared-file updates

- Migration inventories must be updated by the orchestrator: `scripts/ci/apply-supabase-migrations.sh`, `docs/platform/operations/DEPLOYING.md`, `tests/controlplane/migrations.test.ts` (new version 17 `machine_runbooks`; the Supabase renderer `emit.ts` takes it from `PLATFORM_MIGRATIONS`). If another worker also added 0017 the later one must renumber. Add the two new test files to the gate manifest if it enumerates test paths.
- Not wired: no HTTP route, UI or cron mount. The tick (`createRunbookService(...).tickSchedules`) and `executeRunbookRun` are library entry points; the composition root must provide `authorize` (workspace role), `grantFor` (capability broker propose/approve/grant per step), the machine drivers/sessions/evidence, and a periodic caller (for example the internal tick route or a Temporal schedule). Per-step grants from the broker are the integration point that makes critical capabilities also need their own approvals.
- Runs are executed by whichever worker calls `executeRunbookRun`; no long-lived dispatcher loop is included.
- Windows are UTC only, do not cross midnight, and have no DST/zone support by design.
- File upload/write/package operations are accepted as step operations (args validated by their existing schemas) but their end-to-end behavior depends on the other worker's slice.
- Real PostgreSQL behavior of the partial-index `on conflict` and trigger functions is covered by the SQL tests only when they are run on that lane; PGlite was not run by this worker.
- Typecheck: the pre-existing errors in `src/lib/tofu/engine.ts` and `tests/ci/platform-coverage.test.ts` at the base commit are unrelated.

## 5. Suggested ledger implementationStatus

`signed_runbooks_scheduling_audit_built_composition_wiring_and_live_runs_pending`
