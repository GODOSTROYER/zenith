# J11-OPS-INFRA builder report

Worktree `Z:/Projects/Spawned.ai/zenith-wt/prod6-j11-ops-infra`, branch `prod/j11-ops-infra`, base `3a9de905`.
Working tree was initially clean. No commits, Git writes, pushes, dependency installs, cloud calls or credential use.

## Files (22)

Modified: `docker/recipe/Dockerfile`, `docker/runner.Dockerfile`, `docker/zenithd.Dockerfile`,
`deploy/observability/README.md`, `scripts/ci/gate-manifest.mjs`, `tests/security/image-pins.test.ts`,
`docs/build/production/ledger.json`, `deploy/k8s/zenith-execution-worker.yaml`.

Added: `scripts/deploy/pin-digests.mjs`, `deploy/k8s/README.md`, `deploy/observability/images.env`,
`deploy/observability/import-harness.mjs`, `deploy/zenith-managed/cilium.env`,
`tests/security/deploy-pins.test.ts`, `tests/ops/observability-import.test.ts`,
`tests/ci/workflow-history-replay-manifest.test.ts`, `tests/ops/k8s-worker-probe.test.ts`, and verify docs `OPS-02.md`, `OPS-03.md`, `OPS-09.md`,
`MAN-04.md`, `J11-OPS-INFRA.md` (this file).

## Executed check commands and exact results

All PowerShell invocations began with `$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH`.
Counts overlap between attempts; do not sum them. Non-test commands have no test counts.

1. `npx vitest run tests/security/image-pins.test.ts tests/security/deploy-pins.test.ts tests/ops/observability-artifacts.test.ts tests/ops/observability-import.test.ts tests/ci/workflow-history-replay-manifest.test.ts --no-file-parallelism --maxWorkers=2`
   - Exit 1: **79 passed / 2 failed / 1 skipped**, 3 passed files / 2 failed files. Fixed the endpoint/security-option
     false classifications and supplied the missing `title` field in the synthetic strict-report model. No old assertion,
     deadline or test expectation was removed or changed.
2. `npx vitest run tests/security/image-pins.test.ts tests/security/deploy-pins.test.ts tests/ops/observability-artifacts.test.ts tests/ops/observability-import.test.ts tests/ci/workflow-history-replay-manifest.test.ts tests/ci/gate-manifest.test.ts tests/workflows/versioning-audit.test.ts --no-file-parallelism --maxWorkers=2`
   - Exit 1: **363 passed / 5 failed / 1 skipped**, 6 passed files / 1 failed file. All five failures were unchanged
     20,000 ms deadlines in the existing broad report-model suite, with observed case durations 20,015..62,189 ms.
     This attempt is retained; it does not prove that these failures predate this change.
3. `npx vitest run tests/security/image-pins.test.ts tests/security/deploy-pins.test.ts tests/ops/observability-artifacts.test.ts tests/ops/observability-import.test.ts tests/ci/workflow-history-replay-manifest.test.ts tests/workflows/versioning-audit.test.ts --no-file-parallelism --maxWorkers=2`
   - Exit 0: **89 passed / 0 failed / 1 skipped**, 6 passed files, after source review fixes to validator cleanup and
     production/local collector validation. This filtered run does not erase the broader timeout failures.
4. Same exact six-file command as step 3, after adding the committed-history deletion guard:
   - Exit 0: **90 passed / 0 failed / 1 skipped**, 6 passed files. The single skip is the real Docker observability
     import case (`ZENITH_TEST_OBSERVABILITY_IMPORT` unset). No browser/engine/cloud acceptance inferred.
5. `npx vitest run tests/security/image-pins.test.ts tests/security/deploy-pins.test.ts tests/ops/observability-artifacts.test.ts tests/ops/observability-import.test.ts tests/ops/k8s-worker-probe.test.ts tests/ci/workflow-history-replay-manifest.test.ts tests/workflows/versioning-audit.test.ts --no-file-parallelism --maxWorkers=2`
   - Exit 1: **91 passed / 1 failed / 1 skipped**, 6 passed files / 1 failed file. The image inventory case exceeded
     its unchanged 20,000 ms deadline (observed 32,693 ms); all other cases including the new probe contracts passed.
     This deadline failure is retained; it is not a lowered assertion or a successful image gate.
