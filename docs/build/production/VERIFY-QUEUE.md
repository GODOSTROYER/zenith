## 6 October corrected verifier candidate: three local failures repaired, native service acceptance pending

Current integrated code `56aeb01a0bfd306df9135223540c592c12676fd8`: source-pin correction `005cd1cc`, public synthetic fixture modes `7a3c1909`, and strict idle systemd Job correction `56aeb01a`. Independent source reviews retained all100 native identities,152 guest cases,15 service cases, ownership, UID/GID, capabilities, NoNewPrivileges and cleanup guards. Upstream systemd255 prints a present empty `Job=` for an idle job; missing/duplicate/foreign/nonempty values still refuse.

Whole local source228 finished19650 passed/3 failed/1280 skipped. Two failures were stale native100 source hashes; one fixture model assumed0644 despite the gate's077 umask. Child settled and owned data removed; strict gate stopped before security/OPA/OpenTofu. The failed attempt remains retained: [unit receipt](evidence/PROD-CI-08/2026-10-06-unit-22857333.json). Exact successor7a passed both affected suites438/0/0 under077. Reviewed idle-Job packet passed root181/0/0; this is packet-postimage contract evidence, not native service execution. Actual integrated56 passed full compiler/lint. [Correction scope](evidence/PROD-MACH-01/2026-10-06-systemd-fixture-corrections.json).

Published `45b853afbb519ddc85372c5c43c451943471c766` is now terminal: main run37390088534 has14 successful/2 failed jobs (Go,Verify); native37390086824 has2 fresh successes,22 cases and six cleanup proofs each nativeAMD64/ARM64. Verify19412 passed/2 failed/1519 skipped; both failures are the repaired source-pin comparisons. Typecheck/lint passed; Smoke/Gimbal skipped. Go152 and goldens passed, but service setup failed at `setup-unit-poststate`;15 cases unexecuted, service cleanup failed/canonical cleanup skipped. Platform3034/0/8 with1124 required (1107 PG plus17 SDK), PG322/0/0 with80, workflows1273/0/0 with60, policy238/0/0, OpenTofu3916/0/18, reconciliation38/0/0 and intents156/0/0 passed in separate lanes. No overlapping sums. [Every job and source-bound counts](evidence/PROD-CI-08/2026-10-06-ci-45b853af-final.json). Corrected56 still requires complete new observation.

Corrected56 full local gate is running in a clean isolated worktree; actual service15 plus both cleanups and every final pushed CI job remain required.

No requirement promotion:78 original criteria,6 verified/44 in progress/28 planned, four release flagsfalse. Same branch/Saivedant identity. MACH03 route42 and wave2 joins8 remain held; two real critical-schedule tests are being prepared independently. Next: finish coherent gates, publish fixes/evidence normally after predecessor terminal, inspect native service execution, then fixed wave1/wave2 order. Default API/server, live resources and broader building-agent capability gaps remain open.

Current integrated verifier code `22857333`: actual PostgreSQL source80a4 passed native100100/0/0, platform3034/0/8, PG322/0/0, workflows1273/0/0, reconciliation38/0/0, intents156/0/0 and migrations/strict validators; owned cleanup confirmed. Fresh kind228 provider6/release1/guest48 all0F0S and cleaned. Linux custody fix57c30782 has root179/0/0 and independent source review; real systemd15 and full new CI still required. Full local gate currently running on frozen228. See latest [RESULTS](verification/RESULTS-2026-10.md); older chronology remains source-scoped. Same branch, Saivedant identity,20 verifier obligations/78 original criteria/four false release flags preserved.

## 6 October current verifier: workflow correction committed, combined candidate failed

Primary code `59d583884f5d34eb452eddd984a23c10676f8b56` fixes only two stale systemd workflow-condition expectations after independent review. Root111 passed /0 failed /0 skipped and scoped lint passed. Production guards, exact conditions and cleanup fence remain intact. Diagnostics `1aeed6e6` still await hosted execution.

Published `cd71457de4503d69e0828eaba611833ad743b852` is now terminal: main run37380124397 has14 successful /2 failed jobs (Go and Verify); native run37380124506 has2 successful jobs, each22 checks and six cleanup proofs on fresh native AMD64/ARM64. Unit19400 passed /2 failed /1515 skipped; both failures were the corrected expectations. Go152 and goldens passed, but systemd setup and cleanup refused; new15 cases, subsequent root cleanup and interop/crossbuild steps did not execute. Smoke/Gimbal skipped after Verify failure. No complete CI success.

