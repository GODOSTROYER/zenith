# Regression checkpoint, 2026-10-03

Last fully inspected published CI source: `746e4eef8dde0c94cf4850ac0222a20b5b07205c`, branch `codex/production-2026-10-02`, Saivedant's Mac and Git identity. Exact [run 37098189258](https://github.com/GODOSTROYER/zenith/actions/runs/37098189258) finished **13 passing jobs / 1 failing dependency-security job**. All five canonical lanes passed; independently reviewed observations and limitations are in [current CI report](../../ci-37098189258.md). Historical a14's 14/14 run is separate. No current task is paused.

## Completed checklist

- [x] Wave-8 implementation, ancestry, existing changes and historical handoffs preserved.
- [x] Original durable-plan source `15e4453`, 57 paths, independently reviewed and locally verified. Its full unit failure **16,588 passed / 70 failed / 212 skipped** remains recorded; code is not main-integrated.
- [x] Final durable/CI/inactive-security corrections committed as Saivedant at `c121f89`, `cd60f8b` and `50aa292`, merged only into isolated staging `1ce6191`. Targeted **1,079/0/20**, focused **123/0/5**, real PostgreSQL **1,532/0/0**, Supabase **251/0/0**, local kind provider **6/0/0** and release **1/0/0** passed. Earlier failures retained; skips use separate required backend gates.
- [x] Root discovered genuine runner key-rotation persistence failure in the first complete staging gate. Seven-path correction independently reviewed and root verified: focused race **180 top-level + 40 subtests passed, 0 failed/skipped**; affected Vitest/OpenTofu **86/0/0**; full race **232 top-level + 541 subtests passed, 0 failed, 3 Linux-only Mac skips**.
- [x] Runner source `c355eeeff579f4c648f1ee9fce99429727513910` committed and merged as Saivedant into clean isolated staging `356b7d014836e6cb39e54d4848f20d508fe31fde`. No source main integration or source push.
- [x] Exact staging complete executed regression: unit **16,842/0/212**, Temporal **1,000/0/0**, policy **238/0/0**, OpenTofu **3,900/0/8**; all mandatory groups and 12 execution bindings/revalidation passed. Compiler, lint, generated SQL/policy/matrix/AWS and Go checks passed. Overall status remains **failed: mandatory dependency audit**.
- [x] Fresh exact-staging actual PostgreSQL **1,532/0/0**, 70 groups; Supabase **251/0/0**, full apply/reapply, schema name/checksum refusals; native OPA **213/0/0**. PostgreSQL handoff groups cover the eight standalone OpenTofu skips. All owned database resources removed.
- [x] Fresh native ARM64 exact-staging execution-worker startup passed **216.02 seconds**. Actual entrypoint, local PostgreSQL/development Temporal, polling, expected signed no-target refusal, readiness/liveness, outage recovery, packaged assets, encrypted-plan fixtures and idle shutdown. All 14 resources plus owned builder/cache/new images removed. No live mutation or in-flight shutdown proof.
- [x] Guest file.write implementation frozen in 35 paths. Both initial source findings corrected and independently reviewed. Root compiler/scoped lint and 267 TypeScript contracts passed with zero failures/skips, including five real-network OpenTofu cases. Actual Linux/Go/goldens and signed approval acceptance remain open.
- [x] Linux prerequisite frozen in seven paths; zero outside-owned changes, 3,536 untouched parent hashes matched. Initial independent review found exactly one stale-artifact issue; no runtime acceptance claimed.

## Ongoing and pending checklist

