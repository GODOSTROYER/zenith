# PROD-MACH-04: Linux runner delivery and lifecycle

Branch `prod/mach-04-w2`. Build only: nothing below was executed except
typecheck, eslint, `gofmt`, `go build` and `go vet` (linux and host). No test was run.

## 1. What was built

Audit result first: registration (single-use token, key pinned both ways),
revocation (401 `agent_revoked`, cancel of queued/claimed work, exit 3), signed
requests, stale detection (90 s), idempotent first-result-wins settlement and key
rotation already existed. What was missing, and is now built:

| Gap | Built |
|---|---|
| Results lost on crash, restart or outage | **Durable result spool** `go/internal/agent/spool` (fsync + atomic rename + dir fsync, bounded, per-identity, quarantine for corrupt/foreign/refused) wired into `postResult`; replay at start, on reconnect and every 30 s while non-empty (`go/internal/agent/lifecycle.go`) |
| Offline/recovery invisible | Agent connection tracker (online/degraded/offline), heartbeat `lifecycle` report; control plane stores it (migration 26) and derives `connection.state` = online / recovering / offline / revoked (`src/lib/runners/lifecycle.ts`), exposed in the list API (`agentView`) and a new `Platform > Runners` page |
| Revocation only enforced while connected | Durable local revocation marker (`<stateDir>/revoked.json`): a restarted revoked agent exits 3 before polling; `register` (new identity) clears it |
| No signed release channel | `go/internal/release` (Ed25519 manifest, pinned keys, seq/expiry/downgrade rules) and `go/cmd/zenith-release` (keygen/sign/verify); `go/build.sh` builds the tool and signs manifests when the key env is set |
| No verified self-update / rollback | `go/internal/agent/update`: verify -> download -> size+sha256 vs signed manifest -> smoke test (`version`) -> staged as pending health -> restart (exit 75) -> launcher (`MaybeLaunch` in both `run` paths) execs it after re-hashing -> commit after authenticated heartbeat+poll+min stable time; automatic rollback on health deadline (exit 76), boot loop, digest mismatch or exec failure; `update status|check|rollback` CLI |
| No Linux unit for the runner | `deploy/runner/zenith-runner.service` + `INSTALL.md`; `deploy/zenithd` unit, example config and INSTALL updated |

Files (new): `go/internal/release/{release.go,release_test.go}`,
`go/cmd/zenith-release/main.go`, `go/internal/agent/spool/{spool.go,sync_unix.go,sync_windows.go,spool_test.go}`,
`go/internal/agent/update/{state.go,manager.go,launcher.go,exec_unix.go,sync_unix.go,sync_windows.go,update_test.go}`,
`go/internal/agent/{lifecycle.go,updatecmd.go,lifecycle_test.go}`,
`src/lib/runners/lifecycle.ts`, `src/lib/controlplane/db/migrations/0026_agent_lifecycle.ts`,
`src/components/platform/connection-status.tsx`, `src/app/(product)/platform/runners/page.tsx`,
`tests/runners/lifecycle.test.ts`, `deploy/runner/*`, `docs/platform/RUNNER-UPDATES.md`, this file.
Modified: `go/internal/agent/{loop,config,main,register}.go`, `go/internal/{runner,machine}/cli.go`,
`go/build.sh`, `deploy/zenithd/{zenithd.service,config.example.yaml,INSTALL.md}`,
`src/lib/runners/{ports,memory-store,service,admin}.ts`, `src/lib/runners/db/pg-store.ts`,
`src/lib/controlplane/db/repos/{runners,machines}.ts`, `src/lib/controlplane/db/migrations/index.ts`,
`src/app/(product)/platform/layout.tsx` (one nav link), `docs/platform/RUNNER-PROTOCOL.md`.

Not touched: connection admin routes (LIFE-01), local credential custody (MACH-05).

## 2. Acceptance mapping

Acceptance: "Actual Linux registration/revocation, durable results, reconnect/offline recovery, key rotation and update/rollback pass."

