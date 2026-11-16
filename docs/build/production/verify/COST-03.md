# J8 COST-03: measured proposals and human consent

Base packet: `3a9de905`, committed by the orchestrator as `2eb09bc2`. The owner authorized the six integration joins on 2026-10-08; they are now built in this worktree. Status: `implementation_complete_verification_pending`. Actual backend/browser/default-stack verification remains pending; implementation is not verification.

Acceptance: "Measurable bounded nonflapping optimizations respect approval/field ownership and transfer/latency/residency cost."

| Clause | Implementation and acceptance |
|---|---|
| Measured | `cost/optimizer/measurement-collector.ts`: seven days of continuous hourly samples, per-resource scoped queries, explicit units, fresh provenance, no simulated/truncated/partial/overlapping data. Monthly-equivalent usage derived from actual rates; no usage defaults. Unsupported compute, missing meters and fractions the current model cannot express refuse a baseline. Contracts: `measurement-collector.test.ts`; actual local harness: `measurement-collector.local.test.ts`. |
| Bounded, nonflapping | Existing `optimizeEconomics`, durable scale history and `runOptimizerPass` preserved. Existing optimizer and pass tests cover one-step changes, cooldown, reversal, window spending and count bounds. |
| Field ownership | `optimizer-ownership.ts` uses tenant-scoped current resources, complete bounded facts, `guardFor`, registry `evaluateWrite`, approved transfers and revocation/expiry semantics. A native operation needs native-op ownership; manifest ownership alone does not authorize it. `optimizer-ownership.test.ts` is a fixture contract; real registry storage/races retain their separate PostgreSQL gate. |
| Human opt-in and approval | `optimizer-settings-service.ts` requires a browser-human proof, current admin role, policy-authorized environment scope and exact expected version. CAS is serialized by an advisory transaction lock; consent and audit commit together. GET never creates a setting. `optimizer-settings-endpoint.ts` reuses the real browser/session and route wrappers. SQL tests prove default-off, off/on, CAS conflict and actor/tenant refusal. Consent creates no operation or approval. The scheduled pass only proposes to the canonical broker. |
| Transfer, latency, residency | Existing optimizer models preserved. `measurement-ports.ts` reads constraints from the applied revision and performs metric reads using a broker-issued grant inside the existing scoped observe fabric. No credential fallback. |

## Six production joins completed under the owner's expanded scope

1. Registered the browser-only `environments/[id]/optimizer` GET/POST route and its exhaustive middleware classification. Human proof, current admin membership, policy, tenant scope, Origin, strict schema and versioned consent guards remain in force.
2. The existing sweep now calls `cost/optimizer/sweep-step.ts`, composing product reads inside the existing worker store scope, the canonical sweep broker, the platform credential broker, scoped agent observe ports, measured collector and per-environment ownership. Same Temporal activity, lease, cancellation and environment guard; no new scheduler. Opt-in is re-read inside the guard before measurement. No execution call is introduced.
3. Added the usage exporter and authenticated ingress/exposition at the existing internal metrics route. Cost-purpose source selection uses fixed, tenant/resource-bound Prometheus usage templates and covers container services, PostgreSQL, MySQL and object stores. Missing/stale/duplicate producers refuse coverage. Deployment inputs and actual retained observations are required, as documented below; none was manufactured here.
4. `service.scale` checks the size/replica fields present in its validated input. Broker proposal/check and the stored proposal's dispatch/grant admission enforce size ownership. The legacy IaC replica warning cannot authorize size. Exact size transfers become live enabling dependencies, including the final grant predicate after native lock waits. A new native PostgreSQL case tests transfer expiry behind that final coordinator. Existing new-owner/resource-fact insertion concurrency remains J13's separate work.
5. The security SQL inventory registers direct cost queries, including consent's workspace/environment advisory transaction lock, both ownership resource reads, usage-resource validation and the base optimizer resource lookup. Repository queries retain their existing discovery and tenancy guards. No migration or SQL snapshot changed.
6. Product reads expose validated, cloned authoritative environment policies and refuse duplicate environment/project/revision records. Applied V1 optimization uses the pure upgrade view with those policies, preserving its budget without rewriting V1. Missing/malformed/unknown policies refuse instead of using unconstrained defaults. V2 retains its constraints and the stricter current environment budget.

