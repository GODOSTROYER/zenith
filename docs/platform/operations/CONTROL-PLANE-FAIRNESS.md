# Fair, bounded control plane (PROD-OPS-02)

Written against branch `prod/ops-02-w4`, built on base `c9a942d`. Not verified against a live deployment: the local contract and engine tests exist, the staging rehearsal below has not been run.

How Zenith keeps one tenant, one outage or one planned maintenance window from taking the
whole control plane down, and what is guaranteed to keep working while it is degraded.

Everything below is implemented in `src/lib/ops/` and wired into the real callers. Nothing here
is an opt-in library: the API wrapper, the edge middleware, the dispatch entry points, the runner
job store and the execution worker all call it by default. Defaults are safe for a single-node
install; every limit is an environment variable (see [Configuration](#configuration)).

## Layers

| Layer | Where | What it does | Refusal |
|---|---|---|---|
| Edge shield | `src/middleware.ts` -> `ops/edge.ts` | Coarse per-client token bucket (trusted-header IP, else a credential fingerprint). Host-level read-only override. | 429 / 503 + Retry-After |
| API admission | `server/request.ts` `route()` -> `ops/admission.ts` | Maintenance read-only; process-wide in-flight ceiling; per-workspace token bucket and in-flight cap (quota + weight from `tenant_quotas`). | 503 `overloaded`, 429 `rate_limited`, 429 `concurrency_exceeded`, 503 `maintenance_read_only` |
| Dispatch admission | bridge deploy/destroy, MCP execute, portability start -> `ops/admission.ts` `assertDispatchAdmitted` | Called BEFORE an approved operation is claimed. Maintenance pause; per-workspace dispatch bucket; per-workspace active-operation quota. | 503 `maintenance_dispatch_paused`, 429 `rate_limited`, 429 `concurrency_exceeded` |
| Runner job queue | `controlplane/db/repos/jobs.ts` `enqueue` -> `ops/queue-bound.ts` | The durable queue is bounded per workspace and globally. | 429 `queue_full`, 503 `overloaded` |
| Worker scheduling | `workers/execution/run.ts` interceptor -> `ops/worker-gate.ts` | Weighted-fair permits for heavy activities across tenants. | none: it delays, never fails |

All refusals are `BackpressureError` (`ops/errors.ts`): `{ error: { code, message, fix, retryAfterSec } }`
and a `Retry-After` header. 429 means the caller exceeded its OWN share; 503 means the platform or an
operator is shedding load. A refusal is never a 500 and never changes state.

## Backpressure

- Nothing buffers. A full limit is a refusal with a retry hint, never a parked request: the in-flight
  gates refuse instead of queueing, token buckets refuse with `retryAfterMs`, the fair semaphore's
  waiting set is bounded by the worker's own slot count, the span ring drops oldest, and metric series are
  capped per metric (overflow folds into one `_overflow` series).
- Every table of keys an attacker can influence is bounded: token-bucket keys (`maxKeys`, evicting only
  fully refilled buckets and otherwise sharing one overflow bucket), tenant labels (200 distinct, the rest
  `other`), quota cache (5000), in-flight leases (reclaimed after 15 minutes if a handler never returns).
- Refusing never costs an approval: dispatch admission runs before the claim. In the deploy bridge a refusal
  returns "Workflow start is deferred" and leaves the operation `approved`; over MCP it is a retryable
  `dispatch_backpressure` tool error with `retryAfterSec`; portability start answers 429/503 from the route.

### Runner queue semantics (why operation-bound jobs are treated differently)

- Operation-less reads (API-originated) are refused at the workspace's queued-job cap (default 200, or its
  `max_queued_jobs`, scaled by weight) with 429, and at the global cap (5000) with 503.
- Operation-bound jobs (issued by a running workflow) are NOT refused at the tenant cap. Their operation was
  already admitted by the active-operation quota, which bounds how many exist. Refusing one mid-operation
  would fail a step that holds a lease; for a mutating step the workflow can only classify that as
  `uncertain` (`workflows/definitions/policies.ts`). A hard ceiling at 4x the global cap remains as a last
  defence (503).
- The count-then-insert is not serialized, so a cap can be exceeded by at most the number of concurrent
  writers. That is "cap plus concurrency", still a bound.

## Maintenance mode

Operator-controlled, stored in `platform.ops_maintenance` (one row, versioned, audited in the append-only
`ops_maintenance_history`), merged with the host-level `ZENITH_MAINTENANCE_MODE` override (the stricter wins).

| Mode | New dispatch | Mutating API | Everything in flight |
|---|---|---|---|
| `off` | allowed | allowed | - |
| `dispatch_paused` | refused 503 (before the claim) | allowed | continues |
| `read_only` | refused 503 | refused 503 (reads, drain path and control lanes still served) | continues |

Set it with `PUT /api/admin/ops/maintenance` `{ mode, reason, expectedVersion? }` (platform operators only:
a signed-in session whose user id is in `ZENITH_OPS_ADMIN_IDS`, same-origin; a reason is required to enter).
`GET` returns the effective mode, the last changes and the **drain status**: `queuedOperations`,
`runningOperations`, `queuedRunnerJobs`, `activeRunnerJobs`, and `drained: true` once all four are zero.
That is the safe point to stop workers or take the store down. Other API processes see a change within
`ZENITH_OPS_MAINTENANCE_CACHE_MS` (default 2 s); the process that handled the request sees it immediately.

What keeps working in `read_only`, and why:

- reads; runner and machine `poll`, `heartbeat`, job `result` and `logs` (in-flight jobs must settle);
- `/api/internal/tick/*` (the reaper and reconcile passes that finish draining work);
- `/api/admin/ops/*` (the operator must be able to turn maintenance off);
- `/hosted-gateway/*` and the two hosted admission endpoints (the data plane);
- MCP endpoints are a POST transport for reads too, so they are not method-gated; what they could START is
  stopped by the dispatch pause and approvals are browser-only POSTs, which read-only refuses.
- Registration (`/runners/register`) creates state, so read-only refuses it.

An unreachable store never clears a maintenance window that was already seen (the cache keeps the last known
state) and never stalls a request (1.5 s timeout, then last known). `ZENITH_MAINTENANCE_MODE=read_only` on the
host is the way to enter maintenance when the control store itself is the thing being worked on.

Automated reconcile/remediation and scheduled runbooks are not paused by dispatch pause; they are
observation-first control loops that the drain depends on. Pausing them is a separate operator decision.

## Weighted-fair scheduling

Temporal hands a worker tasks in server-queue order. `ops/worker-gate.ts` is an activity interceptor in the
worker; no workflow or activity changed. Before a HEAVY activity (plan, apply, build, deploy, migrate, verify,
observe, execute capability, reconcile observe) runs, it takes a permit from a `FairSemaphore`. Permits are
granted by stride scheduling across tenants (`ops/fair-queue.ts`): the next permit goes to the backlogged
tenant with the smallest virtual time, serving a tenant advances it by `1/weight`, and an idle tenant banks no
credit. Weights come from `platform.tenant_quotas.weight` (default 1), refreshed by the worker every 30 s.

- Light activities (leases, approval check, policy evaluation, step bookkeeping) never wait.
- Heavy capacity defaults to 3/4 of `ZENITH_WORKER_MAX_CONCURRENT_ACTIVITIES`, leaving slots for the light lane.
- Waiting is bounded by `ZENITH_WORKER_FAIR_MAX_WAIT_MS` (15 s, under the 60 s heartbeat timeout). After that the
  activity RUNS (counted in `zenith_worker_fair_bypassed_total`). Fairness may delay work; it must never fail it,
  because an activity that fails before starting would be classified `uncertain` for a mutating step.
- What it cannot do: reorder tasks still in the Temporal server's queue. Bounding what a tenant can put there is the
  dispatch quota's job (`ZENITH_OPS_MAX_ACTIVE_OPERATIONS`, one sequential workflow per active operation), which is
  why both exist. Per-tenant Temporal task-queue partitioning was considered and not built: moving workflow starts
  to new queues needs matching worker polling everywhere first, and a mixed-version rollout would strand workflows.

### Runner queues are already tenant-isolated

A runner or machine agent registers into exactly one workspace, and `claimNext` only ever returns jobs for that
runner in that workspace. There is therefore no shared runner queue across tenants to dequeue fairly: one tenant's
backlog cannot sit in front of another tenant's job. What remains is head-of-line blocking inside one workspace's own
runner, which the per-workspace queued-job cap and the active-operation quota bound. Job order within a runner stays
oldest-first (a verified behaviour that was not changed).

## Data-plane guarantee

> A workload that is already deployed keeps serving, and a runner or machine agent keeps executing and
> settling the jobs it already holds, while the control plane is overloaded, in maintenance, or unreachable.

What is true in code, and where it is tested (`tests/ops/data-plane-independence.test.ts`):

1. **Hosted apps.** App-host requests are rewritten to `/hosted-gateway/*` in the first lines of the edge
   middleware, before the rate limiter, maintenance check or session gate. No admission code runs for them, and
   `/hosted-gateway/*` is a control lane that read-only maintenance and the limiters never touch.
2. **No code path.** The data-plane source trees (`src/lib/hosted/gateway`, `src/lib/hosted/runtime`,
   `src/app/hosted-gateway`, `go/internal/{agent,runner,machine,proc}`) import nothing from `src/lib/ops` and never
   query `ops_maintenance` or `tenant_quotas`. A refusal or an outage of the fairness layer cannot reach them.
3. **Control lanes.** Runner/machine poll, heartbeat, result and logs, cron ticks and the operator route bypass the
   limiters and are served in read-only maintenance, so overload or maintenance cannot block drain or recovery.
4. **Degraded store.** Admission reads the store best effort: quotas fall back to the last known value or the
   defaults, maintenance to the last known state. A store outage lowers protection; it does not fail requests.
   `zenith_control_store_up` goes to 0 and the `ZenithControlStoreDown` alert fires.
5. **Agents.** `zenith-runner` and `zenithd` poll with jittered exponential backoff (`go/internal/agent/backoff.go`,
   1 s to 60 s) and keep executing claimed work. A finished result is posted with up to 12 backoff retries;
   when the agent has a durable spool the result also stays on disk and is replayed on reconnect (`postResult` in
   `go/internal/agent/loop.go`). A job whose lease lapses while the control plane is down becomes `timed_out` and the
   owning operation is reconciled to `uncertain`, never re-dispatched.

What is NOT claimed, and needs the live acceptance harness (deferred by the user, never counted as passed):

- Provider-side workloads (ECS, Kubernetes, VMs) running while Zenith is down. They run on the customer's
  infrastructure and hold no Zenith dependency at request time, but this repository does not run them; the
  rehearsal below does.
- Cloud STS exchanges against the workload-identity OIDC issuer (`/api/oidc/*`) need the control plane to be up.
  They are used by Zenith's own deployments, not by running workloads.
- Infrastructure sharing. The hosted-apps subsystem (`src/lib/hosted`) keeps its own store, separate from the
  `platform` control-store schema, but a deployment that runs both on one database host or one Node process shares that
  failure domain. This document guarantees the admission layer never couples them; it cannot remove a shared host.

### Operational rehearsal (run in staging; record the result)

1. Deploy a hosted app and a runner with a long job.
2. `PUT /api/admin/ops/maintenance` `{ "mode": "read_only", "reason": "rehearsal" }`. Confirm: app traffic unaffected,
   API writes answer 503 with Retry-After, the runner's job settles, `GET` shows `drained: true` afterwards.
3. Set `ZENITH_PLATFORM_DB_URL` to an unreachable host on one API instance. Confirm app traffic unaffected,
   `zenith_control_store_up` is 0, `ZenithControlStoreDown` fires, requests degrade to defaults.
4. Flood one workspace past its limits. Confirm only that workspace sees 429s and another workspace's p95 is flat.

## Telemetry

OpenTelemetry-compatible and dependency-free: `ops/telemetry/` implements the OTel data model (cumulative sums,
gauges, explicit-bucket histograms, W3C trace context) and serializes OTLP/HTTP JSON. No `@opentelemetry/*`
package was added.

- Correlation: metrics carry `tenant` (workspace id, bounded labeler). Spans carry `zenith.tenant.id`,
  `zenith.operation.id`, `zenith.operation.class` (`api`, `dispatch`, `activity`), `zenith.request.id`, plus the
  admission decision. Log lines carry `traceId`. The `traceparent` header is honoured on requests and returned on
  every response. `operation` is deliberately a span/log field and not a metric label (unbounded); join by tenant
  and time on metrics, by operation id on traces.
- Export: set `ZENITH_OTEL_EXPORTER_OTLP_ENDPOINT` (https, or http to loopback) for push every
  `ZENITH_OTEL_EXPORT_INTERVAL_MS`; the optional bearer is read from `ZENITH_OTEL_EXPORTER_OTLP_TOKEN_FILE`. Pull:
  `GET /api/internal/metrics` (`CRON_SECRET` bearer) on the API and `/metrics` on the worker's loopback health
  listener. Export is best effort: one in flight, 5 s timeout, failures counted, never raised.
- Dashboards and alerts: `deploy/observability/` (see its README). `tests/ops/observability-artifacts.test.ts`
  fails if they reference a metric or label that the catalog (`ops/telemetry/catalog.ts`) does not define.

## Alert runbooks

### ZenithControlStoreDown

The control store has not answered for 2 minutes. Deployed workloads and agents are unaffected (see the guarantee).
New operations, approvals and writes may fail. Check the store, the pooler and `ZENITH_PLATFORM_DB_URL`. If the
store is being worked on deliberately, set `ZENITH_MAINTENANCE_MODE=read_only` on the API hosts first.

### ZenithMaintenanceLeftOn

Maintenance has been on for an hour. `GET /api/admin/ops/maintenance` shows who set it and why. Clear it with
`PUT { "mode": "off" }` once `drain.drained` is true or the work is done.

### ZenithApiOverloaded

The process-wide in-flight ceiling is being hit. Look at the control store latency and the worker first; raising
`ZENITH_OPS_API_MAX_IN_FLIGHT` only moves the queue into the database.

### ZenithTenantThrottled

One workspace has been at its own limit for 15 minutes. Find the client (the `tenant` label, then traces by
`zenith.tenant.id`). If the traffic is legitimate raise that workspace with `PUT /api/admin/ops/quotas`.

### ZenithApiErrorRatioHigh

More than 5% of requests failed with 5xx. 503s from backpressure and maintenance count here; compare with the
refusals panel before assuming a defect.

### ZenithApiLatencyHigh

p95 above 2 s for 10 minutes. Check store latency, the runner queue and the worker fair lane.

### ZenithRunnerQueueNearCap

Queued runner jobs are above 80% of the default global cap. Confirm runners are polling and not revoked.

### ZenithWorkerFairLaneSaturated

Heavy activities are exhausting their fair wait and running anyway. Add worker capacity
(`ZENITH_WORKER_MAX_CONCURRENT_ACTIVITIES`) or lower per-workspace `max_active_operations`.

### ZenithWorkerFairBacklog

Heavy activities have waited for a fair turn for 15 minutes. Same remedies as saturation, lower urgency.

### ZenithTelemetryExportFailing

The OTLP collector is not accepting data. Serving is unaffected; fix the endpoint or token file.

### ZenithTelemetryDroppingSamples

A series cap or the span buffer is full. Lower `ZENITH_OTEL_TRACE_SAMPLE_RATIO` or export more often.

## Configuration

All values are bounded; a malformed or out-of-range value falls back to the default and is logged once at start.

| Variable | Default | Meaning |
|---|---|---|
| `ZENITH_OPS_EDGE_RATE_PER_SEC` / `ZENITH_OPS_EDGE_BURST` | 100 / 400 | per-client edge bucket |
| `ZENITH_OPS_EDGE_MAX_KEYS` | 10000 | distinct clients tracked per isolate |
| `ZENITH_OPS_TRUSTED_IP_HEADER` | unset | `x-forwarded-for`, `x-real-ip` or `x-vercel-forwarded-for`; unset keys by credential fingerprint |
| `ZENITH_OPS_API_RATE_PER_SEC` / `ZENITH_OPS_API_BURST` | 50 / 200 | per-workspace API bucket (x weight) |
| `ZENITH_OPS_API_MAX_CONCURRENT_PER_TENANT` | 16 | per-workspace in-flight requests (x weight) |
| `ZENITH_OPS_API_MAX_IN_FLIGHT` | 256 | process-wide in-flight requests |
| `ZENITH_OPS_API_MAX_TENANTS` | 10000 | distinct workspaces tracked |
| `ZENITH_OPS_DISPATCH_RATE_PER_SEC` / `ZENITH_OPS_DISPATCH_BURST` | 1 / 10 | per-workspace dispatch bucket (x weight) |
| `ZENITH_OPS_MAX_ACTIVE_OPERATIONS` | 25 | per-workspace queued+running operations (x weight) |
| `ZENITH_OPS_RUNNER_QUEUE_MAX_PER_TENANT` | 200 | per-workspace queued read jobs (x weight) |
| `ZENITH_OPS_RUNNER_QUEUE_MAX_GLOBAL` | 5000 | queued runner jobs, all workspaces |
| `ZENITH_OPS_RETRY_AFTER_SEC` | 5 | base Retry-After for capacity refusals |
| `ZENITH_OPS_MAINTENANCE_CACHE_MS` | 2000 | how long a maintenance read is reused |
| `ZENITH_MAINTENANCE_MODE` / `ZENITH_MAINTENANCE_REASON` | off | host-level override: `dispatch_paused` or `read_only` |
| `ZENITH_OPS_ADMIN_IDS` | none | comma-separated Supabase user ids allowed to use `/api/admin/ops/*` |
| `ZENITH_WORKER_FAIR_CAPACITY` | 3/4 of activity slots | heavy-lane permits |
| `ZENITH_WORKER_FAIR_MAX_WAIT_MS` | 15000 | longest a heavy activity waits for a fair turn |
| `ZENITH_OTEL_EXPORTER_OTLP_ENDPOINT` | unset | OTLP/HTTP collector base URL |
| `ZENITH_OTEL_EXPORTER_OTLP_TOKEN_FILE` | unset | file holding the collector bearer token |
| `ZENITH_OTEL_EXPORT_INTERVAL_MS` | 15000 | push period |
| `ZENITH_OTEL_SERVICE_NAME` | zenith-control-plane | resource `service.name` |
| `ZENITH_OTEL_TRACE_SAMPLE_RATIO` | 0.1 | head sampling for new traces |

Per-workspace overrides and the scheduling weight live in `platform.tenant_quotas`, managed with
`GET|PUT|DELETE /api/admin/ops/quotas`. `weight` scales the defaults that have no explicit override.

## Known limits

- Token buckets and in-flight gates are per process (edge: per isolate). The effective ceiling scales with the number
  of instances; the active-operation quota and runner queue caps are database-backed and therefore global.
- The edge shield runs before authentication and keys unauthenticated callers by credential fingerprint or one shared
  anonymous bucket; it is a flood shield, not an identity-aware limit. Per-workspace limits apply after the workspace is
  resolved inside `route()`, which is after the snapshot prefetch; the global in-flight ceiling and the edge shield are what
  protect that prefetch.
- Routes that do not use `route()` (the MCP endpoints, waitlist, runner/machine signed endpoints) are covered by the edge
  shield and, for what they start, by dispatch admission; they do not get per-workspace API buckets.
- Maintenance state from the database is read by `route()` and the dispatch/queue layers. The edge middleware cannot read
  a database, so it enforces only the host-level override; a request that reaches a non-`route()` handler in DB-only
  read-only maintenance is not refused at the edge (its dispatch is).
