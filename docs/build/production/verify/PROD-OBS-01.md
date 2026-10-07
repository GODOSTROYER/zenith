# PROD-OBS-01: Canonical observation-to-repair engine

Branch `prod/obs-01-w3`, based on c9a942d6. No platform migration was needed (version 34 is unused).

## 1. What was built

New module `src/lib/repair/` (one door `@/lib/repair`):

- `lifecycle.ts`: `runRepairLifecycle` (observe, diagnose, brokered proposal, policy, approval, remediate, verify), per-finding `LifecycleItem` (stage, disposition, typed refusal), `summarizeRepairs` (the counts-and-digest contract moved here from the activity).
- `refusals.ts`: total `Record<RepairSkipReason, ...>` of typed refusals (code, stage, retryable, human reason) plus broker_error, start_failed, policy_denied. A repair kind with no driver `drift.repair` handler or declarative recipe is `repair_not_supported` with a reason, never "not implemented".
- `diagnosis.ts`: `withDiagnosisRecording` records finished incident-bound investigations through the existing `recordInvestigation` (stores it, escalates an inconclusive diagnosis). Scope-bound (foreign workspace/environment is never stored); a store failure never hides the read result.
- `index.ts` barrel.

Changed:

- `src/lib/reconcile/core.ts`: verify stage. Settled repairs are listed BEFORE any read (so the re-observation postdates the operation), verified after `stability.observe`. `ReconcileResult.verifications` added. Failures in listing or verifying never block observation and never claim success.
- `src/lib/reconcile/types.ts`: `RepairAwaitingVerification`, `RepairVerification(Outcome)`, optional `ReconcileStability.awaitingVerification` / `verifyRepairs`.
- `src/lib/reconcile/platform/stability.ts`: real implementation. `cleared` (incident `closed` when hysteresis resolved it, else `closing`), `still_present` (operation succeeded: `escalateIncident` with `verification_failed`; operation failed: `evaluateIncidentEscalation` from stored facts), `unverifiable` (unread node or simulated observation: nothing claimed, stored facts decide).
- `src/lib/controlplane/db/repos/incident-stability.ts`: `listRepairsAwaitingVerification` (runs the existing `syncAttemptOutcomes` first).
- `src/lib/incidents/stability.ts`: `EscalationReason` gains `verification_failed` (additive; no SQL constraint on reasons).
- Entry points now call the lifecycle: `src/lib/reconcile/activity.ts` (Temporal `reconcileObserve`), `src/lib/reconcile/pass.ts` (HTTP `POST /api/internal/tick/reconcile`), `src/lib/workflows/reconcile-schedule.ts` (durable sweep, passes `entry: "sweep"`; `ReconcilePassOptions.entry` added in `pass-types.ts`), `src/lib/platform/app.ts` (the MCP investigator is wrapped with diagnosis recording).
- `repair: "not_implemented"` removed from the live type and workflow: `ReconcileWorkflowResult.repair` is `not_requested | not_evaluated | considered` (`src/lib/workflows/types.ts`, `definitions/reconcile.ts`). `docs/platform/operations/OBSERVATION-REPAIR.md` updated.

Verified behaviour changed (stated explicitly): the pre-patch replay branch of `reconcileEnvironmentWorkflow` now returns `repair: "not_evaluated"` instead of `"not_implemented"`. Workflow return payloads are not part of replay determinism, and the legacy fixture bundle `tests/workflows/fixtures/reconcile-legacy.ts` keeps the historical literal (cast to the new type) so `tests/workflows/reconcile.test.ts` still records the original behaviour and replays it. The activity-stub failure type `FAILURE_TYPES.notImplemented` is a different mechanism (stub activities in a worker build) and is unchanged.

Dispatch uses only the existing broker interfaces (`propose`, `beginExecution`, `markUncertain`, `startDayTwo`); nothing here touches dispatch re-authorization (DUR-B). Execution authority is unchanged: `allowAutoRepair` only permits a proposal; allow-without-approval still depends on policy, approvals bind the immutable proposal digest, and no auto-execution beyond existing standing grants was added.

