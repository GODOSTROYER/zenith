# J8 COST-03: measured proposals and human consent

Base: `3a9de905`. Status: `implementation_complete_verification_pending`. The production joins below remain required; this packet alone does not enable default optimization.

Acceptance: "Measurable bounded nonflapping optimizations respect approval/field ownership and transfer/latency/residency cost."

| Clause | Implementation and acceptance |
|---|---|
| Measured | `cost/optimizer/measurement-collector.ts`: seven days of continuous hourly samples, per-resource scoped queries, explicit units, fresh provenance, no simulated/truncated/partial/overlapping data. Monthly-equivalent usage derived from actual rates; no usage defaults. Unsupported compute, missing meters and fractions the current model cannot express refuse a baseline. Contracts: `measurement-collector.test.ts`; actual local harness: `measurement-collector.local.test.ts`. |
| Bounded, nonflapping | Existing `optimizeEconomics`, durable scale history and `runOptimizerPass` preserved. Existing optimizer and pass tests cover one-step changes, cooldown, reversal, window spending and count bounds. |
| Field ownership | `optimizer-ownership.ts` uses tenant-scoped current resources, complete bounded facts, `guardFor`, registry `evaluateWrite`, approved transfers and revocation/expiry semantics. A native operation needs native-op ownership; manifest ownership alone does not authorize it. `optimizer-ownership.test.ts` is a fixture contract; real registry storage/races retain their separate PostgreSQL gate. |
| Human opt-in and approval | `optimizer-settings-service.ts` requires a browser-human proof, current admin role, policy-authorized environment scope and exact expected version. CAS is serialized by an advisory transaction lock; consent and audit commit together. GET never creates a setting. `optimizer-settings-endpoint.ts` reuses the real browser/session and route wrappers. SQL tests prove default-off, off/on, CAS conflict and actor/tenant refusal. Consent creates no operation or approval. The scheduled pass only proposes to the canonical broker. |
| Transfer, latency, residency | Existing optimizer models preserved. `measurement-ports.ts` reads constraints from the applied revision and performs metric reads using a broker-issued grant inside the existing scoped observe fabric. No credential fallback. |

## Required orchestrator joins, outside owned paths

1. Add `src/app/api/platform/v1/environments/[id]/optimizer/route.ts` exporting `dynamic = "force-dynamic"`, `runtime = "nodejs"` and re-exporting `GET, POST` from `@/lib/cost/optimizer-settings-endpoint`. Add a **browser-only** GET/POST classification in `_lib/bearer-paths.ts`; default unknown paths already refuse bearers. No agent consent path.
2. In the existing durable reconcile sweep composition, call `runMeasuredOptimizerPass(sql, composedOptimizerPorts, createMeasurementDeps(broker, registeredAgentPorts.observability, productReads(), clock), options)` instead of the unmeasured default pass. Keep the same Temporal activity, lease, environment guard and canonical broker. Do not create another timer/scheduler. `runMeasuredOptimizerPass` builds one ownership adapter per tenant/environment, re-reads opt-in inside the guard and preserves all pass counters. It never executes proposals.
3. J11/default-stack observability must supply the existing Prometheus source with `COST_PROMETHEUS_METRICS`. The required exporter meters are `zenith_cost_internet_egress_bytes_total`, `zenith_cost_inter_component_bytes_total`, `zenith_cost_log_ingest_bytes_total`, and object/DB storage gauges when those nodes exist. They must carry existing tenant/environment/resource selector labels. These are **measured billing boundaries**; total pod network traffic is not a substitute. HTTP requests and CPU/memory use the existing Prometheus templates. The existing Prometheus source covers only container services and Kubernetes namespaces; graphs with object/DB nodes also need their scoped source coverage and gauge mappings from J11. Absent meters cause no proposals. Instrumentation and source configuration are outside J8 ownership and cannot be claimed delivered by these adapters.
4. Preserve dispatch-time ownership reauthorization and J13's ownership concurrency work. The current core `service.scale` field table lists replicas; size proposals also require the size-field dispatch guard before integration. The J8 adapter already refuses size without an exact size transfer; do not infer one from a replicas transfer.
5. The new service's settings/resource/transfer/event reads and writes are tenant-scoped. List `createOptimizerOwnership`, `readOptimizerSettings`, `setOptimizerSettings` in the SQL-scoping/tenancy inventory as applicable. No new table, migration, sensitive-data classification, SQL snapshot or gate-count change is needed. The assembler owns gate registration.
6. The product-read seam exposes applied V2 manifest constraints, but omits V1 environment policies. `createMeasurementDeps` refuses V1 revisions rather than silently losing their budget or availability policies. Legacy acceptance needs an authoritative environment-policy implementation of the existing `MeasurementCollectorDeps.constraints` seam. `measurement-ports.test.ts` proves scoped broker/session reads, policy denial, cancellation, V2 constraint preservation and this legacy refusal.

Until these joins land, the existing default still skips measurements and no new HTTP route exists. That refusal is preserved and explicit; the endpoint handlers are reviewable integration code, not a deployed endpoint.

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
docker exec zenith-j8-pg psql -U postgres -c 'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;'
export ZENITH_TEST_PLATFORM_PG_URL="postgres://postgres:$J8_PG_PASSWORD@127.0.0.1:55438/postgres"
npx vitest run tests/cost/optimizer-settings.test.ts tests/cost/actual-spend-store.test.ts tests/placement/optimizer-pass.test.ts tests/controlplane/ownership-transfers.test.ts --no-file-parallelism --maxWorkers=2
docker stop zenith-j8-pg
docker rm zenith-j8-pg
unset J8_PG_PASSWORD ZENITH_TEST_PLATFORM_PG_URL
```

Expected new consent cases: three PGlite and three PostgreSQL cases pass, zero skips; tests retain their assertions. The existing ownership suite uses its own scoped scratch databases. Keep any nonzero exit or cleanup failure as evidence. Strict TLS/Supabase RLS, Temporal restart, browser consent and the composed sweep still need their existing default-stack acceptance lanes; the bare-PG run does not replace them.

## Actual measurement harness

After J1/J11 joins, operate an underutilized local service, perform its human ownership transfer and retain **seven days of real hourly telemetry**. Configure Prometheus retention at 15 days and at most 512 MiB; PostgreSQL 384 MiB; start these serially alongside the lean default profile. Do not fabricate or backdate samples. Export the actual applied `ResourceGraph` and its validated constraints from the local installation to owned absolute paths. Then:

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