| Clause | Implementation | Tests |
|---|---|---|
| Linux registration | existing token registration + new `zenith-runner.service`/INSTALL; local revocation marker cleared on re-register | `go/internal/agent` existing register tests; `TestRevocationIsDurableAndStopsRestartedAgent` |
| Revocation | server: existing 401 `agent_revoked`, cancel of queued/claimed, claim excludes revoked; agent: exit 3, marker, no spool replay | `tests/runners/lifecycle.test.ts` ("is revoked after revocation"), existing `admin-routes`/`e2e-platform-store`; Go `TestRevocationIsDurableAndStopsRestartedAgent` |
| Durable results | spool Put-before-post, remove only on accept/409/refuse; first result wins; bounded; quarantine | `spool_test.go` (4 tests); `TestSpooledResultSurvivesOutageAndRestartThenReplays`, `TestSpoolIsClearedAfterAcceptanceAndAfterAlreadySettled` |
| Idempotent server acceptance of replay | existing `settleOutcome`: exact logical retry 200 without replacing evidence, divergent 409 | existing `late-effect-receipts.test.ts` ("accepts an identical signed retry..."), `results.test.ts` |
| Reconnect / offline recovery | `connTracker`, replay trigger on reconnect, heartbeat report, derived states and API/UI | `TestHeartbeatCarriesLifecycleReport`; `tests/runners/lifecycle.test.ts` (parse, store, online/recovering/offline/revoked, release attention, admin view) |
| Key rotation | unchanged, existing (`rotation_internal_test.go`, runner-key-rotation evidence) | existing |
| Signed update | `release.Verify/Decide`, pinned keys, replay/downgrade rules | `release_test.go` (round trip, wrong key, tamper, expiry, unknown fields, refusals, decide rules, versions) |
| Staged update + health check + automatic rollback | `update.Manager`, `update.Decide/Launch`, `awaitHealth` | `update_test.go` (stage, refusals: bad signature/digest/size/smoke/replay/downgrade, signed rollback release; launcher boot-loop, deadline, tamper rollback; commit; failed version not reapplied; no relaunch loop) |

## 3. Verification commands (other machine)

Go (Linux host with systemd not required):

```sh
cd go && go vet ./... && go test -race ./internal/release ./internal/agent/... ./internal/runner/... ./internal/machine/...
go test -race -count=3 ./internal/agent -run 'Spool|Heartbeat|Revocation'
GOOS=linux GOARCH=arm64 go build ./... && GOOS=linux GOARCH=amd64 go build ./...
```
Expected: all pass. Existing agent tests are unchanged in behaviour; the spool directory now appears under each test's state dir.

Local end-to-end of the channel on a Linux box (manual acceptance, no test mocks):

```sh
go/build.sh 1.0.0 && go/build.sh 1.1.0   # keep both dist copies; sign 1.1.0 with ZENITH_RELEASE_KEY_FILE/KID/BASE_URL/SEQ
# serve dist/ and the manifest over loopback http, set update.manifestUrl/publicKeys in the agent config,
# run `zenithd update check`, restart, observe: `zenithd update status` pending_health -> committed.
# Break the 1.1.0 binary (or block the control plane) and observe exit 76 / launcher rollback to 1.0.0.
```

TypeScript:

```sh
export ZENITH_TEST_PLATFORM_PG_URL=...   # for the real-Postgres store contract
npx vitest run tests/runners/lifecycle.test.ts tests/runners/store-contract.test.ts tests/runners/admin-routes.test.ts tests/runners/e2e-platform-store.test.ts tests/runners/late-effect-receipts.test.ts
npx tsc --noEmit -p . && npx eslint src/lib/runners src/components/platform/connection-status.tsx "src/app/(product)/platform/runners"
```
Expected: pass. `store-contract` and `e2e-platform-store` apply migration 26 on PGlite via `openPlatformDb`.

## 4. Known gaps and orchestrator updates

