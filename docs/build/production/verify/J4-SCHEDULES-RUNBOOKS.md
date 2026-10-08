# J4 schedules and runbooks

Original base: `443bfeaf`. Step 2 base: `65b71e39` after assembly `257b9ebe` (migrations 44-52, aggregate 0026). Implementation worktree only; no commit, push, cloud call, dependency change or migration/aggregate edit. Implementation status: `implementation_complete_verification_pending`. This document describes authored acceptance, not an executed engine receipt.

## Files and acceptance mapping

- `src/lib/runbooks/semantics.ts`: emit `input.runbook = {runbookId, version, definitionDigest}` from the signature-verified stored version. The broker persists this immutable proposal input; DUR-03's existing collector consumes that component. Native runbooks retain their existing signed definition and exact run approval binding; they do not fabricate an infrastructure saved plan or a migration SQL digest.
- `src/lib/runbooks/delivery.ts`, wired in `src/lib/platform/runbooks.ts`: fresh run/signature/approval checks for every step; exact request/target/bounds comparison; active advertised zenithd and matching environment/resource-address binding; canonical broker policy and grant consumption; fail closed on cancellation, changed proposal or audit outage. The machine step executor reports uncertain if durable broker settlement fails. `run.step.authorized` joins the deterministic step id to the actual broker operation id before delivery. Existing machine transport signs the queue request and records evidence.
- `src/lib/platform/critical-jobs.ts`: adds billing exactly once to CRITICAL_JOBS and MAINTENANCE_JOBS, calling MAN-06's existing `runBillingTick` under the shared fenced lease. Assembly supplied the authenticated HTTP fallback; J4 now uses `runFallbackJob` for its standard deferral response. Billing has no durable-only health exemption because a fallback exists. Disabled mode remains store/network-free inside the billing tick. Current activities emit billing; `criticalMaintenance.ts` permits historical results without that field for replay.
- `scripts/acceptance/maintenance/{preconditions,default,run}.ts`: explicit local admission; READ the migration-seeded immutable cleanup epoch (never insert/update/delete it). A real default worker runs seven core jobs on the existing two natural Temporal schedules, plus billing and the already-registered addenda. No schedule.trigger, fake activities, fabricated health or backdated health rows. An expired nonce fixture proves housekeeping work; billing examines a durable account. Held actual runbook and billing leases prove cross-trigger exclusion; a real 125-second worker outage proves fallback resumption, missed ticks and worker restart. Repeated authenticated billing fallback must retain the same invoice identities. The status HTTP route must agree with stored health. Cleanup drains and removes only this run's schedules in an isolated namespace.
- `scripts/acceptance/maintenance/{runbooks,run-runbooks}.ts`: actual signed-in HTTP publish/request/read/cancel routes and a real registered zenithd. A successful inspection must join a single signed machine queue delivery, non-simulated evidence, settled broker operation, signed-version proposal component and intact audit. A second raw-exec version stays pending independent approval, then cancels with zero steps. This is cancellation before approval, not proof of killing a delivered operating-system process.
- Tests: `tests/machines/runbook-delivery.test.ts` (real signatures/broker over memory and PGlite stores, optional real PostgreSQL; controlled registry and policy; explicitly contract evidence), `tests/platform/billing-schedule.test.ts` (PGlite billing/health/lease), `tests/acceptance/maintenance-default.test.ts` (two explicit real-engine gates). Existing runbook and critical-schedule assertions remain unchanged; the step-executor suite adds a settlement-outage assertion. The precondition suite tests local admission and immutable epoch handling.

OBS-04: natural timers/restart/fallback/no overlap map to the default maintenance harness and existing genuine Temporal restart/SKIP test. The product has TWO Temporal Schedules covering SEVEN core jobs, not seven independent schedules. MACH-03: existing bounded-window/target/in-flight cancellation tests plus the new registered delivery and audit harness. DUR-03: signed reference emission and exact immutable proposal comparison tests. No acceptance state is marked verified.

## Mac setup and commands (8 GB ARM64, Docker 4 GiB)

Assembly's collision-free wave-5 migration registry/aggregate is integrated at `65b71e39`. The prior duplicate-version 42/43 failure is historical; the unchanged genuine schema admission now passes locally. Integrate J1's local default stack before the Mac run. Do not bypass admission.

