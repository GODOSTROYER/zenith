# PROD-CI-05 / PROD-CI-08 / PROD-CI-09: CI repair and full verification runbook

Branch `prod/compose`, base `76a0652`. Nothing below was executed as a test by the author. Only `tsc --noEmit` and `eslint` were run (both clean on the changed files), plus `go vet` of `./internal/machine/ops`. Everything under "Verification runbook" is for the verifier machine.

## 1. What was done

1. Applied both pending packets, one commit each:
   - `manifest-digest-r3/manifest-digest-correction.patch` (packet `manifest-digest-r3`)
   - `settlement-gates-partial/candidate.patch` (packet `settlement-gates-partial`; touches `ci.yml`, `gate-manifest.mjs`, `apply-supabase-migrations.sh`, `DEPLOYING.md`, `migrations.test.ts`, `tenancy.test.ts`, `platform-coverage.test.ts`, `controlplane-sql-scoping.test.ts`)
2. Rebound the two stale pins in `tests/ci/gate-manifest.test.ts` (`sourceSha256`, formerly `413e49df...`) to `87813c36bd0face890cc8e47e8aede5fc3d6fae058c13cd07f5812b449339f71`, the recomputed sha256 of the raw bytes of `tests/controlplane/cleanup-writer-barriers.test.ts`. No other pin of that file or of `src/lib/tofu/engine.ts` exists in `tests/`, `scripts/ci/` or `docs/platform/`. Recompute with `python -c "import hashlib;print(hashlib.sha256(open('tests/controlplane/cleanup-writer-barriers.test.ts','rb').read()).hexdigest())"`.
3. TypeScript fixes (CI run 37282165132 breakages):
   - `src/lib/tofu/engine.ts`: `standaloneRefusal` was an arrow constant typed `(): never`. TypeScript only treats calls as never-returning (control-flow narrowing) for function declarations or explicitly annotated names, so the existing runtime guards (`!after.stateDigest`, `plain(value)`, `typeof value.stateDigest === "string"`) did not narrow. It is now `function standaloneRefusal(): never`. The undefined/unknown cases were already refused at runtime; no cast was added and refusal behaviour is unchanged.
   - `tests/ci/platform-coverage.test.ts`: `workflow.jobs["platform-postgres"].env?.ZENITH_TEST_SAVED_PLAN_SETTLEMENT_REQUIRED` (env is optional in the local `Job` type). The implicit-any `item` on `manifest.packagePhase.requiredCases.map` came from the untyped `cases()` helper in `scripts/ci/gate-manifest.mjs`; it now has a JSDoc signature returning `{package,test,id}[]`.
   - `npx tsc --noEmit -p .` now reports zero errors.
4. Go fixture: added `go/internal/machine/testdata/results/package.install.json` (expected by `tests/machines/go-results.test.ts`) and a `package.install` subtest in `go/internal/machine/ops/results_golden_test.go`, so the fixture is compared by `TestResultGoldens` like its siblings. Args use the real `PackageInstallProfileVersion` digest of the shared `packageModelProfile` (computed by calling the real function: `50cf2fe70382255b9c0bb64503df12e03922a563c381a92a7cfde063ad74f0ec`). The result mirrors what `package_helper_linux.go` emits for a first verified install (changed/committed, `transactionRef` `pi_` + 32 hex, placeholder `aaaa...`). LIMITATION: the actual install only runs in the native Linux helper (package `machine`, root), so the golden pins the contract, not a live mutation. Regeneration command (from `go/`): `ZENITH_UPDATE_MACHINE_GOLDENS=1 GOTOOLCHAIN=local go test -count=1 ./internal/machine/ops -run '^TestResultGoldens$'`, then `git diff -- internal/machine/testdata/results` must be empty (or only formatting of this one file; commit any difference).
5. Migration inventories were verified present (supplied by the settlement packet): `apply-supabase-migrations.sh` lists `0018_platform_core.sql`; `DEPLOYING.md` has rows 15 `cleanup_writer_barriers` and 16 `cleanup_writer_settlements`; `migrations.test.ts` lists `standalone_plan_backends` and `standalone_plan_settlements`; `tenancy.test.ts` classifies `planArtifacts.readStandaloneSettlements` and `planArtifacts.finishStandalone`. `cleanupWriterBarriers.inventoryForNativeOrigin` was NOT classified; it is now in `EXEMPT` with a reason (repo-module export that takes a private opaque origin, not tenant-parameterised, not exposed through `bindRepos`). If the verifier disagrees, move it to `WRITES` or `SWEPT` as appropriate.
6. Diagnosability: `src/lib/platform/plan-artifacts.ts` (the `catch` after dispatch) still throws the identical refusal `Original plan dispatch outcome is unconfirmed; inspect this operation before another write.` Behaviour is unchanged (same condition, same message, `finish(...,false)` still runs first). It now attaches `cause = { name, code }`, each kept only if it matches `^[A-Za-z0-9_.:-]{1,64}$` (error class name and `code`, such as a Postgres SQLSTATE or `PlanArtifactError`). The message text is deliberately not carried, since it may contain secrets or SQL parameters. To diagnose the ~65 platform-postgres failures, print `error.cause` from the thrown error (for example a temporary `console.error(e.cause)` in the failing test, or inspect vitest JSON failure output). If name/code is insufficient, fix at the source of the inner throw rather than widening this surface.

