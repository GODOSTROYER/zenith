# Production progress

Local integrated source: `c32d116745c75048a21b6e42a09ee313ce8230e6`, branch `codex/production-packets-2026-10-04`, exact47-path tested tree. Published `codex/production-2026-10-02` remains414d52b; historical CI37128274569 was rechecked14/14 success. The local candidate is unpublished and does not inherit that result.

Acceptance states: **6 verified / 30 in progress / 42 planned**, all78 IDs and criteria retained. Four formerly unassessed rows now record concrete partial work; no additional row is verified. All four release states remain false.

- [x] Four reviewed source commits integrate AWS native readiness, durable MCP admission, strict native gates and non-AWS DNS ownership.
- [x] ActualPG2354P0F8declaredS/all624mandatory plus strict executed-case validation; affected130P0F0S and compiler/lint passed.
- [x] Focused513P0F16platformS; all skipped cases mapped to actualPG or unchanged actual Linux execution. DNS198P0F0S includes6 actual local OpenTofu cases.
- [ ] Complete combined whole/package/kind/fresh install and pushed CI. Last whole17927P1F559S retained; ARM packageR6 shutdown andR7 storage failures remain open.
- [ ] Integrate corrected APPLY11/native credential8 after independent review and native acceptance. Native OAuth grant persistence/migration15 source work continues.
- [ ] Operate default browser/API/MCP journey, then G3/G4. Default API/server and live-account permissions remain pending; source-independent work continues.

Exact scopes, source bindings, failures, skips and private artifact hashes: [integration receipt](verification/2026-10-04-integrated-source.md). Historical native Linux801 leaves/3declaredS/five goldens and12ACL controls remain scoped evidence. Local kind859 provider6/release1/guest48 does not verify changed shared candidate or live clouds. Counts overlap and must not be summed.

## Requirement checklist

All unchecked rows remain incomplete at their specified evidence levels. Full criteria/dependencies remain in [requirements](REQUIREMENTS.md).

### CI

- [x] PROD-CI-01: Remote baseline reconciliation (verified).
- [x] PROD-CI-02: Canonical migration compatibility (verified).
- [x] PROD-CI-03: Strict PostgreSQL scenario evidence (verified).
- [x] PROD-CI-04: Reproducible Temporal and source scenarios (verified).
- [ ] PROD-CI-05: Canonical gates and sanitized artifacts (in progress).
- [x] PROD-CI-06: Supported runtime admission (verified).
- [x] PROD-CI-07: Dependency vulnerability clearance (verified).
- [ ] PROD-CI-08: Fresh complete verification (in progress).
- [ ] PROD-CI-09: Observed green pushed baseline (in progress).
### PKG

- [ ] PROD-PKG-01: Linux worker image startup (in progress).
- [ ] PROD-PKG-02: Composed worker operation and shutdown (in progress).
- [ ] PROD-PKG-03: Filesystem and plan lifecycle (in progress).
- [ ] PROD-PKG-04: Supported installation topology (in progress).
- [ ] PROD-PKG-05: Default browser API and MCP journey (in progress).
- [ ] PROD-PKG-06: Durable database acceptance (in progress).
### MIX

- [ ] PROD-MIX-01: Execution partitions and authorities (in progress).
- [ ] PROD-MIX-02: Parent and immutable child plans (in progress).
- [ ] PROD-MIX-03: Typed scoped dependency outputs (in progress).
- [ ] PROD-MIX-04: Distributed failure and teardown order (in progress).
- [ ] PROD-MIX-05: Protected cross-cloud connectivity (planned).
- [ ] PROD-MIX-06: Real mixed application traffic (planned).
- [ ] PROD-MIX-07: Mixed-cloud recovery and economics (planned).
### DUR

- [ ] PROD-DUR-01: Durable intent and outbox (in progress).
- [ ] PROD-DUR-02: Authoritative state and projections (in progress).
- [ ] PROD-DUR-03: Exact approved executable semantics (in progress).
- [ ] PROD-DUR-04: Dispatch authorization and bounded autonomy (in progress).
- [ ] PROD-DUR-05: Durable encrypted plan handoff (in progress).
- [ ] PROD-DUR-06: Artifact cleanup and state backend recovery (in progress).
- [ ] PROD-DUR-07: Uncertain external mutation resolution (in progress).
- [ ] PROD-DUR-08: Build and cleanup deduplication (in progress).
### LIFE

- [ ] PROD-LIFE-01: Connection administration lifecycle (planned).
- [ ] PROD-LIFE-02: Versioned offered capability catalog (planned).
- [ ] PROD-LIFE-03: AWS family migration and suffixes (in progress).
- [ ] PROD-LIFE-04: Azure data plane and sovereign identity (planned).
- [ ] PROD-LIFE-05: OCI replacement and deletion evidence (planned).
- [ ] PROD-LIFE-06: Non-AWS ownership-safe DNS teardown (in progress).
- [ ] PROD-LIFE-07: Kubernetes full lifecycle acceptance (planned).
- [ ] PROD-LIFE-08: GitHub source binding lifecycle (in progress).
- [ ] PROD-LIFE-09: Isolated untrusted build provenance (planned).
- [ ] PROD-LIFE-10: Release and data migration safety (planned).
- [ ] PROD-LIFE-11: Backup export import and adoption (in progress).
- [ ] PROD-LIFE-12: Single owner per mutable field (planned).
### MACH

- [ ] PROD-MACH-01: Typed safe guest configuration (in progress).
- [ ] PROD-MACH-02: Kubernetes guest credentials (in progress).
- [ ] PROD-MACH-03: Signed automation and scheduling (planned).
- [ ] PROD-MACH-04: Linux runner delivery and lifecycle (in progress).
- [ ] PROD-MACH-05: Local customer credential custody (planned).
- [ ] PROD-MACH-06: Bounded evaluated coding agents (planned).
### OBS

- [ ] PROD-OBS-01: Canonical observation-to-repair engine (in progress).
- [ ] PROD-OBS-02: Fresh scoped telemetry provenance (planned).
- [ ] PROD-OBS-03: Incident stability and escalation (planned).
- [ ] PROD-OBS-04: Durable critical schedules (in progress).
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

[Current exact counts, skip identities and receipt hashes](verification/2026-10-03-g1-integration.md). Next action: publish this integrated implementation, inspect complete CI, then execute next candidate contracts. Full production ETA remains unbounded by missing live access and remaining implementation; no completion percentage is inferred from tests.