- Migration **26** `0026_agent_lifecycle` is registered in `index.ts` after 0020; versions 21-25 belong to other workers, so contiguity holds only after assembly. Run emit-sql / refresh `supabase/migrations`, `migrations.test.ts`, gate manifest as usual.
- New tables: none. Changed: two columns each on `platform.runners` and `platform.machines` (`lifecycle jsonb` bounded to 8 KiB, `lifecycle_reported_at`). Store functions changed, tenancy classification unchanged (`tenancy.test.ts` / controlplane-sql-scoping): `repos.runners.heartbeat`, `repos.machines.heartbeatMachine` (still `workspace_id`-scoped in SQL); `getRunner/listRunners/findRunnerForAuth/getMachine/listMachines/findMachineForAuth/registerRunner/registerMachine/revoke*` only select two more columns. No new workflow or gate wiring needed.
- Go test files were written but **not run** (build/vet only). `TestSpooledResultSurvivesOutageAndRestartThenReplays` depends on the 2 s initial replay delay plus up to 30 s drain on the first stop; if it flakes, raise its waits.
- The launcher execs a binary under `<stateDir>/update/releases`; a `noexec` state mount breaks updates (documented). Health is judged against the control plane, so a control-plane outage covering the whole `healthWindowSec` rolls a good release back (documented limit).
- No control-plane-initiated update or hold: deliberate (the control plane has no authority over which binary runs). Offline detection emits no new platform event type (adding one would change the event contract tests); the state is derived and shown in API/UI.
- Not verified on a real Linux/systemd host: exec(2) launcher, `Restart=on-failure` with exit 75/76, `ProtectSystem=strict` with the state dir, `noexec` behaviour. Windows `execReplace` runs the child and is for development only.
- `docs/LIMITATIONS.md`: add the health/outage limit above and "update path unverified on real systemd until the Linux acceptance run".

## 5. Suggested ledger implementationStatus

`delivery_lifecycle_built_spool_signed_update_rollback_connection_state_pending_linux_systemd_acceptance`

## 6. J5 update/hold successor, 8 October 2026

Historical pre-review delivery, committed by the orchestrator as `87986de9`.
Section 7 supersedes its pending loop/storage joins and rotation investigation.

Base `3a9de905`. Historical evidence above is retained; its statement that no
control-plane update/hold mechanism exists is superseded by this successor.
This successor is **not integrated or verified Linux acceptance**. Shared Go
loop wiring and an unassigned storage migration remain explicit joins.

### Built in the owned working tree

- `src/lib/controlplane/db/repos/agent-updates.ts`: tenant/kind/agent-scoped
  durable intent, optimistic revisions, agent-row locking for concurrent first
  writes, and transactional revocation checks. No in-memory fallback.
- `src/lib/runners/update-control.ts` and the machine/runner `update` and
  `heartbeat` route files: signed-in human admin intent, viewer reads, exact
  envelope SHA-256, strict request shape, existing signed agent authentication,
  nonce-bound 60-second EdDSA control JWS. Earlier agents keep their heartbeat
  wire shape. Writes refuse unsupported agents (409), missing storage (503)
  and revoked agents (409). The response is desired intent, not acknowledgement.
- `go/internal/runner/update/*`: local durable identity-bound hold/revision,
  fresh nonce/expiry/tenant/kind checks, replay rejection and an exact-envelope
  transport wrapped around the existing signed release updater. URLs, release
  keys and disabling updates remain local authority. Redirects are refused.
  Holds serialize with staging: an in-flight stage finishes before the hold is
  acknowledged. Holds do not disable pending health checks or rollback. A host
  owner retains the existing manual update CLI. Changed identity/corrupt control
  state refuses startup until a host operator archives the old control file.
- `deploy/zenithd/zenithd.service`: unprivileged user, empty capabilities and
  NoNewPrivileges retained; cgroup v2 CPU/memory/pids delegation and service
  resource limits. `acceptance/cgroup-check.sh` tests effective nested controller
  writes inside the actual service sandbox, including UID/capability checks.
- `deploy/zenithd/acceptance/{Dockerfile,build.sh}` and the gated Go systemd test:
  two actual versioned binaries, runtime-generated independent release/control
  keys, real systemd installation, signed registration, held published channel,
  health commit, restart, persisted trust rotation, signed downgrade followed
  by failed-health automatic rollback, revocation, owned cleanup. The HTTP
  server is explicitly a **protocol fixture**, not production control-plane
  acceptance. No cloud API, Docker, PID 1 or PostgreSQL was run here.

