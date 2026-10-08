# W5-ASSEMBLY builder results

Working tree `prod/compose`, base `443bfeaf`. No commit, merge, checkout, push, install, real cloud request or real credential use. Node 22 PATH prefix applies to every PowerShell command:

```powershell
$env:PATH='C:\Users\user\.local\sdk\node22;' + $env:PATH
```

Counts below are Vitest JSON counters, in passed / failed / skipped order. Counts overlap across retries. A collection or beforeAll error is additionally stated even when Vitest reports zero failed cases. Skipped native cases and cases not reached after setup errors never establish acceptance. The source fixes preserve all original gates and assertions; stale expectations are explained below.

## Initial runs and correction retries

| Run | Passed | Failed | Skipped | Exit | File/setup errors |
| --- | ---: | ---: | ---: | ---: | --- |
| Schema initial | 47 | 13 | 11 | 1 | 0 |
| Schema retry | 58 | 2 | 11 | 1 | 0 |
| Gate initial | 418 | 51 | 2 | 1 | 0 |
| Wave 5 branch inventory | 1289 | 43 | 65 | 1 | 2 |
| Root regression retry | 237 | 14 | 0 | 1 | 1 |
| Root regression retry 2 | 71 | 1 | 1 | 1 | 2 |
| Managed regression retry | 179 | 2 | 5 | 1 | 0 |
| SBOM collection diagnostic | 0 | 0 | 0 | 1 | 1 |
| Gate and SBOM retry | 293 | 4 | 1 | 1 | 0 |

Exact commands (temporary JSON paths were local diagnostic receipts and are removed after this summary):

### Schema initial

```powershell
npx vitest run tests/controlplane/wave5-compat.test.ts tests/controlplane/migration-compat.test.ts tests/controlplane/migrations.test.ts tests/security/sensitive-inventory.test.ts --no-file-parallelism --maxWorkers=2 --reporter=json --outputFile=.w5-schema-results.json
```

### Schema retry

```powershell
npx vitest run tests/controlplane/wave5-compat.test.ts tests/controlplane/migration-compat.test.ts tests/controlplane/migrations.test.ts tests/security/sensitive-inventory.test.ts --no-file-parallelism --maxWorkers=2 --reporter=default --reporter=json --outputFile=.w5-schema-results-2.json
```

### Gate initial

```powershell
npx vitest run tests/ci/gate-manifest.test.ts tests/ci/platform-coverage.test.ts tests/ci/release-gates.test.ts tests/controlplane/tenancy.test.ts --no-file-parallelism --maxWorkers=2 --reporter=default --reporter=json --outputFile=.w5-gates-results.json
```

### Wave 5 branch inventory

```powershell
$wave5Files = Get-Content .w5-target-tests.txt
npx vitest run @wave5Files --no-file-parallelism --maxWorkers=2 --reporter=default --reporter=json --outputFile=.w5-branches-results.json
```

Exact contents of `.w5-target-tests.txt`:

```text
tests/acceptance/mixed-connectivity-probe.test.ts
tests/acceptance/mixed-failure-scenarios.test.ts
tests/acceptance/mixed-live-recovery.test.ts
tests/acceptance/mixed-live-run.test.ts
tests/acceptance/mixed-traffic.test.ts
tests/adversarial/approvals-forgery.test.ts
tests/adversarial/build-exfiltration.test.ts
tests/adversarial/cross-tenant.test.ts
tests/adversarial/integration-compromise.test.ts
tests/adversarial/malicious-archives.test.ts
tests/adversarial/prompt-injection.test.ts
tests/adversarial/residual-hardening.test.ts
tests/adversarial/role-escalation.test.ts
tests/adversarial/ssrf-rebinding.test.ts
tests/adversarial/token-forgery.test.ts
tests/audit-export/audit-export.test.ts
tests/audit-export/purpose.test.ts
tests/billing/billing-routes.test.ts
tests/billing/billing-unit.test.ts
tests/billing/billing.engine.test.ts
tests/ci/release-workflow.test.ts
tests/ci/vulnerability-triage.test.ts
tests/connections/zenith-connection.test.ts
tests/controlplane/mixed-follow-up.test.ts
tests/controlplane/recovery-epoch.test.ts
tests/execution/mixed-orchestration-signals.test.ts
tests/execution/mixed/connectivity.test.ts
tests/execution/mixed/economics.test.ts
tests/execution/mixed/output-reader.test.ts
tests/execution/mixed/typed-delivery.test.ts
tests/execution/mixed/typed-inputs-activities.test.ts
tests/execution/mixed/typed-substitution.test.ts
tests/execution/tenant-isolation.test.ts
tests/execution/zenith-destroy-databases.test.ts
tests/execution/zenith-graph-problems.test.ts
tests/execution/zenith-managed-journey.test.ts
tests/execution/zenith-semantics.test.ts
tests/isolation/isolation-profile.test.ts
tests/isolation/managed-onboarding-readiness.test.ts
tests/isolation/tenant-isolation-acceptance.test.ts
tests/live/mixed-connectivity.live.test.ts
tests/managed-serving/catalog.test.ts
tests/managed-serving/domain-routes.test.ts
tests/managed-serving/domain-store.test.ts
tests/managed-serving/domains.test.ts
tests/managed-serving/integration-readiness.test.ts
tests/managed-serving/services-route.test.ts
tests/managed-serving/serving-contract.test.ts
tests/managed-serving/serving-kind.test.ts
tests/managed-serving/serving-render.test.ts
tests/managed-serving/storage-emulator.test.ts
tests/managed-serving/storage.test.ts
tests/ops/recovery-manifest.test.ts
tests/ops/recovery-rehearsal.test.ts
tests/platform/managed-reconcile.test.ts
tests/platform/recovery-service.test.ts
tests/platform/zenith-build.test.ts
tests/platform/zenith-managed-composition.test.ts
tests/platform/zenith-onboarding.test.ts
tests/providers/zenith/isolation-bundle.test.ts
tests/providers/zenith/managed-kind.test.ts
tests/providers/zenith/managed-profile.test.ts
tests/providers/zenith/managed-substrate.test.ts
tests/release/acceptance-scenarios.test.ts
tests/release/checkpoint.test.ts
tests/release/dossier.test.ts
tests/release/live-scope-coverage.test.ts
tests/release/orchestrator.test.ts
tests/release/scope.test.ts
tests/retention/admin-routes.test.ts
tests/retention/key-purpose.test.ts
tests/retention/restore-destination.test.ts
tests/retention/retention.test.ts
tests/slo/definitions.test.ts
tests/slo/restore-sink.test.ts
tests/slo/sli-budget.test.ts
tests/slo/slo-artifacts.test.ts
tests/slo/slo.engine.test.ts
tests/supply-chain/release.test.ts
tests/supply-chain/sbom.test.ts
tests/tofu/typed-inputs.test.ts
tests/tofu/typed-substitution.test.ts
```

