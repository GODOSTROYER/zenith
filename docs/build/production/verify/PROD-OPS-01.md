# PROD-OPS-01 Measured service and recovery objectives

Branch `prod/ops-01-w5`, base `c02c097e`. Platform migration `43` (`0043_slo_measurements`). Build only: the builder ran `tsc --noEmit` and `eslint` on the changed files (both clean) and ran `node scripts/slo/capacity-test.mjs --self-test` once (passed). No vitest suite was run. Operator guide: `docs/platform/operations/SLO.md`.

**All targets are provisional and unapproved (DEC-BUSINESS pending).** No field anywhere can record an approver.

## 1. Summary of what was built

| Area | Files |
|---|---|
| Definition file (versioned, all `provisional`, no approver) | `deploy/slo/slo-definitions.json`; strict validator `src/lib/slo/definitions.ts` (refuses `approved`, any approval-looking field, non-provisional status, unknown fields) |
| SLI computation | `src/lib/slo/sli.ts` (API availability and latency from the OPS-02 catalog metrics via the registry snapshot), `src/lib/slo/store.ts` (dispatch latency and workflow completion from `platform.operations`; scheduler health sampled from OBS-04 `platform.scheduled_job_runs` through `criticalJobHealth`) |
| Durable samples and budgets | `src/lib/slo/recorder.ts` (`flushSloSamples`, delta accounting, wired into `src/lib/ops/sampler.ts` `sampleControlPlane`, so every `/api/internal/metrics` scrape and every worker sampler tick persists deltas), `src/lib/slo/budget.ts` (budget, burn rate, multiwindow alerts, min 20 events) |
| Burn-rate alerts | `deploy/observability/alerts/zenith-slo.rules.json` (recording rules + 6 alerts: availability and latency x fast/slow/ticket), runbook headings in `docs/platform/operations/SLO.md`, row in `deploy/observability/README.md` |
| RPO/RTO hooks for OPS-04 | `src/lib/slo/recovery.ts` (`reportRecoveryRehearsal`: three instants in, RPO and RTO derived), `POST /api/internal/slo/measurements` (bearer, `kind: recovery`), `scripts/slo/report-recovery.mjs` |
| Capacity test | `scripts/slo/capacity-test.mjs` (Node built-ins only, closed-loop GET load, loopback-only unless `--allow-remote`, bearer from a file, `--self-test`, `--report`), `reportCapacityTest`, route `kind: capacity` |
| Operator report | `src/lib/slo/report.ts`, `GET /api/admin/ops/slo` (platform operators), page `/admin/slo` (`src/app/admin/slo/page.tsx`, `slo.module.css`); every objective shows "Provisional, not approved" |
| Migration | `src/lib/controlplane/db/migrations/0043_slo_measurements.ts`, registered in `migrations/index.ts` |
| Docs | `docs/platform/operations/SLO.md`, README row, `SOURCE_SNAPSHOTS` pin in `tests/docs/operator-docs.test.ts` |
| Tests | `tests/slo/definitions.test.ts`, `sli-budget.test.ts`, `slo-artifacts.test.ts`, `slo.engine.test.ts` |

Design choices: error budget history is kept in `platform.slo_samples` (5-minute buckets, additive per-process deltas, 35-day prune) so it works without a metrics backend and across instances. Dispatch latency excludes operations that required approval. Workflow completion cannot yet separate tenant-caused failures (stated in the definition). States are honest: `no_data`, `not_measured` and `unavailable` exist, and RPO, RTO and capacity are never "met" without a recorded measurement.

## 2. Acceptance mapping

| Clause | Implementation | Tests |
|---|---|---|
| Measurable availability / latency / capacity / RPO / RTO objectives defined | `slo-definitions.json` with the defaults 99.5%, p95 < 500 ms, RPO 900 s, RTO 14400 s, plus dispatch, workflow, scheduler and capacity objectives | `definitions.test.ts` |
| ...and tested | SLI math, budgets, burn alerts, durable windows, hooks, report | `sli-budget.test.ts`, `slo.engine.test.ts` |
| Provisional targets separated from accountable approval | `approval: not_approved / DEC-BUSINESS`; validator refuses approver fields; report, API body, page, alerts and guide all say "Provisional, not approved" | `definitions.test.ts` (refusals), `slo.engine.test.ts` (report labels), `slo-artifacts.test.ts` (alert labels and annotations, guide wording) |
| SLIs from OTel metrics and durable records | `sli.ts`, `recorder.ts`, `store.ts` | `sli-budget.test.ts`, `slo.engine.test.ts` ("samples", "durable operation indicators") |
| Error budgets and burn-rate alerts (deploy/observability) | `budget.ts`, `zenith-slo.rules.json` | `sli-budget.test.ts` (burn rules), `slo-artifacts.test.ts` (thresholds equal factor x budget, metrics exist in the catalog, runbook anchors exist) |
| RPO/RTO measurement hooks restore rehearsals report into | `recovery.ts`, internal route, `report-recovery.mjs`, append-only `slo_measurements` | `slo.engine.test.ts` ("RPO, RTO and capacity hooks", routes), `slo-artifacts.test.ts` (script and server arithmetic agree) |
| Capacity test script runnable on the verifier's machine, no new deps | `scripts/slo/capacity-test.mjs` | `slo-artifacts.test.ts` (summarise, never-pass-empty, `--self-test` end to end) |
| Operator report page/API with SLI vs provisional target | `report.ts`, `/api/admin/ops/slo`, `/admin/slo` | `slo.engine.test.ts` ("operator report", "routes") |