### Historical integration joins (fulfilled by section 7)

1. Apply `deploy/zenithd/agent-loop-integration.patch` to the shared
   `go/internal/agent/{loop,lifecycle}.go` and `agent/update/manager.go`, then
   review and run the Go agent regression lane. The patch installs the controller
   whenever local updates are enabled, reports `agent.update.control.v1`, sends
   fresh heartbeat nonces, verifies directives with persisted shared trust,
   wakes staging on a changed intent and checks context expiry before swap.
   Shared Go source was left unchanged to respect this job's path ownership.
   `git apply --check deploy/zenithd/agent-loop-integration.patch` passed here.
   A temporary copied Go tree with the patch compiled and ran targeted tests:
   70 pass events /1 failure /3 skips, including parents/subtests. The failing
   `TestRotationConcurrentReadersObservePersistenceBeforePublication` also
   failed when run alone against **unchanged worktree agent source**, and when
   run alone against the copied patch. Its final persisted/shared-key-count
   assertion at `rotation_internal_test.go:309` remains intact. No cause or
   native successor is established here; shared identity/rotation repair belongs
   to its owner. Mac/Linux must rerun it and the full agent regression before
   integrating this patch. This copied-tree result is not shipped-source proof.
   Until this join, old agents explicitly refuse remote intent and the native
   harness fails its installed-binary admission. Do not claim a shipped feature.
2. Assign a **new** platform migration; no number was assigned to this job and
   none was added. Proposed schema is in
   `tests/runners/update-control-schema.ts` as a **test fixture only**:
   `platform.agent_update_controls(workspace_id text, kind text,
   agent_id text, revision integer > 0, hold boolean, manifest_sha256 text|null,
   requested_by text, updated_at timestamptz default clock_timestamp())`.
   Composite PK `(workspace_id,kind,agent_id)`, kind runner/machine, lowercase
   64-hex digest and `hold -> digest is null` constraints. Add canonical tenant
   RLS, service-role-only access and inventory/grants/tenancy/gate registration.
   Polymorphic identity ownership and revocation are rechecked under the agent
   row lock. New store functions `getUpdateControl` and `putUpdateControl` are
   **tenant-scoped**; all control queries filter workspace/kind/id in SQL.
   No published migration or aggregate snapshot was changed.
3. Keep both joins together. The API fails closed without the schema; an agent
   without the loop marker cannot accept an update/hold even after the schema
   appears. A new agent with an old heartbeat server cannot stage without fresh
   authority, but normal authenticated health checks can still succeed.
4. Assembler: register new test files/gated native test in the canonical gate
   manifest, table inventory and sensitive-data inventory (tenant operational
   metadata; no credentials). Regenerate ledger-derived docs after integration.
   No Wave-5 execution core or installer/default composition was reimplemented.

### Acceptance mapping

| Acceptance | Implementation/test | Remaining evidence |
|---|---|---|
| Control-plane update and hold | update routes/repo, nonce-bound heartbeat JWS, Go controller; `tests/runners/update-control.test.ts`, `go/internal/runner/update/control_test.go` | Loop patch and migration integration; native end-to-end run |
| Signed artifact verification before swap | Existing release signature/size/digest/smoke rules reused, human envelope digest binding and redirect refusal | Gated installed two-version scenario |
| Automatic failed-health rollback | Existing updater/launcher; hold only gates staging; native signed downgrade failure scenario | Actual Linux PID 1 run |
| Least-privilege delegation | Unit resource/delegation properties plus actual unprivileged `ExecStartPre` canary | Real cgroup v2 controller writes and installed unit checks |
| Linux registration/revocation and key rotation | Native registered binary, request signatures/nonces, durable trust rotation and revoked exit | Actual Linux run; fixture CP is not production API proof |
| Durable results, reconnect/offline recovery | Unchanged agent/spool code and original acceptance tests listed above | Retain full original MACH-04 native/default-stack acceptance; new empty-job fixture does not establish result delivery |

### Exact Mac verification commands

