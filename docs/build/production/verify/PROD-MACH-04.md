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