Executed checks and exact counts are in [J8-COST-JOINS-REPORT.md](J8-COST-JOINS-REPORT.md). The previous [J8-COST-REPORT.md](J8-COST-REPORT.md) records the committed base packet.

## Actual local HTTP consent lane

After route registration, start the integrated Next application with its configured **local** identity provider and native control store. A real signed-in, verified workspace admin must provide a runtime Cookie header file. Anonymous local-demo mode cannot satisfy this lane: the anonymous request must return 401. Use a dedicated opted-out environment and an existing environment in another local tenant. No cookie or token belongs in the repository or logs. The harness verifies signed-in GET without Origin, anonymous and bearer refusal, same-origin POST, foreign-tenant refusal, strict input, CAS conflict and opt-out restoration. It neither approves nor executes; an integrated scheduler may create proposals only after the explicit consent call.

```sh
export PATH="$HOME/.local/sdk/node22:$PATH"
export ZENITH_TEST_COST_OPT_IN_HTTP=1
export ZENITH_TEST_COST_OPT_IN_BASE_URL=http://127.0.0.1:3000
export ZENITH_TEST_COST_HUMAN_COOKIE_FILE=/absolute/owned-j8/local-human-cookie
export ZENITH_TEST_COST_WORKSPACE_ID=<actual-local-workspace-id>
export ZENITH_TEST_COST_ENVIRONMENT_ID=<dedicated-opted-out-environment-id>
export ZENITH_TEST_COST_FOREIGN_ENVIRONMENT_ID=<other-tenant-environment-id>
npx vitest run tests/cost/optimizer-settings.http.local.test.ts --no-file-parallelism --maxWorkers=2
```

Expected: **one pass, zero skips**. A missing route, anonymous demo fallback, unavailable identity verification, incorrect tenant scope or failed restoration is a failure. The test accepts only loopback URLs and never prints the Cookie value. The orchestrator's default-stack local-auth startup profile is a prerequisite; it is outside J8 ownership. In a separate terminal with that profile's local auth/control-store environment, set `ZENITH_PLATFORM_ORIGIN=http://127.0.0.1:3000` and start the Next app using `npx next dev --hostname 127.0.0.1 --port 3000` on installed Node 22. The harness base URL must match the configured platform origin. Do not configure remote/cloud identity endpoints for this deferred-live program. This machine did not start or call that service.

## Lean real PostgreSQL lane on the Mac

Use one owned container, 384 MiB, one CPU. The role setup is a bare-PG test fixture, not Supabase/browser proof. Do not run concurrently with Temporal or kind on Docker's 4 GiB profile.

```sh
export PATH="$HOME/.local/sdk/node22:$PATH"
export J8_PG_PASSWORD="$(openssl rand -hex 18)"
docker run -d --name zenith-j8-pg --memory=384m --cpus=1 -p 127.0.0.1:55438:5432 -e POSTGRES_PASSWORD="$J8_PG_PASSWORD" postgres:16-alpine -c shared_buffers=64MB -c max_connections=20
until docker exec zenith-j8-pg pg_isready -U postgres; do sleep 1; done
docker exec zenith-j8-pg psql -U postgres -c 'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;'
export ZENITH_TEST_PLATFORM_PG_URL="postgres://postgres:$J8_PG_PASSWORD@127.0.0.1:55438/postgres"
npx vitest run tests/cost/optimizer-settings.test.ts tests/cost/actual-spend-store.test.ts tests/placement/optimizer-pass.test.ts tests/controlplane/ownership-transfers.test.ts --no-file-parallelism --maxWorkers=2
docker stop zenith-j8-pg
docker rm zenith-j8-pg
unset J8_PG_PASSWORD ZENITH_TEST_PLATFORM_PG_URL
```