## 2. Acceptance mapping

| Requirement | Implementation | Evidence to produce |
| --- | --- | --- |
| PROD-CI-05 (stale pins and gates rebound, typecheck green) | commits for both packets, pin rebind, `engine.ts` / `platform-coverage.test.ts` / `gate-manifest.mjs` typing fixes | `npm run typecheck` 0 errors; `tests/ci/gate-manifest.test.ts` and `tests/ci/platform-coverage.test.ts` pass |
| PROD-CI-08 (migration inventory and tenancy coverage for 0018, Go fixture) | inventories above, `package.install.json` fixture and golden subtest | `tests/docs/operator-docs.test.ts`, `tests/controlplane/migrations.test.ts`, `tests/controlplane/tenancy.test.ts`, `tests/machines/go-results.test.ts`, Go `TestResultGoldens` plus `git diff --exit-code` |
| PROD-CI-09 (platform-postgres failures diagnosable without weakening safety) | sanitized `cause` on the unconfirmed-dispatch refusal | `platform-postgres` lane; inspect `error.cause` for any remaining failure |

## 3. Verification runbook (other machine)

Tell the agent: it MAY fix failures it finds and commit them (identity `Arnav Bule <arnav.bule05@gmail.com>`, no Co-Authored-By trailer, no em dashes in messages), MUST NOT force-push, and MUST record evidence (commit SHA, lane, counts, CI run URL and per-job conclusions) in `docs/build/production/ledger.json`. Never retry an old accepted write blindly; never put credentials in the repository or chat.

Prerequisites: Node 22.23.3, npm lockfile, OpenTofu 1.12.5, OPA 1.19.1, Go 1.27.1 with `GOTOOLCHAIN=local`, Docker, kind and kubectl, a disposable PostgreSQL 16.15 you own, the Temporal CLI as pinned in ci.yml. Run lanes serially (one heavy Docker/DB workload at a time). Secrets go in local env only.

1. Transfer integrity (read-only): `python docs/build/production/transfer/2026-10-05/verify.py`. After the packets were applied, pending patch preimages no longer match the tree; that check concerns packet provenance, so record an expected "already applied" outcome instead of treating it as a regression.
2. Ensure a clean `git status`, then `npm ci` (use `npm ci --ignore-scripts` where ci.yml does).
3. Static: `npm run typecheck` (expect 0 errors) and `npm run lint` (or `node scripts/ci/run-gate.mjs core --run --step typecheck` / `--step lint`). Also `npx eslint src/lib/tofu/engine.ts src/lib/platform/plan-artifacts.ts tests/controlplane/cleanup-writer-barriers.test.ts tests/controlplane/tenancy.test.ts tests/ci/platform-coverage.test.ts tests/ci/gate-manifest.test.ts`.
4. CI-meta tests first (fast, no services): `npx vitest run tests/ci tests/docs/operator-docs.test.ts tests/machines/go-results.test.ts`. The migrations and tenancy tests that need Postgres are env-gated; run them in the platform lane below.
5. Scoped native100 (from the transfer README). Provide `ZENITH_TEST_PLATFORM_PG_URL` (owned PG 16.15; agent3 roles/schema first, then platform16 and Supabase18 migrations as `scripts/ci/apply-platform-migrations.sh` and `scripts/ci/apply-supabase-migrations.sh` do), then:

   ```sh
   export ZENITH_TEST_CLEANUP_WRITER_BARRIER_REQUIRED=1 ZENITH_TEST_SAVED_PLAN_SETTLEMENT_REQUIRED=1 ZENITH_TEST_TOFU_NETWORK=1
   # pinned tofu, opa and go on PATH
   npx vitest run tests/controlplane/cleanup-writer-barriers.test.ts --no-file-parallelism --maxWorkers=1 --reporter=json --outputFile=native-settlement-current.json
   ```

   Require exactly 100 identities, 0 failed, 0 skipped, 0 missing: original46 all pass and new54 all pass (last known attempt was 60 passed / 40 failed; do not assume the 40 are fixed). Genuine saved-byte apply/readback/cleanup is required. Use fresh owned operations per attempt.