6. `npx vitest run tests/security/image-pins.test.ts tests/ops/k8s-worker-probe.test.ts --no-file-parallelism --maxWorkers=1`
   - Exit 0: **51 passed / 0 failed / 0 skipped**, 2 passed files, after explicit redirect refusal and an HTTP-200
     redirect target negative control. The image inventory completed under the unchanged deadline. Overlaps earlier runs.
7. `npx eslint tests/ops/k8s-worker-probe.test.ts` (two invocations, first followed by `git diff --check`): exit 0,
   no errors or warnings. The final scoped lint below also covers the artifact-loader fix.
8. `npx vitest run tests/ops/observability-artifacts.test.ts tests/ops/observability-import.test.ts tests/security/image-pins.test.ts --no-file-parallelism --maxWorkers=2`
   - Exit 0: **65 passed / 0 failed / 1 skipped**, 3 passed files, after the explicit artifact-loader return-type fix.
9. `npx eslint scripts/deploy/pin-digests.mjs deploy/observability/import-harness.mjs scripts/ci/gate-manifest.mjs tests/security/image-pins.test.ts tests/security/deploy-pins.test.ts tests/ops/observability-import.test.ts tests/ops/k8s-worker-probe.test.ts tests/ci/workflow-history-replay-manifest.test.ts`
   - Exit 0: final eight-file scoped lint, no errors or warnings.
10. `npx eslint scripts/deploy/pin-digests.mjs deploy/observability/import-harness.mjs scripts/ci/gate-manifest.mjs tests/security/deploy-pins.test.ts tests/ops/observability-import.test.ts tests/ci/workflow-history-replay-manifest.test.ts`
   - Initial six-file lint: no errors or warnings.
11. `npx eslint scripts/deploy/pin-digests.mjs deploy/observability/import-harness.mjs scripts/ci/gate-manifest.mjs tests/security/image-pins.test.ts tests/security/deploy-pins.test.ts tests/ops/observability-import.test.ts tests/ci/workflow-history-replay-manifest.test.ts`
   - Three seven-file successor invocations: no errors or warnings; standalone observed exit 0. Final syntax checks
     after the last lint also exited 0.
12. `node --check scripts/deploy/pin-digests.mjs`, `node --check deploy/observability/import-harness.mjs`,
   `node --check scripts/ci/gate-manifest.mjs`: exit 0, no diagnostics.
13. `node deploy/observability/import-harness.mjs lint` (two invocations): exit 0, **18 metric panels / 11 alerts / 2
   pipelines**, explicitly `offline_structure`; actual engine validation not run.
14. `node scripts/deploy/pin-digests.mjs --todo`: exit 0; **12 unresolved entries**: 5 runner/zenithd base occurrences,
   3 Kubernetes placeholders, 3 observability image inputs, 1 Cilium version/archive pin. Printed exact crane/buildx/Helm
   commands, never contacted a registry.
15. `node scripts/deploy/pin-digests.mjs --check` (two invocations): **exit 1**, all 12 unresolved entries retained.
    This is an actual failing pin gate, not a passed registry check or an exception allowance.
16. `node scripts/ci/gate-manifest.mjs workflow-history-replay` (one raw output and one PowerShell JSON projection):
    exit 0, **10 strict groups**, `required:false` because no current/committed histories exist at this base. Replay itself
    was not run. Explicit invocation through `run-gate.mjs` will fail until fixtures exist.
17. `git diff --check` (repeated after edits): exit 0, no whitespace diagnostics.
18. `bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh`:
    - First invocation: **exit 1, two TS2345 diagnostics**, both the new artifact loader's generic map return type
      passed to the named dashboard/rules/collector shape. Fixed the loader to return those three names explicitly.
    - Second invocation (only after that fix): **exit 0, no diagnostics**. Both invocations used the prescribed
      serialized script. No direct or concurrent whole-repo typecheck was run.

Broad gate-manifest timeout cases (no assertion/deadline edits):

- `mandatory original-plan product and linked native authority gates`: refuses every missing or nonpassing product case
  and PGlite, foreign, malformed or substituted evidence.
- `mandatory native OAuth grant and additive retained destroy gates`: rejects each missing, nonpassing, PGlite, foreign,
  malformed or substituted native OAuth identity.
- `current platform discovery successors [report models]`: refuses absent, failed, skipped and PGlite evidence for every
  current successor; exposes deleted discovery sources while preserving every historical literal requirement.
- `registered incident and ownership hardening [report models]`: rejects missing, failed, skipped and PGlite replacement
  of each registered hardening case.