Isolated LIFE-12 candidate `6bdf5adf1acd678e3df986fffbb210874c280839` executed seven real PostgreSQL ownership/race controls successfully. Combined gate failed: native10099/1/0; platform3030/4/8; PostgreSQL322/0/0; workflows1273/0/0; reconciliation38/0/0; intents154/2/0. Reports overlap and are not summed. Fresh/reapply/published27-to29 upgrade and Supabase migrations passed. All owned container/volume/image cleanup proofs passed, baseline resources preserved. [Candidate evidence](evidence/PROD-LIFE-12/2026-10-06-pg-6bdf5adf.json).

Reviewed corrections preserve all100 native identities and add explicit foreign-tenant coverage for the new ownership helper. Two remaining historical-schema failures require a narrow fixed-literal claim query: private null ownership result uses the original query; non-null retains every guarded predicate. No published migration changes or schema-probing bypass. Current repair is not runtime accepted or root-integrated. Default API/server, live accounts and wider build-agent feature gaps remain separate blockers. All78 criteria,6 verified/44 in progress/28 planned, and four false release flags remain unchanged.

Current verifier successor `1aeed6e6`: reviewed fixed-phase systemd diagnostics/root174pass. Published predecessor `cd71457d` main14success/1Go setup failure/1Verify pending; nativeARM/AMD22 each passed. Complete predecessor observation before pushing successor; actual systemd15 still unexecuted. LIFE-12 safety repair remains unintegrated pending review and native PostgreSQL races. HANDOFF-VERIFIER fixed20 order supersedes historical instructions below; Saivedant identity and same branch.

# Verification queue (for the verifying agent)

Current verifier code checkpoint: `7d1a89fb`, exact local PostgreSQL acceptance at `3346e4d4`; prior published `68a1f3b7` CI14 success/2 failure, nativeARM22 success/AMD recovery failure. Fresh pushed CI remains required. Read latest RESULTS and evidence above older chronology; preserve newer ancestry and user files. Tests/minimal fixes only; Saivedant identity; HANDOFF-VERIFIER fixed order applies.

Current override: branch `codex/production-2026-10-02`, candidate `5f4713a7`, Saivedant Hava <saivedant169@gmail.com>. Retain all20 verifier obligations and fixed order. CI repair not complete; actual executed counts in latest RESULTS section. Older prod/compose and Arnav instructions below are historical and superseded by human authorization.

> Scope contract and required deliverables: [HANDOFF-VERIFIER.md](HANDOFF-VERIFIER.md). Read it first.

Branch to verify: `prod/compose`. Verify the exact tip you checked out; run `git rev-parse HEAD` first and record that SHA in every piece of evidence. If you push fixes, the new tip is the SHA that evidence must name.

Nothing below has been executed by the builders. Every requirement here is `implementation_complete_verification_pending` in `ledger.json`. Typecheck, eslint, `emit-sql --check`, `capability-matrix --check`, `offered-catalog --check` and `production-ledger --check` were the only checks run at assembly time.

## Rules for you

- You may fix failures and commit. Identity: `Arnav Bule <arnav.bule05@gmail.com>`, no Co-Authored-By trailer, no em dashes in messages.
- Push only normally to the same branch (`prod/compose`). No force push, no history rewrite, no rebase of published commits.
- Never weaken, skip, delete or loosen a test, gate, pin or expectation to make something pass. Fix the cause. If a test is wrong, say why in the commit message and keep the original intent.
- Record evidence in `docs/build/production/ledger.json` using its schema: each evidence item has `level` (one of `ledger.evidenceLevels`), `result`, and a 40-hex `commit`. Do not invent levels.
- Keep pending, failed and passed distinct. A failed or unrun lane is recorded as such, never as passed.
- Mark a requirement `verified` only when every evidence level its acceptance needs is met on the exact commit. Otherwise leave it `in_progress` and keep `implementationStatus` honest (for example `verification_partial_<what_remains>`).
- After a run, update the Results section of this file and re-run `node scripts/build/production-ledger.mjs` so REQUIREMENTS.md stays current (`--check` must pass).
- No credentials in the repository or in chat. Run heavy Docker/DB lanes serially. Clean up only resources you own.

