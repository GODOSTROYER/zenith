# Service and recovery objectives (PROD-OPS-01)

Written against branch `prod/ops-01-w5`, built on base `c02c097`. Not verified against a live deployment: the local contract and engine tests exist; no restore rehearsal has reported a measurement and the capacity test has not been run against a production topology.

**Every target in this guide is provisional and unapproved.** They are engineering defaults chosen so that measurement, budgets and alerts can exist now. The decision that would make any of them a commitment (DEC-BUSINESS) is pending and is made outside this repository. The definition file has no field that can record an approver, the validator refuses one, and every screen, API body and alert says "Provisional, not approved".

## What exists

| Piece | Where |
|---|---|
| Versioned definitions (targets, burn alerts) | `deploy/slo/slo-definitions.json`, validated by `src/lib/slo/definitions.ts` |
| SLI computation | `src/lib/slo/sli.ts` (from the OPS-02 metric catalog), `src/lib/slo/store.ts` (durable rows) |
| Durable samples and budgets | `platform.slo_samples` (migration 43), `src/lib/slo/recorder.ts`, `src/lib/slo/budget.ts` |
| Prometheus recording rules and burn-rate alerts | `deploy/observability/alerts/zenith-slo.rules.json` |
| RPO / RTO / capacity measurement hooks | `src/lib/slo/recovery.ts`, `POST /api/internal/slo/measurements`, `scripts/slo/report-recovery.mjs`, `platform.slo_measurements` |
| Capacity test | `scripts/slo/capacity-test.mjs` |
| Operator report | `GET /api/admin/ops/slo` and the page `/admin/slo` (platform operators, `ZENITH_OPS_ADMIN_IDS`) |

## The provisional objectives

| Objective | Provisional target | Indicator |
|---|---|---|
| Control-plane availability | 99.5% | API requests without a 5xx status, over all API requests. 429 is the caller's own quota and counts as served. |
| API latency | p95 under 500 ms (95% of requests within 500 ms) | `zenith_api_request_duration_seconds` buckets. |
| Dispatch latency | 95% of unapproved operations start within 30 s | `platform.operations` created to started; human approval waits are excluded. |
| Workflow completion | 95% | succeeded over succeeded, failed or uncertain. Tenant-caused failures are not yet separated. |
| Scheduler health | 99% | share of critical jobs healthy at each sample (PROD-OBS-04 records). |
| Sustained capacity | 25 requests/s with p95 at most 500 ms and errors at most 0.5% | the capacity test, on the machine that ran it. |
| RPO | 15 minutes | newest recovered write versus the moment of failure, from a restore rehearsal. |
| RTO | 4 hours | failure to first successful health check, from a restore rehearsal. |

Availability, latency, dispatch, workflow completion and scheduler health are tracked as error budgets over a 30-day window. RPO, RTO and capacity are measured results: until something reports, the page says "Not measured yet", never a pass.

## How the numbers are produced

API availability and latency come from this process's OpenTelemetry-compatible counters and histogram. Every scrape of `/api/internal/metrics`, and every execution-worker sampler tick, adds the counter deltas since the last flush to `platform.slo_samples` in five-minute buckets, so the budget is the sum across instances and survives restarts without a metrics backend. Dispatch latency and workflow completion are computed straight from `platform.operations`. Scheduler health is sampled from `platform.scheduled_job_runs`. If nothing scrapes the API and no worker runs, no samples are written and the report says "No data yet".

Limits worth knowing: availability counts what the API itself saw, so an outage that stops requests from arriving (DNS, edge, platform down) leaves no samples; use an external uptime probe against `/api/internal/tick/status?strict=1` for that. The latency threshold is rounded down to the nearest histogram bucket (0.5 s is a bucket bound).

## Error budgets and burn-rate alerts

For a ratio target T the budget is 1 - T. Burn rate is the observed error ratio divided by the budget. An alert fires when both of its windows burn at or above its factor and the long window has at least 20 events:

| Alert | Long and short window | Factor | Severity |
|---|---|---|---|
| fast | 1h and 5m | 14.4 | critical |
| slow | 6h and 30m | 6 | warning |
| ticket | 3d and 6h | 1 | info |

The report evaluates the same rule from the durable samples; Prometheus evaluates it from `zenith-slo.rules.json` (import like the other rule file). `tests/slo/slo-artifacts.test.ts` fails if a threshold in the JSON stops matching `target` and `factor` in the definition file.

## Reporting a restore rehearsal (for PROD-OPS-04)

A rehearsal reports three instants and the server derives the numbers, so a rehearsal cannot report a figure it did not measure:

- RPO = failure instant minus the newest committed write the restored data contains.
- RTO = first successful health check after restore minus the failure instant.

Inside the app call `reportRecoveryRehearsal(sql, ...)` from `src/lib/slo/recovery.ts`. From a script:

```
node scripts/slo/report-recovery.mjs --url https://<host> --bearer-file ./.cron-secret \
  --failure-at <ISO> --data-through <ISO> --restored-at <ISO> --recorded-by <who> --reference <run id>
```

`--dry-run` prints the derived numbers without contacting anything. Records are append-only. The page judges the latest measurement against the current provisional target.

## Running the capacity test

```
node scripts/slo/capacity-test.mjs --self-test
node scripts/slo/capacity-test.mjs --url http://127.0.0.1:3000 --path /api/internal/metrics --bearer-file ./.cron-secret --concurrency 16 --duration 30
```

GET only. A non-loopback target is refused unless `--allow-remote`. Add `--report` (with `--bearer-file`) to record the result. The figure describes the machine and target that ran it, not a production capacity.

## ZenithSloAvailabilityBurnFast

The API is returning 5xx fast enough to spend two percent of the 30-day budget in an hour. Check `zenith_control_store_up`, the API logs and the last deploy. Roll back a bad deploy first, diagnose second.

## ZenithSloAvailabilityBurnSlow

Sustained elevated 5xx over six hours. Check for a degraded dependency (control store, auth provider) and for one route class dominating `zenith_api_requests_total{status_class="5xx"}`.

## ZenithSloAvailabilityBurnTicket

Slow leak: the three-day error ratio is above the budget rate. Open a ticket; no page.

## ZenithSloLatencyBurnFast

Requests are slow enough to exhaust the latency budget quickly. Check in-flight requests (`zenith_api_inflight_requests`), control-store latency and recent deploys.

## ZenithSloLatencyBurnSlow

Sustained slowness over six hours. Look at per-route-class latency in the dashboard and at the store.

## ZenithSloLatencyBurnTicket

Latency has drifted above the budget rate over three days. Open a ticket; no page.
