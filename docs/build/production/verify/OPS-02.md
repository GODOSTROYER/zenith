# OPS-02: J11 observability import successor

Scope at base `3a9de905`: `deploy/observability/import-harness.mjs`, `images.env`, README, and
`tests/ops/observability-import.test.ts`. The historical implementation mapping remains in `PROD-OPS-02.md`.

The acceptance clause about correlated OTel dashboards/alerts maps to the real gated import test: promtool validates
the production rules; the collector validates a derived local profile; Grafana API import/readback preserves panel
queries/datasources/tenant variable; Prometheus loads all eleven alerts; the tenant metric travels OTLP -> collector ->
Prometheus -> Grafana's datasource; collector trace readback includes trace id, tenant and operation. The unchanged
production two-minute control-store alert must fire. Input is synthetic telemetry, clearly labelled `syntheticTelemetry`.
Offline structure/catalog/runbook tests are contract evidence only.

## Exact Mac commands

Prerequisites: Node 22, existing locked dependencies, Docker Desktop with 4 GiB, Docker Compose v2, and crane or buildx.
Run this profile alone (768 MiB service limits); no database, Temporal, kind, browser, trace backend or credentials needed.

```bash
node --version
node scripts/deploy/pin-digests.mjs --todo
ZENITH_RESOLVE_DEPLOY_PINS=1 node scripts/deploy/pin-digests.mjs --resolve --scope bases --resolver buildx
node deploy/observability/import-harness.mjs lint
ZENITH_TEST_OBSERVABILITY_IMPORT=1 npx vitest run tests/ops/observability-import.test.ts tests/ops/observability-artifacts.test.ts --no-file-parallelism --maxWorkers=1
# Alternative explicit rehearsal, prints only the bounded result, hashes and image refs:
ZENITH_TEST_OBSERVABILITY_IMPORT=1 node deploy/observability/import-harness.mjs run
```

Expected: offline lint reports 18 metric panels, 11 alerts, 2 pipelines; promtool and both production/local collector
validation commands exit 0 (validation runs with networking disabled); the gated test executes
instead of skipping; all tests pass. Allow approximately three minutes for the production pending duration. Successful
return requires owned container cleanup; cleanup failure fails acceptance and retains owned configuration for diagnosis.
Do not sum overlapping direct/script test runs. Image availability/architecture and Grafana/collector API behavior remain
unverified until this command actually succeeds. Registry failures must be repaired with actual version/digest evidence.

Backpressure, fairness, queues, maintenance and workload-serving outage acceptance are existing OPS-02/Wave 5 seams,
not rebuilt by J11. Run their existing dedicated PostgreSQL/Temporal and operational rehearsals after integration. In
particular, `ZENITH_TEST_OPS_EXCLUSIVE_PG=1 ZENITH_TEST_PLATFORM_PG_URL=<owned local database URL>` is needed for
`npx vitest run tests/ops/store.engine.test.ts --no-file-parallelism --maxWorkers=1`; the database must already have the
canonical migrations and be exclusively owned. Never substitute these synthetic telemetry samples for that rehearsal.

Builder status: real import **not run (needs Docker and resolved image digests on Mac)**. No new SQL, tables, auth or
execution-core changes. Ledger `implementation_complete_verification_pending` applies to this infrastructure slice;
all other required evidence remains unchanged. See `J11-OPS-INFRA.md` for actual local command results.