### Root regression retry

```powershell
npx vitest run tests/adversarial/cross-tenant.test.ts tests/adversarial/malicious-archives.test.ts tests/adversarial/ssrf-rebinding.test.ts tests/supply-chain/sbom.test.ts tests/release/dossier.test.ts tests/release/live-scope-coverage.test.ts tests/retention/retention.test.ts tests/retention/key-purpose.test.ts tests/slo/slo.engine.test.ts tests/slo/definitions.test.ts tests/controlplane/mixed-follow-up.test.ts tests/execution/mixed/typed-inputs-activities.test.ts --no-file-parallelism --maxWorkers=2 --reporter=default --reporter=json --outputFile=.w5-root-retry.json
```

### Root regression retry 2

```powershell
npx vitest run tests/supply-chain/sbom.test.ts tests/controlplane/mixed-follow-up.test.ts tests/adversarial/cross-tenant.test.ts tests/execution/mixed/typed-inputs-activities.test.ts tests/billing/billing-unit.test.ts tests/platform/critical-jobs.test.ts --no-file-parallelism --maxWorkers=2 --reporter=default --reporter=json --outputFile=.w5-root-retry-2.json
```

### Managed regression retry

```powershell
npx vitest run tests/managed-serving/domain-routes.test.ts tests/adversarial/residual-hardening.test.ts tests/managed-serving/services-route.test.ts tests/managed-serving/domain-store.test.ts tests/managed-serving/serving-contract.test.ts tests/managed-serving/serving-render.test.ts tests/managed-serving/storage-emulator.test.ts tests/execution/tenant-isolation.test.ts tests/execution/zenith-managed-journey.test.ts tests/execution/zenith-destroy-databases.test.ts tests/execution/zenith-graph-problems.test.ts tests/platform/zenith-build.test.ts tests/providers/zenith/managed-profile.test.ts --no-file-parallelism --maxWorkers=2 --reporter=default --reporter=json --outputFile=.w5-managed-retry.json
```

### SBOM collection diagnostic

```powershell
$env:VITEST_DEBUG_DUMP='.w5-vitest-dump'
npx vitest run tests/supply-chain/sbom.test.ts --no-file-parallelism --maxWorkers=2 --reporter=default --reporter=json --outputFile=.w5-sbom-retry.json
```

### Gate and SBOM retry

```powershell
npx vitest run tests/supply-chain/sbom.test.ts tests/ci/gate-manifest.test.ts --no-file-parallelism --maxWorkers=2 --reporter=default --reporter=json --outputFile=.w5-gate-retry.json
```

## Why failed attempts changed

- Renumbered schemas, exact contract approvals, migration fixture writer-drain admission, aggregate/table inventories and gate cohort pins were reconciled with verifier guards. Contract refusal messages now include the migration name as the existing historical refusal assertion requires.
- The domain/storage vault suffix remains 1..300 characters; PostgreSQL cannot compile the original 300-count regex bound. Character length plus an unbounded safe-alphabet regex preserves both boundaries. Retention preview no longer passes an unused, untyped SQL parameter. Tenant-leading restore indexing is explicit.
- The SBOM recognizes six lockfile bundled entries through their genuine enclosing package's SHA-512 custody. No child hash is fabricated; absent/unrelated/mismatched parent proofs refuse. Its shebang stays LF so Vitest's SSR transform recognizes it. Dossier formatting supports structured ledger results.
- PGlite setup/case timeouts remain unchanged. They account for the sensitive-inventory source sweep, critical runner reaper, domain claim, cross-tenant setup and three gate stress cases in intermediate runs. The report validator now indexes normalized file evidence once instead of repeatedly resolving all file paths; duplicate, malformed, unsuccessful and missing-case checks remain identical.

## Explicit stale-expectation and fixture corrections