Use a fresh dedicated J1 local Supabase/product/control database with genuine Auth/PostgREST. Start that stack using J1's documented lean profile; omit optional observability, kind and build workloads for this lane. Keep Docker at 4 GiB; API heap 768 MiB, one native worker heap 1024 MiB, worker DB pool 2, reconcile max environments/concurrency 1. Native Temporal CLI/SQLite avoids a second Docker database. Only one heavy lane at a time.

Create a private `$J4_DIR` and a mode-0600 `$J4_DIR/local.env` using the J1-generated LOCAL keys and database URLs. Generate fake local signing/sealing secrets at runtime through the existing J1 fixture, never paste real keys. Use separate API and worker ZENITH_DATA directories. Required shared settings:

```dotenv
ZENITH_PLATFORM_DB=postgres
ZENITH_PLATFORM_DB_URL=postgresql://<local fixture user/password>@127.0.0.1:<J1 pooler port>/<fresh database>
ZENITH_PLATFORM_DB_MAX=2
ZENITH_STORE=postgres
# Include J1 product-store/Supabase Auth settings and separate local signer/sealing keys.
ZENITH_SERVERLESS=1
ZENITH_BILLING=managed
# Leave ZENITH_BILLING_STRIPE_SECRET_KEY and all cloud/KMS credentials unset.
ZENITH_TEMPORAL_ADDRESS=127.0.0.1:17233
ZENITH_TEMPORAL_NAMESPACE=j4-maintenance-<unique lowercase suffix>
ZENITH_J4_API_ORIGIN=http://127.0.0.1:3100
ZENITH_J4_CRON_SECRET_FILE=<absolute path to the J1-generated local CRON_SECRET file>
ZENITH_TEST_MAINTENANCE=1
```

ZENITH_SERVERLESS is the existing explicit no-in-process-timer profile, allowing natural durable timers and explicitly invoked fallback routes to be attributed honestly. The harness refuses non-loopback endpoints, existing health, provider connections or an unseeded epoch. Do not edit the singleton to repair a failed precondition. Database/namespace must be dedicated to this lane.

From the integrated repository, Node 22 on PATH, pinned Temporal CLI 1.9.1 at `$TEMPORAL_CLI`:

```bash
mkdir -m 700 "$J4_DIR/temporal"
"$TEMPORAL_CLI" --disable-config-env --disable-config-file server start-dev --headless --ip 127.0.0.1 --port 17233 --http-port 18233 --metrics-port 19233 --db-filename "$J4_DIR/temporal/owned.sqlite"
# Separate terminal; load only the private LOCAL fixture environment:
set -a
. "$J4_DIR/local.env"
set +a
"$TEMPORAL_CLI" operator namespace create --address "$ZENITH_TEMPORAL_ADDRESS" --namespace "$ZENITH_TEMPORAL_NAMESPACE"
"$TEMPORAL_CLI" operator search-attribute create --address "$ZENITH_TEMPORAL_ADDRESS" --namespace "$ZENITH_TEMPORAL_NAMESPACE" --name ZenithScheduleOwner --type Keyword
# Start the genuine J1 API with its product-store/Auth settings, in its own terminal:
NODE_OPTIONS=--max-old-space-size=768 npx next start --hostname 127.0.0.1 --port 3100
# Separate terminal; no other execution worker in this namespace:
npx tsx --env-file="$J4_DIR/local.env" scripts/acceptance/maintenance/run.ts
```

Expected: one sanitized scalar receipt, exit 0; seven core jobs plus billing succeed naturally, durable health, expired nonce removed, billing account examined, runbook and billing fallback during a real outage, repeated billing invoice idempotency, lease exclusion, natural missed-tick accounting, unchanged epoch and owned schedule deletion. Allow 10 minutes. On failure retain the dedicated DB/namespace for inspection; no blanket Docker/database cleanup.

For signed registered delivery, use the same genuine API but a separate dedicated fixture namespace and local workspace/environment/resource created AFTER the seeded epoch. Obtain a registration token through the real browser consent route and run the existing Linux zenithd package in an owned Linux container (MACH-04/J7 fixture), bound to that environment and resource address. Exec remains disabled. The local signed-in operator must be an editor/admin; there must be no credential/authorization test overrides. Save its Cookie header as a mode-0600 file using the J1 signed-in operator fixture. Save a mode-0600 target JSON file: `{workspaceId,targetId,environmentId,resourceId}`. Do not supply keys in target JSON.