## Other executed commands (read-only inspection, no test counts)

`git status --short`, `git log --oneline -10`, `git branch --show-current`, `git diff --stat`, `git diff --numstat`,
`git diff -- docs/build/production/ledger.json`, `git status --porcelain` (a line-count diagnostic), and read-only
`git show HEAD:docs/build/production/ledger.json` inside
the Node scope check. They confirmed the clean base, current branch, changed file scope and unchanged ledger
acceptance/state/evidence/release flags. The Node ledger update changed exactly four implementation status/note pairs.

PowerShell `Get-Content`, `Select-Object`, `ConvertFrom-Json`/`ConvertTo-Json`, `rg`/`rg --files`, and a JSON-summary
`node -e` inspected: PREAMBLE (all addenda), PLAN-100 rows/P3/4.1, WIP handoff, four ledger rows, existing PROD-OPS-02/03
verification docs, Dockerfiles, Kubernetes manifests, observability artifacts, image scanner, workflow-history recorder/
replay/support, manifest/report runner, eslint/TypeScript configuration, ledger renderer, worker health and `/api/me`.
An initial short-ID verify-doc lookup found four absent files (now supplied); absent Cilium/fixture paths and PowerShell
wildcard `rg` queries produced diagnostic missing-path errors, then literal paths/globs were corrected. A preliminary
memory-registry keyword search found no task-relevant infrastructure guidance and supplied no implementation facts.

`node --version` confirmed Node v22.23.3 (two invocations). `Get-Command promtool -ErrorAction SilentlyContinue` found no local
promtool. `Get-Item C:\Users\user\AppData\Local\Temp\zenith-tsc.lock` read shared-lock metadata. A read-only
`Get-CimInstance Win32_Process -Filter "Name = 'node.exe'"` diagnostic was denied by the sandbox; no escalation followed.
Long-queue diagnostics used `Get-Command bash -All`, `Get-Process -Name bash,node` (IDs/CPU/memory/start time only),
and Node byte inspection of the prescribed shell script. They confirmed Git Bash resolution, LF-only script bytes and
rotating serial-lock/active compiler processes. No process or shared lock was killed or changed.
`Get-Date -Format o` read local time during lock diagnostics. A preliminary
`Get-Item -LiteralPath 'tsconfig.tsbuildinfo' -ErrorAction SilentlyContinue` found no local compiler cache (exit 1,
no diagnostics); this is not a compiler failure or pass. A final Node JSON projection confirmed all four pending statuses
and unchanged row states.
Tool `apply_patch` and one scoped `node -e` ledger edit wrote only the listed workspace files. Tool-session polling ran
no additional commands or tests.

## Remaining work, scope joins and deviations

- Real registry digests and Cilium selection/hash remain intentionally unresolved: no network or invented digests.
  Exact Mac commands are in the four requirement docs. The three new image tags are explicitly resolution inputs;
  the import harness refuses them until pinned. Dockerfile frontend digest review remains outside the assigned base seam.
- Observability engines, real Temporal recording/replay/upgrades, kind rollout/rollback, Cilium and two-tenant/runtime
  acceptance: **not run (needs Mac services and integrated Wave 5/J14)**. No cloud acceptance or release certification.
- Retain and rerun the five broad strict-report timeout failures under unchanged deadlines on the verifier. Their
  expensive report-model loops/validator fixes are outside the allowed gate-manifest replay-only edit scope.
- Wave 5 supply-chain/managed runtime mechanisms are not duplicated. Joins: Cilium env triple and fixture-activated
  manifest lane; shared CI scheduling/REQUIREMENTS.md regeneration belong to the assembler. Ledger status is exactly
  `implementation_complete_verification_pending` for four rows; no verified state/evidence/release flags changed.
- Scope extension during source review: fixed the owned worker Deployment's Pod-IP probe mismatch using Node exec
  probes against its existing loopback-only health listener. No listener/core change, privileged fallback, probe period/
  failure-threshold increase or drain reduction. The added contract executes the actual probe against an owned loopback
  HTTP fixture and rejects unhealthy/redirect/unreachable responses and malformed ports. Real cluster acceptance remains
  pending. API image port 3400 matches its manifest.
- No old test expectations changed. The image scanner now recognizes declared endpoints/security options as data,
  with regression tests retaining rejection in image fields. No assertions, gates or resource/deadline thresholds weakened.

Suggested commit: `feat(ops): add infrastructure pinning and observability import harness`