Prerequisites: apply migration 54 from the assembled registry first; Node 22, local Go 1.27,
Docker with unified cgroup v2, an owned **disposable** PostgreSQL database with
all canonical migrations and service role setup. No credential or external
cloud account is required. On the 8 GB ARM64 Mac use two Go workers and a
512 MiB container; Docker's total 4 GiB profile is sufficient for this one
container. Run this separately from PostgreSQL/Temporal/kind heavy lanes.

```sh
export GOTOOLCHAIN=local GOMAXPROCS=2
export PATH="$NODE22_BIN:$PATH"                 # verifier's local Node 22 bin
node --version                               # must be v22.x
npx vitest run tests/runners/agent-update-repo.test.ts tests/runners/update-control.test.ts tests/runners/admin-routes.test.ts tests/runners/lifecycle.test.ts tests/security/sensitive-inventory.test.ts --no-file-parallelism --maxWorkers=2
export ZENITH_TEST_PLATFORM_PG_URL="$OWNED_PLATFORM_PG_URL"
npx vitest run tests/runners/update-control-postgres.test.ts --no-file-parallelism --maxWorkers=2
(cd go && go test -p 2 -count=1 ./internal/runner/update ./internal/agent/... ./internal/release ./internal/protocol)
```

Expected: API/contract tests pass; the enabled PostgreSQL test must pass (not
skip) and must find the integrated table without creating test DDL. Go unit
tests pass; the systemd test is explicitly skipped in the macOS process.
Use existing platform start/migrate procedures; this job does not modify the
installer or spin up a second default-stack composition.

```sh
export ZENITH_UPDATE_FIXTURE_OUT="$(mktemp -d /tmp/zenith-mach04.XXXXXX)"
bash deploy/zenithd/acceptance/build.sh
# Native ARM64 official base, pinned by the verifier before the build:
docker pull --platform linux/arm64 ubuntu:24.04
SYSTEMD_BASE=$(docker image inspect ubuntu:24.04 --format '{{index .RepoDigests 0}}')
docker build --platform linux/arm64 --build-arg SYSTEMD_BASE="$SYSTEMD_BASE" -t zenith-mach04-systemd -f deploy/zenithd/acceptance/Dockerfile .
fixture="zenith-mach04-$(date +%s)"
docker run -d --name "$fixture" --label zenith.fixture=mach04 --platform linux/arm64 --privileged --cgroupns=private --memory=512m --memory-swap=512m --cpus=2 --pids-limit=512 --tmpfs /run --tmpfs /run/lock --tmpfs /tmp -v "$PWD:/src:ro" -v "$ZENITH_UPDATE_FIXTURE_OUT:/fixtures:ro" zenith-mach04-systemd
docker exec "$fixture" env ZENITH_TEST_AGENT_UPDATE_SYSTEMD=1 ZENITH_AGENT_UPDATE_DISPOSABLE_SYSTEMD=1 ZENITH_AGENT_UPDATE_REPO=/src ZENITH_UPDATE_FIXTURE_OUT=/fixtures ZENITH_AGENT_UPDATE_ARCH=arm64 /fixtures/update-systemd.test -test.run '^TestSystemdSignedUpdateAndRollback$' -test.v -test.timeout=8m
result=$?
docker logs "$fixture" > "$ZENITH_UPDATE_FIXTURE_OUT/pid1.log" 2>&1
docker inspect "$fixture" > "$ZENITH_UPDATE_FIXTURE_OUT/container.json"
docker rm -f "$fixture"
test "$result" -eq 0
```

Expected: **1 native systemd test passes, 0 fail, 0 skip**. The test installs a
randomly named owned unit and cleans only its stopped unit/directories. The
container is privileged solely to supply real PID 1/cgroups on Docker Desktop;
the tested zenithd process is unprivileged with an empty capability set.
Failure to delegate controllers is a failure, not permission to run zenithd
as root. Record source-input hashes, fixture binary hashes, exact image digest,
Docker configuration and complete test output. ARM64 here is native Linux in
the Mac VM; an emulated AMD64 run is separate and is never native AMD64 evidence.
The same test binary procedure runs on a disposable native Linux VM with PID 1
systemd; use the matching arch in `ZENITH_AGENT_UPDATE_ARCH`.

### Local results and ledger boundary