- [x] AMD64 emulated worker startup on staging `356b7d0` passed **280.02 seconds**. All 14 resources, owned builder/cache and new images removed.
- [x] GUEST-LINUX-STALE-01 correction frozen and independently re-reviewed. Root **102 contracts passed, zero failures/skips**, compiler/lint/Bash/Node/embedded-Python syntax passed. Fresh attempt IDs and observed current outcome bind the sole sanitized upload path. No native Linux or hosted CI claim.
- [ ] Root: reviewed corrections and TypeScript contracts passed. Execute actual supported-root unprivileged Linux/mount/ACL/race/crash checks and five authentic filesystem goldens.
- [ ] Current dependency clearance: five packages share GHSA-vfj7-8cjw-p6xm. Current published parent versions retain the chain; no compatible safe removal route demonstrated. Inactive exception support is not risk acceptance, and the registry remains empty.
- [ ] Partial 12-path cleanup guard remains unmerged. Initial **79 passed / 1 failed**, corrected failed-suite retry **7 passed**. Durable authoritative quiescence and legitimate authorized success missing; execution refuses destruction.
- [ ] Default browser/API/MCP startup and live AWS account/region/budget pending permission. External mTLS, live clouds, managed clusters, production database security, traffic, recovery and signoff still required.
- [ ] Remaining full-product requirements remain visible below and in the 78-ID production ledger. No wave or AWS milestone substitutes for complete product acceptance.

Agents: `/root/durable_security_review` completed the guest uncertainty correction; `/root/durable_plan_resume` completed independent guest and initial Linux-gate reviews; `/root/guest_file_write` completed the Linux-gate correction and `/root/durable_plan_resume` completed its independent re-review. Root owns runtime verification, evidence, Git and the ledger. No current paused tasks.

## Workstream checklist

- [x] PROD-WS-CI-SCHEMA: ci schema. integrated; `ws/prod-ci-schema`.
- [x] PROD-WS-GATE-REPORT: gate report. integrated; `ws/prod-gate-report`.
- [x] PROD-WS-WORKFLOWS: workflows. integrated; `ws/prod-workflows`.
- [x] PROD-WS-RUNTIME-SECURITY: Runtime admission and advisory clearance. integrated; `ws/prod-runtime-security`.
- [x] PROD-WS-WORKER-STARTUP: Actual worker image operation. integrated; `ws/prod-worker-startup`.
- [x] PROD-WS-DEPENDENCY-REMEDIATION: dependency remediation. integrated; `ws/prod-dependency-remediation`.
- [x] PROD-WS-CANONICAL-REPAIR: canonical repair. integrated; `ws/prod-canonical-repair`.
- [x] PROD-WS-EVIDENCE-BINDING: evidence binding. integrated; `ws/prod-evidence-binding`.
- [x] PROD-WS-AWS-UI-FIXTURES: aws ui fixtures. integrated; `ws/prod-aws-ui-fixtures`.
- [x] PROD-WS-AWS-BROWSER-CONTRACT: aws browser contract. integrated; `ws/prod-aws-browser-contract`.
- [x] PROD-WS-START-UNCERTAINTY: start uncertainty. integrated; `ws/prod-start-uncertainty`.
- [x] PROD-WS-PG-GRANT-CLOCK: pg grant clock. integrated; `ws/prod-pg-grant-clock`.
- [x] PROD-WS-ECS-REPLICA-REPAIR: ecs replica repair. integrated; `ws/prod-ecs-replica-repair`.
- [x] PROD-WS-INTEGRATED-CI: integrated ci. integrated; `ws/prod-integrated-ci`.
- [x] PROD-WS-RESUMED-CI: resumed ci. integrated; `ws/prod-resume-ci`.
- [ ] PROD-WS-DURABLE-PLAN-HANDOFF: Authenticated original plan handoff and safe artifact lifecycle. in_progress; `ws/prod-durable-plan-handoff`.
- [x] PROD-WS-STARTUP-CI-FIX: Strict workflow inventory and early worker configuration admission. integrated; `ws/prod-worker-startup`.
- [x] PROD-WS-WORKER-BOOTSTRAP: worker bootstrap. integrated; `ws/prod-worker-startup`.
- [ ] PROD-WS-ACCEPTANCE-CLEANUP: Uncertain mutation cleanup admission and recovery. in_progress; `ws/prod-acceptance-cleanup`.
- [ ] PROD-WS-BRACES-ADVISORY: New braces advisory reachability and safe remediation. in_progress; `ws/prod-braces-advisory`.
- [ ] PROD-WS-SECURITY-EXCEPTIONS: Inactive fail-closed reviewed expiring advisory exceptions. in_progress; `ws/prod-security-exceptions`.
- [ ] PROD-WS-DURABLE-CI-REGRESSIONS: Strict CI fixture reconciliation after durable plan migration. in_progress; `ws/prod-durable-ci-fixtures`.
- [ ] PROD-WS-GUEST-FILE-WRITE: Linux customer-local approved-template file.write. in_progress; `ws/prod-guest-configuration`. Canonical profile version binds exact execution metadata; Linux runtime, mount and golden proof pending.
- [ ] PROD-WS-RUNNER-KEY-ROTATION: Persist runner trust rotation before publication. Checked source `c355eee` merged into isolated staging `356b7d0`; fresh ARM64 native and AMD64 emulated packages passed with owned cleanup. Main integration and broader lifecycle remain incomplete.

