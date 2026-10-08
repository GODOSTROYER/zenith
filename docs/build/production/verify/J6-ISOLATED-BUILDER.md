# J6 Step 2 implementation handoff

Branch prod/j6-isolated-builder, merged base 66a5c539 (assembly 257b9ebe). Changes remain
in the working tree for the orchestrator. No git metadata, packages, published migrations,
aggregate snapshots or live cloud state changed. The current Step 2 section supersedes
the historical joins/gaps below.

Default native Kubernetes and zenith-managed factories now construct the isolated builder.
Source custody uses separate tenant writer/verifier vault credentials and complete identity,
permission and binding readback. Nodes require protected tenant/runtime labels, two dedicated
taints, readiness and no unapproved workload. All 14 runtime checks must pass before source
execution; failed/missing checks are named in the user-facing refusal. The handle binds node
UID/allocation, current custody, live baseline and original probe. Changed isolation refuses
completion and release. Generated OCI provenance is verified before signed release admission.

DUR-B provenance semantics now include the full tenant build profile, captured before the
review comparison and rechecked before upload/launch. DUR-C vault scopes remain platform for
managed hosting and workspace for native Kubernetes, with no deployment credential fallback.
Migration 59 widens only the immutable approved-source provider CHECK; existing providers,
archive rules, immutable triggers and RLS remain. It retains explicit drained-writer/operator
contract admission. Native registry/pipeline resources are owned release inputs, with an
operator-provisioned tenant registry root, rather than claims of a Kubernetes registry API.

## Step 2 files

50 changed/added files:

- deploy/zenith-managed/build/render.ts
- docs/build/production/ledger.json
- docs/build/production/verify/J6-ISOLATED-BUILDER.md
- docs/build/production/verify/PROD-LIFE-09.md
- docs/build/production/verify/PROD-LIFE-10.md
- docs/build/production/verify/PROD-MAN-01.md
- src/lib/controlplane/db/compat.ts
- src/lib/controlplane/db/migrations/index.ts
- src/lib/drivers/types.ts
- src/lib/execution/build-isolation.ts
- src/lib/execution/build-provenance.ts
- src/lib/execution/graph.ts
- src/lib/execution/ports.ts
- src/lib/execution/release.ts
- src/lib/execution/semantics/collect.ts
- src/lib/execution/semantics/digest.ts
- src/lib/execution/source-snapshot.ts
- src/lib/platform/approved-source-runtime.ts
- src/lib/platform/execution.ts
- src/lib/platform/release-k8s.ts
- src/lib/platform/release.ts
- src/lib/platform/source-bundle.ts
- src/lib/platform/zenith-managed.ts
- src/lib/providers/kubernetes/build/admission.ts
- src/lib/providers/kubernetes/build/config.ts
- src/lib/providers/kubernetes/build/index.ts
- src/lib/providers/kubernetes/build/port.ts
- src/lib/providers/kubernetes/build/render.ts
- src/lib/providers/zenith/managed-substrate.ts
- src/lib/resources/native-types.ts
- tests/execution/build-isolation.test.ts
- tests/execution/semantics.test.ts
- tests/platform/zenith-managed-composition.test.ts
- tests/providers/kubernetes/build/contracts.test.ts
- tests/providers/kubernetes/build/kind.test.ts
- deploy/zenith-managed/build/release-fixture/Dockerfile.template
- deploy/zenith-managed/build/release-fixture/app.c
- deploy/zenith-managed/build/release-fixture/migration.sql
- deploy/zenith-managed/build/review-profile.ts
- src/lib/controlplane/db/migrations/0059_kubernetes_source_provider.ts
- src/lib/providers/kubernetes/build/custody.ts
- src/lib/providers/kubernetes/build/nodes.ts
- src/lib/providers/kubernetes/build/rbac.ts
- src/lib/providers/kubernetes/build/source.ts
- tests/providers/kubernetes/build/dispatch.test.ts
- tests/providers/kubernetes/build/fixtures.ts
- tests/providers/kubernetes/build/graph.test.ts
- tests/providers/kubernetes/build/joins.test.ts
- tests/providers/kubernetes/build/operated-release.test.ts
- tests/providers/kubernetes/build/schema.test.ts

### Each authorized join outside the original owned paths

