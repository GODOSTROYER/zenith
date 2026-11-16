# WS-OCI-SIGNALS-WIRE — make OCI log/metric reads work end to end through the runner

Workstream: WS-OCI-SIGNALS-WIRE (orchestrator brief) — Branch ws/oci-signals-wire — worktree Z:/Projects/Spawned.ai/zenith-wt/ws-oci-signals-wire
Base: ws/integrate-w6 (staging: WS-OCI-SESSIONS, WS-OCI-READJOBS (C4) and the OCI runner signal services merged)

## Situation
WS-OCI-SESSIONS added `src/lib/observability/sources/oci-{common,logging,monitoring}.ts` and the broker OCI session
(`src/lib/platform/credentials.ts`). Staging already has the `loggingsearch` and `monitoring` services in
`src/lib/providers/oci/services.ts`, read-only POST rules under `infrastructure.observe` only in
`src/lib/providers/oci/allowlist.ts`, and the Go guard `go/internal/oci/logging_search.go` + `compartment.go`.
Four gaps keep real reads from working or leave them under-guarded (see tests/platform/WS-OCI-SESSIONS-HANDOFF.md items 4–6):

1. **LQL grammar mismatch.** The TS reader sends `search "<compartment>/<logGroup>" | sort by datetime desc`;
   `bindLoggingSearch` (go/internal/oci/logging_search.go) accepts only `search "<scope>"` and refuses the suffix.
   Accept exactly that one fixed suffix (byte-exact, single spaces) and nothing else; keep every other check.
2. **Capability rules.** Agent reads run with the grant's capability (`logs.read`, `metrics.read`,
   `incident.investigate`, `infrastructure.observe` — see READ_CAPABILITIES in src/lib/platform/agent-ports.ts).
   OCI_ALLOWLIST grants the signal POSTs only to `infrastructure.observe`, so `logs.read`/`metrics.read` reads fail closed.
   Add: `logs.read` → Logging Search rule only; `metrics.read` → Monitoring rule only; `incident.investigate` → both,
   alongside its existing metadata reads. Never give a mutating capability or `topology.read` these rules.
   Regenerate `go/internal/oci/testdata/{services,allowlist}.json` with the existing `scripts/generate-oci-allowlist.ts`.
3. **MQL resource binding (Go).** `compartment.go` binds Monitoring's URL compartment but not the `resourceId` embedded
   in the MQL body. Restrict summarizeMetricsData bodies to the grammar the TS reader emits:
   `namespace` = `oci_computeagent`, query `<CpuUtilization|MemoryUtilization>[<1m|5m|1h|...supported interval>]{resourceId = "<ocid1.instance...>"}.mean()`,
   with `resolution` equal to that interval, and require the resourceId to be bound to the permitted compartment
   through the trusted local resource→compartment bindings (the same map logging_search.go uses). Refuse any other
   namespace, metric, aggregation, dimension, extra field, or an unbound/foreign resourceId.
4. **Tests use the real tables.** `tests/observability/oci-signals.test.ts` still mocks services/allowlist as "pending".
   Remove those mocks so the readers run against the production tables, and assert the capability split from item 2.

## Do
- Items 1–4 above. Go tests for: the accepted LQL form with and without the suffix, every near-miss suffix
  (extra pipe, different sort, trailing text, double spaces), forged compartment, unbound log group; MQL accepted form,
  foreign resourceId, unbound resourceId, other namespace/metric/aggregation/extra dimension, query-language injection
  (quotes, `}`, `||`, newline), resolution mismatch.
- TS allowlist tests (tests/providers/oci/**) for the capability split, and runner payload validation if
  `src/lib/runners/payloads.ts` derives from the tables.
- Update `docs/platform/RUNNER-PROTOCOL-OCI.md` (signal reads section) and the factory comment if needed.

## Owned paths
go/internal/oci/** , src/lib/providers/oci/allowlist.ts , src/lib/providers/oci/services.ts (only if needed) ,
src/lib/observability/sources/oci-*.ts , scripts/generate-oci-allowlist.ts , tests/observability/oci-signals.test.ts ,
tests/providers/oci/** , tests/runners/** (OCI cases only) , docs/platform/RUNNER-PROTOCOL-OCI.md .

## Verification
- `npx tsc --noEmit` (at most twice) ; `npx eslint <touched TS paths>`
- `npx vitest run --maxWorkers=1 tests/observability tests/providers/oci tests/runners tests/platform/oci-sessions.test.ts`
- Go: if your sandbox cannot run `go test` (GOCACHE writes), write the Go tests anyway and SAY they were not run —
  the orchestrator runs `go vet ./... && go test ./internal/oci/... ./internal/runner/...` and gofmt outside the sandbox.