1. Mixed parent planning must declare connectivity. Passing parent fixtures now provide reviewed connectivity; missing connectivity has a refusal assertion and persists no plan. Mixed follow-up fixtures use globally distinct environment IDs because the verifier enforces environment ownership across workspaces.
2. A released literal manifest image retains its reviewed digest. The passing managed journey uses that digest; a new separate changed-image test asserts configuration drift. Destroy policy fixtures use actual V2 `policies.deletion` instead of ignored resource configuration.
3. Managed first deploy cannot use shared platform privileges. The old shared-credential success became a refusal with zero credential reads. Missing credentials, wrong namespace RBAC, absent isolation, stale operator expiry and dry-run outages remain refusals. Undefined fixture arguments selected defaults; missing-policy tests now explicitly pass null.
4. Deployment SSA bodies omit replicas because HPA owns them. Submitted-body assertions retain that requirement while the fake API's live default of one is separately asserted. Emulator setup now occurs inside its unchanged gated beforeAll.
5. Referenced Zenith platform DNS zones use their implemented wildcard classification; no tenant DNS provisioning or foreign-reference guard is removed. Managed object stores use the dedicated provider port in graph executability; actual plans still refuse absent admin configuration or scoped IAM/vault runtime ports before writes/evidence.
6. File-authority route fixtures carry actual loopback Host, matching NextRequest normalization. The default settings getter's empty fallback echoes caller input by design; only that proven fallback is checked and excluded from foreign-data canary scans. Loaded foreign records remain tested. The finite contract burst budget avoids treating legitimate 429 throttling as a lookup oracle; separate admission tests retain default limits.
7. The pre-existing source analyzer refuses a decompression bomb immediately. The adversarial expectation now asserts that hard refusal instead of an unavailable truncated analysis result. Archive case/Unicode/path ancestry and hidden NUL-tail refusals were strengthened.
8. A moved nonsecret typed input is the verifier's `plan_changed` refusal. The negative test asserts that code and zero started apply effects; the engine's pre-dispatch verification call itself is not an applied effect.
9. Sticky IAM fixtures list every principal's actual pending keys. A prior scoped-key case leaves another pending row; treating it as absent falsely allowed revocation. Zero-revoked/blocked assertions are unchanged.
10. SBOM component-inventory identity excludes the root release version, preserving its existing reproducibility assertion. Bundled children are accepted only through genuine hashed-parent evidence. Sensitive-store negative tests assert the actual `secret_material` refusal code.
11. Aggregate inventory, migration versions, runtime bearer paths, introduced requirements and operator source pins now describe the assembled tree. Historical identities and minimum gate counts are retained or increased. A Wave 5 inventory assertion uses canonical literal OpenTofu requirements because that executable command selects directories.

## Remaining acceptance and deviations

Real PostgreSQL, Temporal, Docker/kind, enforcing IAM, CNI/node isolation and real browsers were not run; this PC is build/contract only. Exact owned-service commands are in [W5-ASSEMBLY.md](W5-ASSEMBLY.md) and [W5-ASSEMBLY-ONBOARDING.md](W5-ASSEMBLY-ONBOARDING.md). Live cloud acceptance remains explicitly deferred. Image/Cilium checksum verification, protected release signing key and permission budget approval belong to the later verifier/person.

The approved exception for managed first deploy is documented: automatic namespace/isolation provisioning lacks DUR-B reviewed semantics and DUR-C credential custody; default deploy refuses absent independently prepared isolation. Default builds also refuse until tenant build custody/node isolation exists. Gateway route readback compares rendered rules, filters, paths and backends in addition to attachment, hostnames and readiness. Only declared HPA-owned replicas are excluded from Deployment configuration drift; other native checks remain. Managed tier selection remains operator-configured rather than linked to billing assignments.

The requested Lambda fixture switch is not safe yet: the experimental resource driver does not supply a runnable manifest function kind, source/artifact binding or authenticated invocation/endpoint adapter. The labelled container fixture remains. Restore SLO samples measure actual database restore completion, not application-health completion. Legacy archives need their explicit original restore key after purpose separation.

All Wave 5 ledger entries remain in_progress / implementation_complete_verification_pending; four release flags remain false. The historical shared-build kind harness is retained and documented as blocked by the stronger default guard. No native/live success is claimed and no failing assertion or gate was deleted.

## Final correction receipts

| Run | Passed | Failed | Skipped | Exit |
|---|---:|---:|---:|---:|
| Schema and tenancy successor | 101 | 1 | 13 | 1 |
| Complete gate successor 1 | 458 | 8 | 0 | 1 |
| Complete gate successor 2 | 466 | 1 | 0 | 1 |
| Affected existing regressions | 368 | 9 | 1 | 1 |
| Final regression successor | 451 | 1 | 0 | 1 |
| Gate deletion targeted successor | 1 | 0 | 282 | 0 |
| Final managed reconciliation/drivers | 122 | 0 | 0 | 0 |
| Final recovery report controls | 27 | 0 | 0 | 0 |

The 282 skips in the deletion successor are cases excluded by the explicit name filter. They passed in the previous full 283-case gate run, which had only this deletion timeout. These are selection skips, not native acceptance skips. The final source-deletion test retains each deletion assertion, recreating the complete source state by restoring exact bytes between deletions; it does not repeatedly copy unrelated fixtures. Exact-title evidence is indexed without losing duplicate/nonpassing siblings. The network-source sweep uses AST parsing for literal or escaped tokens and includes escaped-bracket coverage.

The final regression's sole failure was the incomplete-ingress observation; the subsequent 86-driver/36-reconcile run passes all 122 cases after the source fix. The schema successor's sole failure was cold reaper import compilation; the later complete 12-case critical-job file passes after loading its real modules during setup. No timeout was enlarged. All native setup remains gated.

The first offline Go build-info attempt failed because the default Go cache was outside writable roots. A direct diagnostic build failed with the same access error. Moving GOCACHE into this job's temporary directory and keeping GOPROXY=off resolved it; the direct build then passed, and all 15 SBOM cases including real Go build info passed in the final regression. No download/install was needed.

Exact final commands:

### Schema and tenancy successor

```powershell
npx vitest run tests/controlplane/wave5-compat.test.ts tests/controlplane/migration-compat.test.ts tests/controlplane/migrations.test.ts tests/security/sensitive-inventory.test.ts tests/controlplane/tenancy.test.ts tests/managed-serving/domain-store.test.ts tests/adversarial/cross-tenant.test.ts tests/platform/critical-jobs.test.ts --no-file-parallelism --maxWorkers=2 --reporter=default --reporter=json --outputFile=.w5-schema-final.json
```

### Complete gate successor 1

```powershell
npx vitest run tests/ci/gate-manifest.test.ts tests/ci/platform-coverage.test.ts tests/ci/release-gates.test.ts --no-file-parallelism --maxWorkers=2 --reporter=default --reporter=json --outputFile=.w5-gates-final.json
```

### Complete gate successor 2

```powershell
npx vitest run tests/ci/gate-manifest.test.ts tests/ci/platform-coverage.test.ts tests/ci/release-gates.test.ts --no-file-parallelism --maxWorkers=2 --reporter=default --reporter=json --outputFile=.w5-gates-successor.json
```