Expected new consent cases: three PGlite and three PostgreSQL cases pass, zero skips; tests retain their assertions. The existing ownership suite uses its own scoped scratch databases. Keep any nonzero exit or cleanup failure as evidence. Strict TLS/Supabase RLS, Temporal restart, browser consent and the composed sweep still need their existing default-stack acceptance lanes; the bare-PG run does not replace them.

## Actual measurement harness

Operate an underutilized local service, perform its human ownership transfer and retain **seven days of real hourly telemetry**. Configure Prometheus retention at 15 days and at most 512 MiB; PostgreSQL 384 MiB; start these serially alongside the lean default profile. Do not fabricate or backdate samples. Export the actual applied `ResourceGraph` and its validated constraints from the local installation to owned absolute paths. Then:

```sh
export ZENITH_TEST_COST_COLLECTOR=1
export ZENITH_TEST_COST_PROMETHEUS_URL=http://127.0.0.1:9090
export ZENITH_TEST_COST_GRAPH_FILE=/absolute/owned-j8/applied-graph.json
export ZENITH_TEST_COST_CONSTRAINTS_FILE=/absolute/owned-j8/applied-constraints.json
export ZENITH_TEST_COST_WORKSPACE_ID=<actual-local-workspace-id>
export ZENITH_TEST_COST_PROJECT_ID=<actual-local-project-id>
# ZENITH_TEST_PLATFORM_PG_URL points to the actual local control store holding approved transfers.
npx vitest run tests/placement/measurement-collector.local.test.ts --no-file-parallelism --maxWorkers=2
```

Expected: one actual-backend case passes and no skips. It requires actual low utilization, complete meters and exact approved native-op ownership. Otherwise the failure is retained. It reads only a loopback Prometheus endpoint and proposes in memory; it never submits, approves or executes. Separately run the operated browser opt-in and existing Temporal sweep/restart journey after integration, proving no proposals before opt-in, the immutable human approval requirement, proposal counters and durable cooldown after restart. This machine ran none of those real-backend/browser checks.

## Usage exporter deployment and actual default sweep on the Mac

Run the existing local default stack with real local Auth/PostgREST/native platform PostgreSQL, canonical policy/grant keys and its existing Temporal worker/reconcile schedule. Start the integrated app (`npx next dev --hostname 127.0.0.1 --port 3000`) and worker (`npm run worker`) in separate terminals with that installation's environment. Keep one stable API exporter instance per resource; POST reports directly to that instance and scrape the same instance, never a load-balanced address. The registry is process-local and expires reports after 90 seconds. Restarts cause missing samples until actual reports resume; Prometheus retains history. Duplicate active scrape producers are refused by the cost query rather than summed. On the 8 GiB/4 GiB Docker profile, use one API, one worker, one local workload and the existing lean local stack; avoid concurrent browser/kind acceptance jobs. Do not introduce another schedule.

The trusted infrastructure meter sends **actual** reports every 30 seconds to `POST /api/internal/metrics` using the existing operator-held `CRON_SECRET` (no tenant/bearer/browser credential). The exporter validates the workspace, environment, resource ID, address, kind, managed ownership and current status in SQL. Body limit: 16 KiB; maximum active resources: 2000; late, replayed, foreign, ambiguous or malformed reports are refused. No values are created for missing telemetry. Header/body files live outside the repository, mode 0600, and contain only the actual local operator key and actual observations:

```sh
# In an owned directory, write the header and report with the existing trusted meter.
# Header file contains: Authorization: Bearer <runtime local CRON_SECRET>
chmod 600 /absolute/owned-j8/usage.headers /absolute/owned-j8/actual-usage.json
curl --fail --silent --show-error -H @/absolute/owned-j8/usage.headers \
  -H 'Content-Type: application/json' --data-binary @/absolute/owned-j8/actual-usage.json \
  http://127.0.0.1:3000/api/internal/metrics
```