## Migrations as shipped on this branch

Platform migrations: 17 MACH-03 runbooks, 18 LIFE-12 ownership_transfers, 19 OBS-03 incident_stability, 20 COST-03 optimizer_settings (registry in `src/lib/controlplane/db/migrations/index.ts`, contiguous 1..20). Supabase files are cumulative snapshots and published ones are immutable: `0018_platform_core.sql` is byte-identical to base `76a0652`; the new aggregate is `0019_platform_core.sql` (it contains migrations 1..20, generated by `npx tsx scripts/platform/emit-sql.ts`). `scripts/ci/apply-supabase-migrations.sh` applies `0018` then `0019`. A database that applied `0018` alone is behind and must apply `0019` (or run `npm run migrate:platform`).

## Order

1. The full CI-repair runbook: [verify/PROD-CI-REPAIR.md](verify/PROD-CI-REPAIR.md) section 3 (covers PROD-CI-05, PROD-CI-08, PROD-CI-09). Do this first; later requirements depend on a working platform-postgres lane.
2. Then each requirement below, in this order: MACH-01, OBS-02, LIFE-02, LIFE-12, MACH-03, OBS-03, COST-03.
3. Finally, one full pushed-CI inspection on the exact final commit (CI-REPAIR step 8).

Common setup: Node 22; `export ZENITH_TEST_PLATFORM_PG_URL=<owned PG16 url>` where a block says so; Go with `GOTOOLCHAIN=local`.

## Per requirement

### PROD-CI-05 / PROD-CI-08 / PROD-CI-09
Doc: [verify/PROD-CI-REPAIR.md](verify/PROD-CI-REPAIR.md). Commands: `python docs/build/production/transfer/2026-10-05/verify.py`; `npm run typecheck`; `npm run lint`; `npx vitest run tests/ci tests/docs/operator-docs.test.ts tests/machines/go-results.test.ts`; native100 `tests/controlplane/cleanup-writer-barriers.test.ts` with the REQUIRED env vars; `node scripts/ci/run-gate.mjs <lane> --run` then `--validate ... --require-execution` for platform-postgres, postgres, workflows, reconciliation, workflow-intents, policy, tofu, core; guest gate `scripts/ci/run-guest-file-write-gate.mjs` on real Linux; `opa check --strict policy/rego && opa test policy/rego`; packaged workers; then pushed CI per-job inspection. Note `tests/ci/platform-coverage.test.ts` now expects the committed list to end `0015_agent_oauth_grants, 0016, 0017, 0018, 0019`.

### PROD-MACH-01
Doc: [verify/PROD-MACH-01.md](verify/PROD-MACH-01.md). `npx vitest run tests/machines/service-configure.test.ts tests/machines/args.test.ts tests/machines/zenithd.test.ts tests/machines/file-upload.test.ts tests/machines/file-write.test.ts tests/machines/service.test.ts tests/docs/capability-matrix.test.ts`; in `go/`: `go test ./internal/machine/... -run 'ServiceConfigure|Executor|E2EMachine|MachineGrant'`; on Linux, unprivileged, fixed root: `go test ./internal/machine/ops -run ServiceConfigure -count=1` and `go test ./internal/machine -run ServiceConfigure -count=1`; `go vet ./...` for linux/amd64, linux/arm64 and host.

### PROD-OBS-02
Doc: [verify/PROD-OBS-02.md](verify/PROD-OBS-02.md). `npx vitest run tests/observability tests/machines/telemetry.test.ts tests/machines/service.test.ts tests/agent-v3 tests/security/signal-boundaries.test.ts`.

### PROD-LIFE-02
Doc: [verify/PROD-LIFE-02.md](verify/PROD-LIFE-02.md). `npx vitest run tests/offered-catalog tests/middleware/platform-bearer.test.ts tests/docs/capability-matrix.test.ts tests/agent-v3`; `npx tsx scripts/docs/offered-catalog.ts --check` and `--strict`. CI already runs the `--check` step; the test files are not yet in the gate manifest (see risks).

