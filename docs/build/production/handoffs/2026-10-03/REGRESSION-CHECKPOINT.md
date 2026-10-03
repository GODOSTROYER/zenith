# Regression checkpoint, 2026-10-03

Recorded 2026-10-03T04:56:15.642728+00:00. Resumed work active; no current task paused. Production mission incomplete.

## Evidence checklist

- [x] Historical a14 CI: 14/14 jobs passed. Latest pushed290540c/[CI37087774593](https://github.com/GODOSTROYER/zenith/actions/runs/37087774593): 13 passed,1 failed; mandatory dependency audit blocking.
- [x] Isolated durable source15e4453, 57 frozen paths: Saivedant author and committer. Targeted actual PostgreSQL/OpenTofu1,532P/0F/0S; Supabase251P/0F/0S; kind provider6P/0F/0S, release1P/0F/0S. Source unmerged.
- [x] Packaged workers: AMD64 emulated335.76s and ARM64 native300.27s passed. Actual entrypoint, local database/Temporal, readiness/outage recovery, assets and idle shutdown; broader production operations unproved.
- [x] Full-gate prechecks: typecheck, lint, generated artifacts, OPA213/213 and Go race226top+539subP/0F/3Linux-onlyMacS passed.
- [ ] Full unit **16,588P/70F/212S**, 946.98s, 18 affected files. Canonical workflows/policy/OpenTofu phases not executed after exit1. [Failed receipt](../../evidence/durable-plan/full-regression-failed.json).
- [ ] First CI-fixture root check:418P/1F/0S; compiler/lint passed, Go not run. Explicit network-gated secrecy coverage correction required. [First-attempt receipt](../../evidence/durable-plan/ci-fixtures-failed.json).
- [ ] Dependency clearance: five findings remain blocking; inactive support registry empty, no risk acceptance.

## Agent checklist

- [x] Guest gap assessment: 37 source files unchanged; typed guest mutations and convergent services absent. No implementation or runtime acceptance claim.
- [x] `/root/durable_plan_resume`: correction source frozen, 66 owned paths and 18 changed paths. Immutable replan refusal, captured lazy canonical custody, SQL proof binding, paired fixture corrections and typed/doc fixes. Source remains unmerged.
- [x] CI-fixture worker: eight frozen r2 files; complete network-gated inventory and strict negative fixtures retained. Original 418P1F0S preserved.
- [x] `/root/security_exception_corrections`: six frozen r3 support files. Signed advisory scope, final clock, symlink and SemVer defects fixed. Root295P0F0S, actual audit fails five findings, empty registry.
- [x] `/root/durable_security_review`: latest durable/CI/typed-doc and security r3 source reviews clear. No runtime claim from reviewers.
- [x] Root combined affected checks: compiler/lint/gofmt/vet/Go passed;1079P0F20S. PostgreSQL skips require actual database lane.
- [x] Root corrected32-path actual PostgreSQL/OpenTofu passed1532P0F0S/70groups/12bindings and execution revalidation. Focused123P0F5S/compiler/lint/Go passed. Earlier1527P5F0S and owned cleanup retained.
- [x] Corrected Supabase251P0F0S, fresh kind6P0F0S+1P0F0S passed; owned cleanup complete. Three checked worker commits merged into isolated staging1ce6191 as Saivedant.
- [ ] Full staging gate failed one Go rotation test:225top+539subP/1F/3Linux-onlyMacS. Source-only rotation correction active, no unit/later phase rerun yet. Architecture startup and pushed source CI observation remain required.
- [ ] Partial acceptance cleanup:12-path guard unmerged. Execute refuses destruction; durable authoritative success contract missing.
- [x] No current paused tasks. Two source-only workers active: runner key rotation and Linux file.write. Root owns verification/integration; historical pause snapshots preserved.

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

Full goal: [78-requirement checklist](../../PROGRESS.md) and [acceptance details](../../REQUIREMENTS.md). **5 verified,19 in progress,54 planned.** Acceptance states do not measure implementation effort. Implementation complete, sandbox verified, pilot ready and production approved all false.

## Ownership and source locations

Main: `/Users/saivedanthava/Desktop/zenith`, branch `codex/production-2026-10-02`, pushed290540c. Preserve37be ancestry and all newer/untracked user changes. Candidate15e4453 stays isolated. Combined staging `ws/prod-durable-full-integration` starts at15e4453.

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

Latest approximately26GiB free; Docker0images/containers/volumes,0B build cache after corrected kind cleanup. Keep12GiB before image gates; one heavy local process on8GBMac. Same-lock owned dependency consolidation reclaimed1.14GiB. No global prune or unrelated deletion.

Disposable PostgreSQL/Temporal/kind and execution-worker tests approved. API/server startup and dedicated AWS account/region/budget pending. Live cloud/DNS/private-source and managed-cluster fixtures, retention deletion, commercial choices and production signoff remain operator prerequisites. No secrets in chat. Unblocked source work continues.

Next reviewed checkpoint estimate:2–4hours, dependent on bounded corrections and serial verification. Prior45–90minute estimate superseded by70full-suite failures. Full production date not schedulable before remaining implementation/access/operational proof. No unattended background-work claim.

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

- Isolated staging `ws/prod-durable-full-integration` at `1ce61919b2dd6fed04b00dd82e2de3ce229b8752`; source clean. Full gate failed at Go race. [Staging commits](../../evidence/durable-plan/corrections-staging.json), [Go failure](../../evidence/durable-plan/corrections-full-go-failed.json).
- `/root/durable_plan_resume` now owns bounded runner trust-persistence correction in `/Users/saivedanthava/.codex/zenith-production/worktrees/runner-key-rotation`, `ws/prod-runner-key-rotation`, base1ce6191. Private brief `briefs/2026-10-03-runner-key-rotation.md`. No protocol/machine/module edits; root tests pending.
- `/root/guest_file_write` implements actual unprivileged Linux local-template file.write in `/Users/saivedanthava/.codex/zenith-production/worktrees/guest-configuration`, `ws/prod-guest-configuration`, base1ce6191. Private brief `briefs/2026-10-03-guest-file-write.md`. Narrow additional ownership authorized: runner dispatch test plus provider refusal text only. No worker services/Docker/Go tools/Git; root Linux/golden/protocol checks pending.

Do not retry full gate as though the failed Go case passed. Review and test rotation correction, merge verified owned branch into staging, run complete canonical gate; dependency failure stays visible. New guest work is separate and must freeze/review/pass actual Linux behavior before integration. All78requirement release statuses remain incomplete where stated.