See `J5-COMMANDS.md` for exact executed verification commands, failed attempts
and pass/fail/skip counts. Schema-less production APIs refuse rather than use
the PGlite fixture. Suggested/current status remains
`implementation_complete_verification_pending`; state remains `in_progress`.
That requested status does **not** imply the two joins, real database evidence,
full original lifecycle acceptance or actual systemd harness are complete.

## 7. Integrated review follow-up, 8 October 2026

Base `87986de9`. The loop patch is applied to real
`go/internal/agent/{loop,lifecycle}.go` and `agent/update/manager.go`; its `.patch`
file is deleted. Local enablement now installs the controller, advertises the
marker, generates heartbeat nonces, verifies fresh signed intent with shared
persisted trust, wakes the staging loop, and checks cancellation before swap.
`update_control_internal_test.go` exercises the real heartbeat path against the
TLS protocol fixture, including durable hold after restart and refused nonce.
This contract test does not replace real PostgreSQL or installed systemd proof.

Migration **54**, `0054_agent_update_controls.ts`, is appended to the registry.
Versions 44-53 are deliberately absent here because parallel jobs own them;
the assembler inserts them before 54. No placeholder migrations, published
migration edits or aggregate snapshots were created. The repository uses this
canonical table and reports missing storage as actionable `schema_behind`.
The test-only schema is deleted. PGlite opens through the actual migrator.

New table: `platform.agent_update_controls`, composite tenant/kind/agent key,
positive integer revision, bounded identifiers/actor, exact lowercase SHA-256,
hold/digest exclusion, RLS enabled, PUBLIC/browser-role privileges revoked,
service-role CRUD grants. It stores current intent and the human actor id.
`src/lib/sensitivedata/inventory.ts` classifies the table as personal data and
the manifest digest as digest-only, with no automatic retention/deletion claim.
The inventory discovery parser now accepts digits after the first identifier
character; previously it silently missed `manifest_sha256`. A regression case
requires discovery of that column and an exact inventory match. The original
inventory completeness assertion is unchanged.
This exposes two older digest columns too: webhook `body_sha256` and billing
`response_sha256`, now explicitly classified digest-only in the same inventory.
`getUpdateControl` and `putUpdateControl` remain **tenant-scoped** store functions.
`agent-update-repo.test.ts` checks migration ledger/checksum, idempotence,
optimistic concurrency, kinds/tenants, revocation, direct SQL constraints, RLS
and exact grants. The SQL only creates/configures this new table. The existing
compatibility classifier labels the conditional role-grant `DO` block `data`
because its body is opaque; the unchanged compatibility gate accepts it.
No contract approval or classifier bypass is added.

### Windows rotation cause and repair

The original concurrent rotation assertion at
`rotation_internal_test.go:309` is unchanged. The issue was persistence refusal,
not publication before persistence: concurrent `LoadIdentity` calls held open
the replacement target while `SaveIdentity` called `os.Rename`. This SDK's
Windows `syscall.Open` uses `FILE_SHARE_READ | FILE_SHARE_WRITE`; the SDK's
`os.Rename` ultimately calls `MoveFileEx(..., MOVEFILE_REPLACE_EXISTING)`.
The deterministic held-reader probe reproduced Windows errno **5** (Access is
denied) on this machine's temporary filesystem. A separate attempt with
`FILE_SHARE_DELETE` also reproduced errno 5 here, so that attempted fix was
discarded. All three announcement retries could lose to active readers; the
final pin-count assertion then failed even though no unpersisted key published.

`identity.go` now takes a process-wide read/write lock around identity read and
replacement. The read uses one opened handle for permissions and bytes and
closes it before releasing the lease. Replacement keeps its write lease through
file sync, atomic rename and Unix directory sync. A waiting writer blocks new
agent readers until the existing handles close. A single lock avoids path-alias
and lock-registry lifetime problems. External non-sharing handles still cause
safe persistence refusal; later announcements may retry. No deletion gap,
in-place overwrite, weaker pin assertion or trust-publication fallback is used.
Windows still has no directory/power-loss durability claim. Unix keeps atomic
replacement and directory fsync; Linux execution must be verified below.

