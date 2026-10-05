# Production progress

**5 October 2026 wave 2 assembly (prod/compose):** merged PROD-OBS-04, LIFE-01, LIFE-08, LIFE-09, LIFE-10, LIFE-11, MACH-04, MACH-05, UX-01 and UX-03 on top of wave 1. Platform migrations 21 to 27 (scheduled_job_runs, connection_rotations, release_pipelines, portability, agent_lifecycle, plugin_boundaries, github_revocation_reason) are registered contiguously; the Supabase aggregate is now `0020_platform_core.sql` and `0016` to `0019` are untouched. Cross-requirement joins made at assembly: LIFE-09 signed build provenance is the single `attested` verdict inside LIFE-10's release gate; a subdirectory build context needs LIFE-08's inspection digest re-derived at build admission; one coherent platform nav; portability routes classified. The ledger now counts **6 verified / 44 in progress / 28 planned** of 78 requirements; 20 are `implementation_complete_verification_pending` (the ten wave 2 requirements plus the ten from CI repair and wave 1); none are verified and no tests were run on this machine (typecheck, lint on changed files, generator checks and Go build/vet only). Wave 1 must be verified first. Next: [VERIFY-QUEUE.md](VERIFY-QUEUE.md).

**5 October 2026 assembly (prod/compose):** merged PROD-LIFE-12, COST-03, MACH-03 and OBS-03 on top of CI repair, OBS-02, LIFE-02 and MACH-01. Platform migrations 17 to 20 are registered in order; the Supabase aggregate is now `0019_platform_core.sql` and `0018_platform_core.sql` is restored byte-identical to base. Runbook tick added to `tick.yml`. Ten requirements (PROD-CI-05/08/09, MACH-01, MACH-03, OBS-02, OBS-03, LIFE-02, LIFE-12, COST-03) are `implementation_complete_verification_pending`; none are verified and no tests were run. Next: [VERIFY-QUEUE.md](VERIFY-QUEUE.md).

As-is machine-transfer checkpoint, 5 October 2026. Product commit `19be80b`, tree `7da4306a`; final handoff commit is the fetched published branch HEAD. [Exact handoff and commands](transfer/2026-10-05/README.md).

**6 verified / 44 in progress / 28 planned**, all78 acceptance criteria retained. No new verified requirement; all four release states remain false.

- [x] Preserve71 earlier source commits, current93-path product candidate and complete pending3/11 packet bytes.
- [x] Preserve available handoff versions, independent source reviews, current failure accounting and safe other-machine commands.
- [x] Scoped actual Linux ARM64 package4/signed5/Linux31 passed; owned cleanup confirmed.
- [ ] Saved-plan native100 remains60 passed/40 failed/0 skipped; digest3 is source accepted but unexecuted.
- [ ] Partial schema/gates11 needs final review and complete mandatory execution. Full platform27 failure remains open.
- [ ] Whole combined candidate, canonical Linux127, worker22/nativeAMD64, default interfaces and new pushed CI remain unverified.
- [ ] Operated application G2, failure/upgrade/recovery G3 and full providers/mixed-cloud/managed/client/economics G4 remain required.

Counts overlap across source references and lanes. Historical unit18682P0F1167S, native workflows1192P0F0S/PG322P0F0S/platform2755P27F8S and kind55 do not verify changed bytes or production.

## Requirement checklist