- [ ] PROD-WS-GUEST-LINUX-CI: Seven-path native Linux gate and owned fixture prerequisite. Initial stale-artifact finding closed by independently reviewed current-attempt correction; root 102 contract tests, compiler/lint and script syntax passed. Native Linux/mount/ACL/golden proof pending.

Full goal: [78-requirement checklist](../../PROGRESS.md) and [acceptance details](../../REQUIREMENTS.md). **5 verified, 19 in progress, 54 planned.** Acceptance states do not measure implementation effort. Implementation complete, sandbox verified, pilot ready and production approved all false.

## Ownership and source locations

Main: `/Users/saivedanthava/Desktop/zenith`, branch `codex/production-2026-10-02`, pushed `746e4ee`. Preserve37be ancestry and all newer/untracked user changes. Candidate15e4453 stays isolated. Current clean staging `ws/prod-durable-full-integration` is `356b7d0`, retaining original `15e4453` ancestry.

Private worker briefs: `/Users/saivedanthava/.codex/zenith-production/briefs/2026-10-03-full-regressions/`. Original frozen57path inventory: `evidence/durable-plan/root-verification.json`; nine added core fixtures:

```text
tests/execution/aws-bootstrap-context.test.ts
tests/execution/deletion-guards.test.ts
tests/execution/destroy-review-temporal.test.ts
tests/execution/ecs-replica-repair.test.ts
tests/platform/deploy-e2e.test.ts
tests/platform/machine-composition.test.ts
tests/platform/source-bundle-composition.test.ts
tests/tofu/destroy.test.ts
tests/tofu/runner.test.ts
```

CI fixtures own exactly:

```text
tests/ci/assert-lane-report.test.ts
tests/ci/evidence-sanitizer.test.ts
tests/ci/gate-manifest.test.ts
tests/ci/platform-coverage.test.ts
tests/ci/release-gates.test.ts
tests/sources/github-migrations.test.ts
tests/workers/worker-health-wiring.test.ts
tests/workflows/codec-wiring.test.ts
```

Security support owns exactly:

```text
scripts/ci/security-audit.mjs
scripts/ci/security-exceptions.mjs
scripts/ci/security-exceptions.json
tests/ci/security-audit.test.ts
tests/ci/security-exceptions.test.ts
docs/build/production/security-exceptions.md
```

No overlapping ownership. Outside-owned changes become follow-ups. Workers edit source only; root owns runtime checks and Git writes. Preserve strict guards, human browser-only immutable approval, tenant scoping and original-plan custody. No production fallback or skipped-case waiver.

## Next verification and integration

1. Freeze revised source and compare exact hashes. Root runs `npx tsc --noEmit`, affected `eslint`, `npx vitest run --maxWorkers=1` for touched suites, real OpenTofu with `ZENITH_TEST_TOFU_NETWORK=1`, Go gofmt/vet/test. Re-review changed production authority and corrected fixture coverage.
2. Re-run mandatory actual PostgreSQL/OpenTofu and Supabase apply/reapply/tamper after production corrections. No PGlite substitution. Root merge each checked branch into ws/prod-durable-full-integration, retaining both sides of legitimate limitation updates.
3. Run complete combined manifest: typecheck/lint/generated/unit/OPA/Go race/interoperability/canonical Temporal/policy/OpenTofu/actual PostgreSQL/browser as authorized. Preserve current security failure and all missing/failed/skipped/zero checks.
4. Repeat disposable kind and architecture-specific packaged checks when corrected source invalidates prior evidence. Delete owned cluster/kubeconfig/resources/builders/cache/new dependencies.
5. Resolve advisory through safe patch or concrete reviewed operator risk/governance disposition. No self-signed approval or authority installation. Trusted authority and CI verifier deployment remain prerequisites; inactive mechanism does not clear vulnerability.
6. Integrate into current main only after required checks clear. Saivedant author/committer, normal same-branch push, observe exact complete CI. No force push/history rewrite/protected-branch/secret-scanning bypass. Continue remaining whole product goal.