`identity_open_windows_test.go` proves the actual sharing refusal, preservation
on failure and blocked publication until the read lease closes. Twenty repeats
of both Windows cases and the unchanged concurrent-rotation case passed:
**60 passed /0 failed /0 skipped**. Full Go agent/update/release/protocol scope
passed **119 passing leaves +5 passing parents /0 failures /3 skips**. Skips are
the existing Windows permission/symlink cases and the gated Linux systemd case.
Exact commands and all failed diagnostic attempts are in `J5-COMMANDS.md`.
PGlite repository/API attribution is **15 passing cases**, with the real
PostgreSQL case gated off. Final isolated global inventory is **13/0/0**,
with both its original assertions and 20-second timeout preserved. Typecheck
and ESLint passed after the final inventory fix; build/vet/gofmt and integrated
Linux ARM64 agent/systemd-test compilation passed. Earlier failed attempts are
retained, rather than replaced with these successor results.

### Mac/Linux commands and remaining acceptance

After assembly, use Node 22 and local Go 1.27 with two workers. The earlier
512 MiB systemd container commands remain the real two-version acceptance lane.
The patch prerequisites are fulfilled; rebuild its fixture binaries from these
integrated sources before running it. Require **1 pass /0 fail /0 skip** from
the enabled systemd test. Linux ARM64 cross-compilation here is compile evidence
only. Run original result-spool/reconnect/full-lifecycle acceptance too; the
empty-job update fixture does not establish those outcomes.

For a standalone lean PostgreSQL lane, start only this owned database, separately
from systemd/Temporal/kind/browser lanes (Mac Docker total budget 4 GiB):

```sh
export PATH="$NODE22_BIN:$PATH" GOTOOLCHAIN=local GOMAXPROCS=2
fixture="zenith-mach04-pg-$(date +%s)"
password="$(openssl rand -hex 24)" # generated disposable fixture credential
docker run -d --name "$fixture" --memory=512m --cpus=1 --pids-limit=128 -p 127.0.0.1:5440:5432 -e POSTGRES_DB=mach04 -e POSTGRES_PASSWORD="$password" postgres:17-alpine
until docker exec "$fixture" pg_isready -U postgres -d mach04; do sleep 1; done
export ZENITH_TEST_PLATFORM_PG_URL="postgres://postgres:$password@127.0.0.1:5440/mach04"
export ZENITH_PLATFORM_DB=postgres ZENITH_PLATFORM_DB_URL="$ZENITH_TEST_PLATFORM_PG_URL"
npx tsx scripts/platform/migrate.ts
npx vitest run tests/runners/update-control-postgres.test.ts --no-file-parallelism --maxWorkers=2
result=$?
docker rm -f "$fixture"
unset ZENITH_TEST_PLATFORM_PG_URL ZENITH_PLATFORM_DB ZENITH_PLATFORM_DB_URL password
test "$result" -eq 0
npx vitest run tests/runners/agent-update-repo.test.ts tests/runners/update-control.test.ts tests/security/sensitive-inventory.test.ts --no-file-parallelism --maxWorkers=2
(cd go && go test -race -p 2 -count=1 ./internal/agent/... ./internal/runner/update ./internal/release ./internal/protocol)
(cd go && go test -race -p 2 -count=20 -run '^TestRotationConcurrentReadersObservePersistenceBeforePublication$' ./internal/agent)
```

Expected: PostgreSQL **1 pass /0 fail /0 skip**, no fixture-DDL fallback;
PGlite/API/inventory pass; Mac Go cases pass with explicitly reported Linux-only
skips; focused rotation **20 pass /0 fail /0 skip**. Run the same focused and
full Go commands on native Linux (race detector/toolchain prerequisites).
The Windows-specific handle probes are build-excluded on Unix, not Linux proof.

Assembler still owns test/gate manifest and tenancy registry registration plus
assembly of migrations 44-53 and aggregate emission. No other Wave-5 seams were
reimplemented. Ledger remains `implementation_complete_verification_pending`,
state `in_progress`; real PostgreSQL, Linux systemd and original full lifecycle
acceptance were **not run here**. No verified claim or historical receipt changes.
