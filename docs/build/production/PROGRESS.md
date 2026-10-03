# Production progress

Last fully inspected published CI source: `9e62a15f57034bf21d8924a6c6e1e1c558bfe854` on `codex/production-2026-10-02`. Its [GitHub run 37103826519](https://github.com/GODOSTROYER/zenith/actions/runs/37103826519) finished with 13 passing jobs and one failing mandatory dependency-security job. Corrected source remains isolated in staging `356b7d014836e6cb39e54d4848f20d508fe31fde`; it is not integrated into the published branch. This documentation snapshot can advance the branch; inspect its exact newly pushed CI separately.

The production ledger retains 78 acceptance requirements: **5 verified, 19 in progress and 54 planned**. These counts measure acceptance state, not implementation effort or completion percentage. No current task is paused. Implementation complete, sandbox verified, pilot ready and production approved remain false.

[Whole-project test dossier](verification/2026-10-03-complete-test-audit/REPORT.md): fresh published units **16,462 passed / 0 failed / 364 skipped**, remote units **16,427/0/399**. Exact-source follow-ups executed **25 PostgreSQL + 6 Python** formerly skipped cases; original unit statuses retained. Two harness gaps remain: thirteen falsely skipped SSM cases and stale bridge path; one SSM hostile-argv case can return without its shell assertions. Full skip prerequisites and identities are catalogued. Three read-only audit agents completed.

## Completed and verified

- [x] Completed wave-8 implementation and ancestry preserved. No historical patch replay, reset or history rewrite.
- [x] Exact published CI evidence independently reviewed: all 14 job logs and five canonical artifacts captured; ZIP digests, exact source objects and manifests checked. Current run remains **13 passed / 1 failed**, distinct from historical a14's 14/14 green run.
- [x] Runner trust rotation corrected and independently reviewed. Keys persist before publication; failed persistence preserves retry behavior. Root repeated focused race checks: **180 top-level and 40 subtests passed, zero failed/skipped**. Root affected TypeScript/OpenTofu suites: **86 passed, zero failed/skipped**.
- [x] Seven checked runner paths committed as Saivedant at `c355eeeff579f4c648f1ee9fce99429727513910` and merged only into isolated staging `356b7d0`.
- [x] Exact clean staging full unit suites: **16,842 passed, 0 failed, 212 skipped**. Typecheck, lint, generated artifacts, SQL, capability matrix, AWS templates and ledger checks passed.
- [x] Exact staging Go race: **232 top-level and 541 subtests passed, 0 failed, 3 Linux-only skips on this Mac**. Native OPA: **213 passed, 0 failed, 0 skipped**.
- [x] Canonical local Temporal: **1,000 passed, 0 failed, 0 skipped**; policy: **238 passed, 0 failed, 0 skipped**. Required groups, all 12 execution bindings and execution revalidation passed.
- [x] Canonical local OpenTofu: **3,900 passed, 0 failed, 8 skipped**. All 27 required OpenTofu groups passed without matched skips. Those eight cases require the separate real PostgreSQL handoff lane, which passed below; no blanket skip waiver.
- [x] Fresh exact-staging PostgreSQL 16.15: **1,532 passed, 0 failed, 0 skipped**, 70 required groups, all 12 execution bindings and revalidation. Owned database resources and newly pulled image removed.
- [x] Fresh exact-staging Supabase migration application and reapplication: **251 passed, 0 failed, 0 skipped**, 9 required groups. Changed migration name and checksum each refused as expected. Owned resources removed.
- [x] Guest file.write source frozen in 35 paths and independently reviewed. Root typecheck, scoped lint and **267 tests passed, zero failures/skips**, including five actual-network OpenTofu cases. Both initial findings corrected at source: unknown writes retain their receipt and project uncertainty; documentation reflects actual policy. No actual Linux or signed-agent acceptance claim.
- [x] Linux CI prerequisite source frozen in seven owned paths, with 3,536 unchanged parent hashes and zero outside-owned changes. Independent r2 review and root 102 contract tests/compiler/lint/syntax passed; native Linux verification remains required.
- [x] Historical correction kind evidence: provider **6/6**, release **1/1**, zero failures/skips; local cluster removed. Original isolated durable source also passed AMD64 emulated and ARM64 native worker startup. Those results do not establish acceptance for later source changes or live cloud behavior.

## Ongoing, blocked and pending

- [ ] Current mandatory complete-lock audit fails with five packages referencing one braces advisory. No published compatible parent upgrade removes the vulnerable chain. Registry remains empty; no approved exception or risk acceptance. Gate remains mandatory.
- [x] Fresh exact-staging ARM64 execution-worker startup passed in **216.02 seconds**. All 14 resources, owned builder/cache and new images removed. Readiness, outage recovery and idle shutdown passed; no live cloud write or in-flight shutdown proof.
- [x] Fresh AMD64 execution-worker startup on staging `356b7d0` passed under emulation in **280.02 seconds**. All 14 resources, owned builder/cache and new images removed.
- [ ] Guest Linux gate independent review found a stale passed-artifact upload on failed attempts. Current-attempt correction independently reviewed; root **102 tests passed, zero failures/skips**, compiler/lint/script syntax passed. Actual Go parsing/native root-filesystem/mount/ACL and guarded-cleanup acceptance remain required. Root TypeScript checks passed; Go formatting and both Linux-target vet/build/test compilation passed; actual race, unprivileged Linux and five authentic filesystem goldens still pending.
- [x] Fresh matching-client kind provider **6/6** and release **1/1** passed on staging `356b7d0`; kubectl/server **1.37.0**, cluster/kubeconfig/new images removed. Local cluster evidence only.
- [ ] Current source integration and pushed-source CI observation remain blocked by required checks and dependency disposition. No current green CI claim.
- [ ] Partial acceptance-cleanup guard remains unmerged. Initial **79 passed / 1 failed** retained; corrected failed-suite retry **7 passed**. Authoritative durable quiescence and a legitimately authorized success path remain missing; execution refuses destruction.
- [ ] Default API/browser/MCP startup permission and live AWS account, region and budget remain pending. No unrelated services or live cloud changes performed.
- [ ] Remaining product work includes mixed-provider execution and traffic, provider lifecycles, managed two-tenant hosting, typed upload/package/service configuration, scheduling, recovery, security/load/upgrade gates, UX/client integration and accurate economics.

Agents: all three native workers/reviewers completed their current source assignments. Root owns serial runtime verification, Git integration and the ledger. Linux gate re-review and 102 contract tests passed; native Linux acceptance remains pending. [Complete workstream and handoff checklist](handoffs/2026-10-03/REGRESSION-CHECKPOINT.md).

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

External Temporal mTLS, cloud/managed-cluster traffic, production TLS/pooler/authorization and operational signoff require separate acceptance. Destructive retention, pricing, terms and payment accounts require operator decisions; independent implementation continues.

Latest independent storage observation: **23.67 GiB free**, zero Docker images/containers/volumes and 0B cache after both image gates. Owned 4 GiB builders sampled storage every 30 seconds, required 12 GiB before launch and removed all owned resources/cache/new images. One heavy local process runs on this 8 GB Mac. No global prune or unrelated-resource deletion.

Next verified source checkpoint estimate: **2–4 hours**, conditional on Linux and image findings. Full production ETA cannot be fixed until remaining implementation, access and operational acceptance are resolved. See [exact current CI evidence](ci-37103826519.md), [local staging gate receipt](evidence/durable-plan/rotation-full-gate.json), [requirement details](REQUIREMENTS.md) and [resume instructions](RESUME.md).
