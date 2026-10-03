# Production progress

Recorded 2026-10-03T04:56:15.642728+00:00. Last fully observed pushed source CI: `290540c88f54e878e716c1f0b20466dd55b71a06`, branch `codex/production-2026-10-02`, [run37087774593](ci-37087774593.md): 13 passed and 1 failed. Mandatory dependency audit blocks release. This documentation checkpoint advances branch metadata, not isolated staging source.

78 acceptance requirements:5verified,19inprogress,54planned. Current-head green CI reopened after fresh advisory; historicala14 green retained. These are acceptance states, not percentages of implementation effort. No current task is paused. Implementation complete, sandbox verified, pilot ready and production approved remain false.

## Verified checkpoints

- [x] Historical a14 pushed CI: 14/14 jobs; remote unit16,427P/0F/399S; generated109P/0F/0S; actual Smoke/Gimbal passed.
- [x] Root local a14: unit16,630P/0F/196S; workflows982, policy238, OpenTofu3900 all0F0S. Typecheck, lint, generated artifacts, OPA213/213, Go race226top+539subP/0F/3Linux-onlyMacS and mandatory audit passed.
- [x] Fresh platform PostgreSQL:1,422P/0F/0S,45mandatory groups,12receipt bindings; execution revalidation and owned cleanup passed.
- [x] Fresh full Supabase migrations and reapply: PostgreSQL251P/0F/0S, schema name/checksum tamper rejected, owned resources removed.
- [x] Real execution-worker images: clean e109 source AMD64 emulated and ARM64 native startup checks passed. Idle shutdown only; broader operations remain incomplete.
- [x] Fresh kind: provider6/6 and release1/1; local cluster evidence only; owned resources removed.

## Current execution

- [x] Original durable-plan source `15e4453`: 57 frozen paths, independent review, root verification, Saivedant author and committer. Source remains isolated.
- [x] Original actual PostgreSQL/OpenTofu: 1,532 passed, 0 failed, 0 skipped; 70 mandatory groups and all 12 execution bindings. Supabase: 251 passed, schema 7 apply/reapply and checksum/name tamper refusal.
- [x] Original fresh kind: provider 6 passed, release 1 passed, no failures/skips. Both packaged architectures passed, AMD64 under emulation in 335.76s and native ARM64 in 300.27s. Owned resources removed. These proofs bind original commit only.
- [ ] Original full regression: 16,588 passed, 70 failed, 212 skipped across 16,870 cases and 18 affected files. Prechecks passed, including OPA 213 and Go race. Later canonical phases did not run. [Failure retained](evidence/durable-plan/full-regression-failed.json).
- [x] Correction workers finished and froze source: 18 durable files, eight CI fixtures and six inactive security-support files. Independent source reviews clear. No source integration yet.
- [x] Root combined affected checks: **1,079 passed, 0 failed, 20 skipped**; compiler, lint, gofmt, Go vet/test and five real network OpenTofu cases passed. Twenty PostgreSQL-gated skips require fresh real database proof. [Receipt](evidence/durable-plan/corrections-targeted.json).
- [x] Corrected 32-path candidate actual PostgreSQL/OpenTofu: **1,532 passed, 0 failed, 0 skipped**, 70 mandatory groups, all 12 execution bindings and separate execution revalidation passed. Owned resources removed. Previous1527P5F0S remains [recorded](evidence/durable-plan/corrections-real-postgres-failed.json); fixture correction preserved genuine SQL authority cases. [Passed receipt](evidence/durable-plan/corrections-platform-postgres.json).
- [x] Corrected-byte Supabase251P0F0S and fresh kindprovider6P0F0S/release1P0F0S passed. Cluster/kubeconfig/newimages removed.
- [x] Checked worker commits c121f89,cd60f8b,50aa292 merged into isolated staging1ce6191; Saivedant author/committer verified.
- [ ] Clean staging full gate failed Go race:225top+539subtests passed,1failed,3Linux-onlyMacskips. Runner key persistence ordering defect identified; source-only correction active. Full unit and later canonical phases did not run. [Failure retained](evidence/durable-plan/corrections-full-go-failed.json). Architecture startup still required.
- [x] Inactive security-support r3 checks: 295 passed, 0 failed, 0 skipped; typecheck, lint, Go and real network OpenTofu passed. Exact signed advisory scope, final clock, symlink and SemVer corrections reviewed.
- [ ] Dependency audit still exits 1 with five findings. Registry empty; no approved exception, installed trust anchor or risk acceptance. Inactive support does not clear vulnerabilities.
- [ ] Partial cleanup guard remains unmerged: initial 79 passed/1 failed retained, corrected failed-suite retry 7 passed. Execute refuses destruction; durable quiescence authority and legitimate authorized success path remain missing.
- [ ] Linux customer-local approved-template file.write implementation active in isolated worktree. Upload/packages/service/privileged host and actual Linux/systemd acceptance remain outstanding. Live AWS lifecycle/default API/broader operational acceptance remain incomplete.

