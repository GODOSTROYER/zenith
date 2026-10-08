# J6 implementation handoff and command results

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