6. Lanes via the canonical runner: `node scripts/ci/run-gate.mjs <lane> --run`, then `node scripts/ci/run-gate.mjs <lane> --validate .data-ci-lane/<lane>-lane.json --require-execution` (definitions in `scripts/ci/gate-manifest.mjs`, env in `.github/workflows/ci.yml`):
   - `platform-postgres`: expect 1113 required requirements including the additive 54; report at `.data-ci-lane/platform-lane.json`. The earlier ~65 failures lived here; on failure read `error.cause`.
   - `postgres` (PG80), `workflows` (workflow58), the matrix lanes `reconciliation` and `workflow-intents`, `policy`, `tofu`, and `core` steps `typecheck lint unit smoke gimbal`.
   - Guest and Go: on a real Linux host (unprivileged UID; persistent ext/xfs/btrfs root) run `ZENITH_GUEST_ATTEMPT_ID=<fresh> node scripts/ci/run-guest-file-write-gate.mjs --run`, then `--select-current`. It runs `go test -json -race -count=1 ./... -skip <package pattern>`, the package phase, `TestResultGoldens` and `git diff --exit-code -- internal/machine/testdata/results`; the new `package.install.json` must produce no diff. Also run `go vet ./...` and `go build ./...` in `go/`.
   - Go race standalone: `cd go && GOTOOLCHAIN=local CGO_ENABLED=1 go test -race -count=1 ./...` (the package-native root cases need the guest environment; use the guest gate's skip pattern elsewhere).
   - OPA: `opa check --strict policy/rego` and `opa test policy/rego` (the `policy` lane does both).
   - kind: provider, release and guest scenarios per the `docker` and `go` jobs in ci.yml with a disposable kind cluster you own.
   - worker22 / packaged workers: `node scripts/ci/packaged-worker-native.mjs --run --platform linux/amd64` (and `linux/arm64` on ARM) with `--evidence <dir>/sanitized.json`, then `--validate` and `--validate-artifact`. The 18GiB free-disk floor must not be waived.
7. Packaged workers on CI: in the previous run (37282165340) the native packaged-worker jobs failed on both architectures with sanitized output. Download artifacts `packaged-worker-amd64-37282165340-1` and `packaged-worker-arm64-37282165340-1` (`gh run download 37282165340 -n <name>`), inspect the sanitized JSON for the failing required check IDs, reproduce locally with the commands above, and fix at the cause.
8. Push `prod/compose` (no force) and inspect every job of every workflow (`ci.yml`, `packaged-workers.yml`, `agent-control.yml`) on the exact pushed commit SHA: `gh run list --commit <sha>`, then `gh run view <id> --json jobs`, and confirm each job `conclusion` is `success` (no skipped required job, nothing masked by continue-on-error). Record the SHA, run IDs and per-job conclusions in `ledger.json`. Fix failures, commit, push again, and re-inspect on the new exact commit.

## 4. Known gaps and risks

- No test was executed by the author. Likeliest first breaks: the `TestResultGoldens` byte comparison for the new fixture (key order follows Go marshaling: args struct order `profileRef,profileVersion,expectedInstalledVersion`; data keys sorted), and the `inventoryForNativeOrigin` classification choice in `tenancy.test.ts`.
- The `package.install` golden does not exercise the native root helper; native proof remains the four package-native cases in the guest lane.
- The `gate-manifest.mjs` change is a JSDoc-only annotation on `cases()`; count and hash pins (127 required cases, 1113 requirements, and so on) are unchanged by this work.
- The ~65 platform-postgres failures remain undiagnosed; this change only makes the inner error class and code visible.

## 5. Suggested ledger implementationStatus

`ci-repair-built-unverified: packets manifest-digest-r3 and settlement-gates-partial applied; pins rebound; typecheck and eslint clean; package.install golden added; sanitized cause on unconfirmed dispatch; awaiting full verification runbook and per-job CI inspection`