```bash
# With the J1/MACH-04 registered-agent fixture already started and polling:
export ZENITH_TEST_RUNBOOK_DELIVERY=1
export ZENITH_J4_BROWSER_COOKIE_FILE="$J4_DIR/operator.cookie"
export ZENITH_J4_TARGET_FILE="$J4_DIR/target.json"
export ZENITH_WORKER_RECONCILE_SCHEDULE_MODE=provision
export ZENITH_WORKER_RECONCILE_MAX_ENVIRONMENTS=1
export ZENITH_WORKER_RECONCILE_CONCURRENCY=1
NODE_OPTIONS=--max-old-space-size=1024 npx tsx --env-file="$J4_DIR/local.env" workers/execution/worker.ts
# Separate terminal with the same private local env and target/cookie file settings:
npx tsx --env-file="$J4_DIR/local.env" scripts/acceptance/maintenance/run-runbooks.ts
```

Expected: exit 0, single actual signed inspection queue delivery, default broker settled succeeded, non-simulated evidence, intact audit join, immutable signed version component, raw exec pending independent approval and cancelled without delivery. Retain append-only records; stop only fixture-owned services. This harness needs an actual registered Linux agent and signed-in Auth cookie; a scripted transport cannot pass it.

Equivalent vitest gates, after the corresponding prerequisites:

```bash
ZENITH_TEST_MAINTENANCE=1 ZENITH_TEST_RUNBOOK_DELIVERY=0 npx vitest run tests/acceptance/maintenance-default.test.ts --testNamePattern="seven critical jobs" --no-file-parallelism --maxWorkers=2
ZENITH_TEST_MAINTENANCE=0 ZENITH_TEST_RUNBOOK_DELIVERY=1 npx vitest run tests/acceptance/maintenance-default.test.ts --testNamePattern="real signed registered delivery" --no-file-parallelism --maxWorkers=2
ZENITH_TEST_TEMPORAL=1 ZENITH_TEST_TEMPORAL_DOWNLOAD=0 ZENITH_TEST_TEMPORAL_CLI="$TEMPORAL_CLI" npx vitest run tests/workflows/critical-schedule.test.ts --no-file-parallelism --maxWorkers=2
ZENITH_TEST_PLATFORM_PG_URL="<fresh loopback PostgreSQL>" npx vitest run tests/controlplane/machine-runbooks.test.ts tests/machines/runbook-delivery.test.ts --no-file-parallelism --maxWorkers=2
npx vitest run tests/platform/billing-schedule.test.ts tests/billing/billing-routes.test.ts tests/platform/critical-jobs.test.ts --no-file-parallelism --maxWorkers=2
```

Unset real-engine gates produce explicit skips, never passes. Enabling a gate with missing prerequisites must fail. The existing Temporal SKIP test deliberately holds a controlled activity; the new default harness proves actual job lease exclusion, not that every production activity takes longer than one cadence.

## Joins and limits for the orchestrator

- J1 supplies the genuine local stack, Auth cookie fixture and environment keys. J7/MACH-04 supplies the consent-registered Linux agent with exact environment/address binding; ambiguous/unbound machines fail closed.
- Billing fallback join is complete: `src/app/api/internal/tick/billing/route.ts` authenticates first, preserves the store-free disabled branch, refuses unavailable platform boot, then uses the canonical shared fallback wrapper/lease/health record. SQL-backed route contracts cover both verbs, durable-first deferral, busy exclusion and repeated invoice idempotency. Boot/session ports are controlled in those tests; the default API/Temporal proof remains the explicit Mac gate.
- Register the new targeted files and the two explicit acceptance gates in the central gate manifest after source review; that shared manifest is outside this job.
- No migration 55 or inventory change is needed. Existing signed runbook, approval, audit, health and billing tables suffice.
- Broader DUR-03 default infrastructure/browser approval, provider-direct teardown and standing-grants component verification remain their owners' lanes; migration SQL digest remains null as previously documented.
- All Docker/PG/Temporal/browser/registered-agent acceptance is NOT RUN here. Review the harness source before the Mac run; J4 does not claim external reviewer approval or a production signoff.

## Local checks

See [J4-CHECKS.md](J4-CHECKS.md) for exact command results. The required serialized whole-repo typecheck and changed-file eslint passed. No existing assertion, gate or expectation was removed or relaxed. The historical base migration failure is retained in the command report; assembly fixed the registry before these successful SQL reruns. No migration was dropped or bypassed.
