# WS-GO-OCI — implement the `oci.http` runner job kind in zenith-runner (Go)

Workstream: WS-GO-OCI (new; orchestrator brief) — Branch ws/go-oci — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-go-oci
Base: platform/integration @ e92a3df

## Situation
- OCI is runner-only: the control plane never holds OCI keys. The TS side is merged:
  `src/lib/providers/oci/runner-transport.ts` (`createRunnerOciTransport(dispatch, {capability})`
  serializes an unsigned `oci.http` request and decodes the response), the per-capability allowlist
  as data in `src/lib/providers/oci/allowlist.ts` (`OCI_ALLOWLIST`), and the protocol proposal
  `docs/platform/RUNNER-PROTOCOL-OCI.md` (payload, runner verification order, OCI HTTP Signatures
  via instance / resource / OKE workload principal, allowlist, sealed secret-write, results, audit).
- Nothing exists in Go: go/internal/runner/kinds has aws (awshttp.go, awsaction.go), k8shttp.go,
  probe.go, tofu*.go, and kind.go (registry).

## Objective
`oci.http` implemented in the Go runner exactly as RUNNER-PROTOCOL-OCI.md specifies, with the same
allowlist as the TS side, proven by a cross-language golden test.

## Owned paths
go/internal/oci/** (new: request signing, principals, allowlist) ; go/internal/runner/kinds/ocihttp*.go
(new) ; the registration line(s) in go/internal/runner/kinds/kind.go and the runner's local config
(oci.enabled, oci.allowedCompartments, region/tenancy labels — find where awshttp's config lives) ;
docs/platform/RUNNER-PROTOCOL-OCI.md (turn the proposal into the spec of what is implemented) ;
TS: the job-kind constant/union and `src/lib/runners/payloads.ts` schema for `oci.http` (find where
RUNNER_JOB_KINDS is defined) + NEW tests/runners/oci-*.test.ts ; a generated golden fixture of
OCI_ALLOWLIST (e.g. go/internal/oci/testdata/allowlist.json written by a small TS script under
scripts/ and checked by both a TS test and a Go test).
Do NOT edit go/internal/machine/**, go/internal/runner/kinds/probe*.go, src/lib/runners/dispatch.ts
or docs/platform/RUNNER-PROTOCOL.md (WS-MACH-ALIGN owns them). If dispatch.ts needs an `oci.http`
limits entry, write the exact one-line addition in your report.

## Build
1. Signing: OCI HTTP Signature (draft-cavage) as OCI specifies (signed headers for GET/DELETE vs
   POST/PUT incl. x-content-sha256, content-length, content-type), keyId from the principal.
   Principals: instance principal (federation via instance metadata + leaf certificate),
   resource principal (env RP v2.2 variables), OKE workload identity. Keys live only in memory.
   Unit-test the signer against OCI's published signing test vector if available (else a vector
   computed independently and documented).
2. Verification order before any network call: job signature/claims (as other kinds), capability
   in the grant, method+path match the allowlist for that capability, compartment in
   oci.allowedCompartments, region allowlist, no DELETE, forbidden headers refused, body size bound.
3. Response: status, bounded headers allowlist, bounded body; errors classified like awshttp.
4. secret.write (sealed body) stays DISABLED: refuse with a clear reason until sealing exists.
5. Tests: Go unit tests (signer, allowlist from the golden fixture, refusals, size bounds, principal
   loading with fakes, an httptest OCI endpoint), TS test that the fixture equals OCI_ALLOWLIST.

## Tools
Go 1.27.1 for Windows: `C:\Users\user\.local\sdk\go\bin\go.exe` — run from `go/` with
`$env:GOTOOLCHAIN='local'; $env:GOCACHE='C:\Users\user\AppData\Local\Temp\zenith-gocache-oci'`.
Also `gofmt -l .` (must be empty) and `go vet ./...`. WSL is not available. If Go cannot execute in
your sandbox, say so; the orchestrator runs it.

## Verification
- (in go/) go vet ./... ; go test ./internal/oci/... ./internal/runner/... ; gofmt -l .
- npx tsc --noEmit ; npx eslint src/lib/runners tests/runners scripts
- npx vitest run --maxWorkers=2 tests/runners/oci tests/providers/oci