### Affected existing regressions

```powershell
$env:ZENITH_TEST_GO='C:/Users/user/.local/sdk/go/bin/go.exe'
$env:GOTOOLCHAIN='local'
$env:GOPROXY='off'
npx vitest run tests/supply-chain/sbom.test.ts tests/keycustody/registry.test.ts tests/ops/admission.test.ts tests/middleware/platform-bearer.test.ts tests/platform/source-bundle.test.ts tests/controlplane/mixed-parent-plans.test.ts tests/docs/operator-docs.test.ts tests/reconcile/platform.test.ts --no-file-parallelism --maxWorkers=2 --reporter=default --reporter=json --outputFile=.w5-affected-regression.json
```

### Final regression successor

```powershell
$env:ZENITH_TEST_GO='C:/Users/user/.local/sdk/go/bin/go.exe'
$env:GOTOOLCHAIN='local'
$env:GOPROXY='off'
$env:GOCACHE='C:/Users/user/AppData/Local/Temp/zenith-w5-go-cache'
$env:GOFLAGS='-p=2'
$env:GOMAXPROCS='2'
npx vitest run tests/providers/zenith/drivers.test.ts tests/execution/zenith-managed-journey.test.ts tests/execution/zenith-graph-problems.test.ts tests/managed-serving/serving-contract.test.ts tests/platform/critical-jobs.test.ts tests/controlplane/mixed-parent-plans.test.ts tests/docs/operator-docs.test.ts tests/middleware/platform-bearer.test.ts tests/supply-chain/sbom.test.ts tests/ci/assert-lane-report.test.ts tests/ci/lane-report.test.ts --no-file-parallelism --maxWorkers=2 --reporter=default --reporter=json --outputFile=.w5-final-regression.json
```

### Gate deletion targeted successor

```powershell
npx vitest run tests/ci/gate-manifest.test.ts --testNamePattern 'exposes deleted discovery sources' --no-file-parallelism --maxWorkers=2 --reporter=default --reporter=json --outputFile=.w5-gate-deletion-retry.json
```

### Final managed reconciliation/drivers

```powershell
npx vitest run tests/providers/zenith/drivers.test.ts tests/platform/managed-reconcile.test.ts --no-file-parallelism --maxWorkers=2 --reporter=default --reporter=json --outputFile=.w5-managed-final.json
```

### Final recovery report controls

```powershell
npx vitest run tests/ci/lane-report.test.ts --no-file-parallelism --maxWorkers=2 --reporter=default --reporter=json --outputFile=.w5-recovery-report-final.json
```

## Compiler, lint, generation and other checks

No Vitest cases apply to these commands: each exit is one command check, not a test-count claim. Read-only git/rg/Get-Content/filesystem/clock/process inspections are diagnostics, not test acceptance. A Windows process-command-line inspection was denied; no process was changed.

| Exact command | Runs and result |
|---|---|
| `$env:NODE_OPTIONS='--max-old-space-size=8192'; bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh` | First exit1, two TypeScript diagnostics; second and final exits0, zero diagnostics. Final rerun follows the incomplete-ingress source fix. All runs use the serialization lock. |
| `npx eslint @lintFiles` | Three whole-changed-file selections, exit0 each, 0 errors / 0 warnings. Final selection: 102 TS/TSX/MJS files, excludes temporary `.w5-*` diagnostics. |
| `npx eslint src/lib/providers/zenith/drivers/network/http-route.ts tests/ci/lane-report.test.ts` | Final files changed after the 102-file selection: exit0, 0 errors / 0 warnings. |
| `npx tsx scripts/platform/emit-sql.ts` | Emitted final0026 three times after hash/index/bound fixes, exit0; initial path mistakenly targeted0025 and was immediately restored from3a9de905. Net published diff is empty. |
| `npx tsx scripts/platform/emit-sql.ts --check` | All recorded checks exit0; final0026 up to date. |
| `node scripts/build/production-ledger.mjs` | Regenerated requirement report, exit0. |
| `node scripts/build/production-ledger.mjs --check` | All checks exit0, all78 criteria and release flags retained. |
| `npx tsx scripts/docs/capability-matrix.ts --check` | All checks exit0, matrix up to date. |
| `npx tsx scripts/docs/offered-catalog.ts --check` | All checks exit0, catalog v1-3e05c4662ac4 up to date. |
| `node scripts/ci/lockfile-integrity.mjs` | All checks exit0: 915 own SHA-512 entries and 6 genuine bundled-parent entries. |
| `bash -n scripts/ci/apply-supabase-migrations.sh` | Exit0. |
| `bash -n scripts/k8s/managed-substrate-acceptance.sh` | Exit0, shell syntax only. |
| `node --check scripts/supply-chain/sbom.mjs` | Exit0. |
| `node --check scripts/ci/lane-report.mjs` | Exit0. |
| `node --check tests/ci/assert-lane-report.mjs` | Exit0. |
| `git diff --check` | Exit0, no whitespace errors. |
| `git diff --exit-code 3a9de905 -- <published source/aggregate list below>` | Exit0, published1..43 and0016..0025 unchanged. |
| `git diff --exit-code -- package.json package-lock.json go src/lib/execution/direct-kubernetes.ts` | Exit0, no changes to packages/Go/native Kubernetes. |
| `git branch --show-current` / `git rev-parse HEAD` | Exit0: prod/compose,443bfeaf537dd5d5324d33c84fc544ede0baa632. |
| `node --version` | Exit0,v22.23.3. |
| `& 'C:/Users/user/.local/sdk/go/bin/go.exe' version` with GOTOOLCHAIN=local | Exit0,go1.27.1 windows/amd64. |

Final changed-file selection:

```powershell
$lintFiles = @((git diff --name-only --diff-filter=ACMR); (git ls-files --others --exclude-standard)) | Where-Object { $_ -match '\.(ts|tsx|mjs)$' -and $_ -notmatch '^\.w5-' } | Sort-Object -Unique
npx eslint @lintFiles
```

