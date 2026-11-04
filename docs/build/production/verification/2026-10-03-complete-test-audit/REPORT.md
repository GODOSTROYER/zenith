# Zenith whole-project test audit, 3 October 2026

**Published source: 16,462 passed, 0 failed, 364 skipped in a fresh local full unit run. Pushed CI: 13 jobs passed and 1 failed. CI remains red. Production approval remains open.**

This audit answers which tests passed, failed or skipped, why they skipped, what additional evidence covers them and what product acceptance remains unperformed. Three independent read-only auditors reviewed source scope, local raw reports and remote artifacts in isolated worktrees. The lead reran published-source units and two missing-prerequisite follow-ups, independently checked reported counts and reproduced two test-harness gaps. No implementation source changed for this audit.

## Source and evidence boundaries

| Scope | Source | Evidence boundary |
| --- | --- | --- |
| Published branch codex/production-2026-10-02 | 9e62a15f57034bf21d8924a6c6e1e1c558bfe854 | Fresh macOS unit execution and terminal pushed CI run 37103826519 |
| Isolated durable staging | 356b7d014836e6cb39e54d4848f20d508fe31fde | Local full regression, actual databases/Temporal/OPA/OpenTofu, worker images and kind; not merged or pushed |
| Guest file.write candidate | Dirty 35-path source based on 1ce6191 | 267 TypeScript contracts plus Linux-target compilation; no native Linux writer acceptance |
| Guest Linux CI candidate | Dirty seven-path source based on 356b7d0 | 102 gate contracts/syntax checks; no actual hosted/native Linux acceptance |

The original wave-8 baseline 37be734 is an ancestor of published source. Historical paused patches were not replayed. A documentation commit publishing this dossier has its own CI run; the results here remain bound to the source commits above.

Raw reports and logs stay in private local evidence. Public exports contain assertion names/status/ordinals, selected sanitized receipts and original input hashes. Provider-format token strings, URL credentials and credential-like query values are redacted where present. Original name hashes retain traceability. No raw failure payloads, environment values or cloud credentials are published.

## Executed suites and gates

| Lane or check | Passed | Failed | Skipped | Scope / qualification |
| --- | --- | --- | --- | --- |
| Fresh published full unit | 16462 | 0 | 364 | 16,826 cases; 807 files; supported Node 22.23.3; 606.97 seconds |
| Pushed full unit | 16427 | 0 | 399 | Same 16,826 cases and 807 files; GitHub Linux environment |
| Pushed hosted Vitest | 1146 | 0 | 13 | 92 files; overlaps full unit |
| Pushed generated docs | 109 | 0 | 0 | Four files; overlaps full unit |
| Pushed actual PostgreSQL | 251 | 0 | 0 | 9 files / 9 required groups |
| Pushed actual platform PostgreSQL | 1422 | 0 | 0 | 46 files / 45 required groups |
| Pushed policy Vitest | 238 | 0 | 0 | 7 files / 7 required groups |
| Pushed real OpenTofu lane | 3900 | 0 | 0 | 121 files / 27 required groups; schemas and inert local applies |
| Pushed Temporal lane | 982 | 0 | 0 | 45 files / 44 required groups; real local engine, scripted cloud activities |
| Staging full unit | 16842 | 0 | 212 | 17,054 cases; 812 files; includes unpushed implementation |
| Staging real PostgreSQL | 1532 | 0 | 0 | 52 files / 70 required groups |
| Staging Supabase migration lane | 251 | 0 | 0 | 9 files / 9 groups; actual PostgreSQL apply/reapply and tamper refusal |
| Staging Temporal | 1000 | 0 | 0 | 45 files / 44 groups |
| Staging policy Vitest | 238 | 0 | 0 | 7 files / 7 groups |
| Staging real OpenTofu | 3900 | 0 | 8 | 122 files / 27 groups; eight PG-dependent handoff cases run separately |
| Native OPA | 213 | 0 | 0 | Interpreter cases, separate from 238 Vitest policy contracts |
| Fresh missing-PostgreSQL follow-up | 153 | 0 | 0 | Five files; 25 formerly skipped published cases now passed |
| Fresh Python-alias follow-up | 6 | 0 | 0 | Exact published collector suite; original six unit skips retained |
| Guest writer TypeScript | 267 | 0 | 0 | Dirty isolated source; includes five actual-network OpenTofu cases |
| Guest Linux CI contracts | 102 | 0 | 0 | Dirty isolated source; synthetic gate/JSON contract fixtures |

These counts overlap. Do not sum lanes, reruns, ancestor suites, browser step checks or Go subtests into one unique project total. Passing tests do not establish line/branch coverage or complete acceptance.

Go on corrected staging: 232 top-level cases and 541 subtests passed; zero failed; three top-level skips. Eleven tested packages passed; six packages have no test files. Some package results were cached. Go race in remote CI reports eleven passing package invocations but does not emit individual case/skip counts. Golden generation reports one package invocation; separate TypeScript interoperability has 19 passed, zero failed/skipped.

Browser evidence: agent browser 44 scripted step checks, hosted browser 24; separate agent and hosted journeys 35 and 22 checks. These are not Playwright test-case totals. Chrome 154.0.8037.57 was installed through Playwright core 1.56.1. Local fixture IdP and services do not prove external human approval, production OAuth clients or cloud serving. Smoke emitted its pass marker; no fabricated aggregate count. Gimbal checked two production assets.

Typecheck, eslint, application build, app Docker build, generated artifacts and workflow validation passed in pushed CI. App Docker build alone does not prove execution-worker startup. Staging full gate overall exit is failed because mandatory dependency audit remains red.

## Why the fresh published unit run skipped 364 cases