- platform/release.ts and release-k8s.ts: default factories select the owned builder; existing
  cloud/durable launch and workload/migration adapters retain their authority ordering.
- platform/execution.ts and approved-source-runtime.ts: canonical source uploader and profile
  digest callback; no injected test ports required by production.
- platform/source-bundle.ts: approved native source archive acquisition and custody handoff;
  preserve explicit StepFailedError refusal reasons without exposing raw credential responses.
- platform/zenith-managed.ts and providers/zenith/managed-substrate.ts: default tenant build
  availability/session delegates to separate provisioned custody; old shared credentials refuse.
- resources/native-types.ts and execution/graph.ts: native managed registry/pipeline release
  inputs admitted by exact type, while normal workload drivers/rendering keep their checks.
- execution/source-snapshot.ts and build-provenance.ts: native provider accepted in immutable
  reviewed inputs and signed statements. execution/build-isolation.ts: native rootless profile
  with no open-egress or metadata exception.
- execution/ports.ts, drivers/types.ts, execution/semantics/{collect,digest}.ts and release.ts:
  trusted profile digest seam and reviewed semantics at source custody/build dispatch.
- controlplane/db/migrations/0059_kubernetes_source_provider.ts, migrations/index.ts and compat.ts:
  assigned storage widening, registration and exact approved checksum with operator admission.
- tests/execution/build-isolation.test.ts and tests/platform/zenith-managed-composition.test.ts:
  replace provably stale no-native-profile/old-factory expectations.
- tests/execution/semantics.test.ts: new profile mutation case. Ledger and three verify docs:
  implementation_complete_verification_pending notes and real Mac instructions only.

### Stale expectation changes

1. The old owned contract expecting all Kubernetes source builds to refuse now expects an
   unconfigured native request to refuse before source execution; default positive dispatch
   and all custody/isolation gates have separate tests.
2. Existing build-isolation test formerly said native Kubernetes has no profile. Native now
   has its own rootless profile; an AWS-shaped observation still refuses as a different profile.
3. Two static default composition assertions now point to the isolated source store and the shared
   native/managed uploader branch, because those are the implemented production joins.
No assertion, environment gate, timeout or test was weakened or deleted.

## Step 2 verification commands

Every PowerShell shell starts by prepending C:/Users/user/.local/sdk/node22 to PATH.
All Vitest invocations use --no-file-parallelism --maxWorkers=2; no whole suite was run.
Counts below overlap across reruns and must not be added as unique evidence.