- [x] PROD-CI-01: Remote baseline reconciliation (verified).
- [x] PROD-CI-02: Canonical migration compatibility (verified).
- [x] PROD-CI-03: Strict PostgreSQL scenario evidence (verified).
- [x] PROD-CI-04: Reproducible Temporal and source scenarios (verified).
- [ ] PROD-CI-05: Canonical gates and sanitized artifacts (in_progress).
- [x] PROD-CI-06: Supported runtime admission (verified).
- [x] PROD-CI-07: Dependency vulnerability clearance (verified).
- [ ] PROD-CI-08: Fresh complete verification (in_progress).
- [ ] PROD-CI-09: Observed green pushed baseline (in_progress).
- [ ] PROD-PKG-01: Linux worker image startup (in_progress).
- [ ] PROD-PKG-02: Composed worker operation and shutdown (in_progress).
- [ ] PROD-PKG-03: Filesystem and plan lifecycle (in_progress).
- [ ] PROD-PKG-04: Supported installation topology (in_progress).
- [ ] PROD-PKG-05: Default browser API and MCP journey (in_progress).
- [ ] PROD-PKG-06: Durable database acceptance (in_progress).
- [ ] PROD-MIX-01: Execution partitions and authorities (in_progress).
- [ ] PROD-MIX-02: Parent and immutable child plans (in_progress).
- [ ] PROD-MIX-03: Typed scoped dependency outputs (in_progress).
- [ ] PROD-MIX-04: Distributed failure and teardown order (in_progress).
- [ ] PROD-MIX-05: Protected cross-cloud connectivity (planned).
- [ ] PROD-MIX-06: Real mixed application traffic (planned).
- [ ] PROD-MIX-07: Mixed-cloud recovery and economics (planned).
- [ ] PROD-DUR-01: Durable intent and outbox (in_progress).
- [ ] PROD-DUR-02: Authoritative state and projections (in_progress).
- [ ] PROD-DUR-03: Exact approved executable semantics (in_progress).
- [ ] PROD-DUR-04: Dispatch authorization and bounded autonomy (in_progress).
- [ ] PROD-DUR-05: Durable encrypted plan handoff (in_progress).
- [ ] PROD-DUR-06: Artifact cleanup and state backend recovery (in_progress).
- [ ] PROD-DUR-07: Uncertain external mutation resolution (in_progress).
- [ ] PROD-DUR-08: Build and cleanup deduplication (in_progress).
- [ ] PROD-LIFE-01: Connection administration lifecycle (in_progress).
- [ ] PROD-LIFE-02: Versioned offered capability catalog (in_progress).
- [ ] PROD-LIFE-03: AWS family migration and suffixes (in_progress).
- [ ] PROD-LIFE-04: Azure data plane and sovereign identity (planned).
- [ ] PROD-LIFE-05: OCI replacement and deletion evidence (planned).
- [ ] PROD-LIFE-06: Non-AWS ownership-safe DNS teardown (in_progress).
- [ ] PROD-LIFE-07: Kubernetes full lifecycle acceptance (planned).
- [ ] PROD-LIFE-08: GitHub source binding lifecycle (in_progress).
- [ ] PROD-LIFE-09: Isolated untrusted build provenance (in_progress).
- [ ] PROD-LIFE-10: Release and data migration safety (in_progress).
- [ ] PROD-LIFE-11: Backup export import and adoption (in_progress).
- [ ] PROD-LIFE-12: Single owner per mutable field (in_progress).
- [ ] PROD-MACH-01: Typed safe guest configuration (in_progress).
- [ ] PROD-MACH-02: Kubernetes guest credentials (in_progress).
- [ ] PROD-MACH-03: Signed automation and scheduling (in_progress).
- [ ] PROD-MACH-04: Linux runner delivery and lifecycle (in_progress).
- [ ] PROD-MACH-05: Local customer credential custody (in_progress).
- [ ] PROD-MACH-06: Bounded evaluated coding agents (planned).
- [ ] PROD-OBS-01: Canonical observation-to-repair engine (in_progress).
- [ ] PROD-OBS-02: Fresh scoped telemetry provenance (in_progress).
- [ ] PROD-OBS-03: Incident stability and escalation (in_progress).
- [ ] PROD-OBS-04: Durable critical schedules (in_progress).
- [ ] PROD-MAN-01: Default managed substrate and sessions (planned).
- [ ] PROD-MAN-02: Managed serving integrations (planned).
- [ ] PROD-MAN-03: Tenant storage domains and service catalog (planned).
- [ ] PROD-MAN-04: Two untrusted tenant isolation (planned).
- [ ] PROD-MAN-05: Resource isolation under load (planned).
- [ ] PROD-MAN-06: Separable metering and billing (planned).
- [ ] PROD-MAN-07: Operator commercial decisions (planned).
- [ ] PROD-OPS-01: Measured service and recovery objectives (planned).
- [ ] PROD-OPS-02: Fair bounded control plane (planned).
- [ ] PROD-OPS-03: Rolling upgrades and replay (planned).
- [ ] PROD-OPS-04: Clean-host restore and recovery epochs (planned).
- [ ] PROD-OPS-05: Purpose-separated key custody (planned).
- [ ] PROD-OPS-06: Sensitive persistence minimization (planned).
- [ ] PROD-OPS-07: Configurable non-destructive retention (planned).
- [ ] PROD-OPS-08: Independent adversarial security acceptance (planned).
- [ ] PROD-OPS-09: Verified release supply chain (planned).
- [ ] PROD-UX-01: Accessible privileged operator journey (in_progress).
- [ ] PROD-UX-02: Configured client interoperability (planned).
- [ ] PROD-UX-03: Reviewed revocable plugin boundaries (in_progress).
- [ ] PROD-COST-01: Source-backed dated price catalog (in_progress).
- [ ] PROD-COST-02: Complete placement costs and constraints (in_progress).
- [ ] PROD-COST-03: Bounded economic optimization (in_progress).
- [ ] PROD-REL-01: Required end-to-end release evidence (planned).
- [ ] PROD-REL-02: Requirement-to-evidence release dossier (planned).
- [ ] PROD-REL-03: Separate release status and signoff (planned).
- [ ] PROD-REL-04: Scope permission and resumable execution (planned).

Full criteria and dependencies remain in [REQUIREMENTS.md](REQUIREMENTS.md). Pending permissions and exact evidence scopes are in the handoff. No unattended work promised.