### PROD-LIFE-12
Doc: [verify/PROD-LIFE-12.md](verify/PROD-LIFE-12.md). `ZENITH_TEST_PLATFORM_PG_URL=... npx vitest run tests/capabilities/ownership-transfers.test.ts tests/capabilities/field-ownership-broker.test.ts tests/controlplane/tenancy.test.ts tests/controlplane/migrations.test.ts tests/security/controlplane-sql-scoping.test.ts tests/ci/platform-coverage.test.ts tests/docs/operator-docs.test.ts tests/ownership tests/providers/aws/drivers/compute/ecs-ownership-lifecycle.test.ts`; regression `npx vitest run tests/capabilities tests/reconcile tests/resources tests/providers/aws/drivers/compute tests/execution`. The doc's mention of `0020_platform_core.sql` is superseded: the aggregate is `0019`.

### PROD-MACH-03
Doc: [verify/PROD-MACH-03.md](verify/PROD-MACH-03.md). `npx vitest run tests/machines/runbooks.test.ts tests/machines/runbook-step-executor.test.ts tests/controlplane/machine-runbooks.test.ts tests/controlplane/migrations.test.ts tests/middleware/platform-bearer.test.ts tests/engine/postgres-scheduler.test.ts tests/docs` (also with the PG env var). `POST /api/internal/tick/runbooks` is now listed in `.github/workflows/tick.yml`.

### PROD-OBS-03
Doc: [verify/PROD-OBS-03.md](verify/PROD-OBS-03.md). `npx vitest run tests/incidents tests/controlplane/incident-stability.test.ts tests/controlplane/migrations.test.ts`, then the same with the PG env var. The migration is version 19 (`0019_incident_stability.ts`).

### PROD-COST-03
Doc: [verify/PROD-COST-03.md](verify/PROD-COST-03.md). `npx vitest run tests/placement/optimizer.test.ts tests/placement/optimizer-pass.test.ts`, `tests/placement`, `tests/capabilities/broker.test.ts`, and with the PG env var `tests/controlplane/migrations.test.ts tests/controlplane/tenancy.test.ts tests/security/controlplane-sql-scoping.test.ts`. The migration is version 20 (`0020_optimizer_settings.ts`).

## Known risks collected from the verify docs

- `tests/machines/file-write.test.ts:105` (`ZENITHD_OPERATIONS` not containing `package.install`) may already fail at base; check against `76a0652` before blaming MACH-01.
- `service.configure` result goldens were not produced: they need a real Linux unprivileged run on a fixed-root fixture (`ZENITH_UPDATE_MACHINE_GOLDENS=1`). Do not hand-write them. `package.install.json` golden bytes (key order from Go marshaling) are unconfirmed; `TestResultGoldens` plus `git diff --exit-code -- internal/machine/testdata/results` is the check.
- About 65 platform-postgres saved-plan dispatch failures were never diagnosed; the dispatch error now exposes the cause name and code. Read `error.cause` first. The native100 target is 100 passed / 0 failed / 0 skipped; the last attempt was 60/40.
- Likeliest first breaks elsewhere: the `inventoryForNativeOrigin` choice in `tests/controlplane/tenancy.test.ts`; OBS-03 SQL using `to_char(... at time zone 'utc')` and `pg_advisory_xact_lock(hashtextextended(...))`; the merged tenancy SWEPT sets (ownershipTransfers plus optimizerSettings) and the `EXPECTED_TABLES` unions in `tests/controlplane/migrations.test.ts`, which were resolved by hand in the merges.
- MACH-03: the runbook tick is in `tick.yml` but is not yet registered as a durable critical schedule; route handlers have no route-level test; step operations for critical capabilities fail closed unless policy allows them without a per-step approval; windows are UTC only; cloud-transport targets are refused.
- COST-03: no measurement collector is wired (utilization is an input), and there is no human opt-in endpoint for `optimizer_settings`; the optimizer cannot act until both exist. Non-container right-sizing needs the plan pipeline to consume an `optimize` input.
- OBS-03: the escalation channel is a durable record plus a platform event only; no paging or channel delivery exists. `reserveRemediation` has no production caller and no observer loop calls `observeSignal` (PROD-OBS-04 owns schedules).
- LIFE-02: `tests/offered-catalog/*` are not yet in `scripts/ci/gate-manifest.mjs`, so CI does not run them as a required lane. Adding them changes manifest pins; recompute pins, do not edit by hand.
- LIFE-12: revocation has a store function but no REST or UI route; ownership is rechecked at propose time only.
- OBS-02: all source evidence is `contract` or `simulated`; no live-provider run exists.
- Docker, Postgres, Temporal, kind, real systemd, the signed browser approval journey and hosted CI were never exercised for any of these requirements.