Published source/aggregate selection:

```powershell
$publishedFiles = @(git ls-tree -r --name-only 3a9de905 -- src/lib/controlplane/db/migrations supabase/migrations) | Where-Object { $_ -match 'src/lib/controlplane/db/migrations/(00(?:0[1-9]|[12][0-9]|3[0-9]|4[0-3]))_' -or $_ -match 'supabase/migrations/00(?:1[6-9]|2[0-5])_' }
git -c core.safecrlf=false diff --exit-code 3a9de905 -- @publishedFiles
```

Direct Go diagnostics, working directory `go`, GOTOOLCHAIN=local and GOPROXY=off:

```powershell
& 'C:/Users/user/.local/sdk/go/bin/go.exe' build -o 'C:/Users/user/AppData/Local/Temp/zenith-w5-release.exe' ./cmd/zenith-release
# Exit1: default build-cache directory not writable.
$env:GOCACHE='C:/Users/user/AppData/Local/Temp/zenith-w5-go-cache'
$env:GOMAXPROCS='2'
& 'C:/Users/user/.local/sdk/go/bin/go.exe' build -p 2 -o 'C:/Users/user/AppData/Local/Temp/zenith-w5-release.exe' ./cmd/zenith-release
# Exit0. No Go source changed, so additional vet/gofmt are not applicable.
```

SBOM parser diagnostics used esbuild TS and Vite SSR transforms into local `.w5-sbom-*` files. Plain import and esbuild parse passed; two SSR `node --check .w5-sbom-ssr.mjs` attempts failed on the CRLF hashbang, then the LF-preserving transform/check passed. A direct real-lockfile buildSbom/validateSbom invocation returned921 components and0 issues. Those diagnostics are superseded by the15/0/0 file test and were never native release evidence.

Managed-joiner repair lint commands, every invocation exit0 with0 errors/0 warnings:

```text
npx eslint tests/execution/tenant-isolation.test.ts tests/platform/zenith-build.test.ts tests/execution/zenith-managed-journey.test.ts src/lib/managed-serving/storage.ts
npx eslint src/lib/controlplane/db/migrations/0050_managed_serving.ts src/lib/providers/zenith/render.ts tests/execution/zenith-destroy-databases.test.ts tests/execution/zenith-graph-problems.test.ts tests/managed-serving/serving-contract.test.ts tests/managed-serving/storage-emulator.test.ts tests/managed-serving/services-route.test.ts
npx eslint tests/managed-serving/domain-store.test.ts
npx eslint src/lib/execution/graph.ts tests/execution/zenith-graph-problems.test.ts tests/execution/zenith-managed-journey.test.ts
npx eslint src/lib/providers/zenith/drivers/kubernetes/wrap.ts src/lib/providers/zenith/drivers/network/http-route.ts tests/providers/zenith/drivers.test.ts
```

Domain-store lint ran twice. Historical pre-repair joiner tests (8/0/0 onboarding,89/0/0 reconcile,0/0/26 domain setup failure,10/0/16 isolation setup failure) remain in W5-MAN-JOINS; its original exact invocation text was not retained by the joiner and is not reconstructed as executed evidence. Current root commands above validate their final files. No heavy agent checks ran concurrently with root's final checks.

Additional stale source-pin corrections: operator claims now require both `azure, managed` release composition and the managed reconcile argument, preserving the Azure/native guards while asserting the union. The bearer inventory increased100 to110 exported methods. Restore/supply-chain/mixed-recovery guides gained their missing source pins/index links. Three ZENITH-prefixed symbols are explicitly classified as constants, and ten actual managed variables are documented. No missing real variable is exempted.

## Latest result for each Wave 5 acceptance file

All83 files observed. **1367 passed /0 failed /68 skipped** across the latest complete file results. This combines independent scoped commands and is not one whole-suite or native acceptance run. Subsequent runtime/source changes were covered by their focused regressions.

