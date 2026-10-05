# PROD-OBS-04 Durable critical schedules (verify)

Branch `prod/obs-04-w2`, platform migration 21. Build-only: nothing here has been executed; typecheck (`tsc --noEmit -p .`) and eslint on changed files were clean.

## 1. What was built

Temporal is the durable substrate (existing worker, task queue `zenith-execution`). Two Schedules now cover every critical periodic job; GitHub cron and the in-process scheduler remain only as a fallback trigger running the same code.

| Job (health name) | Durable trigger | Fallback trigger |
|---|---|---|
| observation + COST-03 optimizer pass (`reconcile`) | existing `zenith-reconcile-sweep-v1` (already ran the optimizer pass in-lease) | `/api/internal/tick/reconcile` |
| platform housekeeping (`housekeeping`) | new `zenith-critical-maintenance-v1` | `jobs?housekeeping=1`, in-process scheduler |
| runner/machine reaper (`runner-reaper`) | same new schedule | `/api/internal/tick/jobs` |
| MACH-03 signed runbook tick (`runbooks`) | same new schedule | `/api/internal/tick/runbooks`, in-process scheduler |

New files
- `src/lib/controlplane/db/migrations/0021_scheduled_job_runs.ts` (registered in `migrations/index.ts`): `platform.scheduled_job_runs`.
- `src/lib/controlplane/db/repos/scheduled-jobs.ts` (registered in `repos/index.ts`): `beginRun`, `finishRun` (fenced), `recordSkip`, `getScheduledJob`, `listScheduledJobs`.
- `src/lib/platform/critical-jobs.ts`: registry, `runCriticalJob` (lease + fence + record + fallback deferral), `recordLeasedRun`, `MAINTENANCE_JOBS`, `runCriticalMaintenance`, `runFallbackJob`, `criticalJobHealth`.
- `src/lib/workflows/definitions/criticalMaintenance.ts` (workflow `criticalMaintenanceWorkflow`, exported from `definitions/index.ts`, type name in `types.ts`).
- `src/lib/workflows/critical-schedule.ts`: schedule options, compatibility check, `ensureCriticalMaintenanceSchedule`, `inspectCriticalMaintenanceSchedule`.
- `src/lib/workflows/critical-activities.ts`: `runCriticalMaintenance` activity.
- `src/app/api/internal/tick/status/route.ts`: bearer-gated last-run/health (GET or POST, `?strict=1` gives 503 when not healthy).
- Tests: `tests/platform/critical-jobs.test.ts`, `tests/workflows/critical-schedule.test.ts`.

Edited
- `src/lib/platform/app.ts`: `reapRunnerJobs(db)` extracted so worker and fallback share the reap.
- `src/lib/workflows/reconcile-schedule.ts`: the sweep activity records its run (fenced by the sweep lease) into `scheduled_job_runs` as `reconcile`/`temporal`.
- `src/lib/server/cron.ts`, `tick/runbooks/route.ts`, `tick/reconcile/route.ts`: fallback paths go through `runFallbackJob`.
- `workers/execution/worker.ts`, `startup.ts`: register the activity, provision the schedule (only in `ZENITH_WORKER_RECONCILE_SCHEDULE_MODE=provision`, never in observe mode, never un-pausing), log job health every 30 s. A schedule provisioning failure is a warning (health then shows never_run/stale), it does not stop the worker.
- `types.ts` (`RegisteredWorkerActivities` includes the new activity), `tests/workflows/sandbox.test.ts` and `tests/workers/reconcile-composition.test.ts` (inventory/registration updates).

Semantics
- Leases/fencing: every run holds `critical-job:<job>` (fenced lease, renewed, lost-lease aborts). The run record stores the fence; only that fence can finish it.
- Overlap: Temporal `SKIP` plus the shared lease, so a Temporal run and a cron trigger cannot overlap (the loser returns `busy`).
- Missed-run catch-up: schedule catch-up window 5 min (older dropped); all jobs are level-triggered, so one immediate pass closes a gap. The gap is counted in `missed_ticks_total`.
- Fallback idempotency: a fallback trigger is skipped (`deferred: durable_current`, counted) while a `temporal` success is younger than 90 s; otherwise it runs and records `fallback` as the source. Reconcile environments keep their own claims, so a fallback pass that does run is idempotent with the sweep.
- Health: `healthy` / `stale` (no success for 5 cadences) / `failing` (3 consecutive failures) / `never_run`, with last source, durable flag, missed ticks, skips. Only counts and fixed codes are stored; no errors, ids or provider output.