All reports require `workspaceId`, `environmentId`, `resourceId`, `address`, `observedAt` (actual current UTC ISO time) and `kind`. Container reports require `cpuPercent`, `memoryPercent`, `requestsTotal`, `internetEgressBytesTotal`, `interComponentBytesTotal`, `logIngestBytesTotal`. CPU and memory percentages use actual utilization divided by actual assigned capacity. Byte/request fields are cumulative measured counters, including explicit measured zero. Internet egress is bytes crossing the internet billing boundary; inter-component traffic is separately metered; log ingestion is bytes accepted at the logging boundary. Total pod traffic and configured storage capacity do not satisfy these meanings. PostgreSQL/MySQL/object reports require `occupiedBytes`, from actual occupied storage measurements. The trusted meter must aggregate each resource once; do not report independent replicas as duplicate resource totals. This ingress is a trust boundary for infrastructure instrumentation, not a tenant claim of billable usage.

Scrape `GET /api/internal/metrics` every 30 seconds with the same existing internal authentication; use a runtime `bearer_token_file` in Prometheus, never a checked-in key. Set `ZENITH_OBSERVE_PROMETHEUS_URL=http://127.0.0.1:9090` for the API/worker. The exporter attaches `zenith_workspace_id`, `zenith_environment_id`, `zenith_resource_address`; cost source matchers come from the authorized scope/graph rather than caller labels. Fixed templates require a current unique producer heartbeat at every sample. Configure the existing Prometheus container with `--memory=512m --cpus=1`, `--storage.tsdb.retention.time=15d` and `--storage.tsdb.retention.size=256MB`. Use the installation's pinned ARM64-compatible image, bind only loopback, and do not run overlapping acceptance profiles.

After seven days of real data, current underutilization and actual approved transfers for the field the optimizer will change, use a fresh opted-out local environment without conflicting pending scale operations. Run:

```sh
export PATH="$HOME/.local/sdk/node22:$PATH"
# Keep the actual local installation's ZENITH_TEST_PLATFORM_PG_URL and consent variables above.
export ZENITH_TEST_COST_TEMPORAL_ADDRESS=127.0.0.1:7233
export ZENITH_TEST_COST_DEFAULT_SWEEP=1
npx vitest run tests/placement/optimizer-sweep.local.test.ts --no-file-parallelism --maxWorkers=2
```

Expected: **one pass / zero failures / zero skips**. This uses the operated existing schedule and genuine default worker, waits for natural passes, proves zero optimizer operations before human opt-in, bounded awaiting-human-approval proposals after consent, zero starts/runner jobs, durable no-duplicate history on another pass and finally restores opt-out. No synthetic clock, fabricated samples, privileged substitute, new scheduler, approval or execution call is used. Native size-transfer expiry is independently checked by `tests/controlplane/ownership-transfers.test.ts` under `ZENITH_TEST_PLATFORM_PG_URL`; that new case must pass, never skip, in the Mac native lane. The unchanged Temporal restart suite remains required:

```sh
ZENITH_TEST_RECONCILE_SCHEDULE=1 ZENITH_TEST_TEMPORAL=1 ZENITH_TEST_TEMPORAL_CLI=/absolute/path/to/temporal npx vitest run tests/workflows/reconcile-schedule.test.ts --no-file-parallelism --maxWorkers=2
```

Its owned Temporal/native PostgreSQL prerequisites are documented in `PROD-OBS-04.md`; use that runbook's exact required flags/profile. None of the native/browser/Prometheus/Temporal cases above was run on this Windows machine. The actual workload meter, local stack startup and real seven-day data are deployment/verification prerequisites, not evidence supplied by contract fixtures.