Two source-only implementation workers active: bounded runner key persistence correction and Linux file.write. Root owns reviews, serial checks and Git integration. No current task paused. [Agent/workstream checkpoint](handoffs/2026-10-03/REGRESSION-CHECKPOINT.md).

## Requirements checklist

Each unchecked row remains incomplete at its stated acceptance level; existing contract code is preserved. See [requirement details](REQUIREMENTS.md) and [machine ledger](ledger.json).

### CI

- [x] PROD-CI-01: Remote baseline reconciliation (verified).
- [x] PROD-CI-02: Canonical migration compatibility (verified).
- [x] PROD-CI-03: Strict PostgreSQL scenario evidence (verified).
- [x] PROD-CI-04: Reproducible Temporal and source scenarios (verified).
- [ ] PROD-CI-05: Canonical gates and sanitized artifacts (in progress).
- [x] PROD-CI-06: Supported runtime admission (verified).
- [ ] PROD-CI-07: Dependency vulnerability clearance (in progress).
- [ ] PROD-CI-08: Fresh complete verification (in progress).
- [ ] PROD-CI-09: Observed green pushed baseline (reopened; current-head dependency gate red).

### PKG

- [ ] PROD-PKG-01: Linux worker image startup (in progress).
- [ ] PROD-PKG-02: Composed worker operation and shutdown (in progress).
- [ ] PROD-PKG-03: Filesystem and plan lifecycle (in progress).
- [ ] PROD-PKG-04: Supported installation topology (in progress).
- [ ] PROD-PKG-05: Default browser API and MCP journey (in progress).
- [ ] PROD-PKG-06: Durable database acceptance (in progress).

### MIX

- [ ] PROD-MIX-01: Execution partitions and authorities (planned).
- [ ] PROD-MIX-02: Parent and immutable child plans (planned).
- [ ] PROD-MIX-03: Typed scoped dependency outputs (planned).
- [ ] PROD-MIX-04: Distributed failure and teardown order (planned).
- [ ] PROD-MIX-05: Protected cross-cloud connectivity (planned).
- [ ] PROD-MIX-06: Real mixed application traffic (planned).
- [ ] PROD-MIX-07: Mixed-cloud recovery and economics (planned).

### DUR

- [ ] PROD-DUR-01: Durable intent and outbox (planned).
- [ ] PROD-DUR-02: Authoritative state and projections (in progress).
- [ ] PROD-DUR-03: Exact approved executable semantics (planned).
- [ ] PROD-DUR-04: Dispatch authorization and bounded autonomy (planned).
- [ ] PROD-DUR-05: Durable encrypted plan handoff (in progress).
- [ ] PROD-DUR-06: Artifact cleanup and state backend recovery (in progress).
- [ ] PROD-DUR-07: Uncertain external mutation resolution (in progress).
- [ ] PROD-DUR-08: Build and cleanup deduplication (planned).

### LIFE

- [ ] PROD-LIFE-01: Connection administration lifecycle (planned).
- [ ] PROD-LIFE-02: Versioned offered capability catalog (planned).
- [ ] PROD-LIFE-03: AWS family migration and suffixes (in progress).
- [ ] PROD-LIFE-04: Azure data plane and sovereign identity (planned).
- [ ] PROD-LIFE-05: OCI replacement and deletion evidence (planned).
- [ ] PROD-LIFE-06: Non-AWS ownership-safe DNS teardown (planned).
- [ ] PROD-LIFE-07: Kubernetes full lifecycle acceptance (planned).
- [ ] PROD-LIFE-08: GitHub source binding lifecycle (planned).
- [ ] PROD-LIFE-09: Isolated untrusted build provenance (planned).
- [ ] PROD-LIFE-10: Release and data migration safety (planned).
- [ ] PROD-LIFE-11: Backup export import and adoption (in progress; cleanup admission portion only).
- [ ] PROD-LIFE-12: Single owner per mutable field (planned).