| Exact command | Result |
| --- | --- |
| npx vitest run tests/execution/build-release-joins.test.ts --no-file-parallelism --maxWorkers=2 | 8 passed, 0 failed, 0 skipped. Migration-42 collision gone. |
| npx vitest run tests/providers/kubernetes/build/contracts.test.ts tests/execution/build-isolation.test.ts tests/execution/build-release-joins.test.ts --no-file-parallelism --maxWorkers=2 | 82 passed, 0 failed bodies, 8 skipped; 1 suite failed setup because new migration initially assumed azure was last in the CHECK. Fixed to preserve migration49's zenith. |
| npx vitest run tests/providers/kubernetes/build/contracts.test.ts tests/providers/kubernetes/build/joins.test.ts tests/providers/kubernetes/build/dispatch.test.ts tests/execution/build-release-joins.test.ts --no-file-parallelism --maxWorkers=2 | 60 passed, 0 failed bodies, 0 skipped; 1 suite transform failure in new dispatch test regex. Fixed. |
| npx vitest run tests/providers/kubernetes/build/dispatch.test.ts tests/providers/kubernetes/build/schema.test.ts tests/platform/zenith-managed-composition.test.ts tests/execution/semantics.test.ts --no-file-parallelism --maxWorkers=2 | 61 passed, 0 failed bodies, 0 skipped; 2 suite transform failures (new SQL tamper string and static assertion quoting). Fixed. |
| npx vitest run tests/providers/kubernetes/build/schema.test.ts tests/providers/kubernetes/build/dispatch.test.ts tests/platform/zenith-managed-composition.test.ts tests/platform/approved-source-runtime.test.ts tests/execution/semantics-dispatch.test.ts --no-file-parallelism --maxWorkers=2 | 74 passed, 1 failed, 8 skipped. New admission test passed env instead of the API's allowed set. Fixed. |
| npx vitest run tests/providers/kubernetes/build/contracts.test.ts tests/providers/kubernetes/build/joins.test.ts tests/providers/kubernetes/build/dispatch.test.ts tests/providers/kubernetes/build/schema.test.ts tests/providers/kubernetes/build/kind.test.ts tests/providers/kubernetes/build/operated-release.test.ts --no-file-parallelism --maxWorkers=2 | 65 passed, 0 failed, 9 skipped: 7 real PG, 1 kind, 1 operated release. |
| npx vitest run tests/execution/build-release-joins.test.ts tests/execution/build-isolation.test.ts tests/execution/build-provenance.test.ts tests/execution/build-admission.test.ts tests/execution/semantics.test.ts tests/execution/semantics-dispatch.test.ts --no-file-parallelism --maxWorkers=2 | 163 passed, 0 failed, 0 skipped (6 files). |
| npx vitest run tests/platform/source-bundle-composition.test.ts tests/platform/source-bundle.test.ts tests/platform/zenith-managed-composition.test.ts tests/platform/approved-source-runtime.test.ts tests/execution/kubernetes-deploy-journey.test.ts tests/providers/zenith/managed-substrate.test.ts --no-file-parallelism --maxWorkers=2 | 168 passed, 0 failed, 7 skipped (6 files). Real PG source composition remains gated. |
| npx vitest run tests/providers/kubernetes/build/contracts.test.ts tests/providers/kubernetes/build/joins.test.ts tests/providers/kubernetes/build/dispatch.test.ts tests/providers/kubernetes/build/schema.test.ts tests/controlplane/migration-compat.test.ts --no-file-parallelism --maxWorkers=2 | 90 passed, 1 failed, 7 skipped. Existing N-1/N PGlite rehearsal exceeded unchanged 20-second timeout. Isolated rerun recorded below. |
| npx vitest run tests/providers/kubernetes/build/graph.test.ts --no-file-parallelism --maxWorkers=2 | 2 passed, 0 failed, 0 skipped: actual native git graph admission and build-profile semantics collector. |
| bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh (first) | Exit1, 20 diagnostics in new code/fixtures. Fixed typed KubeConfig/API access, literal provider, complete node/operation shapes and admission API argument. |
| Same serialized typecheck (second) | Exit1, 5 diagnostics: opaque KubeConfig access and optional nonResourceURLs. Fixed without widening credentials. |
| Same serialized typecheck (third) | Exit1, 1 diagnostic: compilation captured the old optional nonResourceURLs access before that edit. It is fixed. Final rerun below. |
| npx eslint $lintPaths $newPaths, where $lintPaths=@(git diff --name-only -- '*.ts'), $newPaths=@(git ls-files --others --exclude-standard -- '*.ts') | Four runs all exit0, 0 errors, 0 warnings; final run exit0, 0 errors, 0 warnings. |
| npx eslint $lintPaths src/lib/providers/kubernetes/build/custody.ts src/lib/providers/kubernetes/build/nodes.ts src/lib/providers/kubernetes/build/source.ts src/lib/providers/kubernetes/build/rbac.ts src/lib/controlplane/db/migrations/0059_kubernetes_source_provider.ts | Earlier scope check exit0, 0 errors, 0 warnings. |
| npx tsx -e "import { migration0059KubernetesSourceProvider as m } from './src/lib/controlplane/db/migrations/0059_kubernetes_source_provider'; import { migrationChecksum } from './src/lib/controlplane/db/migrations'; console.log(migrationChecksum(m));" | Twice exit0. Final SQL checksum afef954e9417c33a3a0dadc254253ab523c9dbc425af27da5120927e8064df9a registered and checked by tests. |
| node scripts/build/production-ledger.mjs --check | Six runs exit0. JSON/check valid, no row marked verified. |

| Final command | Result |
| --- | --- |
| npx vitest run tests/controlplane/migration-compat.test.ts --no-file-parallelism --maxWorkers=2 | Isolated retry: 22 passed, 0 failed, 0 skipped. Existing timeout unchanged. |
| npx vitest run tests/providers/kubernetes/build/dispatch.test.ts tests/providers/kubernetes/build/schema.test.ts tests/providers/kubernetes/build/graph.test.ts --no-file-parallelism --maxWorkers=2 | Final focused code: 19 passed, 0 failed, 7 skipped (real PG), 3 files passed. |
| Same serialized typecheck (fourth, final code) | Exit0, 0 diagnostics. |
| git diff --check | Exit0, 0 whitespace errors. |

