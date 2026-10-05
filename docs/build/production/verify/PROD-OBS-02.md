# PROD-OBS-02 Fresh scoped telemetry provenance

## 1. Summary
A typed `TelemetryEnvelope` (schema v1) now accompanies every telemetry read.
It carries signal, scope (workspace/project/environment/addresses), range, a non-secret scoped-session
descriptor (provider, region, transport, expiry, truncated SHA-256 ref; no credentials), `observedAt`,
freshness (budget, newest item, age) and per-source provenance (source id, provider, evidence level,
simulated flag, item count, newest/oldest, reason). States: `fresh | stale | empty | unknown | inaccessible`.

Files:
- `src/lib/observability/telemetry.ts` (new): types, classification, builders, `describeSession`.
- `src/lib/observability/fabric.ts`: every fabric answer (logs, metrics, events, traces) sets `QueryResult.telemetry`.
  Because every provider source (AWS CloudWatch/events, GCP, Azure, OCI, Kubernetes, Prometheus, Loki, sandbox) is queried through the fabric, all readers are covered at this chokepoint. Items are counted after tenant/range filtering, so a foreign-environment item cannot make an answer fresh.
- `src/lib/observability/types.ts`: additive optional `QueryResult.telemetry`.
- `src/lib/observability/health.ts`: `describeHealthTelemetry`, `resourceHealthWithTelemetry` (resource health).
- `src/lib/machines/telemetry.ts` (new): `readMachineHealth` / `machineHealthTelemetry` (machine health through the existing `executeMachineOperation` authority path; grant refusal returns `inaccessible`).
- Wiring: `agent-access/v3/adapters.ts`, `platform/agent-ports.ts`, `platform/execution.ts`, `execution/verify.ts` pass the described session to the fabric; `agent-access/v3/tools/observe.ts` returns `telemetry` in `data` for logs and metrics; verify diagnostics include a compact telemetry summary.
- Exports in `observability/index.ts` and `machines/index.ts`.

## 2. Acceptance mapping
"Logs/metrics/traces/provider events/resource events/machine health use scoped sessions, timestamps/provenance and explicit unknown/inaccessible results."
- Scoped sessions: `describeSession` + `FabricOptions.session`, wired in the four fabric construction sites. Tests: `tests/observability/telemetry.test.ts` ("describes the scoped session without any credential material", "session refs are stable...").
- Timestamps/provenance (logs, metrics, events, traces): fabric envelope. Tests: "labels a recent answer fresh...", "covers metrics, events and traces...", "carries simulated provenance per source".
- Stale: "labels an answer whose newest item is older than the budget stale".
- Unknown/inaccessible/empty: "reports a refused source as inaccessible", "reports a timed-out source as unknown", "unavailable-only source answer...", "keeps empty distinct from unknown", "with no covering source...", partial case.
- Resource events and resource health: events via fabric (`searchEvents`); health via `resourceHealthWithTelemetry` ("resource health telemetry" describe block).
- Machine health: `tests/machines/telemetry.test.ts`.
- Tenant scoping: "counts only items inside the tenant scope".

## 3. Verification commands
```
npx vitest run tests/observability tests/machines/telemetry.test.ts tests/machines/service.test.ts tests/agent-v3 tests/security/signal-boundaries.test.ts
npx tsc --noEmit -p .   # pre-existing unrelated errors exist in src/lib/tofu/engine.ts and tests/ci/platform-coverage.test.ts at base 76a0652
npx eslint src/lib/observability src/lib/machines/telemetry.ts tests/observability/telemetry.test.ts tests/machines/telemetry.test.ts
```
Expected: all pass. No env vars needed (fake sources and fake machine drivers; the fabric under test is the real one).

## 4. Known gaps
- Tests were not run by the worker (build-only rule); they were typechecked and linted.
- Evidence level for all sources stays `contract`/`simulated`; no live-provider run exists, and none is claimed.
- Freshness budgets are defaults (log 15m, metric 10m, trace 15m, event 60m, health 5m), overridable via `FabricOptions.freshnessBudgetMs`. A `stale` label for a wide range means "newest item is old", not "the source is broken".
- `classifyUnavailable` is text-based on already-redacted reasons; sources that fail with unusual refusal wording are labeled `unknown`, never `fresh`.
- Per-resource `RuntimeState` from driver `runtime()` calls in the investigation engine is not wrapped (that lives in incident files owned by PROD-OBS-03's area); use `describeHealthTelemetry` there.
- No new SQL or tables; no shared-file updates needed besides LIMITATIONS/ledger.

## 5. Suggested ledger implementationStatus
`implemented_contract_tested: typed telemetry envelope with scope/session/observedAt/freshness/provenance and explicit fresh/stale/empty/unknown/inaccessible states on fabric logs/metrics/events/traces, resource health and machine health; contract and fake-engine tests only, no live provider run`
