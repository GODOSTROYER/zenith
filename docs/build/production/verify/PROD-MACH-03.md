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

## 2b. Reachability (merged with prod/compose; composition root wired)

- Migration 17 registered like 15/16 (src registry) and the generated aggregate `supabase/migrations/0018_platform_core.sql` regenerated with `npx tsx scripts/platform/emit-sql.ts` (hardening block for the six tables added to `emit.ts`; `--check` passes). Inventories updated: `docs/platform/operations/DEPLOYING.md` (row 17 with checksum, schema note), `scripts/ci/apply-supabase-migrations.sh` (platform table presence list), `tests/controlplane/migrations.test.ts` (EXPECTED_TABLES). The migration runtime manifest drives version checks, so no pinned count changed. If LIFE-12 also regenerates `0018_platform_core.sql`, re-run the emit script after merging.
- Store functions are in `controlplane/db/repos/machine-runbooks.ts` and are NOT added to `repos/index.ts`, so `tests/controlplane/tenancy.test.ts` and the sql-scoping classification need no entry (they enumerate that namespace). Every statement is workspace-scoped in SQL except the two system reads `listDueSchedules` and `listClaimableRuns`; tenant isolation is asserted in `tests/controlplane/machine-runbooks.test.ts`. If the orchestrator prefers it registered, classify those two as system-maintenance reads.
- Composition: `src/lib/platform/runbooks.ts` (store, control-plane signer and pinned keys, broker role resolver for authorization, `createDefaultMachinePort` evidence + signed zenithd queue, per-step broker `propose` / `beginExecution` / `completeExecution` / `markUncertain`). A step the broker does not `allow` outright fails (`step_require_approval`, `step_deny`); the run-level human approval never substitutes for it. Targets are limited to registered zenithd machines (cloud transports need the product connection for the environment, not resolved here); this is enforced at request and schedule time.
- Routes under `/api/platform/v1/runbooks` (all via `platformRoute`, existing principal/role checks): GET list and POST publish (browser-only), POST `:id/runs`, POST `:id/schedules`, GET `runs`, GET `runs/:id`, POST `runs/:id/approve` (browser-only, binds `bindingDigest`), POST `runs/:id/cancel`, GET `schedules`, POST `schedules/:id/approve` (browser-only), POST `schedules/:id/state`. Classified in `_lib/bearer-paths.ts`; `tests/middleware/platform-bearer.test.ts` inventory count updated 37 -> 48. Agents (integration credentials) can request, schedule, cancel and read but cannot publish or approve; the owner of an agent cannot approve that agent's request (accountable identity is compared).
- Periodic driver: `POST /api/internal/tick/runbooks` (CRON_SECRET bearer, control-store only) and a pass in the in-process scheduler slow cycle (`cron.ts`, failure isolated from the engine pass). Durability comes from PostgreSQL state, not the caller: unique (schedule, slot), compare-and-set cursor, run claim leases (expired lease reclaimed, in-flight step then marked uncertain, never re-dispatched), a `system:runbook-tick` lease, budgeted execution with `releaseOnAbort`. HONEST GAP: OBS-04 (durable critical schedules) is not in this branch. Registering `runbookTickPass` as a Temporal schedule / OBS-04 critical schedule is the remaining step; until then the tick is driven by the cron route (`.github/workflows/tick.yml` must add `tick/runbooks`, not editable here) or the long-lived scheduler.
- MCP: no machine operation is exposed through the v3 MCP tools, so no MCP tool was added.
- Added tests: `tests/machines/runbook-step-executor.test.ts`; list/claimable coverage in `tests/controlplane/machine-runbooks.test.ts`.

## 3. Verification commands (other machine)

```
npx vitest run tests/machines/runbooks.test.ts tests/machines/runbook-step-executor.test.ts
npx vitest run tests/controlplane/machine-runbooks.test.ts tests/controlplane/migrations.test.ts   # PGlite lane
ZENITH_TEST_PLATFORM_PG_URL=<postgres url> npx vitest run tests/controlplane/machine-runbooks.test.ts tests/controlplane/migrations.test.ts
npx vitest run tests/middleware/platform-bearer.test.ts tests/engine/postgres-scheduler.test.ts tests/docs
npx tsx scripts/platform/emit-sql.ts --check
npx tsc --noEmit -p . && npx eslint <changed files>
```

Expected: all pass, zero skipped (the PostgreSQL lane only with the env var). No Go or OPA changes.

## 4. Known gaps

- No UI page; the REST surface is complete. Real end-to-end runs against a live zenithd machine, the live signer and the broker ledger are untested here (nothing was executed).
- The route handlers are not covered by a route-level test (the bearer-path inventory, service, runner, executor and SQL store are). A route test needs the session/identity mocks used by the operations route tests.
- Windows are UTC only, never cross midnight. Cloud-transport runbook targets are refused. File upload/write/package steps depend on the other worker's slice.
- Step operations for critical capabilities need the broker to allow them without a per-step approval (policy/autonomy); otherwise the step fails closed.

## 5. Suggested ledger implementationStatus

`signed_runbooks_scheduling_audit_rest_and_tick_wired_zenithd_targets_live_runs_and_obs04_registration_pending`

## J4 follow-up (2026-10-08)

See [J4 schedules/runbooks](J4-SCHEDULES-RUNBOOKS.md) for the signed delivery/semantics and natural-timer harness, exact Mac commands, local checks and shared joins. Implementation complete, verification pending; historical evidence above is not new J4 acceptance.