Read-only discovery used git status --short/--porcelain, git log --oneline -10, git diff
--stat/--name-only, git ls-files --others --exclude-standard, rg/rg --files, Get-Content,
Select-String, Get-ChildItem (typecheck lock), Get-Process (RAM). Speculative nonexistent
paths and Windows wildcard rg paths returned errors; actual paths found with rg were read.
PowerShell literal here-strings/Node fs and .NET UTF8 writes edited only working-tree files.
One report-only counter using git ls-files --error-unmatch on an untracked file exited1 after the report write; the status-based file count above is correct. One absolute-path apply_patch attempt was rejected and made no change. No .git writes,
install command, permission escalation, Docker/cloud request or real credential was used.

## Remaining verification / joins

- Not run (needs real PostgreSQL): seven schema custody checks plus existing owning source
  composition. Not run (needs kind/Docker/runtime profiles): actual default managed component
  build, denial probes, OCI bytes, one-off command, readiness and serving digest readback.
- Not run (needs real product/human review, Temporal, PG and kind): new operated LIFE-10 harness
  checks the actual default operation's review/workflow, signed immutable-source provenance,
  expand migration, readiness/cutover and independent SQL/HTTP. Exact Mac commands and lean
  two-node profile are in PROD-LIFE-09.md Step2, referenced by LIFE-10/MAN-01 verify docs.
- Runtime handler and reviewed node seccomp/AppArmor files must be provisioned on the Mac.
  review-profile.ts hashes their actual bytes into the profile and protected node label.
  Missing support/failed probes remains BLOCKED/refused, never a pass or privileged fallback.
- Assembly must merge assigned migrations53-58 before the contiguous inventory gate. J6 adds
  only assigned59; no fake placeholders or edits to published snapshots. This gate was not
  run against the intentionally incomplete parallel-job registry.
- Registry auth is exact-host Basic dockerconfig; bearer challenge is refused. Use an owned
  local registry/mirror with isolated host/IP destinations. Source archive cap stays700KiB.
- Broader LIFE-10 progressive/rollback/destructive migration/data-restore lanes retain their
  existing contracts and Mac acceptance. No production verification is claimed.

Deviation: none from Step2. Minimal outside-path joins are explicitly authorized and listed.
Suggested commit: feat(build): wire tenant-isolated source builds into default releases

---

# Historical J6 Step 1 implementation and command results

Worktree: Z:/Projects/Spawned.ai/zenith-wt/prod6-j6-isolated-builder.
Branch: prod/j6-isolated-builder. Base: 443bfeaf. Changes are uncommitted; no git history, packages, migrations,
aggregate snapshots or cloud state was changed. Node v22.23.3; Go go1.27.1
windows/amd64, GOTOOLCHAIN=local.

## Files

Added 18 implementation/test files:
- src/lib/providers/kubernetes/build: config.ts, render.ts, admission.ts, port.ts,
  artifact.ts, index.ts.
- deploy/zenith-managed/build: builder.go, builder_test.go, proxy.py,
  Dockerfile.builder, Dockerfile.proxy, Dockerfile.fixture, fixture-app.c,
  resolve-images.sh, render.ts, README.md.
- tests/providers/kubernetes/build: contracts.test.ts, kind.test.ts.

Updated ledger.json (only PROD-LIFE-09/10/MAN-01 status and notes) and appended
the corresponding three verify documents. This report is one additional file.
Total: 23 changed/added files.

## Verification command history

Every PowerShell invocation prepended C:/Users/user/.local/sdk/node22 to PATH.
No npm install/ci, whole vitest suite, Docker, real PostgreSQL, Temporal, kind,
browser or real cloud command was executed.