| File | Passed | Failed | Skipped | Receipt |
|---|---:|---:|---:|---|
| `tests/acceptance/mixed-connectivity-probe.test.ts` | 13 | 0 | 0 | `.w5-branches-results.json` |
| `tests/acceptance/mixed-failure-scenarios.test.ts` | 9 | 0 | 0 | `.w5-branches-results.json` |
| `tests/acceptance/mixed-live-recovery.test.ts` | 12 | 0 | 0 | `.w5-branches-results.json` |
| `tests/acceptance/mixed-live-run.test.ts` | 16 | 0 | 0 | `.w5-branches-results.json` |
| `tests/acceptance/mixed-traffic.test.ts` | 31 | 0 | 0 | `.w5-branches-results.json` |
| `tests/adversarial/approvals-forgery.test.ts` | 33 | 0 | 0 | `.w5-branches-results.json` |
| `tests/adversarial/build-exfiltration.test.ts` | 13 | 0 | 0 | `.w5-branches-results.json` |
| `tests/adversarial/cross-tenant.test.ts` | 10 | 0 | 0 | `.w5-schema-final.json` |
| `tests/adversarial/integration-compromise.test.ts` | 11 | 0 | 7 | `.w5-branches-results.json` |
| `tests/adversarial/malicious-archives.test.ts` | 56 | 0 | 0 | `.w5-root-retry.json` |
| `tests/adversarial/prompt-injection.test.ts` | 11 | 0 | 0 | `.w5-branches-results.json` |
| `tests/adversarial/residual-hardening.test.ts` | 10 | 0 | 1 | `.w5-managed-retry.json` |
| `tests/adversarial/role-escalation.test.ts` | 20 | 0 | 0 | `.w5-branches-results.json` |
| `tests/adversarial/ssrf-rebinding.test.ts` | 51 | 0 | 0 | `.w5-root-retry.json` |
| `tests/adversarial/token-forgery.test.ts` | 15 | 0 | 0 | `.w5-branches-results.json` |
| `tests/audit-export/audit-export.test.ts` | 10 | 0 | 0 | `.w5-branches-results.json` |
| `tests/audit-export/purpose.test.ts` | 4 | 0 | 0 | `.w5-branches-results.json` |
| `tests/billing/billing-routes.test.ts` | 13 | 0 | 0 | `.w5-branches-results.json` |
| `tests/billing/billing-unit.test.ts` | 21 | 0 | 0 | `.w5-root-retry-2.json` |
| `tests/billing/billing.engine.test.ts` | 55 | 0 | 0 | `.w5-branches-results.json` |
| `tests/ci/release-workflow.test.ts` | 8 | 0 | 0 | `.w5-branches-results.json` |
| `tests/ci/vulnerability-triage.test.ts` | 9 | 0 | 0 | `.w5-branches-results.json` |
| `tests/connections/zenith-connection.test.ts` | 5 | 0 | 0 | `.w5-branches-results.json` |
| `tests/controlplane/mixed-follow-up.test.ts` | 19 | 0 | 0 | `.w5-root-retry-2.json` |
| `tests/controlplane/recovery-epoch.test.ts` | 15 | 0 | 0 | `.w5-branches-results.json` |
| `tests/controlplane/wave5-compat.test.ts` | 10 | 0 | 0 | `.w5-schema-final.json` |
| `tests/execution/mixed-orchestration-signals.test.ts` | 15 | 0 | 0 | `.w5-branches-results.json` |
| `tests/execution/mixed/connectivity.test.ts` | 42 | 0 | 0 | `.w5-branches-results.json` |
| `tests/execution/mixed/economics.test.ts` | 14 | 0 | 0 | `.w5-branches-results.json` |
| `tests/execution/mixed/output-reader.test.ts` | 16 | 0 | 0 | `.w5-branches-results.json` |
| `tests/execution/mixed/typed-delivery.test.ts` | 12 | 0 | 0 | `.w5-branches-results.json` |
| `tests/execution/mixed/typed-inputs-activities.test.ts` | 11 | 0 | 0 | `.w5-root-retry-2.json` |
| `tests/execution/mixed/typed-substitution.test.ts` | 11 | 0 | 0 | `.w5-branches-results.json` |
| `tests/execution/tenant-isolation.test.ts` | 24 | 0 | 0 | `.w5-managed-retry.json` |
| `tests/execution/zenith-destroy-databases.test.ts` | 4 | 0 | 0 | `.w5-managed-retry.json` |
| `tests/execution/zenith-graph-problems.test.ts` | 6 | 0 | 0 | `.w5-final-regression.json` |
| `tests/execution/zenith-managed-journey.test.ts` | 11 | 0 | 0 | `.w5-final-regression.json` |
| `tests/execution/zenith-semantics.test.ts` | 5 | 0 | 0 | `.w5-branches-results.json` |
| `tests/isolation/isolation-profile.test.ts` | 17 | 0 | 0 | `.w5-branches-results.json` |
| `tests/isolation/managed-onboarding-readiness.test.ts` | 0 | 0 | 2 | `.w5-branches-results.json` |
| `tests/isolation/tenant-isolation-acceptance.test.ts` | 0 | 0 | 27 | `.w5-branches-results.json` |
| `tests/live/mixed-connectivity.live.test.ts` | 1 | 0 | 1 | `.w5-branches-results.json` |
| `tests/managed-serving/catalog.test.ts` | 15 | 0 | 0 | `.w5-branches-results.json` |
| `tests/managed-serving/domain-routes.test.ts` | 26 | 0 | 0 | `.w5-managed-retry.json` |
| `tests/managed-serving/domain-store.test.ts` | 16 | 0 | 0 | `.w5-schema-final.json` |
| `tests/managed-serving/domains.test.ts` | 38 | 0 | 0 | `.w5-branches-results.json` |
| `tests/managed-serving/integration-readiness.test.ts` | 23 | 0 | 0 | `.w5-branches-results.json` |
| `tests/managed-serving/services-route.test.ts` | 8 | 0 | 0 | `.w5-managed-retry.json` |
| `tests/managed-serving/serving-contract.test.ts` | 6 | 0 | 0 | `.w5-final-regression.json` |
| `tests/managed-serving/serving-kind.test.ts` | 0 | 0 | 4 | `.w5-branches-results.json` |
| `tests/managed-serving/serving-render.test.ts` | 35 | 0 | 0 | `.w5-managed-retry.json` |
| `tests/managed-serving/storage-emulator.test.ts` | 0 | 0 | 4 | `.w5-managed-retry.json` |
| `tests/managed-serving/storage.test.ts` | 48 | 0 | 0 | `.w5-branches-results.json` |
| `tests/ops/recovery-manifest.test.ts` | 19 | 0 | 0 | `.w5-branches-results.json` |
| `tests/ops/recovery-rehearsal.test.ts` | 0 | 0 | 10 | `.w5-branches-results.json` |
| `tests/platform/managed-reconcile.test.ts` | 36 | 0 | 0 | `.w5-managed-final.json` |
| `tests/platform/recovery-service.test.ts` | 5 | 0 | 0 | `.w5-branches-results.json` |
| `tests/platform/zenith-build.test.ts` | 29 | 0 | 0 | `.w5-managed-retry.json` |
| `tests/platform/zenith-managed-composition.test.ts` | 20 | 0 | 0 | `.w5-branches-results.json` |
| `tests/platform/zenith-onboarding.test.ts` | 11 | 0 | 0 | `.w5-branches-results.json` |
| `tests/providers/zenith/isolation-bundle.test.ts` | 86 | 0 | 0 | `.w5-branches-results.json` |
| `tests/providers/zenith/managed-kind.test.ts` | 0 | 0 | 6 | `.w5-branches-results.json` |
| `tests/providers/zenith/managed-profile.test.ts` | 11 | 0 | 0 | `.w5-managed-retry.json` |
| `tests/providers/zenith/managed-substrate.test.ts` | 28 | 0 | 0 | `.w5-branches-results.json` |
| `tests/release/acceptance-scenarios.test.ts` | 7 | 0 | 0 | `.w5-branches-results.json` |
| `tests/release/checkpoint.test.ts` | 10 | 0 | 0 | `.w5-branches-results.json` |
| `tests/release/dossier.test.ts` | 13 | 0 | 0 | `.w5-root-retry.json` |
| `tests/release/live-scope-coverage.test.ts` | 40 | 0 | 0 | `.w5-root-retry.json` |
| `tests/release/orchestrator.test.ts` | 10 | 0 | 0 | `.w5-branches-results.json` |
| `tests/release/scope.test.ts` | 32 | 0 | 0 | `.w5-branches-results.json` |
| `tests/retention/admin-routes.test.ts` | 6 | 0 | 0 | `.w5-branches-results.json` |
| `tests/retention/key-purpose.test.ts` | 2 | 0 | 0 | `.w5-root-retry.json` |
| `tests/retention/restore-destination.test.ts` | 11 | 0 | 0 | `.w5-branches-results.json` |
| `tests/retention/retention.test.ts` | 25 | 0 | 0 | `.w5-root-retry.json` |
| `tests/slo/definitions.test.ts` | 8 | 0 | 0 | `.w5-root-retry.json` |
| `tests/slo/restore-sink.test.ts` | 5 | 0 | 0 | `.w5-branches-results.json` |
| `tests/slo/sli-budget.test.ts` | 13 | 0 | 0 | `.w5-branches-results.json` |
| `tests/slo/slo-artifacts.test.ts` | 11 | 0 | 0 | `.w5-branches-results.json` |
| `tests/slo/slo.engine.test.ts` | 16 | 0 | 0 | `.w5-root-retry.json` |
| `tests/supply-chain/release.test.ts` | 13 | 0 | 0 | `.w5-branches-results.json` |
| `tests/supply-chain/sbom.test.ts` | 15 | 0 | 0 | `.w5-final-regression.json` |
| `tests/tofu/typed-inputs.test.ts` | 0 | 0 | 4 | `.w5-branches-results.json` |
| `tests/tofu/typed-substitution.test.ts` | 1 | 0 | 2 | `.w5-branches-results.json` |

