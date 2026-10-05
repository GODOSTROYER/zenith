# PROD-MACH-01 verification: typed convergent service configuration

Branch `prod/mach-01`. Base 76a0652. Build only: nothing below has been executed on this machine except TypeScript typecheck, eslint on changed TS files, and `go build`/`go vet` for linux and the host.

## 1. What was built

Finding: `file.write`, `file.upload` and `package.install` already had full contracts (TS args/results/policy, zenithd handler). The remaining MACH gap named by the handoff was typed convergent service configuration. This work adds one new capability, `service.configure`, following exactly how `file.write`/`file.upload` are implemented, and reusing the existing atomic Linux file engine, durable once-only dispatch (`MachineEvidenceSink.runOnce`), grant/approval machinery and the `services.restartAllow` restart authority.

Operation contract: args `{unit, profileRef, profileVersion, expectedSha256|null}` only. The signed envelope cannot carry bytes, paths, modes, owners, unit-file edits, command lines or the convergence action; those are a local profile bound into `profileVersion` (domain `zenith.service.configure.profile/v1`, separate from write/upload).

Execution (Go): preflight refuses if the unit is not loaded (no file effect); then the shared atomic writer (`runFileMutation`, new `serviceConfigurePurpose`: temp file, fsync, exact-prior-digest, backup + durable intent, rename, directory fsync, independent postcondition); then `systemctl <reload|restart> --no-pager -- <unit>` through the existing `CmdRunner`; then a poll-count-bounded `loaded`+`active` postcondition. A byte-identical config on a dead unit is converged by restart; on an active unit nothing runs. Failure after the commit is a definite `service_failed`/`effect: committed` with retained backup and transaction refs; cancellation while an action may be in flight is `mutation_uncertain`/`effect: unknown`, never re-dispatched. No automatic rollback or privileged fallback.

Files (all under `Z:\Projects\Spawned.ai\zenith-wt\prod-mach-01`):

TypeScript
- `src/lib/machines/types.ts` (operation vocabulary), `src/lib/capabilities/catalog.ts` (high risk, autonomy 5, resource scope, mutating, not escape hatch)
- `src/lib/machines/args.ts` (strict schema; `.service` only, protected units refused), `results.ts` (success receipt + `ServiceConfigureFailureDataSchema`)
- `src/lib/machines/service.ts` (grant constraints limited to maxTimeoutSec/maxOutputBytes, 2048-byte metadata budget, receipt/precondition binding, unknown effect -> uncertain), `evidence.ts` (metadata-only summaries)
- `src/lib/machines/transports/zenithd.ts` (supported, receipt binding), `aws-ssm.ts`, `kubernetes.ts` (explicit unsupported text), `simulated.ts` (never fabricated)
- `src/lib/runners/payloads.ts` (strict admission before signing)
- `docs/platform/CAPABILITY-MATRIX.md`, `docs/platform/operations/POLICY.md`, `docs/platform/ZENITHD.md`, `deploy/zenithd/config.example.yaml`

Go (`go/internal/machine`)
- `ops/serviceconfigure.go` (config, profile version, strict args, constraints, convergence, custody separation), `ops/ops.go` (op name, `Config.ServiceConfigure`, `Supported`, injectable sleep), `ops/fileupload.go` (purpose, validation, version binding), `ops/filewrite_linux.go` (intent binds operation/profile), `ops/packageinstall.go` (isolation of helper subtree from service custody)
- `executor.go` (resource-scoped grant, constraints, 2048-byte budget, audit extras, audit-failure uncertainty), `cli.go` (`zenithd service-configure-versions`)

Tests
- TS: `tests/machines/service-configure.test.ts` (new), `tests/machines/args.test.ts`, `tests/machines/zenithd.test.ts` (updated for the new op)
- Go: `ops/serviceconfigure_test.go` (all platforms), `ops/serviceconfigure_linux_test.go` (real unprivileged filesystem + fake systemctl), `serviceconfigure_test.go` (config loading, versions CLI, signed Verify admission), `executor_test.go` and `e2e_test.go` (additions)

## 2. Acceptance mapping