| Exact command | Result |
| --- | --- |
| npx vitest run tests/providers/kubernetes/build/contracts.test.ts --no-file-parallelism --maxWorkers=2 (initial) | 27 passed, 2 failed, 0 skipped. Artifact export was missing; fixed. |
| npx eslint src/lib/providers/kubernetes/build tests/providers/kubernetes/build/contracts.test.ts (initial) | 6 errors, 0 warnings. Replaced any types without removing assertions. |
| C:/Users/user/.local/sdk/go/bin/go.exe test -json builder.go builder_test.go (build directory, default cache) | Exit 1 before tests: sandbox denied default Go cache. 0 tests ran. |
| Same go test, GOTOOLCHAIN=local, GOCACHE=C:/Users/user/AppData/Local/Temp/zenith-j6-go-cache (first) | 13 passed, 1 failed, 0 skipped including subtests. POSIX archive paths were incorrectly normalized with Windows filepath.Clean; fixed with path.Clean. |
| Same cached go test (second) | 13 passed, 1 failed, 0 skipped including subtests. Windows cannot report POSIX executable bits; see expectation correction below. |
| Same cached go test (final) | 14 passed, 0 failed, 0 skipped: 4 top-level tests plus 10 subtests. |
| C:/Users/user/.local/sdk/go/bin/gofmt.exe -w deploy/zenith-managed/build/builder.go deploy/zenith-managed/build/builder_test.go | Exit 0, 2 files formatted. |
| C:/Users/user/.local/sdk/go/bin/gofmt.exe -w deploy/zenith-managed/build/builder_test.go | Exit 0, 1 file formatted. |
| C:/Users/user/.local/sdk/go/bin/gofmt.exe -w deploy/zenith-managed/build/builder.go | Exit 0, repeated as runtime probes changed. |
| C:/Users/user/.local/sdk/go/bin/go.exe test -json deploy/zenith-managed/build/builder.go deploy/zenith-managed/build/builder_test.go (worktree root, local toolchain, temp cache) | Earlier 14 passed; final 15 passed, 0 failed, 0 skipped: 5 top-level tests and 10 subtests, after Kubernetes discovery normalization. |
| npx vitest run tests/providers/kubernetes/build/contracts.test.ts tests/providers/kubernetes/build/kind.test.ts tests/execution/build-provenance.test.ts tests/execution/build-release-joins.test.ts --no-file-parallelism --maxWorkers=2 | 53 passed, 0 failed test bodies, 9 skipped; 1 suite failed setup. 8 release-join bodies blocked by base migration-42 checksum collision (mixed_output_records), 1 kind body gated. Migration collision belongs to assembly and was not edited. |
| npx vitest run tests/providers/kubernetes/build/contracts.test.ts tests/providers/kubernetes/build/kind.test.ts tests/execution/build-provenance.test.ts --no-file-parallelism --maxWorkers=2 (earlier) | 54 passed, 0 failed, 1 skipped (kind needs actual infrastructure). |
| npx vitest run tests/providers/kubernetes/build/contracts.test.ts --no-file-parallelism --maxWorkers=2 (after policy-version guard) | 31 passed, 0 failed, 0 skipped. |
| Same contract command (after positive proxy/direct registry checks) | 33 passed, 0 failed, 0 skipped. |
| Same contract command (final, with Dockerfile context containment) | 34 passed, 0 failed, 0 skipped. |
| npx vitest run tests/providers/kubernetes/build/contracts.test.ts tests/providers/kubernetes/build/kind.test.ts tests/execution/build-provenance.test.ts --no-file-parallelism --maxWorkers=2 (after real product/vault harness composition) | 58 passed, 0 failed, 1 skipped; 34 owned contracts, 24 existing provenance cases, 1 gated kind journey. |
| Same three-file vitest command (after material-digest guards) | 61 passed, 0 failed, 1 skipped; 37 owned contracts, 24 existing provenance cases, 1 gated kind journey. |
| Same three-file vitest command (final, after session-guard signature fixes) | 62 passed, 0 failed, 1 skipped; 38 owned contracts, 24 existing provenance cases, 1 gated kind journey. The added pure naming test accepts the matching tenant and rejects a mismatched tenant; it performs no source execution or provider API call. |
| npx eslint src/lib/providers/kubernetes/build tests/providers/kubernetes/build deploy/zenith-managed/build/render.ts | Subsequent runs as files/guards changed all exit 0, 0 errors, 0 warnings; final run includes the receipt field type, real product/vault harness composition, material digest guards and session identity fixes. |
| bash -n deploy/zenith-managed/build/resolve-images.sh | Run three times; all exit 0. Resolver never executed. |
| git diff --check | Initial check found 3 added blank EOF lines; fixed. Final checks exit 0. |
| node --version | v22.23.3, exit 0. |
| C:/Users/user/.local/sdk/go/bin/go.exe version | go1.27.1 windows/amd64, exit 0. |
| bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh (first) | Exit 1, exactly 2 owned TypeScript errors: port.ts session guards passed workspace/environment as separate arguments; the helper requires one context object. Both fixed. No other diagnostics. |
| Same serialized typecheck (after the 2 fixes) | Exit 0, 0 diagnostics. |