## 3. Verification commands (other machine, Node 22)

```
npx tsc --noEmit -p .
npx eslint src/lib/slo src/app/admin/slo src/app/api/admin/ops/slo src/app/api/internal/slo src/lib/ops/sampler.ts tests/slo

# pure, no database: expected all pass
npx vitest run tests/slo/definitions.test.ts tests/slo/sli-budget.test.ts tests/slo/slo-artifacts.test.ts

# real engine: PGlite always, plus PostgreSQL when set (expected all pass on both lanes)
npx vitest run tests/slo/slo.engine.test.ts
ZENITH_TEST_PLATFORM_PG_URL=postgres://... npx vitest run tests/slo/slo.engine.test.ts

# docs pin and sibling suites that touch the edited sampler
npx vitest run tests/docs/operator-docs.test.ts tests/ops

# the generator itself, no vitest
node scripts/slo/capacity-test.mjs --self-test            # expect {"selfTest":"passed"}, exit 0
node scripts/slo/report-recovery.mjs --dry-run --failure-at 2026-10-07T10:00:00Z --data-through 2026-10-07T09:56:30Z --restored-at 2026-10-07T10:42:10Z   # rpoSeconds 210, rtoSeconds 2530

# manual capacity run against a local `next start` (GET only, loopback only)
node scripts/slo/capacity-test.mjs --url http://127.0.0.1:3000 --path / --concurrency 16 --duration 20
```

Optional rule syntax check where Prometheus tooling exists: `promtool check rules deploy/observability/alerts/zenith-slo.rules.json`.

## 4. Known gaps, risks and shared-file updates for the assembler

Known gaps:
- Migration 42 is absent in this branch (sibling wave-5 worker); the registry has a hole until the assembler fills it. If the migration loader asserts contiguity, opening a store on this branch alone will fail until assembly.
- Availability is what the API itself observed. An outage that stops requests arriving leaves no samples; an external uptime probe (`/api/internal/tick/status?strict=1`) is the guide's answer, not something built here.
- No restore rehearsal exists yet (PROD-OPS-04 is not in this base). The hook is built and tested with synthetic instants only; RPO, RTO and capacity show "Not measured yet" until something reports.
- The capacity figure is machine-local. No production topology number exists and none is claimed.
- Workflow completion counts tenant-caused failures as failures (documented in the definition).
- The `/admin/slo` page has no link from the existing waitlist-oriented admin shell (different operator set: `ZENITH_OPS_ADMIN_IDS`); reach it by URL.
- Things that may break first: engine test deltas on a shared PostgreSQL (assertions are `>=` there, exact on PGlite); the `update platform.operations` seeding in `slo.engine.test.ts` assumes no check constraint ties `started_at` to status; `tests/ops/store.engine.test.ts` now also runs `flushSloSamples` through `sampleControlPlane` (best effort, swallowed on failure) and needs migration 43 only for the samples to land.

Shared-file updates for the assembler:
- Migrations inventory: version 43 `slo_measurements`, tables `platform.slo_samples`, `platform.slo_measurements` (append-only trigger `slo_measurements_immutable`), regenerate emit-sql / `supabase/migrations`, `scripts/ci/apply-supabase-migrations.sh`, `DEPLOYING.md`, `tests/controlplane/migrations.test.ts`.
- Tenancy classification (`tests/controlplane/tenancy.test.ts` / controlplane-sql-scoping): the store functions are not in `repos` (like `ops/store.ts`). All are SYSTEM, no workspace id: `addSamples`, `sampleWindows`, `pruneSamples` (counts per SLI name), `recordMeasurement`, `listMeasurements` (platform evidence), `workflowCompletionWindows`, `dispatchLatencyWindows` (aggregate counts over `platform.operations` across all workspaces; no id, payload or principal returned).
- `src/lib/sensitivedata/inventory.ts` (OPS-06 guard): add `platform.slo_samples` (owner `ops/slo (OPS-01)`, classification operational, retention operational "35 days, pruned by flushSloSamples", columns: counts only) and `platform.slo_measurements` (operational, immutable append-only, `recorded_by` is an operator or runner label; `details` holds fixed numeric/ISO/short-token fields).
- Gate manifest: add `tests/slo/*.test.ts` to the unit lane and `tests/slo/slo.engine.test.ts` to the engine lane (it follows the `LANES` pattern, no extra env).
- Route inventory/count test: two API routes (`/api/admin/ops/slo`, `/api/internal/slo/measurements`) and one page (`/admin/slo`) added; the two API routes are not in any middleware allow-list change (the admin route is operator-session gated, the internal route is CRON_SECRET gated like the other tick routes).
- `docs/LIMITATIONS.md`: add the gaps above (provisional and unapproved targets; machine-local capacity; no live restore rehearsal measurement; availability excludes requests that never arrive).
- Optional: add `alerts/zenith-slo.rules.json` to whatever deploy step imports the other rule file.

No verified behaviour was changed. The only edit to an existing runtime file is the one `await flushSloSamples(sql)` line (plus its import) in `src/lib/ops/sampler.ts`, after the store-up gauge is set; it never throws.

## 5. Suggested ledger implementationStatus

`built_unverified: provisional (unapproved, DEC-BUSINESS pending) SLO definitions, SLIs from OPS-02 metrics and durable rows, durable error budgets and burn-rate alerts, RPO/RTO/capacity measurement hooks (migration 43), capacity test script and operator report page/API. No restore rehearsal or production-topology capacity measurement exists yet.`