| Reason | Cases | Meaning |
| --- | --- | --- |
| Real PostgreSQL opt-in | 138 | This specific suite requires an actual PostgreSQL URL/contract opt-in. Platform suites use ZENITH_TEST_PLATFORM_PG_URL; legacy/Supabase contract suites require ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. Apply/secrecy/handoff additionally require real OpenTofu, network opt-in and, for handoff restore, matching PostgreSQL clients. File-specific guards below identify the exact condition. |
| Local Temporal server prerequisite | 117 | An existing ZENITH_TEST_TEMPORAL_SERVER or explicit ZENITH_TEST_TEMPORAL_DOWNLOAD=1 is required. Downloads are disabled in default unit execution. |
| Provider-schema network opt-in | 58 | ZENITH_TEST_TOFU_NETWORK=1 and, where checked, a detected OpenTofu binary are required. This tests real pinned provider schemas and negative persistence controls without cloud accounts. OCI MySQL creation remains separately guarded; its five skipped cases are network schema checks, not unsupported-capability skips. |
| Broken shell prerequisite detection | 13 | The native shell harness builds sh sh -s, which fails its probe. Root independently found sh -s succeeds. The thirteen guarded script assertions remain skipped; repair is still needed. FileRead also excludes Darwin, but the earlier broken probe already disables its cases. |
| Authorized live hosted-service fixture | 13 | ZENITH_CONTRACT_POSTGRES=1, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. The tracker branch also checks atomic functions. Disposable PostgreSQL contracts do not establish hosted bucket/data-service acceptance. |
| Disposable Kubernetes cluster opt-in | 7 | ZENITH_TEST_KIND=1 and a disposable KUBECONFIG are required; release tests also require a pinned non-root release image. Dedicated kind reports are listed separately. |
| Missing executable alias | 6 | The collector probes the literal python executable with -I. That alias was unavailable in this run although python3 exists. This is not an OS-wide Azure restriction and passing elsewhere is not Azure guest delivery proof. |
| Separate Temporal history opt-in | 2 | ZENITH_SEC_TEMPORAL=1 is required for these actual history checks, with a local test server. This flag is separate from ordinary Temporal suite enablement. |
| External mTLS acceptance opt-in | 2 | ZENITH_TEST_TEMPORAL_MTLS=1 and an authorized external namespace, address and certificate/key files are required. Disposable local Temporal does not prove external mTLS. |
| Explicit real-network opt-in | 1 | ZENITH_TEST_NETWORK=1 is required for the non-routable TCP timeout check. The default unit run disables this opt-in. |
| Nonportable stale path prerequisite | 1 | The compatibility guard requires a hard-coded Z:/Projects/.../ws-act product-port.ts path that is absent. Current repository product-port exists. Root separately matched 23 phase/title rows; this does not change the one skipped test. |
| Different operating system | 1 | This Windows inherited-ACL assertion runs only when process.platform is win32. The local report was produced on macOS ARM64. |
| OpenTofu template test opt-in | 1 | The skipped mock-provider template test requires ZENITH_TEST_TOFU and a detected binary, with provider initialization. It is distinct from ZENITH_TEST_TOFU_NETWORK. |
| Separate real-OpenTofu removal opt-in | 1 | ZENITH_TEST_DELETION_GUARDS_TOFU=1 and an available OpenTofu binary are required. The generic network provider opt-in alone does not enable this test. |
| Authorized public GitHub network fixture | 1 | ZENITH_TEST_SOURCE_GITHUB=1 plus an authorized repository and pinned 40-hex commit are required; ordinary mocked source tests do not replace this download check. |
| Authorized private GitHub App fixture | 1 | ZENITH_TEST_SOURCE_GITHUB_APP=1 plus app configuration, repository binding and a pinned commit are required. Store-only GitHub tests do not prove private App token/download acceptance. |
| Intentionally different backend | 1 | The scenario has an only-backend selector; the repeated FileStore instance is outside that scenario’s backend scope. Do not treat the FileStore repetition as an unexecuted universal backend promise. |

Exact file guards, line references, case names and unchanged-test-source separate-lane matches are in [SKIPPED-CASES.md](SKIPPED-CASES.md) and [skipped-vitest-cases.json](skipped-vitest-cases.json). There are 63 skip-bearing files in the fresh local run. Of 364 skipped cases, 305 have unique display-name matches passing in other parsed runs with identical test-file bytes; 59 lack such correspondence. These include staging runs with different production code and are not evidence that every published implementation path passed. All 31 fresh follow-up cases above ran on exact published implementation. Categories describe source guards and observed local prerequisites; standard Vitest JSON does not carry a runtime skip-reason string for every case.

31 formerly skipped published cases now executed in independent follow-ups: 25 PostgreSQL cases in journals (6+7), GitHub store (10), vault rewrap (1) and destroy review (1), plus six Azure collector Python cases. PostgreSQL follow-up aggregate is 153 cases because those files also contain other backend/unit contracts. No claim of 153 new unique database mutations. Owned disposable PostgreSQL and newly pulled image were removed. Temporary python alias was removed. Six Python collector passes establish local script behavior, not delivery through a live Azure VM agent.

Skips that can run locally without cloud accounts include disposable PostgreSQL, Temporal, provider-schema downloads, real local OpenTofu, kind, the controlled TCP timeout and Linux/systemd checks on a suitable disposable Linux host. External mTLS, actual Supabase HTTP/buckets, private GitHub App source and live provider lifecycles need the stated authorized fixtures. Windows ACL cases require Windows.

Some backend rows are not collected at all when factories omit an unavailable backend. In particular, the PostgresStore matrix requires ZENITH_CONTRACT_POSTGRES plus Supabase URL/service credentials. A skipped count is not a complete count of absent production acceptance. Database alerts/history require actual Supabase service behavior; bare PostgreSQL does not replace those HTTP paths. Backend-specific selectors can intentionally skip a FileStore repetition.

OCI MySQL correction: its five skipped cases are real-provider schema/persistence negative controls guarded by the OpenTofu network opt-in. They are not skipped because database creation is unsupported. Separate passing refusal checks establish creation remains disabled pending a safe provider-supported secret sink.

## Two confirmed test-harness gaps

### AUDIT-SSM-SHELL-01