Root private helpers under `/Users/saivedanthava/.codex/zenith-production/`: check_candidate.py, check_platform_postgres.py, check_supabase_postgres.py, check_kind.py, run_packaged_storage.py, check_durable_full.py. Use exact worktree/fresh labels. Private logs/patches not automatically available on another machine; public hashes preserve binding.

## Resources, decisions and ETA

Latest image cleanup observed approximately 21 GiB free and zero Docker images/containers/volumes/cache. Fresh matching-client kind provider 6/6 and release 1/1 passed with owned cleanup. Reserve 12 GiB before image gates; one heavy local process on this 8 GB Mac. Same-lock owned dependency consolidation reclaimed1.14GiB. No global prune or unrelated deletion.

Disposable PostgreSQL/Temporal/kind and execution-worker tests approved. API/server startup and dedicated AWS account/region/budget pending. Live cloud/DNS/private-source and managed-cluster fixtures, retention deletion, commercial choices and production signoff remain operator prerequisites. No secrets in chat. Unblocked source work continues.

Next reviewed checkpoint estimate: 2–4 hours, dependent on bounded corrections and serial verification. Earlier 45–90 minute estimate predates the original 70 full-suite failures. Full production date not schedulable before remaining implementation/access/operational proof. No unattended background-work claim.

## Frozen correction receipts

All private receipts are under `/Users/saivedanthava/.codex/zenith-production/logs/` and remain available on this machine:

- `durable-plan-verify-full-regressions-typed-fixture-doc-source-checkpoint-20261003.json`: 66 owned paths, 17 changed; SHA-256 `6eed6836c09c22c6c189818aeca3c4e3f06727d773496df5e2f2fa37c38ed736`.
- `durable-ci-fixtures-20261003/r2/freeze.json`: eight-path CI r2 correction; binary diff SHA-256 `b55993f12d379961d0dd5f35c2c89fad24c9ba75ca1bb2e04296f6be53f62e0e`.
- `security-exceptions-corrections-r3/freeze.json`: six frozen inactive support paths; SHA-256 `985e105af2b48d975dd3f47dc5630683816336804132bc5a26db15aebea8f2bd`.
- `durable-regressions-typed-doc-source-freeze-20261003.json`: root verification-only combined31 paths; SHA-256 `562b1340fc4ae9fa5b2c4b3c734737b42e89a90273562e56eb8e1e899e391c7b`.
- `durable-typed-fixture-doc-independent-review-20261003.json`: latest source-only review clear; SHA-256 `cfddd5a401d115b88732be9c0758c880f140038848e28d7c4bff1d0607f2370a`.

Root verification worktree: `/Users/saivedanthava/.codex/zenith-production/worktrees/durable-regression-verify`, still verification-only. Previous21-path runtime failure and30-path typecheck failure source archives retained separately. [Current public source receipt](../../evidence/durable-plan/corrections-source.json), [affected root checks](../../evidence/durable-plan/corrections-targeted.json).

Latest one-file intended-host fixture checkpoint: `durable-plan-verify-full-regressions-pg-apply-host-env-source-checkpoint-20261003.json`, SHA-256 `7d04ca7412f6c38c34b59dcc5ce156716c438e318c7f3ce359bbc8ae66d26264`, 66 owned/18 changed. Root combined32-path freeze: `durable-regressions-pg-apply-source-freeze-20261003.json`, SHA-256 `63eebf6959b49dc7320a4c558c978155de670c48959f466ca84ff0ece2f4e739`. [Final source binding](../../evidence/durable-plan/corrections-final-source.json), [actual PostgreSQL retry](../../evidence/durable-plan/corrections-platform-postgres.json).