Read-only inspection used git status --short, git log --oneline -10, git branch --show-current,
Get-Content/Get-Item/Get-ChildItem and targeted rg/rg --files over the preamble,
PLAN-100, ledger, verify docs and named source/tests. Some speculative paths were
absent (unprefixed LIFE/MAN verify files and release-kubernetes naming); existing
prefixed docs/release-k8s code was read instead. An initial apply_patch write
failed on the Windows path; PowerShell literal here-string writes succeeded.
Two late edit commands used doubled relative paths from the build directory, and a subsequent subdirectory Set-Content was denied. Those edits did not apply; worktree-root literal file writes and gofmt then succeeded, and the changed Go code passed all 14 test/subtest results. Get-CimInstance process inspection was denied; Get-Process and lock timestamps were readable. No permission override was attempted. Editing commands used Set-Content/
Add-Content or Node fs writes only in the owned worktree; the transient larger
Go fixture source was removed after replacing it with the small static C fixture.

## Test expectation correction

Exactly one new expectation was corrected: TestExtractDigestBoundRegularFile
expects Windows' reported DOS writable file mode 0666 on Windows. Linux/macOS
still assert the original strict 0700 mode. The deployed builder is Linux;
Windows extraction tests establish byte/path handling, not Linux permission
acceptance. No existing test, assertion or environment gate was removed.

Kubelet unconditionally supplies API discovery environment links even with service links disabled ([upstream implementation](https://github.com/kubernetes/kubernetes/blob/master/pkg/kubelet/kubelet_pods.go)). The trusted entrypoint removes only those fixed discovery keys before the unchanged strict credential guard. A new test proves removal and proves that a runtime-built fake Kubernetes credential remains rejected.

## Remaining work and deviations

- Default build-port wiring is outside J6-owned paths. Assembly must switch the
  import, extend managed build read scopes/RBAC and keep durable launch/authority
  ordering. The old factory remains selected in this worktree.
- Kubernetes source custody/profile/provenance provider joins are outside scope.
  The owned Kubernetes factory refuses **before source execution** until joined.
- Schema need for that native Kubernetes join: an assigned additive migration must widen the approved_source_snapshots provider CHECK to include kubernetes, preserving the other checks and immutable custody. Migration 0013 plus wave-5 managed_source_provider currently admit aws/gcp/azure/zenith. No number was assigned here and no migration or aggregate was edited.
- Reviewed runtime class, node Localhost seccomp/AppArmor profiles, user namespaces
  and compatible admission are real prerequisites; not installed or assumed.
  Stock kind may refuse proc isolation. Never fix that with privileged pods,
  Unconfined profiles or disabled process sandbox.
- Real kind/default-product release and wider Temporal/PG/browser journeys need
  the Mac. Exact commands and lean resource assumptions are in PROD-LIFE-09.md.
- Proxy CONNECT allowlisting cannot isolate different virtual hosts sharing an
  allowed IP. Use dedicated registry/package mirrors. Registry bearer-challenge
  auth needs an owned adapter; the current deterministic reader refuses it.
- Source custody remains 700 KiB. Shared immutable source Secrets require safe
  operator pruning after durable references/Jobs expire, rather than deleting
  them while another build could still consume them.
- The base release-join setup has a migration-42 collision. Assembly owns numbering.
- These gaps are explicitly recorded in all three ledger notes. No row marked
  verified. The requested implementation status is scoped to the owned build
  artifact, not a claim that default composition or acceptance is finished.

Suggested commit: feat(build): add runtime-gated rootless Kubernetes builder