### MACH

- [ ] PROD-MACH-01: Typed safe guest configuration (in progress; Linux file.write slice).
- [ ] PROD-MACH-02: Kubernetes guest credentials (planned).
- [ ] PROD-MACH-03: Signed automation and scheduling (planned).
- [ ] PROD-MACH-04: Linux runner delivery and lifecycle (in progress; key rotation persistence).
- [ ] PROD-MACH-05: Local customer credential custody (planned).
- [ ] PROD-MACH-06: Bounded evaluated coding agents (planned).

### OBS

- [ ] PROD-OBS-01: Canonical observation-to-repair engine (in progress).
- [ ] PROD-OBS-02: Fresh scoped telemetry provenance (planned).
- [ ] PROD-OBS-03: Incident stability and escalation (planned).
- [ ] PROD-OBS-04: Durable critical schedules (planned).

### MAN

- [ ] PROD-MAN-01: Default managed substrate and sessions (planned).
- [ ] PROD-MAN-02: Managed serving integrations (planned).
- [ ] PROD-MAN-03: Tenant storage domains and service catalog (planned).
- [ ] PROD-MAN-04: Two untrusted tenant isolation (planned).
- [ ] PROD-MAN-05: Resource isolation under load (planned).
- [ ] PROD-MAN-06: Separable metering and billing (planned).
- [ ] PROD-MAN-07: Operator commercial decisions (planned).

### OPS

- [ ] PROD-OPS-01: Measured service and recovery objectives (planned).
- [ ] PROD-OPS-02: Fair bounded control plane (planned).
- [ ] PROD-OPS-03: Rolling upgrades and replay (planned).
- [ ] PROD-OPS-04: Clean-host restore and recovery epochs (planned).
- [ ] PROD-OPS-05: Purpose-separated key custody (planned).
- [ ] PROD-OPS-06: Sensitive persistence minimization (planned).
- [ ] PROD-OPS-07: Configurable non-destructive retention (planned).
- [ ] PROD-OPS-08: Independent adversarial security acceptance (planned).
- [ ] PROD-OPS-09: Verified release supply chain (planned).

### UX

- [ ] PROD-UX-01: Accessible privileged operator journey (planned).
- [ ] PROD-UX-02: Configured client interoperability (planned).
- [ ] PROD-UX-03: Reviewed revocable plugin boundaries (planned).

### COST

- [ ] PROD-COST-01: Source-backed dated price catalog (planned).
- [ ] PROD-COST-02: Complete placement costs and constraints (planned).
- [ ] PROD-COST-03: Bounded economic optimization (planned).

### REL

- [ ] PROD-REL-01: Required end-to-end release evidence (planned).
- [ ] PROD-REL-02: Requirement-to-evidence release dossier (planned).
- [ ] PROD-REL-03: Separate release status and signoff (planned).
- [ ] PROD-REL-04: Scope permission and resumable execution (planned).

## Access, storage and next checkpoint

API/server startup and live AWS account/region/budget remain pending. External Temporal mTLS, cloud/managed-cluster traffic, production TLS/pooler/RLS and operational signoff require separate acceptance. Retention/pruning policy, pricing/terms/payment accounts and destructive business decisions require user decisions; unblocked coding continues.

Docker restart authorized and completed. Current independently checked Docker inventory: zero images, containers and volumes, 0B cache; approximately26GiB free. Corrected PostgreSQL/Supabase/kind owned resources removed. Both durable-plan image gates removed owned resources. Earlier duplicate dependency consolidation reclaimed1.14GiB. PostgreSQL16.15 clients installed without starting server/service. Keep12GiB before image gates; one heavy local process; remove only owned test resources and dedicated cache.

Next reviewed checkpoint estimate: **2–4hours**, dependent on correction scope and serial verification. Previous45–90minute estimate superseded by70new full-suite failures. Full production ETA unavailable until live access, remaining implementation and operational acceptance resolved.

Evidence: [exact CI report](ci-37080857980.md), [local gate summary](evidence/local-gates/a14e57f.json), [resume instructions](RESUME.md).
