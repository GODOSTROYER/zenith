# Independent remote CI evidence audit ;  run 37103826519

**Overall result: failure.** Thirteen jobs succeeded; the mandatory dependency audit failed. Five canonical real-engine lanes passed their declared groups with zero failed/skipped/unknown assertions. The broad unit suite passed 16,427 cases and skipped 399. This run does not establish all-project zero-skip acceptance or deployment readiness.

Exact source: `9e62a15f57034bf21d8924a6c6e1e1c558bfe854` on `codex/production-2026-10-02`, push run 268, attempt 1, created 2026-10-03T06:40:26Z; terminal update 2026-10-03T06:59:18Z. [Remote run](https://github.com/GODOSTROYER/zenith/actions/runs/37103826519). Evidence came from root’s completed local capture. This auditor performed no network requests or runtime verification.

## Exact jobs and observed gate outcomes

| Job | Remote job ID | Conclusion | What the job checked |
|---|---:|---|---|
| hosted | 111148396862 | success | Hosted suites; 22-check local acceptance; 24-check real Chrome journey |
| verify | 111148396918 | success | Workflow syntax, typecheck, lint, Node+DOM unit, smoke and production asset checks |
| workflows | 111148396932 | success | Pinned local Temporal development/time-skipping, immutable public Git fixture, canonical groups, execution revalidation |
| build | 111148396938 | success | Next production build |
| agent | 111148396939 | success | 35-check local link/revoke acceptance with one identity provider double; 44-check real Chrome approval screen |
| go | 111148396951 | success | Pinned toolchain, gofmt, vet, race, real golden regeneration+diff, TS interop, cgo-free amd64/arm64 cross-build |
| docker | 111148396953 | success | Root Dockerfile image build with no push |
| postgres | 111148396960 | success | Migrations, canonical hosted/agent/membership/waitlist PostgreSQL groups, execution revalidation |
| policy | 111148396972 | success | Pinned OPA strict reproducible bundle and interpreter tests; canonical policy groups, execution revalidation |
| platform-postgres | 111148396999 | success | Platform migrations, real PostgreSQL required groups, execution revalidation |
| tofu | 111148397021 | success | Pinned OpenTofu/provider schemas and required groups, execution revalidation; selected actual Go/OpenTofu tests |
| ledger | 111148397034 | success | Ledger Markdown current against its source ledger |
| supply-chain | 111148397074 | failure | Registry+integrity lockfile validation succeeded; mandatory known-dependency audit failed |
| generated | 111148397094 | success | Platform SQL and capability matrix check modes; documentation drift suites |

Metadata contains 162 steps: 158 success, 3 skipped and 1 failure. No job was skipped. The skipped steps are the Go “no module” fallback, platform-Postgres “no migrator” fallback, and supply-chain setup-node postcleanup. The first two conditions were false because the module/migrator existed; the postcleanup was skipped after the audit failed. None is a missing primary Go/migration gate. Every fresh log hash, summary and revalidator line is retained in `remote-job-evidence-audit.json`.

## Fresh counts ;  no grand-total inflation

| Measure | Passed | Skipped | Failed | Scope |
|---|---:|---:|---:|---|
| Core unit | 16,427 | 399 | 0 observed | 807 files; total 16,826 cases |
| Hosted Vitest | 1,146 | 13 | 0 observed | 92 files; overlaps core unit |
| PostgreSQL canonical | 251 | 0 | 0 | 9 files; 9 required groups |
| Policy canonical | 238 | 0 | 0 | 7 files; 7 required groups |
| OpenTofu canonical | 3,900 | 0 | 0 | 121 files; 27 required groups |
| Workflow canonical | 982 | 0 | 0 | 45 files; 44 required groups |
| Platform-Postgres canonical | 1,422 | 0 | 0 | 46 files; 45 required groups |
| Documentation drift | 109 | 0 | 0 observed | 4 files; overlaps core unit |
| Go golden TS interop | 19 | 0 | 0 observed | 1 file; overlaps core unit |
| OPA interpreter | 213 | 0 not case-exported | 0 observed | Separate Rego test measure |
| Hosted acceptance | 22 checks | not case-exported | 0 observed | Local publish/restore journey |
| Hosted browser | 24 checks | not case-exported | 0 | Real installed Chrome; local gateway |
| Agent acceptance | 35 checks | not case-exported | 0 observed | Local link/revoke; one IdP double |
| Agent browser | 44 checks | not case-exported | 0 | Real installed Chrome; next dev, IdP double |
| Go race | 11 packages | case counts unknown | 0 observed package failures | 6 additional packages have no test files |

The unit reconciliation parsed all 807 default-reporter file rows, not just terminal totals. Their totals sum exactly to 16,826; passed sums to 16,427 and skipped sums to 399. The reporter labels 785 files ✓ and 22 ↓. Twenty-eight files actually have zero passed cases: six are labeled ✓ despite all their cases being skipped. Reporter file labels are therefore not a substitute for case accounting. Full rows and log line anchors are in `remote-unit-files.json` and `.csv`.

The canonical lane aggregates overlap the unit suite and each other. Platform-Postgres 1,422 includes PGlite, mock and non-PG assertions; OpenTofu 3,900 includes compiler/SDK/mocked checks. Only explicitly selected backend/suite requirements establish the intended engine evidence. Neither aggregate is a count of exclusively real PostgreSQL or cloud executions. Required group counts may overlap by hierarchy and are not additive unique cases.

## Five artifacts and exact source binding

| Lane | Artifact ID | ZIP SHA256 | Evidence SHA256 |
|---|---:|---|---|
| platform-postgres | 11268025080 | `f113d53fc18c1b267891807fafe0b6d617b653a6d6c8bf7f28fda03b6be27600` | `ca6f57a670100abc70b565c161c3d49a936c44f8302458ff382f707eafa0cdd7` |
| policy | 11267740182 | `e1324189a5dcfbf4343386273485432f45bee6b7de92dbee9d2e85d2ed84e137` | `04d1c7a41060a3eef40e9eb33c04f316c2ce820e31ea6f40774d626b50eec389` |
| tofu | 11267425856 | `607fc0fc919b86ae63ad7b93e4995128752f065c0bdf7493cb91c1ca45f8a0eb` | `6571fa6ed74e79d47cbb1899167c9d96c1da9eafdc6054e28df8d501b7b0044e` |
| workflows | 11267186377 | `7528b38241ef7928e3592b73be8e47a86ac7e0fb61cea6287b3c82cf44229d72` | `a5f04f9f216656d8e653dfc8837ad20c889220763c9aabb6bd88a187684c27de` |
| postgres | 11266119704 | `1c9acab6d648e96c3fe9556e161a730aaa099491cbb259fcd01a569d7b74f3f5` | `564a0faec4f6d6b4e0ec7934126ef72726a2e34a10ff343673832ef1b3cc3058` |

Each ZIP digest matches its GitHub artifact metadata, run ID and exact head SHA. Each archive contains exactly one expected sanitized JSON file and its bytes equal the captured extraction. All five evidence documents have schema 1, passed verdict, positive counts, zero failures/skips/unknowns, exact trusted required IDs/files/backends, complete validation, and observed zero-exit schema-2 execution receipts with matching binding. All six embedded gate sources, lockfile hash, locked/installed dependency versions, commit and clean index metadata match exact source. The nine reviewed local sources were also compared independently against their exact Git objects.

For each lane this auditor rebuilt eleven receipt binding relationships from the sanitized payload, recomputed compact source/runtime/manifest hashes, stable requirement IDs and pretty origin-receipt digest, and compared all twelve exported flags. The twelfth environment-inventory flag is internally consistent with the comparison record. It cannot be replayed from original inventory values because that private inventory was not uploaded. The report digest likewise binds the embedded origin to the exported evidence but cannot be recomputed from a missing raw report. Manifest snapshots were supplied by root from exact source. This auditor independently rebuilt all five ordered required inventories from exact source declarations, test-directory enumeration, backend-suite regex rules and stable ID computation in Python: all 9/7/27/44/45 groups match snapshot contents and order. `independent-source-requirements.json` retains this check. Matching source hashes and runner configuration were audited offline without executing Node.

Canonical `--run` and later `--validate ... --require-execution` both passed in all five logs. The source runner removes old raw reports and origin sidecars before launching, captures an immutable observed outcome, and revalidates source/manifest/environment/report bindings. Validators fail missing/malformed/zero/failed/skipped-required reports, mismatched/missing receipts and nonzero observed execution. The inventory is private, sanitized evidence whitelists scalar counts/hash metadata, and full test names and environment values are excluded. Standard Vitest JSON lacks unique task IDs; the artifact explicitly says `not-exported-by-standard-vitest-json`.

Execution flags (all true in each artifact): `lane`, `reportSha256`, `manifestSha256`, `sourceSha256`, `sourceBindingComplete`, `effectiveEnvironmentSha256`, `environmentInventorySha256`, `shellContextSha256`, `shellLevelSha256`, `shellCommandSha256`, `runtimeSha256`, `environmentInventoryIntegrity`.

## Source-mapped skipped coverage

Seventy-two unit files contain skipped cases. Forty-seven files (305 skipped unit cases) have source-selected groups in the canonical manifests; two files (3 skipped cases) have command inclusion only; twenty-three files (91 skipped cases) are outside all five canonical commands. These are file/group associations. A partial required suite does not prove every skipped unit case in that file reran. `remote-skipped-files.json` retains source-only guard candidates with line numbers, group scopes, inclusion and inference limits. Full skipped case titles are absent from the remote default-reporter output and are never presented as captured identities.

| Unit file | Captured skips | Canonical association | Source guard candidate anchor |
|---|---:|---|---|
| [tests/waitlist/pg-contract.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/waitlist/pg-contract.test.ts#L208) | 38 | postgres (groups) | source:208; candidate only |
| [tests/credentials/bootstrap-templates.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/credentials/bootstrap-templates.test.ts#L654) | 1 | outside five lanes | source:654; candidate only |
| [tests/platform/deploy-e2e.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/platform/deploy-e2e.test.ts#L143) | 6 | workflows (groups) | source:143; candidate only |
| [tests/platform/source-bundle.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/platform/source-bundle.test.ts#L411) | 1 | workflows (groups) | source:411; candidate only |
| [tests/agent-control-journal-fixes.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/agent-control-journal-fixes.test.ts#L469) | 6 | outside five lanes | source:469; candidate only |
| [tests/machines/ssm-documents.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/machines/ssm-documents.test.ts#L326) | 14 | outside five lanes | source:326; candidate only |
| [tests/workflows/deploy.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/workflows/deploy.test.ts#L1) | 38 | workflows (groups) | source:1; candidate only |
| [tests/agent-control-journal.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/agent-control-journal.test.ts#L122) | 7 | outside five lanes | source:122; candidate only |
| [tests/agent-control/pg-contract.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/agent-control/pg-contract.test.ts#L248) | 16 | postgres (groups) | source:248; candidate only |
| [tests/scripts/migrate-hosted-to-postgres.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/scripts/migrate-hosted-to-postgres.test.ts#L593) | 3 | postgres (groups) | source:593; candidate only |
| [tests/agent-link/pg-contract.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/agent-link/pg-contract.test.ts#L223) | 14 | postgres (groups) | source:223; candidate only |
| [tests/db/contract/workspace-sharing.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/db/contract/workspace-sharing.test.ts#L159) | 22 | postgres (groups) | source:159; candidate only |
| [tests/security/tofu-workspace-injection.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/security/tofu-workspace-injection.test.ts#L285) | 4 | tofu (groups) | source:285; candidate only |
| [tests/execution/destroy-review.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/execution/destroy-review.test.ts#L261) | 1 | outside five lanes | source:261; candidate only |
| [tests/secrets/rewrap.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/secrets/rewrap.test.ts#L362) | 1 | outside five lanes | source:362; candidate only |
| [tests/controlplane/migrations.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/controlplane/migrations.test.ts#L338) | 3 | platform-postgres (groups) | source:338; candidate only |
| [tests/tofu/runner.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/tofu/runner.test.ts#L42) | 16 | tofu (groups) | source:42; candidate only |
| [tests/execution/journey.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/execution/journey.test.ts#L64) | 3 | tofu (groups) | source:64; candidate only |
| [tests/hosted/data/pg-contract.live.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/hosted/data/pg-contract.live.test.ts#L139) | 11 | outside five lanes | source:139; candidate only |
| [tests/hosted/artifacts/storage-store.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/hosted/artifacts/storage-store.test.ts#L351) | 2 | outside five lanes | source:351; candidate only |
| [tests/security/tofu-secrets.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/security/tofu-secrets.test.ts#L236) | 1 | tofu (groups) | source:236; candidate only |
| [tests/providers/aws/drivers/network/compile-graph.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/providers/aws/drivers/network/compile-graph.test.ts#L287) | 6 | tofu (groups) | source:287; candidate only |
| [tests/workflows/client.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/workflows/client.test.ts#L283) | 12 | workflows (groups) | source:283; candidate only |
| [tests/db/contract/history.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/db/contract/history.test.ts#L245) | 7 | outside five lanes | source:245; candidate only |
| [tests/db/contract/alerts.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/db/contract/alerts.test.ts#L106) | 7 | outside five lanes | source:106; candidate only |
| [tests/workflows/operations.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/workflows/operations.test.ts#L1) | 28 | workflows (groups) | source:1; candidate only |
| [tests/controlplane/executor.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/controlplane/executor.test.ts#L277) | 1 | platform-postgres (groups) | source:277; candidate only |
| [tests/security/tofu-runner-env.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/security/tofu-runner-env.test.ts#L85) | 3 | tofu (groups) | source:85; candidate only |
| [tests/tofu/backends.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/tofu/backends.test.ts#L126) | 4 | tofu (groups) | source:126; candidate only |
| [tests/db/contract/audit.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/db/contract/audit.test.ts#L212) | 1 | outside five lanes | source:212; candidate only |
| [tests/execution/compile-refs-providers.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/execution/compile-refs-providers.test.ts#L180) | 2 | tofu (groups) | source:180; candidate only |
| [tests/providers/terraform-lb-names.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/providers/terraform-lb-names.test.ts#L178) | 7 | outside five lanes | source:178; candidate only |
| [tests/controlplane/open.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/controlplane/open.test.ts#L202) | 2 | platform-postgres (groups) | source:202; candidate only |
| [tests/providers/oci/mysql.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/providers/oci/mysql.test.ts#L107) | 5 | tofu (groups) | source:107; candidate only |
| [tests/providers/gcp/bootstrap.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/providers/gcp/bootstrap.test.ts#L144) | 2 | tofu (groups) | source:144; candidate only |
| [tests/providers/gcp/tofu-validate.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/providers/gcp/tofu-validate.test.ts#L64) | 6 | tofu (groups) | source:64; candidate only |
| [tests/providers/azure/mysql.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/providers/azure/mysql.test.ts#L132) | 2 | tofu (groups) | source:132; candidate only |
| [tests/providers/azure/deploy.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/providers/azure/deploy.test.ts#L107) | 1 | tofu (groups) | source:107; candidate only |
| [tests/providers/oci/validate.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/providers/oci/validate.test.ts#L50) | 5 | tofu (groups) | source:50; candidate only |
| [tests/providers/kubernetes/kind.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/providers/kubernetes/kind.test.ts#L36) | 6 | outside five lanes | source:36; candidate only |
| [tests/providers/aws/drivers/messaging/assemble.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/providers/aws/drivers/messaging/assemble.test.ts#L116) | 1 | tofu (groups) | source:116; candidate only |
| [tests/workflows/worker.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/workflows/worker.test.ts#L1) | 1 | workflows (groups) | source:1; candidate only |
| [tests/tofu/ephemeral-network.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/tofu/ephemeral-network.test.ts#L56) | 5 | tofu (groups) | source:56; candidate only |
| [tests/workflows/ecs-replica-repair.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/workflows/ecs-replica-repair.test.ts#L1) | 11 | workflows (groups) | source:1; candidate only |
| [tests/workflows/reconcile.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/workflows/reconcile.test.ts#L1) | 2 | workflows (groups) | source:1; candidate only |
| [tests/tofu/network.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/tofu/network.test.ts#L35) | 4 | tofu (groups) | source:35; candidate only |
| [tests/providers/aws/identity/trust.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/providers/aws/identity/trust.test.ts#L95) | 1 | tofu (groups) | source:95; candidate only |
| [tests/execution/destroy-review-temporal.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/execution/destroy-review-temporal.test.ts#L60) | 1 | outside five lanes | source:60; candidate only |
| [tests/workflows/replay.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/workflows/replay.test.ts#L1) | 7 | workflows (groups) | source:1; candidate only |
| [tests/providers/aws/drivers/compute/assemble.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/providers/aws/drivers/compute/assemble.test.ts#L83) | 3 | tofu (groups) | source:83; candidate only |
| [tests/providers/aws/drivers/e2e-compile.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/providers/aws/drivers/e2e-compile.test.ts#L111) | 2 | tofu (groups) | source:111; candidate only |
| [tests/providers/azure/validate.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/providers/azure/validate.test.ts#L48) | 5 | tofu (groups) | source:48; candidate only |
| [tests/cli/config.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/cli/config.test.ts#L34) | 1 | outside five lanes | source:34; candidate only |
| [tests/providers/aws/drivers/data/assemble.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/providers/aws/drivers/data/assemble.test.ts#L96) | 1 | tofu (groups) | source:96; candidate only |
| [tests/sources/github-store.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/sources/github-store.test.ts#L72) | 10 | outside five lanes | source:72; candidate only |
| [tests/providers/gcp/identity/trust.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/providers/gcp/identity/trust.test.ts#L56) | 1 | tofu (groups) | source:56; candidate only |
| [tests/security/workflow-history.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/security/workflow-history.test.ts#L53) | 2 | workflows (groups) | source:53; candidate only |
| [tests/providers/azure/identity/trust.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/providers/azure/identity/trust.test.ts#L48) | 1 | tofu (groups) | source:48; candidate only |
| [tests/providers/kubernetes/release-kind.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/providers/kubernetes/release-kind.test.ts#L20) | 1 | outside five lanes | source:20; candidate only |
| [tests/workflows/codec-replay.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/workflows/codec-replay.test.ts#L27) | 2 | workflows (groups) | source:27; candidate only |
| [tests/workflows/approval-time.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/workflows/approval-time.test.ts#L1) | 3 | workflows (groups) | source:1; candidate only |
| [tests/acceptance/sample-app.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/acceptance/sample-app.test.ts#L26) | 1 | outside five lanes | source:26; candidate only |
| [tests/workflows/destroy-replay.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/workflows/destroy-replay.test.ts#L22) | 6 | workflows (groups) | source:22; candidate only |
| [tests/execution/deletion-guards-real.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/execution/deletion-guards-real.test.ts#L20) | 1 | outside five lanes | source:20; candidate only |
| [tests/acceptance/tofu-destroy.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/acceptance/tofu-destroy.test.ts#L29) | 1 | outside five lanes | source:29; candidate only |
| [tests/policy/parity.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/policy/parity.test.ts#L38) | 1 | policy (groups) | source:38; candidate only |
| [tests/tofu/hcl-template-real.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/tofu/hcl-template-real.test.ts#L14) | 2 | tofu (command only) | source:14; candidate only |
| [tests/tofu/destroy-real.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/tofu/destroy-real.test.ts#L13) | 2 | tofu (groups) | source:13; candidate only |
| [tests/workflows/mtls-live.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/workflows/mtls-live.test.ts#L9) | 2 | outside five lanes | source:9; candidate only |
| [tests/bridge/steps.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/bridge/steps.test.ts#L20) | 1 | outside five lanes | source:20; candidate only |
| [tests/sources/github-live.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/sources/github-live.test.ts#L7) | 1 | outside five lanes | source:7; candidate only |
| [tests/tofu/plan-lock.test.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/tofu/plan-lock.test.ts#L18) | 1 | tofu (command only) | source:18; candidate only |

External Temporal mTLS contributes two captured unit skips and is expressly excluded from the workflow lane as `external-temporal-mtls`, status unverified, with a release-blocker statement. Passing local development/time-skipping Temporal does not discharge it. The private GitHub App source test is one captured skip; the public immutable codeload fixture exercised by workflows does not replace private App acceptance. Kind cluster and release image tests account for seven skips outside the canonical lanes. Windows ACL configuration is one platform-inapplicable skip on Linux. Several opt-in PG journal/history/alerts/vault/source-store tests, network sample acceptance, destructive OpenTofu acceptance, and a developer-machine bridge projection fixture also remain outside the five commands. Their exact names are source-declared, not captured skipped-case titles.

The Go race log exposes 11 tested packages and 6 no-test packages, with no `-json` or `-v`; actual skip counts and identities cannot be recovered. All source-declared `t.Skip` sites and surrounding test names are inventoried in `go-source-skip-guards.json` as possible guards. The real systemctl/journalctl opt-in is absent from CI. The two real Go/OpenTofu tests skip without their binary/network prerequisites in the broad Go command, but a later dedicated tofu job selects both with the configured binary and network flag; that package succeeds. Linux arm64 is cross-compiled, not executed.

## Verification defects and release blocker

### REMOTE-AUDIT-01 ;  The overall run failed its mandatory complete locked dependency audit.

Classification: observed-release-blocker; priority P1.
Fresh supply-chain log lines 139–145 reports `@next/eslint-plugin-next`, `braces`, `eslint-config-next`, `fast-glob`, and `micromatch`, all resolving to `GHSA-vfj7-8cjw-p6xm`, followed by exit 1. This is five affected package findings sharing one advisory family, not five distinct GHSAs. The preceding integrity check passed 921 pinned registry packages, including 6 bundled dependencies. The source audit gate includes all severity levels and development/optional/peer dependencies, uses the lockfile-only registry report, validates complete counts and advisory chains, and grants no exemptions. Raw audit details are unavailable, so no severity/range/fix assertion is invented.
Follow-up outside the owned audit-output scope: Resolve dependency findings in a separate authorized source workstream and rerun the mandatory audit; preserve all-severity dev/optional/peer scope.

### REMOTE-SHELL-02 ;  Native POSIX shell availability helper forms sh sh -s, causing the probe to run sh as a script instead of consuming stdin with sh -s.

Classification: source defect independently reproduced by the root with a harmless native probe; priority P1.
Source: [tests/machines/_sh.ts:34](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/machines/_sh.ts#L34), [tests/machines/_sh.ts:48](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/machines/_sh.ts#L48).
Thirteen shell-guarded cases plus one OpenTofu-guarded case are source-consistent with the fourteen captured remote skips. Root independently reproduced the native argv defect with harmless stdin only: `sh sh -s` exited 126, while `sh -s` exited 0 with expected stdout. The root receipt is `AUDIT-SSM-SHELL-01`; all three exact source hashes match. This auditor did not run the probe. No SSM/cloud request or production mutation vulnerability was demonstrated. Thirteen script guard cases and one silent hostile-argv assertion path remain a verification gap; passing surrounding files is not proof those behaviors executed.
Follow-up outside the owned audit-output scope: Correct the native invocation shape, test the actual shell prerequisite, and require meaningful hostile-parameter/filesystem execution in an authorized gate.

### REMOTE-SHELL-03 ;  The advertised real-shell hostile argv test silently returns when findSh is unavailable, so a passed test/file does not establish its shell assertions executed.

Classification: source-only-false-green-path; priority P1.
Source: [tests/machines/ssm-transport.test.ts:490](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/machines/ssm-transport.test.ts#L490), [tests/machines/ssm-transport.test.ts:493](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/machines/ssm-transport.test.ts#L493).
Follow-up outside the owned audit-output scope: Replace silent return with observable prerequisite handling and require the real shell check in the intended native gate.

### REMOTE-REPLAY-04 ;  Only sanitized lane evidence is retained publicly; raw reports and private environment inventories are absent.

Classification: independent-replay-limitation; priority P2.
Follow-up outside the owned audit-output scope: Keep sanitized uploads; arrange authorized private retention/replay of raw reports and hashed environment inventory if stronger independent execution replay is required.

### REMOTE-COVERAGE-05 ;  399 unit cases skipped; external Temporal mTLS remains explicitly unverified; several opt-in integrations are outside all five canonical lane commands.

Classification: incomplete-runtime-acceptance; priority P2.
Follow-up outside the owned audit-output scope: Plan authorized disposable acceptance for the uncovered source guards without claiming unit or aggregate lane passes replace these prerequisites.

### REMOTE-GO-06 ;  Go nonverbose package summaries hide actual per-case skips and case counts, including the systemd opt-in.

Classification: case-observability-limitation; priority P2.
Follow-up outside the owned audit-output scope: In a separate CI/evidence change, capture private go test -json reports and sanitize exact counts/skip identities while preserving race/golden/cross-build gates.

## Runtime and fixture boundaries

OPA 1.19.1 ran 213 interpreter tests, strict Rego validation and reproducible Linux/amd64 static bundle checking; the 238 policy lane cases exercise declared interpreter/Wasm parity scenarios. The binary was compiled with Go 1.26.6, which is not the project Go toolchain. This establishes those scenarios with one pinned OPA version, not every business rule or OPA version.

Go 1.27.1 ran formatting, vet and race gates, actual result golden regeneration followed by diff/status checks, and 19 TS contract cases. Goldens intentionally model fixtures rather than a real customer host. The generic root Dockerfile built with no push; runner/zenithd-specific Dockerfiles, deployment hardening and actual customer-local typed writes have no acceptance from this exact public revision.

PostgreSQL 16.15 service containers and migration scripts were real prerequisites. Default test connections are privileged local service connections. Platform migration tests inspect RLS enabled/no policies and create transient anon/authenticated/service_role roles to inspect grants/revokes before rollback; those assertions should not be erased by a blanket “no RLS tested” statement. They also do not establish deployed Supabase/PostgREST/Supavisor least-privilege request behavior, production pooler settings or customer authentication.

OpenTofu 1.12.5 installed pinned AWS 6.66.0, Google 8.5.0, AzureRM 5.7.0 and OCI 9.7.1 schemas; actual local builtin-provider plan/apply and selected Go lock-enforcement checks ran. Mocked SDK assertions and schema validation are not cloud-resource deployment, credentials, IAM or customer infra acceptance. Temporal CLI 1.9.1 (development server 1.32.0, UI 2.54.1) and SDK 1.24.0 ran local dev/time-skipping tests and an immutable public Git source fixture. External namespace/mTLS, private GitHub App, kind cluster and live cloud credentials were not supplied in these lanes.

Installed Chrome 154.0.8037.57 was driven by Playwright-core 1.56.1. Hosted browser viewports were 1280×800 and 375×812; agent viewports were 1280×800 and 380×780. The hosted journey used a local built recipe/gateway; the agent used next dev and one identity-provider double. These are real Linux browser checks with local test identities/services, not deployed OIDC or cross-browser/customer acceptance.

## Version evidence

```json
{
  "node": {
    "pinned": "22.23.3",
    "observed": "22.23.3",
    "supportedEngineRange": ">=22.22.2 <23"
  },
  "npm": {
    "observed": "10.9.9"
  },
  "vitest": {
    "locked": "4.1.11"
  },
  "postgres": {
    "pinnedImage": "16.15-alpine",
    "clientLocked": "3.4.7"
  },
  "pglite": {
    "locked": "0.5.8"
  },
  "go": {
    "pinnedAndObserved": "1.27.1",
    "executed": "linux/amd64",
    "crossCompiledOnly": [
      "linux/amd64",
      "linux/arm64"
    ]
  },
  "opa": {
    "pinnedAndObserved": "1.19.1",
    "rego": "v1",
    "bundledCompilerGoVersion": "go1.26.6"
  },
  "opentofu": {
    "pinnedAndObserved": "1.12.5",
    "providers": {
      "aws": "6.66.0",
      "google": "8.5.0",
      "azurerm": "5.7.0",
      "oci": "9.7.1"
    }
  },
  "temporal": {
    "cliObserved": "1.9.1",
    "devServerObserved": "1.32.0",
    "uiObserved": "2.54.1",
    "sdkLocked": "1.24.0"
  },
  "browser": {
    "chromeObserved": "154.0.8037.57",
    "playwrightCoreLocked": "1.56.1",
    "engine": "playwright-core chromium",
    "viewports": {
      "hosted": [
        "1280x800",
        "375x812"
      ],
      "agent": [
        "1280x800",
        "380x780"
      ]
    }
  },
  "next": {
    "locked": "15.5.24"
  },
  "vite": {
    "locked": "7.3.6"
  }
}
```

## Independent replay and scope limits

- This is an offline independent source and captured-evidence audit; no tests, network requests, runtime commands, services, or deployment were executed by this auditor.
- All counts were freshly parsed from run 37103826519. No prior-run count or verdict was copied. Repeated job/lane assertions overlap, so no combined unique-test grand total is claimed.
- Sanitized ZIPs contain no raw Vitest reports, origin sidecars, or private environment inventories. Their digests and internal relationships match, but original assertion matching and environment values cannot be independently replayed.
- Standard Vitest JSON does not export unique task identity. Identical display names cannot independently establish distinct cases, even if raw JSON were supplied.
- The 399 captured unit skips have file identities and counts; skipped case titles are absent in the captured reporter output. Source guard candidates and declared suite names are labeled inferences rather than captured skipped-case identities.
- Go package-only race output does not disclose case totals or actual runtime skip events. Eleven package passes are not eleven tests; six no-test packages are not six skipped cases.
- Platform-Postgres 1422 and OpenTofu 3900 are lane assertion totals containing other engines, mocks, compiler and SDK checks. Required-group counts are scoped evidence; overlapping required groups must not be summed into a unique total.
- Hosted and agent browsers use installed Linux Chrome with local services. DOM project tests use jsdom. Neither establishes deployed customer acceptance, Safari/Firefox/Windows browser coverage, real external identity-provider integration, or live cloud/provider acceptance.
- The Go golden and TypeScript interop gate verifies generated result fixture contracts. Its public exact9 source has no newly frozen production typed file.write/native Linux gate. That private workstream cannot inherit this run acceptance.
- Supported pinned versions show this one CI environment. Other Node/OPA/Go/OpenTofu/PostgreSQL versions, architecture runtime behavior, hardened systemd deployment and external services require their own evidence.
- Raw npm audit JSON is absent. Five package findings and one advisory family are captured; severity, vulnerable ranges, advisory text, dependency graph and fixed versions cannot be independently reconstructed from these short logs.

## Exact reviewed source hashes

| Source | SHA256 |
|---|---|
| [scripts/ci/gate-manifest.mjs](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/scripts/ci/gate-manifest.mjs) | `16c388f6f0a9e6df26aed2c13d13d831e3246eb4f283ceb6e1aee4898e1532e6` |
| [scripts/ci/run-gate.mjs](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/scripts/ci/run-gate.mjs) | `fe9ff29bf99f70495f3ac27d1ab94cb3630b50b41e632fb3b50d79a10767b68f` |
| [scripts/ci/sanitize-evidence.mjs](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/scripts/ci/sanitize-evidence.mjs) | `63a69e0b4d8bacfa5a2f530cfb7d4688e469e870e3f28ff2c018ff8bc6211fba` |
| [scripts/ci/lane-report.mjs](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/scripts/ci/lane-report.mjs) | `a3c9a51ff6ff26fd78905c79f9d829c7ac53a2fd3b3596c0e34189ea9ec456e8` |
| [tests/ci/assert-lane-report.mjs](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/tests/ci/assert-lane-report.mjs) | `bdb3bb8c1b9ffd6179557ef17073cf5877c8eae6c5751dc659188a0c3bd81f4b` |
| [vitest.config.ts](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/vitest.config.ts) | `989f8b075986c64a2b4b70b66defc288a84ccc2a5f1b26a33ebe61e62d24fd08` |
| [package-lock.json](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/package-lock.json) | `b6c8d26a1c57a70d031ad8b72d1a391d554e53121a8b58e590763902c674816d` |
| [.github/workflows/ci.yml](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/.github/workflows/ci.yml) | `cc76429ae8ae5f7550e3ecd59a6cc02479b0dca7edd94010a0116b16264a0450` |
| [scripts/ci/security-audit.mjs](https://github.com/GODOSTROYER/zenith/blob/9e62a15f57034bf21d8924a6c6e1e1c558bfe854/scripts/ci/security-audit.mjs) | `43ecf6a4c5b23b2d99c1e116aba7d1790ef9cd3abc996ce10d53606e55c0996a` |

Relevant source anchors: `.github/workflows/ci.yml` core 85–102; PG 198–226; hosted 258–278; agent 315–332; policy 460–499; tofu 550–619; Go 688–749; workflows 804–845; platform-PG 923–959; generated 978–985; ledger 1015–1016; supply-chain 1047–1051. `scripts/ci/run-gate.mjs:12` validation and `:68` execution cleanup/receipt; `scripts/ci/sanitize-evidence.mjs:257` scalar evidence, `:292` bindings, `:331` preserved outcome; `scripts/ci/gate-manifest.mjs:37` external mTLS and `:147` required-source selection; `tests/controlplane/migrations.test.ts:280` RLS and `:290` transient role grant assertions.

All created audit outputs are private 0600 under the assigned logs directory. Worktree changes remain disallowed; final receipt records unchanged tracked-source bytes and clean Git status. This dossier does not modify source, execute tests, publish raw logs or claim runtime acceptance for privately frozen workstreams.

## Separate fresh local count comparison

The root subsequently ran the same public source unit suite locally with raw JSON: 16,462 passed, 0 failed, 364 skipped, 16,826 total in the same 807 files. This auditor compared each remote file total against that raw report: every total matches and local availability enabled 41 new passes across 12 files, while six Azure Python collector cases passed remotely and skipped locally. The net change is 35 additional passes across 13 differing files. Remote remains 16,427 passed/399 skipped. The Azure collector specifically probes an executable named `python` at `tests/machines/azure-scripts.test.ts:13`; this is a tool-availability guard, not an unconditional macOS exclusion. Source guards use local tool availability/PATH, so these differences do not constitute a source regression or retroactively identify remote skipped case titles. Full count deltas are in `remote-local-unit-count-comparison.json`; the local auditor owns the actual local skipped-title inventory.

| File | Remote skips | Local skips | Additional local passes |
|---|---:|---:|---:|
| tests/machines/ssm-documents.test.ts | 14 | 13 | 1 |
| tests/security/tofu-workspace-injection.test.ts | 4 | 0 | 4 |
| tests/tofu/runner.test.ts | 16 | 0 | 16 |
| tests/execution/journey.test.ts | 3 | 0 | 3 |
| tests/security/tofu-secrets.test.ts | 1 | 0 | 1 |
| tests/security/tofu-runner-env.test.ts | 3 | 0 | 3 |
| tests/providers/terraform-lb-names.test.ts | 7 | 0 | 7 |
| tests/providers/gcp/bootstrap.test.ts | 2 | 1 | 1 |
| tests/machines/azure-scripts.test.ts | 0 | 6 | -6 |
| tests/acceptance/tofu-destroy.test.ts | 1 | 0 | 1 |
| tests/policy/parity.test.ts | 1 | 0 | 1 |
| tests/tofu/hcl-template-real.test.ts | 2 | 0 | 2 |
| tests/tofu/plan-lock.test.ts | 1 | 0 | 1 |

The local SSM documents file still has 13 shell skips, and its associated transport test retains the silent-return path. The one OpenTofu/HCL SSM case passes locally where its binary is available; this does not close the shell helper defect.
