# J5 executed verification commands, 8 October 2026

Working tree: `Z:/Projects/Spawned.ai/zenith-wt/prod6-j5-agent-update`, base
`3a9de905`. No commits, git mutations, installs, cloud calls or live engines.
Inspection used `Get-Content`, `rg`, `git status --short` and
`git log --oneline -10`; these have no test-case counts. Missing optional paths
and no-match searches were diagnostic lookup results, not acceptance failures.

Every PowerShell invocation began with:

```powershell
$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH
```

Go verification used the exact SDK executables and, after the first cache
refusal, these environment values:

```powershell
$env:GOTOOLCHAIN = 'local'
$env:GOCACHE = Join-Path $env:TEMP 'zenith-j5-go-cache'
$env:GOMAXPROCS = '2'
```

Counts do not add across reruns. Go JSON counts below include parent test
events and subtests; final owned scope is **32 passing leaves plus 2 passing
parents**, 0 failures, 1 gated systemd skip. Build/lint/compiler commands have
no test cases; their pass/fail result and diagnostics are shown explicitly.

| Executed command | Result |
|---|---|
| `node --version` | Pass: `v22.23.3` |
| `C:/Users/user/.local/sdk/go/bin/go.exe version` | Pass: `go1.27.1 windows/amd64` |
| `C:/Users/user/.local/sdk/go/bin/gofmt.exe -w internal/runner/update` (inside `go`, repeated after edits) | Every invocation passed |
| `C:/Users/user/.local/sdk/go/bin/gofmt.exe -l go/internal/runner/update` | Pass: no unformatted files |
| `C:/Users/user/.local/sdk/go/bin/go.exe test -json -count=1 -p 2 ./internal/runner/update ./internal/agent/update ./internal/release` (inside `go`, original cache) | Setup failed: protected `C:/Users/user/AppData/Local/go-build`; **0 passed /0 failed test cases /0 skipped**, command exit 1 |
| Same Go test command with task-specific `GOCACHE`, first retry | **33 passed /0 failed /0 skipped** events; exit 0 |
| Same command after adding gated systemd test | **33 passed /0 failed /1 skipped** events; exit 0 |
| Same command after expiry/redirect coverage and final formatting | **34 passed /0 failed /1 skipped** events; exit 0. Package events: runner/update 23/0/1, agent/update 6/0/0, release 5/0/0 |
| `C:/Users/user/.local/sdk/go/bin/go.exe build -p 2 ./internal/runner/update ./cmd/zenithd ./cmd/zenith-runner` (inside `go`) | Pass, exit 0 |
| `C:/Users/user/.local/sdk/go/bin/go.exe vet -p 2 ./internal/runner/update ./internal/agent/update ./internal/release ./cmd/zenithd ./cmd/zenith-runner` (inside `go`) | Pass, no diagnostics |
| `C:/Users/user/.local/sdk/go/bin/go.exe vet -p 2 ./internal/runner/update` (inside `go`, after final edits) | Pass, no diagnostics |
| `GOOS=linux GOARCH=arm64 C:/Users/user/.local/sdk/go/bin/go.exe test -p 2 -c -o $TEMP/zenith-j5-update-systemd-arm64.test ./internal/runner/update` (inside `go`) | Pass: compiled real Linux harness; **0 tests executed**, not native acceptance |
| `GOOS=linux GOARCH=arm64 C:/Users/user/.local/sdk/go/bin/go.exe vet -p 2 ./internal/runner/update` (inside `go`) | Pass, no diagnostics |
| `npx vitest run tests/runners/update-control.test.ts tests/runners/admin-routes.test.ts tests/runners/lifecycle.test.ts --no-file-parallelism --maxWorkers=2` | Initial **25 passed /9 failed /0 skipped**. New capability fixture marker violated the existing registration regex; implementation and fixture marker fixed to `agent.update.control.v1`. Existing assertions unchanged |
| `npx vitest run tests/runners/update-control.test.ts --no-file-parallelism --maxWorkers=2` | Successor **9 passed /0 failed /0 skipped** |
| `npx vitest run tests/runners/update-control.test.ts tests/runners/update-control-postgres.test.ts --no-file-parallelism --maxWorkers=2` | Both successor invocations **9 passed /0 failed /1 skipped**; PostgreSQL gate absent |
| `npx eslint src/lib/controlplane/db/repos/agent-updates.ts src/lib/runners/update-control.ts src/app/api/platform/v1/runners/[id]/update/route.ts src/app/api/platform/v1/machines/[id]/update/route.ts src/app/api/platform/v1/runners/[id]/heartbeat/route.ts src/app/api/platform/v1/machines/[id]/heartbeat/route.ts tests/runners/update-control.test.ts tests/runners/update-control-schema.ts tests/runners/update-control-postgres.test.ts` | Pass: 9 files, 0 errors, 0 warnings |
| `npx eslint src/lib/runners/update-control.ts tests/runners/update-control-postgres.test.ts` (after fixes) | Pass: 2 files, 0 errors, 0 warnings |
| `NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit -p .` | First attempt failed with **3 diagnostics**: unsupported agent error-code literals; fixed using existing `invalid_request` and `runner_plane_unconfigured` |
| Same typecheck after fixes | Pass, exit 0, 0 diagnostics |
| `git apply --check deploy/zenithd/agent-loop-integration.patch` (repeated) | Passed each invocation; **patch was not applied to shared worktree source** |
| `git diff --check` (repeated) | Passed each invocation |
| `C:/Program Files/Git/bin/bash.exe -c 'export PATH="/c/Users/user/.local/sdk/node22:$PATH"; bash -n deploy/zenithd/acceptance/build.sh deploy/zenithd/acceptance/cgroup-check.sh'` (repeated) | Passed each invocation; shell syntax only, no systemd execution |
| Node JSON parse/status check of MACH-04 ledger row | Pass: `in_progress`, `implementation_complete_verification_pending`, 4 new test paths; evidence unchanged |

