# WS-MACH-ALIGN — align zenithd with the machine-plane contract and wire the machine plane

Workstream: WS-MACH-ALIGN (new; written by the orchestrator)
Branch: ws/mach-align — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-mach-align
Base: platform/integration (machine plane, runner server, Go agents and execution activities all merged; tsc clean)

## Objective
Three parts built in parallel must now agree and be wired:
- TS machine plane `src/lib/machines/**` (semantic ops; `executeMachineOperation`; transports
  aws_ssm / kubernetes / zenithd / simulated). Its `src/lib/machines/results.ts`
  (`MachineResultDataSchemas`) is now THE result contract for every machine operation.
- Go zenithd `go/internal/machine/**` (+ `go/cmd/zenithd`), whose result shapes were defined
  independently in `docs/platform/ZENITHD.md`.
- TS runner server `src/lib/runners/**` (machine request queue: `enqueueMachineRequest`,
  `awaitMachineRequest`, `toMachineResult` in `src/lib/runners/dispatch.ts`).

Owned paths: go/internal/machine/** , go/internal/runner/kinds/probe*.go (Windows errno only, item 5),
docs/platform/ZENITHD.md, docs/platform/RUNNER-PROTOCOL.md (§5 + the clarifications in item 4),
src/lib/machines/** , src/lib/runners/dispatch.ts (only if the adapter needs an additive export),
src/lib/execution/capability.ts (+ its ports in src/lib/execution/ports.ts, additively),
tests/machines/** , tests/runners/** , tests/execution/** .
Another Codex job (WS-COMPOSE) owns src/lib/platform/**, workers/** and src/lib/workflows/activities/index.ts —
do not touch those; expose factories it can call and describe the one-line wiring in your report.

## Remaining
1. Contract alignment (TS wins): for EVERY operation zenithd implements, make the Go result JSON
   exactly match `MachineResultDataSchemas` (field names, types, units, optionality); args are the
   NORMALIZED ones; `since` is a relative duration like `15m`/`2d` bounded to 7d; failures carry
   `{error: <MachineFailureCode>, reason?}`; exec results carry `exitCode` and
   `output {stdout, stderr, truncated}`. Add a cross-language golden test: a JSON fixture per
   operation in `go/internal/machine/testdata/results/*.json` produced by the Go code, and a TS test
   in tests/machines/ that validates each fixture with `MachineResultDataSchemas` (and a Go test
   that regenerates/compares them). Update docs/platform/ZENITHD.md accordingly.
2. `src/lib/machines/dispatcher.ts`: `createRunnerMachineDispatcher(runtime)` implementing
   `MachineRequestDispatcher` over the runner server's machine queue (enqueue with the compact
   grant JWS → `mreq_…`; await → `MachineDispatchOutcome`; agent silence past the deadline →
   status `uncertain`, never re-dispatched). Tests with the runner store's in-memory/PGlite setup
   used in tests/runners.
3. `src/lib/machines/sessions.ts`: `createMachineSessionProvider({ credentials, grantJws })` building
   the per-transport session: aws_ssm → the broker's AwsSession (purpose observe for read-only
   operations, deploy for mutating ones, decided from the capability catalog), kubernetes →
   `KubernetesMachineSession` (KubernetesSession + the connection's `namespaces`; build it with the
   kubernetes provider's `createKubernetesSession`), zenithd → `{ grantJws }`, sandbox → undefined.
   Switch `src/lib/machines/redact.ts` to the merged `src/lib/credentials/redact.ts`
   (`redactCredentials`), keeping the tofu redactor if it adds coverage.
4. Machine capabilities in the execution activities: `executeCapability` (src/lib/execution/capability.ts)
   currently runs driver day-two operations; when the operation's capability is a machine operation
   (`machine.inspect`, `process.list`, `service.status`, `machine.service.restart`, `container.*`,
   `file.read`, `network.*`, `system.*`, `machine.exec`), resolve the target from the operation's
   resource (EC2 instance id from the observation's externalId → aws_ssm; k8s pod/namespace →
   kubernetes; a registered zenithd machine bound to the resource → zenithd) and call
   `executeMachineOperation` with the operation's grant, recording evidence; map
   `MachineOperationError` code `uncertain` to the operation's `uncertain` outcome; never retry it.
   Add the needed port to ExecutionDeps additively. Tests for each transport path with fakes.
   Also write the RUNNER-PROTOCOL.md clarifications the Go worker proposed: machine results/logs go
   to `/machines/{id}/jobs/{jti}/result|logs`; a machine grant's `cap` equals the operation; a job
   id already accepted is dropped silently; grant ids are not single-use at the runner; `tofu.run`
   `plan` accepts optional `destroy: true` (apply then needs `infrastructure.destroy`); `planJson`
   bounded separately (default 3 MiB, fail not truncate).
5. Go portability: `go test ./...` must pass on Windows too (dev convenience; Linux is the target).
   Two probe tests fail on Windows because a refused connection is classified `network_error`
   (Windows WSAECONNREFUSED / ECONNREFUSED via syscall.Errno 10061) instead of the
   refused/closed classification Linux gets: classify both. Do not weaken the tests.

## Known failures at base
- Windows only: go/internal/runner `TestE2ERegisterPollExecuteResultRevoke` and
  go/internal/runner/kinds `TestProbeTCPOpenAndClosed` (refused-port classification, item 5).

## Tools
- Go 1.27.1 for Windows: `C:\Users\user\.local\sdk\go\bin\go.exe` — run from `go/` with
  `$env:GOTOOLCHAIN='local'; $env:GOCACHE='C:\Users\user\AppData\Local\Temp\zenith-gocache'`.
  Also run `gofmt -l .` (must be empty) and `go vet ./...`. WSL is not available to you.

## Decisions already made (keep them)
- machine.exec is argv-only, never a shell string; SSM exec refuses `{{` in argv.
- zenithd file.write / file.upload / package.install stay unsupported.
- Evidence summaries never contain file contents, log lines or DNS answers.

## Verification commands
- go vet ./... ; go test ./... ; gofmt -l . (in go/, Windows Go)
- npx tsc --noEmit
- npx eslint src/lib/machines src/lib/runners src/lib/execution tests/machines tests/runners tests/execution
- npx vitest run tests/machines tests/runners tests/execution