## Current staging and active source jobs

Clean staging: `/Users/saivedanthava/.codex/zenith-production/worktrees/durable-full-integration`, branch `ws/prod-durable-full-integration`, exact `356b7d014836e6cb39e54d4848f20d508fe31fde`. Do not rerun completed unit/canonical/database/native OPA checks without new source or unresolved evidence. Mandatory dependency audit failure remains; main source integration blocked.

Guest writer: `/Users/saivedanthava/.codex/zenith-production/worktrees/guest-configuration`, `ws/prod-guest-configuration`, base `1ce61919b2dd6fed04b00dd82e2de3ce229b8752`. Current 35-path correction receipt SHA-256 `94ef95c6d808c4ed80f95126c7622de845cb41da357997b5be1d248c9a94ef4a`; independent review `bf110f0b3f8bf77d83f64ca7f6c91e6a6c9337c667759d92703a561d23c89f12`. Preserve original 34-path receipt and initial findings. Root subsequently formatted only 15 Go files; current hashes and private originals are in `logs/guest-file-write-20261003/root-format/receipt.json`. Non-Go bytes unchanged. TypeScript 267 contracts passed; Linux-target vet/build/test compilation passed for ARM64 and AMD64; actual Linux/race/golden checks remain required. Workers executed no formatter/compiler/runtime/Git operations.

Linux CI prerequisite: `/Users/saivedanthava/.codex/zenith-production/worktrees/guest-linux-ci`, `ws/prod-guest-linux-ci`, base `356b7d0`. Initial seven-path receipt `dec591e3746b237293f3da6e9dfa6c25782e985320ea805b75b26350cd8a48a8`; independent review `472ec10939593e628a66103ca848dc22ff0fb3a3db6238c4b005a50f1b0465db`. Preserve initial evidence. Current r2 receipt `95585fa3d62b16248896784847818f93293f02a0c3144898c4ade471839fc28a`, independent r2 review `3fdf656253d02b1bdbdf880699464fe69bad12a55ce77c45f20c6f59853a9b33`; root 102 contract tests and compiler/lint/script syntax passed. Preserve initial evidence separately.

Actual Linux prerequisites: nonzero UID/GID, persistent ext-family/XFS/Btrfs root filesystem, trusted `/opt`, actual POSIX ACL xattrs, four owned bind-mount fixtures and real `/proc` mount identities. Docker overlay root or mounting only `/opt` is insufficient. Provision only an owned disposable supported-root runtime; never weaken production guards. Generate the five filesystem result goldens through actual `TestResultGoldens/file.write-filesystem` execution, then independently check and commit. Source-only parser fixtures are not Linux acceptance.

Private helpers and logs remain under `/Users/saivedanthava/.codex/zenith-production/`. Current labels: `prod-durable-rotation-full-root`, `prod-durable-rotation-platform-postgres-root`, `prod-durable-rotation-supabase-root`, `prod-durable-rotation-native-opa-root`, `prod-durable-rotation-arm64-root`, `prod-durable-rotation-amd64-root`. Before continuation, inspect final receipts and source hashes rather than assuming a running gate finished. All live/external/default-composition and operational proof remains separately required.

## Source disk checkpoint

Owned 35 guest and seven Linux-CI source, including untracked additions and tracked binary patches, saved privately at `/Users/saivedanthava/.codex/zenith-production/checkpoints/progress-20261003T063411Z`. Each archive carries its exact base, branch and SHA-256 inventory. No Git metadata, dependency trees, raw results, credentials or unrelated user files included. Source remains unmerged and unpushed. Go formatting changed only 15 owned Go files; root Linux-target vet/build/test compilation passed for both ARM64 and AMD64. Actual native behavior remains required.

This documentation snapshot may advance the published branch beyond the last fully inspected CI source `746e4ee`. After push, read the exact new run by its head SHA and inspect all terminal jobs/logs/artifacts before any green claim. No unattended continuation is promised.