## 2. Acceptance mapping

| Clause | Implementation | Tests |
| --- | --- | --- |
| Temporal/HTTP/controller reuse ONE lifecycle | `runRepairLifecycle` called from activity.ts, pass.ts (tick and sweep) | `tests/repair/lifecycle.test.ts` "entry points share the lifecycle"; existing `tests/reconcile/activity.test.ts`, `pass.test.ts`, `tests/workflows/reconcile.test.ts` |
| `repair:not_implemented` removed (grep) | types.ts, definitions/reconcile.ts | `lifecycle.test.ts` source scan; `grep -rn "not_implemented" src` leaves only `FAILURE_TYPES.notImplemented`, the stub-activity failure and health `health_not_implemented:` signal names |
| Proposals via capability broker and approval path | unchanged `proposeRepairs` -> broker.propose; items report allow/approval/deny | `lifecycle.test.ts` "proposals go through the broker" |
| Every previously not_implemented repair kind is a real proposal or typed refusal | `refusals.ts` total table; `repair_not_supported` names the gap | `lifecycle.test.ts` typed refusals, "repair kind without a handler" |
| Post-remediation verification re-observes, closes or escalates | core.ts verify stage + platform/stability.ts | `lifecycle.test.ts` verification ordering and failure isolation; `tests/repair/lifecycle.platform.test.ts` (real SQL) |
| Inconclusive diagnosis escalates (diagnose stage reachable) | `withDiagnosisRecording` wired in app.ts | `lifecycle.test.ts` diagnose stage |
| Reuses OBS-03 / OBS-02 | `observeSignal`, `reserveRemediation`, `recordInvestigation`, `evaluateIncidentEscalation`, `escalateIncident` unchanged | existing `tests/controlplane/incident-stability.test.ts`, `tests/reconcile/stability.test.ts` |

## 3. Verification commands

Node 22. From the repo root:

```
npx vitest run tests/repair tests/reconcile tests/workflows/reconcile.test.ts tests/workflows/operations.test.ts tests/controlplane/incident-stability.test.ts tests/incidents
ZENITH_TEST_PLATFORM_PG_URL=<disposable pg16 url> npx vitest run tests/repair/lifecycle.platform.test.ts
npx tsc --noEmit -p .
```

Expected: all pass; the platform file runs on PGlite without the env var and additionally on PostgreSQL with it. The Temporal replay tests in `tests/workflows/reconcile.test.ts` need the existing Temporal dev-server setup of that suite.

## 4. Known gaps and shared-file updates

- No new SQL. `tests/controlplane/tenancy.test.ts` and controlplane-sql-scoping: add `incidentStability.listRepairsAwaitingVerification` to the tenant-scoped list (every statement is `workspace_id = $1` scoped, joins on workspace_id). Workflow/gate wiring: add `tests/repair/lifecycle.test.ts` to the unit gate and `tests/repair/lifecycle.platform.test.ts` to the platform/PG lane.
- `ReconcilePassResult` and the workflow `ReconcileRepairSummary` were not extended with verification counts, to keep verified contracts byte-stable; verification outcomes are on `ReconcileResult.verifications` and in escalations/incident events.
- Verification is recomputed each pass for open incidents (no "verified" marker column); outputs are idempotent (`escalateIncident` is idempotent, hysteresis owns closure).
- A repair whose node is simply not observable stays `unverifiable`; the incident closes only by genuine clean observations.
- Live provider remediation and ECS adapter acceptance are unchanged and still open; not claimed here.
- The deploy-time `observeEnvironment` activity (execution/verify.ts) is a separate deploy-verification observation, not a repair path, and was not routed through the lifecycle.
- Nothing was run: tests were not executed in this build pass (typecheck and eslint only, both clean).

## 5. Suggested ledger implementationStatus

`lifecycle_unified_local: runRepairLifecycle is the single door for Temporal, HTTP tick and durable sweep; typed refusals for every unrepaired finding; post-remediation verification closes or escalates; diagnosis recording wired. Tests written, not yet executed. Live provider remediation unproven.`