The helper constructs native probe argv `sh sh -s`. Root harmless reproduction exits 126 with `/bin/sh: /bin/sh: cannot execute binary file`; correct `sh -s` exits zero. Thirteen SSM document cases therefore skip even with an available shell. A separate hostile-argv transport case returns when the same probe is absent and is reported passed without executing those shell assertions. Reported pass counts are retained honestly; they do not mean every path inside each case ran. FileRead additionally excludes Darwin, so corrected probing does not establish Linux-only file safety on macOS. Source repair and a required observable native gate remain pending. No product mutation vulnerability or cloud request was proved by this audit.

### AUDIT-BRIDGE-PATH-02

The compatibility test guards on an obsolete absolute Windows worktree path, which is absent on this host. Current repository product-port exists. Root independently compared 23 ordered phase/title rows and found them equal. That is a source comparison, not 23 executed cases or a replay of the original skipped case. Replace the stale prerequisite with repository-relative resolution and execute the case. Findings remain unfixed in this documentation-only audit.

Source audit also indexes nine conditional bare-return sites across seven files. These include intentional backend exemptions and host prerequisite checks. Only the SSM path above has root runtime probe evidence here; do not label every source-only candidate a proved false pass.

## Remote CI terminal result

[Run 37103826519](https://github.com/GODOSTROYER/zenith/actions/runs/37103826519) ran at exact published source 9e62a15 from 06:40:26Z to 06:59:18Z on 3 October. Thirteen jobs succeeded; supply-chain failed. All fourteen job logs and five canonical ZIP artifacts were captured, with archive digests matching GitHub metadata. Nine exact Git-object source/lock files matched captured source.

Supply-chain job 111148397074 failed `Known dependency findings block release`: @next/eslint-plugin-next, braces, eslint-config-next, fast-glob and micromatch reference [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). This is one advisory across five affected package entries, not five independent advisories. Lock integrity passed. The advisory lists affected braces <=3.0.3 and no patched release. No exception is approved or active. Dev/build reachability does not itself satisfy mandatory complete-lock security clearance.

Three skipped GitHub steps are unused fallback/cleanup branches, not skipped jobs or test cases: Go no-module fallback, platform no-migrator fallback, and setup-node post-step after dependency failure. Overall: 158 successful steps, one failed and three skipped across 162 steps.

Remote unit counts are 16,427 passed / 399 skipped; local exact-source counts are 16,462 / 364. All 807 file case totals agree. Twelve files account for 41 extra local passes with tools available, while six Azure collector cases passed remotely but skipped locally without literal python. Net local gain is 35. Follow-up with an isolated alias subsequently passed those six. Local skipped cases are therefore not a subset of remote skips. Remote raw case IDs/titles are unavailable; the public remote inventory is complete at file-count level, not 399 fabricated raw identities.

Remote skip-bearing files: 72. Source associations put 305 cases in 47 files associated with required canonical groups, three cases in two command-only files and 91 in 23 files outside the five canonical lanes. Those are file/source associations, not case-by-case raw status correspondence. Twenty-eight unit files contain zero passed cases; six nevertheless have a reporter checkmark. Case counts take precedence over checkmark summaries.

Independent reviewers reconstructed eleven schema-2 execution bindings; the twelfth private-inventory integrity flag is internally consistent. All five canonical lanes observed exit zero with matched nonzero required groups. Raw assertion reports and private environment inventories were not uploaded, so their hashes, ancestry/status matching and duplicate handling cannot be replayed independently from remote public artifacts. Tool version output is not executable-byte attestation.

## Packaged worker and local Kubernetes evidence

Corrected isolated staging has native ARM64 startup in 216.02 seconds and AMD64 startup under ARM64 emulation in 280.02 seconds. Both ran actual execution-worker entrypoints with local PostgreSQL/Temporal, schema checks, policy/signer loading, polling, readiness/liveness, dependency outage recovery and idle SIGTERM exit zero. An empty reconcile and signed no-target read refusal were exercised. UID 10001, 12 SSM assets, encrypted plan storage and retention sentinels were checked. Fourteen owned resources per run plus dedicated builders/cache/new images were removed. This is not fourteen test cases, native AMD64-host proof, authorized cloud deployment or in-flight mutation shutdown acceptance.

Fresh kind on staging passed provider 6/6 and release 1/1, zero failures/skips, with matching kubectl/server 1.37.0. Earlier mismatched-client evidence was retained and superseded by this supported-client rerun. Disposable cluster/kubeconfig/new images were deleted. Default kind CNI evidence does not establish enforced NetworkPolicy, managed-CNI two-tenant isolation, StatefulSet recovery or live cloud acceptance.

| Kind case | Result |
| --- | --- |
| kubernetes provider against a real cluster (kind) creates the namespace, policy and workload, then a second apply changes nothing | passed |
| kubernetes provider against a real cluster (kind) rolls out, and the drivers observe, verify and report runtime | passed |
| kubernetes provider against a real cluster (kind) refuses to touch a same-named object it does not own | passed |
| kubernetes provider against a real cluster (kind) restarts, scales and reads logs and events through the operations | passed |
| kubernetes provider against a real cluster (kind) deploys a new image, rolls back to the previous revision, and the pods follow | passed |
| kubernetes provider against a real cluster (kind) prunes what is no longer desired and never deletes the namespace | passed |
| Kubernetes release ports against a disposable kind cluster rolls out a pre-built digest, observes readiness and runs exactly one migration Job across retries | passed |

## Native Go skips

| Case | Observed reason | Needed execution |
| --- | --- | --- |
| TestRealSystemctlAndJournalctl | set ZENITH_TEST_SYSTEMD=1 on a host running systemd to run against real systemctl/journalctl | Explicit opt-in and suitable actual Linux/systemd host |
| TestDisksComeFromRealFilesystemsOnly | statfs is Linux only | Actual Linux filesystem |
| TestProcfsAgainstTheRealHost | needs Linux /proc | Actual Linux /proc |

Guest typed file.write candidate still has zero native Linux runtime acceptance cases. Six vet/build/test-compilation steps for AMD64/ARM64 are compilation evidence. Required root-filesystem, unprivileged UID/GID, trusted root allowlist, ACL/mount/symlink/atomic-write/crash, five authentic golden fixtures and browser-signed agent delivery must execute on supported disposable Linux. Docker overlay alone is not the admitted filesystem fixture.

## Historical failures remain recorded

No failed attempt has been rewritten as a passing run. Later results remain separately source-bound. The failed-case export omits raw error payloads.

| Attempt | Passed / failed / skipped | Resolution and evidence |
| --- | --- | --- |
| Original durable affected suites | 396 / 39 / 25 | Diagnostic correction: 438/0/26, then genuine PostgreSQL revealed a JSON SQL binding defect |
| Original durable actual PostgreSQL | 1517 / 11 / 5 | Corrected targeted 444/0/21; later full actual PostgreSQL 1532/0/0 |
| Original durable full unit15e4453 | 16588 / 70 / 212 | Corrections c121f89, cd60f8b, 50aa292; staging356 full unit16842/0/212 |
| Correction CI fixture | 418 / 1 / 0 | Secret-scanning fixture and strict manifest expectations corrected; separate later required suites pass |
| Correction combined target | 823 / 1 / 20 | Retained failed attempt; later targeted1079/0/20 and focused123/0/5 |
| Correction actual PostgreSQL | 1527 / 5 / 0 | Fixture environment repaired; later1532/0/0 |
| First corrected staging Go race1ce6191 | 225 top +539 sub passed /1 failed /3 skipped | TestNextKeysArePinnedAndPersisted exposed persist-before-publish defect; c355eee fixed retry/durable trust; staging356232 top+541 sub passed |
| Partial cleanup initial | 79 / 1 / 0 | Failed-suite retry7/0/0; no complete80-case success or authorized durable cleanup acceptance claimed |
| Original wave8 remote37be734 | 11 passing jobs /3 failed jobs | Migration/report/reproducibility defects subsequently corrected; do not reuse historical green as current-head green |

For the original 70 failed durable unit cases, 68 have exact unique file/fullName matches passing in current staging unit. Two gate-manifest display names changed; their current file passes, but direct stable identity closure is not established. Former PostgreSQL failures have separate actual-backend matching proof where available. Last source-change commits are indexed as context, not asserted as the sole causal fix for every case. See [historical-failed-cases.json](historical-failed-cases.json) and detailed local report.

## Published-source domain counts

Every test file is included. Parent-domain totals normalize root-level tests into one root group. Provider totals below are subsets of providers, not additional counts.

| Domain | Files | Passed | Failed | Skipped |
| --- | --- | --- | --- | --- |
| (root) | 15 | 225 | 0 | 13 |
| acceptance | 12 | 211 | 0 | 1 |
| actions | 28 | 359 | 0 | 0 |
| agent-access | 1 | 26 | 0 | 0 |
| agent-control | 1 | 0 | 0 | 16 |
| agent-link | 1 | 0 | 0 | 14 |
| agent-v3 | 16 | 284 | 0 | 0 |
| alerts | 5 | 141 | 0 | 0 |
| analysis | 7 | 352 | 0 | 0 |
| api | 16 | 198 | 0 | 0 |
| auth | 14 | 211 | 0 | 0 |
| bridge | 8 | 124 | 0 | 1 |
| capabilities | 12 | 383 | 0 | 0 |
| ci | 12 | 489 | 0 | 0 |
| cli | 5 | 120 | 0 | 1 |
| client | 7 | 30 | 0 | 0 |
| controlplane | 15 | 252 | 0 | 6 |
| cost | 1 | 18 | 0 | 0 |
| credentials | 10 | 296 | 0 | 1 |
| db | 15 | 110 | 0 | 37 |
| deploy | 1 | 62 | 0 | 0 |
| docs | 4 | 109 | 0 | 0 |
| drift | 1 | 8 | 0 | 0 |
| engine | 8 | 45 | 0 | 0 |
| execution | 30 | 588 | 0 | 5 |
| hosted | 90 | 1061 | 0 | 13 |
| hosted-spike | 2 | 85 | 0 | 0 |
| importers | 2 | 14 | 0 | 0 |
| incidents | 12 | 262 | 0 | 0 |
| logsim | 1 | 6 | 0 | 0 |
| machines | 15 | 581 | 0 | 19 |
| middleware | 1 | 66 | 0 | 0 |
| navigator | 13 | 152 | 0 | 0 |
| observability | 19 | 496 | 0 | 0 |
| placement | 9 | 139 | 0 | 0 |
| platform | 17 | 317 | 0 | 7 |
| platform-ui | 6 | 147 | 0 | 0 |
| policy | 7 | 238 | 0 | 0 |
| providers | 136 | 4330 | 0 | 48 |
| reconcile | 12 | 223 | 0 | 0 |
| resources | 9 | 448 | 0 | 0 |
| runners | 17 | 321 | 0 | 0 |
| screens | 84 | 1058 | 0 | 0 |
| scripts | 3 | 43 | 0 | 3 |
| secrets | 5 | 107 | 0 | 1 |
| security | 23 | 281 | 0 | 2 |
| server | 4 | 48 | 0 | 0 |
| shell | 6 | 62 | 0 | 0 |
| sources | 6 | 62 | 0 | 11 |
| spatial | 2 | 8 | 0 | 0 |
| tofu | 19 | 458 | 0 | 15 |
| ui | 9 | 67 | 0 | 0 |
| waitlist | 10 | 405 | 0 | 38 |
| workers | 3 | 28 | 0 | 0 |
| workflows | 20 | 308 | 0 | 112 |

## Provider scope

Provider unit assertions mostly validate schemas, compilers, authority guards and scripted transport behavior. Only explicitly marked real-engine/cluster/live reports establish those executions. Public provider unit counts:

| Provider | Files | Passed | Failed | Skipped |
| --- | --- | --- | --- | --- |
| aws | 44 | 1513 | 0 | 14 |
| azure | 22 | 546 | 0 | 9 |
| gcp | 17 | 648 | 0 | 8 |
| kubernetes | 15 | 386 | 0 | 7 |
| oci | 15 | 622 | 0 | 10 |
| shared | 7 | 123 | 0 | 0 |
| zenith | 16 | 492 | 0 | 0 |

OpenTofu network tests use real pinned schemas: AWS 6.66.0, Google 8.5.0, AzureRM 5.7.0, OCI 9.7.1 through OpenTofu 1.12.5. Schema validation and inert local applies do not prove actual cloud permissions, sovereign endpoint acceptance, lost-response recovery, DNS/TLS or application traffic. AWS family boundaries remain implemented; stack-first migration/live permission readback remain open. OCI MySQL stays unsupported. Non-AWS DNS ownership teardown, Kubernetes stateful/CNI and each source/build/release lifecycle still need their specified proof.

## Source inventory and canonical workflow coverage

Published source contains 807 Vitest files (724 Node/83 DOM), 37 Go test files with 230 top-level declarations and 6 Rego test files with 213 test rule declarations. Runtime parameterization and later staging source explain why declaration counts differ from executed cases. Five canonical lanes share one source manifest with required group, skip, zero-test and execution-receipt checks. Fourteen CI jobs and three additional workflow definitions were inspected. Vitest 4.1.11 positional filters use case-insensitive substring matching: tests/platform also selects platform-ui, so platform PostgreSQL has 46 files; workflows has 45 files and 44 required groups. Exact selected source sets match captured remote file inventories.

37 repeated file/fullName groups have74extra occurrences across25files in each current full-unit report. Case ordinals are retained. Display names alone cannot deduplicate universal case identities. Vitest numTotalTestSuites includes ancestor suite groups; actual file count is testResults.length.

## Complete production requirement checklist

Acceptance states remain 5 verified, 19 in progress and 54 planned across 78 requirements. These are not effort percentages. Implementation complete, sandbox verified, pilot ready and production approved remain false. No live-provider, default production composition, full operational recovery or business signoff is inferred from passing local contracts.

- [x] PROD-CI-01: Remote baseline reconciliation. State: verified; implementation: complete. Required evidence: remote_ci. Acceptance: Fetch current run36925770382/job logs, preserve exact11 success/3 failure facts and separate local/remote evidence.
- [x] PROD-CI-02: Canonical migration compatibility. State: verified; implementation: complete. Required evidence: contract, local_engine. Acceptance: Fresh/reapplied complete Supabase SQL passes canonical checksums, names and compatible schema checks; tampered/missing/incompatible schemas fail.
- [x] PROD-CI-03: Strict PostgreSQL scenario evidence. State: verified; implementation: complete. Required evidence: contract, local_engine. Acceptance: Real PostgreSQL JSON identifies each backend/scenario despite quoted labels; missing/failed/skipped/zero/malformed evidence fails, PGlite cannot substitute.
- [x] PROD-CI-04: Reproducible Temporal and source scenarios. State: verified; implementation: complete. Required evidence: contract, local_engine. Acceptance: Real local codec/destroy replay and pinned public source acquisition execute; externally authorized mTLS/private source have explicit prerequisites and release blockers.
- [ ] PROD-CI-05: Canonical gates and sanitized artifacts. State: in_progress; implementation: in_progress. Required evidence: contract, local_engine. Acceptance: One manifest drives local/CI commands, strict requirements and explicit external gates; commit/environment/dependency-bound artifacts omit secrets and untrusted diagnostic payloads.
- [x] PROD-CI-06: Supported runtime admission. State: verified; implementation: complete. Required evidence: contract. Acceptance: Node22 compatible patch and upper bound agree across metadata, CI, setup, doctor, hosted and recipe admission; fresh hosts reject unsupported runtimes.
- [ ] PROD-CI-07: Dependency vulnerability clearance. State: in_progress; implementation: in_progress. Required evidence: contract, local_engine. Acceptance: Reconcile advisories by ID/version/platform and production/build/dev reachability; safe patches, mandatory gates, reviewed expiring exceptions, no force upgrades.
- [ ] PROD-CI-08: Fresh complete verification. State: in_progress; implementation: in_progress. Required evidence: contract, local_engine, remote_ci. Acceptance: Clean installation, migrations, typecheck/lint/generated artifacts, real OpenTofu, OPA, Go race/interoperability, PostgreSQL, Temporal and real browser gates run with exact counts.
- [ ] PROD-CI-09: Observed green pushed baseline. State: in_progress; implementation: green_historical_baseline_new_advisory_reopens_current_head. Required evidence: remote_ci. Acceptance: Push nonprotected branch, observe entire new GitHub run through terminal status; pending/failed and external release gates remain visible.
- [ ] PROD-PKG-01: Linux worker image startup. State: in_progress; implementation: in_progress. Required evidence: contract, local_linux_arm64, local_linux_amd64. Acceptance: Build AMD64 and ARM64 execution-worker images and exercise actual entrypoint; distinguish native/emulated architecture evidence.
- [ ] PROD-PKG-02: Composed worker operation and shutdown. State: in_progress; implementation: in_progress. Required evidence: contract, local_linux_arm64, local_linux_amd64. Acceptance: Actual schema, signer, policy loading, Temporal polling, authorized operation, readiness/liveness and graceful shutdown pass with real disposable stores.
- [ ] PROD-PKG-03: Filesystem and plan lifecycle. State: in_progress; implementation: in_progress. Required evidence: contract, local_engine. Acceptance: Nonroot permissions, SSM assets, private plan storage, cleanup and runtime filesystem constraints pass under actual image execution.
- [ ] PROD-PKG-04: Supported installation topology. State: in_progress; implementation: in_progress. Required evidence: contract, local_engine. Acceptance: Reproducible API, durable product/platform stores, Temporal, workers and customer agents deploy from a clean host without hidden injected ports.
- [ ] PROD-PKG-05: Default browser API and MCP journey. State: in_progress; implementation: in_progress. Required evidence: contract, local_engine. Acceptance: Actual default composition handles browser/API/MCP proposal and human approval; independent application behavior proves outcomes.
- [ ] PROD-PKG-06: Durable database acceptance. State: in_progress; implementation: in_progress. Required evidence: contract, local_engine. Acceptance: Complete Supabase/hosted migrations, production TLS/pooler/authorization/concurrency/recovery acceptance is distinct from local PostgreSQL contracts.
- [ ] PROD-MIX-01: Execution partitions and authorities. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Partition graph by provider/account/region/backend; bind separate authorized connections before replacing existing cross-provider refusal.
- [ ] PROD-MIX-02: Parent and immutable child plans. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Dependency-ordered child workflows have immutable subplans, parent approval/evidence and durable receipts; stable resource addresses survive resume.
- [ ] PROD-MIX-03: Typed scoped dependency outputs. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Typed outputs/secret references preserve provenance and scope; newly materialized effects require review unless precisely preauthorized.
- [ ] PROD-MIX-04: Distributed failure and teardown order. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Cycles, partial success, timeout, expiry, cancellation, outage, drift/migration/teardown order fail safely; no fictional transaction or destructive automatic compensation.
- [ ] PROD-MIX-05: Protected cross-cloud connectivity. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Prove cross-provider network/DNS/TLS/identity/secret bindings, overlap handling and private connectivity or explicitly approved protected endpoints; databases never silently public.
- [ ] PROD-MIX-06: Real mixed application traffic. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: GCP compute, Azure PostgreSQL and AWS functions or justified equivalent serve actual application traffic with independently checked readback.
- [ ] PROD-MIX-07: Mixed-cloud recovery and economics. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Transfer/latency/residency costs included; one-provider failure recovery demonstrated; full acceptance harness exists even when live accounts unavailable.
- [ ] PROD-DUR-01: Durable intent and outbox. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Product, platform, Temporal and runner authorities have durable intent/outbox and idempotent start/signal across every crash window.
- [ ] PROD-DUR-02: Authoritative state and projections. State: in_progress; implementation: in_progress. Required evidence: contract, local_engine. Acceptance: Operation authority versus UI projection defined; independent workers and concurrent writers preserve state without treating local locks as external atomicity.
- [ ] PROD-DUR-03: Exact approved executable semantics. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Approval binds revision, recipe, scripts/migrations, targets/configuration, provider locks/backend and saved plan; changed relevant semantics invalidates approval.
- [ ] PROD-DUR-04: Dispatch authorization and bounded autonomy. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Policy/authorization rechecked at dispatch; browser-human approvals unforgeable; destructive/high-risk gates mandatory; standing grants are explicitly bounded.
- [ ] PROD-DUR-05: Durable encrypted plan handoff. State: in_progress; implementation: in_progress. Required evidence: contract, local_engine. Acceptance: Encrypted immutable plan artifacts work across independent workers with tenant access/integrity/expiry; sanitized PlanViews stay separate from raw sensitive data.
- [ ] PROD-DUR-06: Artifact cleanup and state backend recovery. State: in_progress; implementation: in_progress. Required evidence: contract, local_engine. Acceptance: Janitor writer/unlink race closed; supported backends prove locking/encryption/versioning/restore without unsafe deletion.
- [ ] PROD-DUR-07: Uncertain external mutation resolution. State: in_progress; implementation: in_progress. Required evidence: contract, local_engine. Acceptance: Partitions/stale fences/delayed calls/revocation/renewal preserve uncertain/conflict/tombstones; provider idempotency or receipts/readback enable evidence-based operator resolution and new authorization.
- [ ] PROD-DUR-08: Build and cleanup deduplication. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Build launches and external cleanup effects use durable receipts, independent readback and deduplicated retry rather than blind replay.
- [ ] PROD-LIFE-01: Connection administration lifecycle. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Default create/onboard/verify/revoke/rotate flows work through UI/API/CLI for supported providers and customer runners.
- [ ] PROD-LIFE-02: Versioned offered capability catalog. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Explicit matrix covers VM/container/serverless/triggers/jobs/data/cache/storage/messaging/network/firewall/DNS/TLS/identity/secrets/day-two; schema/refusal/mock-only paths are not offered services.
- [ ] PROD-LIFE-03: AWS family migration and suffixes. State: in_progress; implementation: in_progress. Required evidence: contract, local_engine. Acceptance: Stack-first boundaries and bootstrap suffix propagate into connection/compiler/role selection; maximum names/partitions/zones fit IAM and actual permissions independently verified without widening privilege.
- [ ] PROD-LIFE-04: Azure data plane and sovereign identity. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Trusted source wiring preserved; data-plane permission, sovereign identity/ARM endpoints and real source builds accepted.
- [ ] PROD-LIFE-05: OCI replacement and deletion evidence. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Same-runner receipts/lost-response uncertainty preserved; independent deletion completion and runner replacement recovery proven; MySQL remains unsupported pending safe secret sink.
- [ ] PROD-LIFE-06: Non-AWS ownership-safe DNS teardown. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: GCP/Azure/OCI DNS teardown proves ownership and refuses foreign/unreadable targets with human destructive approval.
- [ ] PROD-LIFE-07: Kubernetes full lifecycle acceptance. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Default build/guest credentials, StatefulSets, CronJobs, persistent data, real CNI NetworkPolicy and supported managed-cluster acceptance proven.
- [ ] PROD-LIFE-08: GitHub source binding lifecycle. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Bind/remove/uninstall/revoke and private-source acceptance; monorepo/Dockerfile/buildpack acquisition avoids arbitrary host execution.
- [ ] PROD-LIFE-09: Isolated untrusted build provenance. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Build identity/network/filesystem/resources deny deployment credentials and metadata; dependency downloads controlled, artifacts have verified provenance.
- [ ] PROD-LIFE-10: Release and data migration safety. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Source to build/digest/migration/readiness/cutover/readback works; progressive rollout/code rollback/compatible migrations separate from reviewed data restore.
- [ ] PROD-LIFE-11: Backup export import and adoption. State: in_progress; implementation: partial_cleanup_admission_in_progress. Required evidence: contract, local_engine. Acceptance: Supported backup/export/import/adoption and ownership-safe decommissioning pass with independently readable restored data.
- [ ] PROD-LIFE-12: Single owner per mutable field. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Native operations, IaC and autoscalers have explicit field ownership and conflict detection; no competing writers.
- [ ] PROD-MACH-01: Typed safe guest configuration. State: in_progress; implementation: bounded_file_write_source_reviewed_runtime_unverified. Required evidence: contract, local_engine. Acceptance: file.write/file.upload/package.install and convergent services use atomic changes, safe paths/symlinks, allowlists, privilege separation, backups and postconditions.
- [ ] PROD-MACH-02: Kubernetes guest credentials. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Default supported Kubernetes guest credential resolution is tenant-scoped, revocable and never falls back to higher privilege.
- [ ] PROD-MACH-03: Signed automation and scheduling. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Versioned signed scripts/runbooks, bounded targets/windows/cancellation/audit; raw exec remains approved high-risk escape hatch, argv parsing never claimed sandbox.
- [ ] PROD-MACH-04: Linux runner delivery and lifecycle. State: in_progress; implementation: bounded_rotation_root_verified_in_isolated_staging. Required evidence: contract, local_engine. Acceptance: Actual Linux registration/revocation, durable results, reconnect/offline recovery, key rotation and update/rollback pass.
- [ ] PROD-MACH-05: Local customer credential custody. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Supported runner modes keep credentials local; revoked bindings cannot trigger privileged fallback; model-visible results contain no secrets.
- [ ] PROD-MACH-06: Bounded evaluated coding agents. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Analysis and requirements lead to actual deployment journey; token/tool/runtime/spend budgets and task/unsafe/recovery evaluations enforced; repository/plugin data is not authority.
- [ ] PROD-OBS-01: Canonical observation-to-repair engine. State: in_progress; implementation: in_progress. Required evidence: contract, local_engine. Acceptance: Reconcile Temporal/HTTP/controller reuse one observe/diagnose/brokered proposal/policy/approval/remediate/verify lifecycle; repair:not_implemented removed with implementation.
- [ ] PROD-OBS-02: Fresh scoped telemetry provenance. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Logs/metrics/traces/provider events/resource events/machine health use scoped sessions, timestamps/provenance and explicit unknown/inaccessible results.
- [ ] PROD-OBS-03: Incident stability and escalation. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Deduplication/hysteresis/cooldowns/attempt and blast-radius limits/windows/escalation/postmortem; inconclusive diagnosis escalates, repair storms and autoscaler conflicts blocked.
- [ ] PROD-OBS-04: Durable critical schedules. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Critical observation/reaping use durable scheduling across restart, not only best-effort GitHub cron.
- [ ] PROD-MAN-01: Default managed substrate and sessions. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Default Zenith session opener/substrate/source build/release composition operates without manually injected test ports.
- [ ] PROD-MAN-02: Managed serving integrations. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Supported registry/gateway/DNS/TLS/secret delivery/storage/managed database integrations operate; established managed DB services reused.
- [ ] PROD-MAN-03: Tenant storage domains and service catalog. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Tenant object storage, domain ownership proof/renewal, DB export/restore, autoscaling and promised services function.
- [ ] PROD-MAN-04: Two untrusted tenant isolation. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Two tenants prove route/storage/CNI/metadata/FQDN-egress/pod security/quota/operator separation; sandboxed or stronger runtime evaluated against threat model.
- [ ] PROD-MAN-05: Resource isolation under load. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Noisy-neighbor/resource-exhaustion tests prove bounded tenant impact; namespaces alone do not establish isolation.
- [ ] PROD-MAN-06: Separable metering and billing. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Metering/quotas/plan assignment/invoice/payment-webhook reconciliation and safe suspension/export operate; BYOC/selfhosted do not require Zenith billing.
- [ ] PROD-MAN-07: Operator commercial decisions. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Pricing/terms/payment accounts and destructive retention await accountable decisions; nonpayment never silently destroys data.
- [ ] PROD-OPS-01: Measured service and recovery objectives. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Measurable availability/latency/capacity/RPO/RTO objectives defined and tested, with provisional targets clearly separated from accountable approval.
- [ ] PROD-OPS-02: Fair bounded control plane. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Backpressure/fair tenant scheduling/bounded queues/maintenance controls and correlated OpenTelemetry dashboards/alerts; workloads keep serving during control-plane outage.
- [ ] PROD-OPS-03: Rolling upgrades and replay. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: API/worker/runner upgrades with in-flight histories and schema/protocol compatibility/rollback pass.
- [ ] PROD-OPS-04: Clean-host restore and recovery epochs. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Restore product/platform/agent/hosted/source stores, Temporal/artifacts/customer state and keys; consumed approvals/mutations cannot resurrect, controlled epoch reconciliation/reopen required.
- [ ] PROD-OPS-05: Purpose-separated key custody. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Production signing and vault/result/Temporal encryption rotation retain decrypt-only histories with separated purposes and safe operator codec diagnostics.
- [ ] PROD-OPS-06: Sensitive persistence minimization. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Protect unavoidable raw plans/state, minimize persistence and test leaks; no claim redaction catches every unknown secret.
- [ ] PROD-OPS-07: Configurable non-destructive retention. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Archive/holds/bounded pruning preserve active/audit/receipts/replay prevention; implementation and dry-run allowed, deletion awaits approved policy.
- [ ] PROD-OPS-08: Independent adversarial security acceptance. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Tenant/role/stale-approval/SSRF/rebinding/prompt injection/archive/build/exfiltration/forgery/escalation/integration compromise tested independently.
- [ ] PROD-OPS-09: Verified release supply chain. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Pinned verified dependencies/SBOM/provenance/signed releases/updater verification/vulnerability triage/tamper-evident audit export ship; no unperformed certification claim.
- [ ] PROD-UX-01: Accessible privileged operator journey. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Connection admin/onboarding/readiness/plan/progress/cancellation/replan/reapproval/uncertainty/accessibility with consistent legacy/platform projections; MFA/step-up and workspace controls for privileged humans.
- [ ] PROD-UX-02: Configured client interoperability. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Actual coding-agent clients over MCP/SDK/CLI prove exact OAuth audiences/issuers/scoped consent/revocation/streaming/reconnect/cancellation/version compatibility using current primary docs.
- [ ] PROD-UX-03: Reviewed revocable plugin boundaries. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Plugin capability declarations/provenance/schemas/isolation/revocation; no token passthrough or direct credential/store access.
- [ ] PROD-COST-01: Source-backed dated price catalog. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Refreshable official-source-backed catalogs replace weak values and distinguish estimates/forecasts/actual spend.
- [ ] PROD-COST-02: Complete placement costs and constraints. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Include egress/NAT/IPv4/IO/requests/backups; reject infeasible budgets/residency/availability; estimates never represented as hard billing caps.
- [ ] PROD-COST-03: Bounded economic optimization. State: planned; implementation: not_assessed. Required evidence: contract, local_engine. Acceptance: Measurable bounded nonflapping optimizations respect approval/field ownership and transfer/latency/residency cost.
- [ ] PROD-REL-01: Required end-to-end release evidence. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Clean install/private source/plan approval/DNS-TLS/stateful traffic/update-rollback/machine schedules/drift-repair/revocation/crash-partition-writers/key rotation/upgrade/restore/mixed traffic/two tenants/export/teardown independently verified.
- [ ] PROD-REL-02: Requirement-to-evidence release dossier. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Every requirement maps implementation/tests/environment/commit/evidence and deployment/upgrade/recovery instructions; skipped/unperformed items remain visible.
- [ ] PROD-REL-03: Separate release status and signoff. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Implementation complete, sandbox verified, pilot ready and production approved are separate; production requires relevant live/operational evidence and accountable signoff.
- [ ] PROD-REL-04: Scope permission and resumable execution. State: planned; implementation: not_assessed. Required evidence: contract, local_engine, live_sandbox, operational_rehearsal. Acceptance: Approved budgets/disposable resources only; no unrelated services/purchases/terms/production/secret bypass/protected branches/history rewrites; consolidate decisions and checkpoint exact next commands without unattended-work claims.

Open release blockers include current dependency advisory disposition, native guest Linux acceptance, required source integration/fresh pushed CI, default API/browser/MCP composition, live AWS lifecycle/recovery, extended stateful Kubernetes/CNI/provider acceptance, genuine mixed-cloud orchestration and traffic, managed two-tenant serving/isolation, durable outbox/uncertainty/recovery, isolated builds, key rotation/restore/load/upgrades, client access and pricing/billing/operator decisions. Private accepted code and local evidence remain preserved; unperformed acceptance is visibly open.

## Reproduction and next commands

Run from exact intended source, with supported locked runtime and serialized heavy processes. Never reuse unrelated kubeconfig contexts or services. Keep URLs/passwords/certificate files in private environment inputs, not command logs or chat.

```sh
git rev-parse HEAD
git merge-base --is-ancestor 37be7340536ccb68ae4bb49294e8ab3799d1f01b HEAD
node --version
npm --version
npm ci
npx vitest run --maxWorkers=1 --reporter=default --reporter=json --outputFile=PRIVATE_REPORT
node scripts/ci/run-gate.mjs policy --run --report PRIVATE_REPORT --evidence PRIVATE_EVIDENCE
node scripts/build/production-ledger.mjs --check
```

Canonical lane usage and its exact prerequisites are in SOURCE-INVENTORY.md; use scripts/ci/run-gate.mjs's actual lane arguments, not guessed flags. The policy command shown is a valid example; run it only with its recorded OPA prerequisites. Use a different private output per invocation. Before starting default API/server composition, obtain the pending narrow permission. Actual PostgreSQL, local Temporal, kind and worker test infrastructure are already authorized. Use owned labels and pinned images; remove each owned cluster/container/builder/image after tests. Do not prune unrelated Docker state.

Next verification work: repair SSM probe and stale bridge path, make skipped/bare-return prerequisites observable, ensure uncovered PostgreSQL contracts have a required canonical lane, execute actual Linux guest acceptance on admitted filesystem, disposition mandatory vulnerability findings without a self-approved exception, integrate reviewed source only after gates, push normally and observe the complete exact new run. External mTLS/private App/Supabase/cloud acceptance need configured authorized accounts/fixtures; missing access remains a blocker while independent implementation continues.

## Documentation publication validation

Documentation checks passed 109 cases across four suites, zero failures/skips. Root independently rehashed all 393 local evidence inputs and verified exported derivative hashes, file/case totals and preserved requirement states. These checks are a separate rerun, not extra unique product cases.

## Artifacts and audit limits

- [Every passed/skipped local Vitest assertion](all-vitest-cases.csv), including ordinals and separate follow-up lanes.
- [Every local/remote Vitest file count](all-vitest-files.csv).
- [Every observed skipped case and prerequisite](SKIPPED-CASES.md).
- [Source inventory, owned scopes, scripts, workflows and acceptance mapping](SOURCE-INVENTORY.md).
- [Detailed local evidence, historical failures and correspondence limits](LOCAL-EVIDENCE-AUDIT.md).
- [Detailed terminal remote evidence and engine limitations](REMOTE-CI-AUDIT.md).
- [All78acceptance records](requirement-acceptance.json).
- [Native Go and kind identities](native-case-inventory.json).
- [Fresh follow-up receipts](follow-up-receipts.json).
- [Original private input hashes](private-input-hashes.json), retained for available original bytes; private inputs are not uploaded.

No line/branch coverage percentage was measured. No grand total deduplicates all overlapping languages/lanes/attempts. Remote case titles and raw environment report bytes are unavailable. No unexecuted certification, live-cloud, managed isolation or production approval claim. Public files are sanitized derivatives; original and exported SHA256 hashes intentionally differ. This dossier is a checkpoint, not a promise of unattended background work.