Explicitly not covered (stay HTTP/in-process only): engine, alerts, outbox, agent journal and the hosted job runner passes. They read the legacy product snapshot, which a Temporal worker cannot provide. Their fallback status is unchanged.

## 2. Acceptance mapping

"Critical observation/reaping use durable scheduling across restart, not only best-effort GitHub cron."
- Observation + optimizer: durable sweep schedule (existing) now also records health; `tests/platform/critical-jobs.test.ts` (overlap, fallback deferral/resume), existing `tests/workflows/reconcile-schedule.test.ts` (real Temporal, restart survival).
- Reaping/housekeeping/runbooks: `criticalMaintenanceWorkflow` schedule; `tests/workflows/critical-schedule.test.ts` (definition, custody, adoption, drift refusal), `tests/platform/critical-jobs.test.ts` (runs, failures, staleness, catch-up, fencing), `tests/workflows/sandbox.test.ts` (sandbox safety of the new definition).
- Persistence across restart: Temporal Schedules persist server-side; run state persists in PostgreSQL. A real-Temporal restart test for the new schedule was not written (see gaps).
- GitHub cron only a fallback: fallback deferral tests above.
- Visibility: status route + worker log + `criticalJobHealth` tests.

## 3. Verification commands (other machine)

```
npx vitest run tests/platform/critical-jobs.test.ts tests/workflows/critical-schedule.test.ts tests/workflows/sandbox.test.ts tests/platform/housekeeping.test.ts tests/controlplane/migrations.test.ts tests/controlplane/tenancy.test.ts tests/security/controlplane-sql-scoping.test.ts
ZENITH_TEST_PLATFORM_PG_URL=<disposable pg> ZENITH_TEST_RECONCILE_SCHEDULE=1 ZENITH_TEST_TEMPORAL=1 ZENITH_TEST_TEMPORAL_CLI=<cli> npx vitest run tests/workflows/reconcile-schedule.test.ts tests/workers/reconcile-composition.test.ts
```
Expected: all pass. migrations/tenancy/scoping tests need the shared-file updates in section 4 first. Smoke: with a worker in provision mode, `describe` schedule `zenith-critical-maintenance-v1` (unpaused, overlap SKIP) and `POST /api/internal/tick/status` with the cron bearer returns each job `healthy` with `durable: true` within a few minutes; stop the worker, wait 90 s, a cron `POST /api/internal/tick/runbooks` runs (not deferred) and the job's `lastSuccessSource` becomes `fallback`.

## 4. Gaps and shared-file updates for the orchestrator

- Migration inventory: add version 21 `scheduled_job_runs` (supabase emit, `emit.ts`, apply script, DEPLOYING.md, `migrations.test.ts`).
- Tenancy/scoping classification (`tests/controlplane/tenancy.test.ts`, `tests/security/controlplane-sql-scoping.test.ts`), all system maintenance, no tenant data, keyed by fixed job name: `scheduledJobs.beginRun`, `scheduledJobs.finishRun` ("keyed by job + lease fence"), `scheduledJobs.recordSkip`, `scheduledJobs.getScheduledJob`, `scheduledJobs.listScheduledJobs` ("system scheduler health, no tenant rows"). Table has RLS enabled and service_role-only grants.
- `.github/workflows/tick.yml`: optionally add a `status` pass (POST works, returns 200; use `?strict=1` to fail the workflow when stale). GitHub cron remains valid unchanged; it now defers while the durable schedule is current.
- Gate manifest: add the two new vitest files; real-Temporal lane for the new schedule if desired.
- LIMITATIONS: alerts/engine/outbox/agent/hosted-job passes remain best-effort cron; GitHub disables schedules after 60 idle days.
- Gaps: no real-Temporal restart/overlap test for `zenith-critical-maintenance-v1` (only the reconcile schedule has one); `runbooks` fallback deferral relies on the single runbook function using the process platform store (worker calls `ensurePlatformApp(db)` first); the maintenance schedule is created unpaused only in provision mode, so an unprovisioned environment shows `never_run` until an operator provisions it; stale `running` rows from a crashed holder are overwritten by the next run.

## 5. Suggested ledger implementationStatus

`source_complete_durable_schedules_wired_runtime_acceptance_pending` (Temporal schedules for observation, reaping, housekeeping and runbooks with lease/fence/overlap/catch-up/health; requires PostgreSQL + Temporal execution evidence).