The68 skips cover Windows/Linux integration/webhook controls, real PostgreSQL/Temporal restore, kind/CNI/onboarding/serving, IAM emulator, OpenTofu native binary and deliberately deferred live-cloud connectivity. They remain unverified. Local schema/tenancy native13 skips are additional overlapping per-command receipts, not included in this83-file summary.

## Files changed or added

Nine unpublished migrations are plain-file renames to44..52; the removed old names and added new names below are those renames. Published source/aggregates are absent because their diff is empty.

| Change | Path |
|---|---|
| M | `.github/workflows/ci.yml` |
| M | `.github/workflows/tick.yml` |
| M | `deploy/slo/slo-definitions.json` |
| M | `docs/LIMITATIONS.md` |
| M | `docs/build/production/PROGRESS.md` |
| M | `docs/build/production/REQUIREMENTS.md` |
| M | `docs/build/production/VERIFY-QUEUE.md` |
| M | `docs/build/production/ledger.json` |
| M | `docs/build/production/permissions.json` |
| M | `docs/build/production/verify/MIX-FOLLOWUP.md` |
| A | `docs/build/production/verify/W5-ASSEMBLY-ONBOARDING.md` |
| A | `docs/build/production/verify/W5-ASSEMBLY-RESULTS.md` |
| A | `docs/build/production/verify/W5-ASSEMBLY.md` |
| A | `docs/build/production/verify/W5-MAN-JOINS.md` |
| M | `docs/platform/operations/DEPLOYING.md` |
| M | `docs/platform/operations/KEY-CUSTODY.md` |
| M | `docs/platform/operations/MIXED-RECOVERY.md` |
| M | `docs/platform/operations/README.md` |
| M | `docs/platform/operations/RECOVERY.md` |
| M | `docs/platform/operations/RESTORE-RUNBOOK.md` |
| M | `docs/platform/operations/SUPPLY-CHAIN.md` |
| M | `scripts/ci/apply-supabase-migrations.sh` |
| M | `scripts/ci/gate-manifest.mjs` |
| M | `scripts/ci/lane-report.mjs` |
| M | `scripts/k8s/managed-substrate-acceptance.sh` |
| M | `scripts/ops/recovery.ts` |
| M | `scripts/platform/emit-sql.ts` |
| M | `scripts/release/dossier.ts` |
| M | `scripts/supply-chain/sbom.mjs` |
| M | `src/app/admin/admin-shell.tsx` |
| M | `src/app/api/internal/tick/billing/route.ts` |
| M | `src/app/api/platform/v1/_lib/bearer-paths.ts` |
| M | `src/lib/audit-export/service.ts` |
| A | `src/lib/audit-export/signer.ts` |
| M | `src/lib/audit-export/store.ts` |
| M | `src/lib/billing/store.ts` |
| M | `src/lib/controlplane/db/compat.ts` |
| D | `src/lib/controlplane/db/migrations/0042_mixed_output_records.ts` |
| D | `src/lib/controlplane/db/migrations/0043_slo_measurements.ts` |
| A | `src/lib/controlplane/db/migrations/0044_mixed_output_records.ts` |
| D | `src/lib/controlplane/db/migrations/0044_recovery_epochs.ts` |
| D | `src/lib/controlplane/db/migrations/0045_retention.ts` |
| A | `src/lib/controlplane/db/migrations/0045_slo_measurements.ts` |
| A | `src/lib/controlplane/db/migrations/0046_recovery_epochs.ts` |
| D | `src/lib/controlplane/db/migrations/0047_audit_exports.ts` |
| A | `src/lib/controlplane/db/migrations/0047_retention.ts` |
| A | `src/lib/controlplane/db/migrations/0048_audit_exports.ts` |
| D | `src/lib/controlplane/db/migrations/0048_managed_source_provider.ts` |
| D | `src/lib/controlplane/db/migrations/0049_managed_serving.ts` |
| A | `src/lib/controlplane/db/migrations/0049_managed_source_provider.ts` |
| A | `src/lib/controlplane/db/migrations/0050_managed_serving.ts` |
| D | `src/lib/controlplane/db/migrations/0050_tenant_isolation_effects.ts` |
| D | `src/lib/controlplane/db/migrations/0051_billing.ts` |
| A | `src/lib/controlplane/db/migrations/0051_tenant_isolation_effects.ts` |
| A | `src/lib/controlplane/db/migrations/0052_billing.ts` |
| M | `src/lib/controlplane/db/migrations/emit.ts` |
| M | `src/lib/controlplane/db/migrations/index.ts` |
| M | `src/lib/controlplane/db/repos/mixed-output-records.ts` |
| M | `src/lib/execution/direct-zenith.ts` |
| M | `src/lib/execution/graph.ts` |
| M | `src/lib/execution/semantics/operation.ts` |
| A | `src/lib/execution/semantics/zenith.ts` |
| M | `src/lib/execution/session.ts` |
| M | `src/lib/execution/tenant-isolation.ts` |
| M | `src/lib/hosted/source/validate.ts` |
| M | `src/lib/keycustody/purposes.ts` |
| M | `src/lib/keycustody/registry.ts` |
| M | `src/lib/managed-serving/access.ts` |
| M | `src/lib/managed-serving/storage.ts` |
| M | `src/lib/ops/admission.ts` |
| M | `src/lib/ops/recovery/restore.ts` |
| M | `src/lib/platform/app.ts` |
| M | `src/lib/platform/audit-export.ts` |
| M | `src/lib/platform/critical-jobs.ts` |
| M | `src/lib/platform/execution.ts` |
| M | `src/lib/platform/reconcile.ts` |
| M | `src/lib/platform/source-bundle.ts` |
| M | `src/lib/platform/zenith-managed.ts` |
| A | `src/lib/platform/zenith-onboarding.ts` |
| M | `src/lib/providers/zenith/drivers/kubernetes/wrap.ts` |
| M | `src/lib/providers/zenith/drivers/network/http-route.ts` |
| M | `src/lib/providers/zenith/managed-port.ts` |
| M | `src/lib/providers/zenith/managed-substrate.ts` |
| M | `src/lib/providers/zenith/render.ts` |
| M | `src/lib/providers/zenith/session.ts` |
| M | `src/lib/retention/archive.ts` |
| M | `src/lib/retention/classes.ts` |
| A | `src/lib/retention/key.ts` |
| M | `src/lib/retention/restore.ts` |
| M | `src/lib/retention/store.ts` |
| M | `src/lib/sensitivedata/inventory.ts` |
| M | `src/lib/slo/definitions.ts` |
| A | `src/lib/slo/restore-sink.ts` |
| A | `supabase/migrations/0026_platform_core.sql` |
| M | `tests/adversarial/cross-tenant.test.ts` |
| M | `tests/adversarial/malicious-archives.test.ts` |
| M | `tests/adversarial/residual-hardening.test.ts` |
| M | `tests/adversarial/ssrf-rebinding.test.ts` |
| A | `tests/audit-export/purpose.test.ts` |
| M | `tests/billing/billing-unit.test.ts` |
| M | `tests/ci/assert-lane-report.mjs` |
| M | `tests/ci/gate-manifest.test.ts` |
| M | `tests/ci/incoming-cohort-fixture.ts` |
| M | `tests/ci/lane-report.test.ts` |
| M | `tests/ci/platform-coverage.test.ts` |
| M | `tests/ci/release-gates.test.ts` |
| M | `tests/controlplane/migrations.test.ts` |
| M | `tests/controlplane/mixed-follow-up.test.ts` |
| M | `tests/controlplane/mixed-parent-plans.test.ts` |
| M | `tests/controlplane/tenancy.test.ts` |
| A | `tests/controlplane/wave5-compat.test.ts` |
| M | `tests/docs/operator-docs.test.ts` |
| M | `tests/execution/mixed/_fixtures.ts` |
| M | `tests/execution/mixed/typed-inputs-activities.test.ts` |
| M | `tests/execution/tenant-isolation.test.ts` |
| M | `tests/execution/zenith-destroy-databases.test.ts` |
| M | `tests/execution/zenith-graph-problems.test.ts` |
| M | `tests/execution/zenith-managed-journey.test.ts` |
| A | `tests/execution/zenith-semantics.test.ts` |
| A | `tests/isolation/managed-onboarding-readiness.test.ts` |
| A | `tests/managed-serving/domain-routes.test.ts` |
| M | `tests/managed-serving/domain-store.test.ts` |
| M | `tests/managed-serving/services-route.test.ts` |
| M | `tests/managed-serving/serving-contract.test.ts` |
| M | `tests/managed-serving/storage-emulator.test.ts` |
| M | `tests/middleware/platform-bearer.test.ts` |
| M | `tests/platform/critical-jobs.test.ts` |
| A | `tests/platform/managed-reconcile.test.ts` |
| M | `tests/platform/zenith-build.test.ts` |
| M | `tests/platform/zenith-managed-composition.test.ts` |
| A | `tests/platform/zenith-onboarding.test.ts` |
| M | `tests/providers/zenith/drivers.test.ts` |
| M | `tests/providers/zenith/managed-substrate.test.ts` |
| A | `tests/retention/key-purpose.test.ts` |
| A | `tests/slo/restore-sink.test.ts` |
| M | `tests/supply-chain/sbom.test.ts` |

136 paths: 99 modified, 28 added, 9 removed old migration names. Temporary diagnostics are excluded and removed. No commits or integration.

Suggested commit: `feat: assemble wave 5 production control plane`.
