# Control-plane observability (PROD-OPS-02)

Dashboard, alert and collector definitions for the fair, bounded control plane. Design and runbooks:
`docs/platform/operations/CONTROL-PLANE-FAIRNESS.md`.

| File | What |
|---|---|
| `grafana/zenith-control-plane.dashboard.json` | Grafana dashboard (import; pick your Prometheus datasource for `DS_PROMETHEUS`). Tenant variable `tenant` filters every tenant-scoped panel. |
| `alerts/zenith-control-plane.rules.json` | Prometheus rule groups in JSON (a YAML subset: `promtool check rules` and Prometheus accept it as is). Every alert carries `severity`, `service` and a `runbook_url` to a heading in the runbook. |
| `alerts/zenith-slo.rules.json` | Recording rules and multiwindow burn-rate alerts for the PROVISIONAL service objectives (PROD-OPS-01; see `docs/platform/operations/SLO.md`). |
| `otel/collector.json` | Example OpenTelemetry Collector config: OTLP/HTTP in, Prometheus scrape endpoint for metrics, OTLP to your trace backend (`ZENITH_TRACES_BACKEND_ENDPOINT`). |

These are definitions only. Nothing here has been imported into a live Grafana, Prometheus or collector from this
repository; `tests/ops/observability-artifacts.test.ts` proves they are valid JSON and that every metric and label they
reference exists in `src/lib/ops/telemetry/catalog.ts`.

## Reproducible local import (J11)

`import-harness.mjs lint` checks the JSON structure offline. `import-harness.mjs run`, gated by
`ZENITH_TEST_OBSERVABILITY_IMPORT=1`, runs real promtool and collector validation, starts three private Docker services,
imports the datasource/dashboard through Grafana's API, verifies panels and tenant filters through readback, and checks
all eleven loaded Prometheus rules. It sends explicitly synthetic OTLP tenant metrics and a correlated tenant/operation
span, checks the Grafana datasource's query path and the collector's trace sink, and waits for the unchanged two-minute
`ZenithControlStoreDown` rule to fire. No control-store outage or tenant-fairness claim follows from this synthetic input.

The profile is 256 MiB per service (768 MiB total), one process per service, loopback-only random published ports,
read-only configuration and private ephemeral storage. Grafana's anonymous Admin mode is only for this disposable
loopback installation; it must not be copied to a deployed service. Cleanup targets the unique owned Compose project.

`images.env` initially contains **unresolved resolution inputs**. The harness refuses them until the Mac resolves real
registry digests with `scripts/deploy/pin-digests.mjs`. Exact commands, evidence scope and remaining gates are in
`docs/build/production/verify/OPS-02.md`. No Docker/collector/Grafana/Prometheus acceptance was run on this builder.

## Getting data in

Push (any host): set on the API and the execution worker

```
ZENITH_OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.internal:4318   # https, or http to a loopback collector
ZENITH_OTEL_EXPORTER_OTLP_TOKEN_FILE=/run/secrets/otel-token          # optional bearer, a file reference
```

Pull (long-lived hosts): `GET /api/internal/metrics` with `Authorization: Bearer $CRON_SECRET` on each API instance, and
`http://127.0.0.1:${ZENITH_WORKER_HEALTH_PORT:-9464}/metrics` on each worker (loopback only; scrape it with a sidecar or
node-local agent). Each scrape of the API route also samples queue depth, active operations and maintenance mode from
the control store, and reports `zenith_control_store_up 0` when the store does not answer.

## Following one tenant or one operation

1. In the dashboard pick the tenant (workspace id). The refusals, queue and worker panels narrow to it.
2. In your trace backend search `zenith.tenant.id = <workspace>` and, for one operation, `zenith.operation.id = <op id>`.
   API spans (`zenith.operation.class = api`), dispatch decisions (`dispatch`) and worker activities (`activity`) share
   those attributes; the admission decision is on the span as `zenith.admission.decision`.
3. Log lines carry `traceId` (and `requestId`); the `traceparent` response header returns the trace id to the caller.

`operation` is intentionally not a metric label (unbounded cardinality); it is a span and log attribute.