"atomic changes": shared writer, `serviceconfigure_linux_test.go` TestServiceConfigureCreateReplaceNoopAndConvergence.
"safe paths/symlinks": shared guards; destination is never caller-selected; `deniedWritePath` refuses /etc, unit files, systemd dirs; TestServiceConfigureGuardsRefuseWithoutAnyServiceEffect (target-symlink, source digest), TestServiceConfigureRejectsUnsafeProfiles.
"allowlists": unit in `services.restartAllow` (load + prepare), unprotected `.service` only, exact profile ref/version; TestServiceConfigureAdmissionIsExactAndUsesExistingRestartAuthority, TestServiceConfigureDefaultsOffAndRequiresRestartAuthority, tests/machines/service-configure.test.ts (unit refusals).
"privilege separation": zenithd stays unprivileged (writer refuses euid 0), never writes unit files/`/etc`, only reaches systemd through the existing restart authority; custody (destinations, sources, backup stores, package helper subtree) is disjoint from file.write/file.upload/package.install: TestServiceConfigureCustodyIsSeparateFromFileOperations.
"backups": private 0600 `.data`/`.json` retained for replace and for failed convergence; verified by the replace and `service_failed` cases.
"postconditions": file postcondition from the writer plus `loaded`/`active` convergence; TestServiceConfigureUnitFailureAfterCommitIsDefiniteAndRetained, TestServiceConfigureSlowStartWithinBoundSettles, TestServiceConfigureCancellationDuringActionIsUncertain.
Policy/approval: catalog entry drives the existing OPA/autonomy path (risk high, autonomy 5, resource scope); signed Verify refuses a grant without a resource or with unenforceable constraints: TestServiceConfigureVerifyRequiresResourceGrantAndRefusesForeignConstraints.
Evidence/uncertainty: tests/machines/service-configure.test.ts (receipt binding, runOnce replay, no output/paths/prior hash in evidence).

## 3. Verification commands (other machine)

TypeScript (Node 22):
- `npx vitest run tests/machines/service-configure.test.ts tests/machines/args.test.ts tests/machines/zenithd.test.ts tests/machines/file-upload.test.ts tests/machines/file-write.test.ts tests/machines/service.test.ts tests/docs/capability-matrix.test.ts` expect all pass except the pre-existing assertion in `tests/machines/file-write.test.ts` line 105 (`ZENITHD_OPERATIONS` not containing `package.install`) if it already failed at base.
- `npx tsc --noEmit -p .` expect only the pre-existing errors in `src/lib/tofu/engine.ts` and `tests/ci/platform-coverage.test.ts` (neither file touched here).

Go (`cd go`, `GOTOOLCHAIN=local`):
- Any platform: `go test ./internal/machine/... -run 'ServiceConfigure|Executor|E2EMachine|MachineGrant'` (non-Linux skips the Verify admission test).
- Native Linux, unprivileged user, same fixture requirement as the file.write suite (`ZENITH_FILE_WRITE_TEST_ROOT` or a home on a supported persistent filesystem): `go test ./internal/machine/ops -run ServiceConfigure -count=1` and `go test ./internal/machine -run ServiceConfigure -count=1`. The Linux tests fail (not skip) when run as root or without a conforming fixture root, like the file.write suite.
- `go vet ./...` for linux/amd64, linux/arm64 and the host.

## 4. Known gaps

- Authentic result goldens were NOT produced: the existing convention requires real Linux filesystem execution on a provisioned fixed root. No `testdata/results/service.configure*.json` exists; do not hand-write one. If the verifier wants goldens they must be generated on Linux with `ZENITH_UPDATE_MACHINE_GOLDENS=1` using a new fixed-root fixture (not added here). `package.install.json` was deliberately not created.
- systemd privilege: `systemctl restart/reload` from the unprivileged zenithd depends on the same polkit rule `machine.service.restart` already needs (see `deploy/zenithd/INSTALL.md`). A reload on an unchanged-config unit whose earlier reload failed is not detected as unconverged (the unit stays active); recovery is a fresh approved change.
- Real systemd, real mount/ACL/crash behavior, the signed browser approval journey and hosted CI are unverified; `fakeSystemd` replaces only systemctl.
- CAPABILITY-MATRIX.md was edited by hand to match `scripts/docs/capability-matrix.ts` ordering; confirm with the docs test (`--check`) and regenerate if it differs.
- Shared files for the orchestrator: add `service.configure` test paths to `scripts/ci/gate-manifest.mjs` and the guest-file-write gate if it should gate this operation; update LIMITATIONS.md (service configuration no longer "incomplete" in design, still unverified at runtime). No DB tables or migrations were added.

## 5. Suggested ledger implementationStatus

`linux_file_write_integrated_native_slice_verified_service_configure_built_unverified_other_operations_contract_complete`
