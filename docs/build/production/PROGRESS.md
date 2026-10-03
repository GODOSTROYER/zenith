# Production progress

Recorded 2026-10-03T01:51:40.507074+00:00. Pushed baseline: `a14e57f7106fb1602f7c1e02db79fe137818cb80`, branch `codex/production-2026-10-02`. Preserve newer local source and historical failed evidence.

78 acceptance requirements: 6 verified, 16 in progress, 56 planned. These are acceptance states, not percentages of implementation effort. No current task is paused. Implementation complete, sandbox verified, pilot ready and production approved remain false.

## Verified checkpoints

- [x] Exact pushed CI: 14/14 jobs; remote unit16,427P/0F/399S; generated109P/0F/0S; actual Smoke/Gimbal passed.
- [x] Root local a14: unit16,630P/0F/196S; workflows982, policy238, OpenTofu3900 all0F0S. Typecheck, lint, generated artifacts, OPA213/213, Go race226top+539subP/0F/3Linux-onlyMacS and mandatory audit passed.
- [x] Fresh platform PostgreSQL:1,422P/0F/0S,45mandatory groups,12receipt bindings; execution revalidation and owned cleanup passed.
- [x] Fresh full Supabase migrations and reapply: PostgreSQL251P/0F/0S, schema name/checksum tamper rejected, owned resources removed.
- [x] Real execution-worker images: clean e109 source AMD64 emulated and ARM64 native startup checks passed. Idle shutdown only; broader operations remain incomplete.
- [x] Fresh kind: provider6/6 and release1/1; local cluster evidence only; owned resources removed.

## Current execution

- [ ] Durable-plan original54-path snapshot preserved. Root compiler/lint passed after corrections; first runtime396P/39F/25S. Runtime source fixes and canonical schema6-to-7 RLS/grant parity fix source-reviewed; final56-path candidate compiler/lint passed;435P/3F/26S, three narrow corrections underway. No passing combined artifact runtime gate yet.
- [ ] Root runs compiler/lint/touched suites, then mandatory real PostgreSQL plus OpenTofu original-byte custody cases. Independent reviewer checks correction delta.
- [ ] Fresh combined package/kind/full gates precede integration and a new exact pushed CI observation.
- [ ] Cleanup safety12-path guard lint passed;79P/1F/0S, finalized-recorder fixture correction underway. Execute currently refuses all destruction. Source remains unmerged pending real authority and successful authorized cleanup path.
- [ ] Live AWS lifecycle, production API journey and broader operational acceptance remain outstanding.

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
- [x] PROD-CI-09: Observed green pushed baseline (verified).

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

- [ ] PROD-MACH-01: Typed safe guest configuration (planned).
- [ ] PROD-MACH-02: Kubernetes guest credentials (planned).
- [ ] PROD-MACH-03: Signed automation and scheduling (planned).
- [ ] PROD-MACH-04: Linux runner delivery and lifecycle (planned).
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

Docker restart was authorized and completed. After owned database cleanup Docker images, containers, volumes and build cache were empty. Most recent sample28.92GiB free after consolidating same-lock root-owned dependency install,1.14GiB reclaimed; Docker inventory zero. Maintain12GiB before image gates; one heavy local process; remove only owned test resources and dedicated build cache.

Next durable-plan verification checkpoint estimate:45–90minutes, dependent on regression results. Full production ETA remains unavailable until access and operational acceptance prerequisites are resolved.

Evidence: [exact CI report](ci-37080857980.md), [local gate summary](evidence/local-gates/a14e57f.json), [resume instructions](RESUME.md).