The small loop patch was generated from copies of the exact base files using
`node $TEMP/zenith-j5-integration-patch.cjs` and `git diff --no-index
--src-prefix=a/ --dst-prefix=b/ before after` in the owned temporary directory.
Git's no-index exit 1 means a patch exists; this is not a failed test. Shared
worktree `go/internal/agent` files remained unchanged.

The patch was applied to **temporary copies only** for these additional checks:

| Executed command | Result |
|---|---|
| `C:/Users/user/.local/sdk/go/bin/go.exe test -json -count=1 -p 2 ./internal/agent ./internal/runner/update` in `$TEMP/zenith-j5-integration-review/shadow-go` | **70 passed /1 failed /3 skipped** events; agent 47/1/2, controller 23/0/1. Failure: concurrent trust-rotation final key-count assertion |
| `C:/Users/user/.local/sdk/go/bin/go.exe test -p 2 -count=1 -run '^TestRotationConcurrentReadersObservePersistenceBeforePublication$' ./internal/agent` in the original worktree `go` | **0 passed /1 failed /0 skipped**; same unchanged assertion at line 309 |
| Same focused command in temporary patched `shadow-go` | **0 passed /1 failed /0 skipped**; same assertion |

The shared rotation failure is retained for its owner and Mac/Linux verifier;
it was not skipped, weakened or fixed outside scope. The patch's copied-tree
check is not evidence of a shipped integration. Full Go agent regression is
still required after that repair/integration.

Not run: real PostgreSQL (needs the assigned migration and owned PostgreSQL),
Linux PID 1/systemd/cgroup acceptance (needs disposable Linux VM/container),
Docker, Temporal, kind, browser and live clouds. Exact Mac commands and expected
native result are in `PROD-MACH-04.md`. No test expectation was changed to weaken
an assertion. No published migration or aggregate SQL snapshot was edited.

Suggested commit: `feat(runners): add signed update intent and systemd rollback harness`

## Files changed or added (26)

```text
deploy/zenithd/INSTALL.md
deploy/zenithd/config.example.yaml
deploy/zenithd/zenithd.service
deploy/zenithd/acceptance/Dockerfile
deploy/zenithd/acceptance/build.sh
deploy/zenithd/acceptance/cgroup-check.sh
deploy/zenithd/agent-loop-integration.patch
docs/build/production/ledger.json
docs/build/production/verify/PROD-MACH-04.md
docs/build/production/verify/J5-COMMANDS.md
go/internal/runner/update/control.go
go/internal/runner/update/control_test.go
go/internal/runner/update/sync_unix.go
go/internal/runner/update/sync_windows.go
go/internal/runner/update/systemd_linux_test.go
go/internal/runner/update/systemd_other_test.go
go/internal/runner/update/systemd_test.go
src/app/api/platform/v1/machines/[id]/heartbeat/route.ts
src/app/api/platform/v1/machines/[id]/update/route.ts
src/app/api/platform/v1/runners/[id]/heartbeat/route.ts
src/app/api/platform/v1/runners/[id]/update/route.ts
src/lib/controlplane/db/repos/agent-updates.ts
src/lib/runners/update-control.ts
tests/runners/update-control-postgres.test.ts
tests/runners/update-control-schema.ts
tests/runners/update-control.test.ts
```