## Wave 2 (5 October 2026, assembled on prod/compose, build-only)

**Verify wave 1 first.** Everything above (CI repair, MACH-01, OBS-02, LIFE-02, LIFE-12, MACH-03, OBS-03, COST-03) must be run and green before the blocks below: wave 2 shares the migration registry, `tenancy.test.ts`, `platform-bearer.test.ts`, the generated Supabase aggregate and the platform nav with it, so a wave 1 failure will confuse every wave 2 result. No wave 2 byte has been executed: no vitest, go test, Docker, PostgreSQL, Temporal or cloud run. Typecheck, eslint (changed files), `emit-sql --check`, `capability-matrix --check`, `offered-catalog --check`, `production-ledger --check`, and Go `build`/`vet` were the only checks.

### Migrations and shared files as shipped

Platform migrations 21 OBS-04 `scheduled_job_runs`, 22 LIFE-01 `connection_rotations`, 23 LIFE-10 `release_pipelines`, 24 LIFE-11 `portability`, 25 MACH-04 `agent_lifecycle`, 26 UX-03 `plugin_boundaries`, 27 LIFE-08 `github_revocation_reason` (workers built them as 21, 22, 24, 25, 26, 28, 30 and the assembler renumbered to contiguous 1..27; checksums in DEPLOYING.md were recomputed). The new aggregate is `supabase/migrations/0020_platform_core.sql` (migrations 1..27, generated); `0016` to `0019` are untouched. `scripts/ci/apply-supabase-migrations.sh` applies `0019` then `0020`. Counts: `platform-bearer.test.ts` route inventory is now 65 (counted from the route files; LIFE-11's two portability routes were unclassified and are now in `bearer-paths.ts`); `action-bridge.test.ts` needed no edit (27 deliberately unmapped actions, checked against the registry).

Cross-requirement joins made at assembly (read these when a combined test fails):
- LIFE-09 provenance into LIFE-10: `admitBuiltArtifacts` (release.ts) is the single verification; its per-service result is handed to the release gate as `BeginInput.builtAdmission` and consumed by the registered `zenith.build-attestation` verifier as the `attested` verdict. Built images are held to `attested`; pinned images to `ZENITH_RELEASE_MIN_PROVENANCE` (default `pinned_digest`). Test: `tests/release-safety/built-attestation.test.ts`.
- LIFE-08 into LIFE-09: a non-root `contextDir` needs the inspection `contextDigest` in the pipeline spec; `admitBuildContext` re-derives it from the approved commit through `deps.sourceContext` (`createGithubContextVerifier`) before the bundle is prepared, and the digest is signed into the provenance statement and re-checked at admission. The product service source now carries optional `contextDir` / `contextDigest` and `expand.ts` passes them. No dedicated test yet for the re-derivation path (see risks).
- Platform nav: one list in `src/app/(product)/platform/_components/platform-nav.tsx` (Operations, Environments, Releases, Runbooks, Readiness, Runners, GitHub source, Plugins, Connections, Connect AWS, Workspace policy); the layout uses it alone.
- `tick.yml` gained the OBS-04 `status` pass.

### PROD-OBS-04
Doc: [verify/PROD-OBS-04.md](verify/PROD-OBS-04.md). `npx vitest run tests/platform/critical-jobs.test.ts tests/workflows/critical-schedule.test.ts tests/workflows/sandbox.test.ts tests/platform/housekeeping.test.ts tests/controlplane/migrations.test.ts tests/controlplane/tenancy.test.ts tests/security/controlplane-sql-scoping.test.ts`; real Temporal: `ZENITH_TEST_PLATFORM_PG_URL=... ZENITH_TEST_RECONCILE_SCHEDULE=1 ZENITH_TEST_TEMPORAL=1 ZENITH_TEST_TEMPORAL_CLI=<cli> npx vitest run tests/workflows/reconcile-schedule.test.ts tests/workers/reconcile-composition.test.ts`. Worker needs `ZENITH_STORE=postgres` for engine/alerts/outbox.

### PROD-LIFE-01
Doc: [verify/PROD-LIFE-01.md](verify/PROD-LIFE-01.md). `npx vitest run tests/connections tests/cli tests/middleware/platform-bearer.test.ts tests/bridge/connection-aws.test.ts tests/bridge/connection-kubernetes.test.ts tests/actions/connection-env-isolation.test.ts tests/platform/credentials-verification.test.ts tests/controlplane/migrations.test.ts tests/controlplane/tenancy.test.ts tests/security/controlplane-sql-scoping.test.ts tests/capabilities/action-bridge.test.ts tests/docs/operator-docs.test.ts`. PGlite plus synthetic cloud fetch.

### PROD-LIFE-08
Doc: [verify/PROD-LIFE-08.md](verify/PROD-LIFE-08.md). `npx vitest run tests/sources tests/middleware/platform-bearer.test.ts tests/controlplane/migrations.test.ts tests/controlplane/tenancy.test.ts`; lifecycle test is POSIX only; with `ZENITH_TEST_PLATFORM_PG_URL` also `tests/sources/github-webhook.test.ts`.

### PROD-LIFE-09
Doc: [verify/PROD-LIFE-09.md](verify/PROD-LIFE-09.md). `npx vitest run tests/execution/build-isolation.test.ts tests/execution/build-provenance.test.ts tests/execution/build-admission.test.ts tests/execution/release.test.ts tests/execution/journey.test.ts tests/execution/approved-source.test.ts tests/release-safety/built-attestation.test.ts tests/providers/aws/drivers/compute/codebuild.test.ts tests/providers/gcp/release.test.ts tests/providers/gcp/build-gcp.test.ts tests/providers/azure/release.test.ts tests/providers/azure/build-digest.test.ts tests/platform/release.test.ts tests/platform/release-multi.test.ts tests/platform/codebuild-launch-authority.test.ts tests/workflows`.

### PROD-LIFE-10
Doc: [verify/PROD-LIFE-10.md](verify/PROD-LIFE-10.md). `npx vitest run tests/release-safety tests/execution/release-safety.test.ts tests/execution/release.test.ts tests/execution/manifest-release.test.ts tests/providers/gcp/release-progressive.test.ts tests/providers/gcp/release.test.ts tests/providers/kubernetes tests/controlplane/release-pipelines.test.ts tests/controlplane/migrations.test.ts tests/middleware/platform-bearer.test.ts tests/platform/deploy-e2e.test.ts tests/platform/composition.test.ts tests/docs`; repeat the two controlplane files with `ZENITH_TEST_PLATFORM_PG_URL`. Behaviour change: tag-only images are refused.

### PROD-LIFE-11
Doc: [verify/PROD-LIFE-11.md](verify/PROD-LIFE-11.md). `npx vitest run tests/portability tests/execution/portability.test.ts tests/capabilities/portability-broker.test.ts tests/controlplane/tenancy.test.ts tests/security/controlplane-sql-scoping.test.ts tests/capabilities tests/execution tests/policy tests/security/policy-invariants.test.ts tests/docs tests/ownership`; real engines: `ZENITH_TEST_PLATFORM_PG_URL`, `ZENITH_TEST_POSTGRES_URL`, `ZENITH_TEST_S3_ENDPOINT` with `ZENITH_PORTABILITY_ALLOW_PRIVATE_HOSTS=1`, `ZENITH_TEST_MYSQL_URL` (see the doc for the exact files). `npx tsx scripts/docs/capability-matrix.ts --check`.

### PROD-MACH-04
Doc: [verify/PROD-MACH-04.md](verify/PROD-MACH-04.md). In `go/` with `GOTOOLCHAIN=local`: `go vet ./... && go test -race ./internal/release ./internal/agent/... ./internal/runner/... ./internal/machine/...` and `go test -race -count=3 ./internal/agent -run 'Spool|Heartbeat|Revocation'`; `npx vitest run tests/runners/lifecycle.test.ts tests/runners/store-contract.test.ts tests/runners/admin-routes.test.ts tests/runners/e2e-platform-store.test.ts tests/runners/late-effect-receipts.test.ts` (also with the PG env var). The real systemd update acceptance is manual and Linux only.

### PROD-MACH-05
Doc: [verify/PROD-MACH-05.md](verify/PROD-MACH-05.md). `npx vitest run tests/security/result-sanitizer.test.ts tests/runners tests/agent-v3 tests/agent-control* tests/security tests/execution/platform.test.ts`; `node scripts/test-agent-reader.mjs`; in `go/`: `go test ./internal/runner/... ./internal/redact/... ./internal/agent/...`. Expect to touch existing tests that assert the old `[redacted]` marker or exact runner registration labels.

### PROD-UX-01
Doc: [verify/PROD-UX-01.md](verify/PROD-UX-01.md). `npx vitest run tests/platform-ui tests/docs/operator-docs.test.ts`. The nav list moved: any assertion on the old `PLATFORM_LINKS` contents must follow the merged list. A real-browser accessibility pass (axe, keyboard, screen reader) is still owed.

### PROD-UX-03
Doc: [verify/PROD-UX-03.md](verify/PROD-UX-03.md). `npx vitest run tests/plugins tests/agent-v3 tests/agent-control-oauth.test.ts tests/capabilities tests/controlplane/migrations.test.ts tests/controlplane/tenancy.test.ts tests/security/controlplane-sql-scoping.test.ts tests/docs`; `ZENITH_TEST_PLATFORM_PG_URL=... npx vitest run tests/plugins/service.test.ts`.

### Wave 2 known risks

- The join code (`builtAdmission`, `minProvenanceFor`, `sourceContext`, `contextDigest` provenance field) was written at assembly without running anything. Likeliest first breaks: `tests/execution/build-provenance.test.ts` and `build-admission.test.ts` (new optional statement field, `contextDigest` expectation), `tests/execution/release.test.ts` and `journey.test.ts` (admission now returns a map; `beginRuns` input gained `admissions`), and `tests/release-safety/pipeline.test.ts` (new option).
- There is no test of `createGithubContextVerifier` or `admitBuildContext` yet: add owning, foreign and mismatched-digest cases beside `tests/sources/github-inspect.test.ts` and `tests/execution/build-admission.test.ts`.
- Merged tests added by different workers were never run together: `tenancy.test.ts` (SWEPT additions for `connectionRotations` and `plugins` use nonexistent ids as foreign probes), `migrations.test.ts` (`EXPECTED_TABLES` union; `scheduled_job_runs` has no `workspace_id` and is in `NO_WORKSPACE_COLUMN`), `platform-bearer.test.ts` (65), `operator-docs.test.ts` (migration inventory rows 21 to 27, new env vars).
- The `tick.yml` `status` pass is informational (200 unless `?strict=1`); a never-run job will not fail the workflow.
- LIFE-09, LIFE-10, LIFE-01, LIFE-08 and UX-01 touch the platform nav and `bearer-paths.ts`; check the nav contains each page and that no route is reachable but unlisted.
- OBS-04 and MACH-04 have Temporal and systemd acceptance that cannot be reproduced without those environments; record them as pending, not passed.
- Live cloud, hosted CI and the signed browser approval journey were never exercised for any wave 2 requirement.

## Results

Not yet run. Append one dated block per requirement here: SHA verified, commands, counts, and which evidence levels were reached or remain pending.

**Wave 2 assembly gap (write these tests first):** the cross-requirement joins added during assembly have no tests yet. Add vitest coverage for (1) build admission re-deriving LIFE-08 `contextDigest` and refusing a mismatched or non-inspected `contextDir`, (2) the single provenance admission path (LIFE-09 attestation consumed as LIFE-10 `attested` verdict; unattested Zenith-built images refused, pinned external digests admitted at `pinned_digest`), then run them with the rest of wave 2.

## Verifier checkpoint, 5 October 2026

- PROD-CI-05: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-ci-05).
- PROD-CI-08: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-ci-08).
- PROD-CI-09: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-ci-09).
- PROD-MACH-01: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-mach-01).
- PROD-MACH-03: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-mach-03).
- PROD-OBS-02: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-obs-02).
- PROD-OBS-03: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-obs-03).
- PROD-LIFE-02: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-life-02).
- PROD-LIFE-12: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-life-12).
- PROD-COST-03: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-cost-03).
- PROD-OBS-04: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-obs-04).
- PROD-LIFE-01: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-life-01).
- PROD-LIFE-08: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-life-08).
- PROD-LIFE-09: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-life-09).
- PROD-LIFE-10: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-life-10).
- PROD-LIFE-11: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-life-11).
- PROD-MACH-04: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-mach-04).
- PROD-MACH-05: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-mach-05).
- PROD-UX-01: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-ux-01).
- PROD-UX-03: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-ux-03).
