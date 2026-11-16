# Complete production task checklist

Paused at user request, recorded 2026-10-02T07:32:03.553814+00:00. No requirement IDs changed.

Counts: **6 verified, 13 paused after prior work, 59 planned/pending, 78 total**. These counts do not imply equal effort or a production completion percentage.

## Verified requirements

- [x] **PROD-CI-01**: Remote baseline reconciliation. State: verified. Dependencies: none. Implementation: complete.
- [x] **PROD-CI-02**: Canonical migration compatibility. State: verified. Dependencies: none. Implementation: complete.
- [x] **PROD-CI-03**: Strict PostgreSQL scenario evidence. State: verified. Dependencies: none. Implementation: complete.
- [x] **PROD-CI-04**: Reproducible Temporal and source scenarios. State: verified. Dependencies: none. Implementation: complete.
- [x] **PROD-CI-06**: Supported runtime admission. State: verified. Dependencies: none. Implementation: complete.
- [x] **PROD-CI-09**: Observed green pushed baseline. State: verified. Dependencies: PROD-CI-02, PROD-CI-03, PROD-CI-04, PROD-CI-05. Implementation: complete.

## Paused requirements, previously underway

- [ ] **PROD-CI-05**: Canonical gates and sanitized artifacts. State: paused. Dependencies: none. Implementation: in_progress.
- [ ] **PROD-CI-07**: Dependency vulnerability clearance. State: paused. Dependencies: none. Implementation: in_progress.
- [ ] **PROD-CI-08**: Fresh complete verification. State: paused. Dependencies: PROD-CI-02, PROD-CI-03, PROD-CI-04, PROD-CI-05, PROD-CI-06, PROD-CI-07. Implementation: in_progress.
- [ ] **PROD-PKG-01**: Linux worker image startup. State: paused. Dependencies: PROD-CI-09. Implementation: in_progress.
- [ ] **PROD-PKG-02**: Composed worker operation and shutdown. State: paused. Dependencies: PROD-CI-09. Implementation: in_progress.
- [ ] **PROD-PKG-03**: Filesystem and plan lifecycle. State: paused. Dependencies: PROD-CI-09. Implementation: in_progress.
- [ ] **PROD-PKG-04**: Supported installation topology. State: paused. Dependencies: PROD-CI-09. Implementation: in_progress.
- [ ] **PROD-PKG-05**: Default browser API and MCP journey. State: paused. Dependencies: PROD-CI-09. Implementation: in_progress.
- [ ] **PROD-PKG-06**: Durable database acceptance. State: paused. Dependencies: PROD-CI-09. Implementation: in_progress.
- [ ] **PROD-DUR-02**: Authoritative state and projections. State: paused. Dependencies: PROD-CI-09. Implementation: in_progress.
- [ ] **PROD-DUR-07**: Uncertain external mutation resolution. State: paused. Dependencies: PROD-CI-09. Implementation: in_progress.
- [ ] **PROD-LIFE-03**: AWS family migration and suffixes. State: paused. Dependencies: PROD-CI-09. Implementation: in_progress.
- [ ] **PROD-OBS-01**: Canonical observation-to-repair engine. State: paused. Dependencies: PROD-CI-09. Implementation: in_progress.

## Pending requirements, not started in this continuation

- [ ] **PROD-MIX-01**: Execution partitions and authorities. State: planned. Dependencies: PROD-CI-09, PROD-PKG-05, PROD-LIFE-03, PROD-LIFE-07. Implementation: not_assessed.
- [ ] **PROD-MIX-02**: Parent and immutable child plans. State: planned. Dependencies: PROD-CI-09, PROD-PKG-05, PROD-LIFE-03, PROD-LIFE-07. Implementation: not_assessed.
- [ ] **PROD-MIX-03**: Typed scoped dependency outputs. State: planned. Dependencies: PROD-CI-09, PROD-PKG-05, PROD-LIFE-03, PROD-LIFE-07. Implementation: not_assessed.
- [ ] **PROD-MIX-04**: Distributed failure and teardown order. State: planned. Dependencies: PROD-CI-09, PROD-PKG-05, PROD-LIFE-03, PROD-LIFE-07. Implementation: not_assessed.
- [ ] **PROD-MIX-05**: Protected cross-cloud connectivity. State: planned. Dependencies: PROD-CI-09, PROD-PKG-05, PROD-LIFE-03, PROD-LIFE-07. Implementation: not_assessed.
- [ ] **PROD-MIX-06**: Real mixed application traffic. State: planned. Dependencies: PROD-CI-09, PROD-PKG-05, PROD-LIFE-03, PROD-LIFE-07. Implementation: not_assessed.
- [ ] **PROD-MIX-07**: Mixed-cloud recovery and economics. State: planned. Dependencies: PROD-CI-09, PROD-PKG-05, PROD-LIFE-03, PROD-LIFE-07. Implementation: not_assessed.
- [ ] **PROD-DUR-01**: Durable intent and outbox. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-DUR-03**: Exact approved executable semantics. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-DUR-04**: Dispatch authorization and bounded autonomy. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-DUR-05**: Durable encrypted plan handoff. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-DUR-06**: Artifact cleanup and state backend recovery. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-DUR-08**: Build and cleanup deduplication. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-LIFE-01**: Connection administration lifecycle. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-LIFE-02**: Versioned offered capability catalog. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-LIFE-04**: Azure data plane and sovereign identity. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-LIFE-05**: OCI replacement and deletion evidence. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-LIFE-06**: Non-AWS ownership-safe DNS teardown. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-LIFE-07**: Kubernetes full lifecycle acceptance. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-LIFE-08**: GitHub source binding lifecycle. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-LIFE-09**: Isolated untrusted build provenance. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-LIFE-10**: Release and data migration safety. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-LIFE-11**: Backup export import and adoption. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-LIFE-12**: Single owner per mutable field. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-MACH-01**: Typed safe guest configuration. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-MACH-02**: Kubernetes guest credentials. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-MACH-03**: Signed automation and scheduling. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-MACH-04**: Linux runner delivery and lifecycle. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-MACH-05**: Local customer credential custody. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-MACH-06**: Bounded evaluated coding agents. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-OBS-02**: Fresh scoped telemetry provenance. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-OBS-03**: Incident stability and escalation. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-OBS-04**: Durable critical schedules. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-MAN-01**: Default managed substrate and sessions. State: planned. Dependencies: PROD-CI-09, PROD-PKG-05, PROD-LIFE-07. Implementation: not_assessed.
- [ ] **PROD-MAN-02**: Managed serving integrations. State: planned. Dependencies: PROD-CI-09, PROD-PKG-05, PROD-LIFE-07. Implementation: not_assessed.
- [ ] **PROD-MAN-03**: Tenant storage domains and service catalog. State: planned. Dependencies: PROD-CI-09, PROD-PKG-05, PROD-LIFE-07. Implementation: not_assessed.
- [ ] **PROD-MAN-04**: Two untrusted tenant isolation. State: planned. Dependencies: PROD-CI-09, PROD-PKG-05, PROD-LIFE-07. Implementation: not_assessed.
- [ ] **PROD-MAN-05**: Resource isolation under load. State: planned. Dependencies: PROD-CI-09, PROD-PKG-05, PROD-LIFE-07. Implementation: not_assessed.
- [ ] **PROD-MAN-06**: Separable metering and billing. State: planned. Dependencies: PROD-CI-09, PROD-PKG-05, PROD-LIFE-07. Implementation: not_assessed.
- [ ] **PROD-MAN-07**: Operator commercial decisions. State: planned. Dependencies: PROD-CI-09, PROD-PKG-05, PROD-LIFE-07. Implementation: not_assessed.
- [ ] **PROD-OPS-01**: Measured service and recovery objectives. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-OPS-02**: Fair bounded control plane. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-OPS-03**: Rolling upgrades and replay. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-OPS-04**: Clean-host restore and recovery epochs. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-OPS-05**: Purpose-separated key custody. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-OPS-06**: Sensitive persistence minimization. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-OPS-07**: Configurable non-destructive retention. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-OPS-08**: Independent adversarial security acceptance. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-OPS-09**: Verified release supply chain. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-UX-01**: Accessible privileged operator journey. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-UX-02**: Configured client interoperability. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-UX-03**: Reviewed revocable plugin boundaries. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-COST-01**: Source-backed dated price catalog. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-COST-02**: Complete placement costs and constraints. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-COST-03**: Bounded economic optimization. State: planned. Dependencies: PROD-CI-09. Implementation: not_assessed.
- [ ] **PROD-REL-01**: Required end-to-end release evidence. State: planned. Dependencies: none. Implementation: not_assessed.
- [ ] **PROD-REL-02**: Requirement-to-evidence release dossier. State: planned. Dependencies: none. Implementation: not_assessed.
- [ ] **PROD-REL-03**: Separate release status and signoff. State: planned. Dependencies: none. Implementation: not_assessed.
- [ ] **PROD-REL-04**: Scope permission and resumable execution. State: planned. Dependencies: none. Implementation: not_assessed.

## Workstreams integrated and preserved

- [x] PROD-WS-CI-SCHEMA: `ws/prod-ci-schema` integrated locally. This is source integration, not completion of every related production requirement.
- [x] PROD-WS-GATE-REPORT: `ws/prod-gate-report` integrated locally. This is source integration, not completion of every related production requirement.
- [x] PROD-WS-WORKFLOWS: `ws/prod-workflows` integrated locally. This is source integration, not completion of every related production requirement.
- [x] PROD-WS-RUNTIME-SECURITY: `ws/prod-runtime-security` integrated locally. This is source integration, not completion of every related production requirement.
- [x] PROD-WS-WORKER-STARTUP: `ws/prod-worker-startup` integrated locally. This is source integration, not completion of every related production requirement.
- [x] PROD-WS-DEPENDENCY-REMEDIATION: `ws/prod-dependency-remediation` integrated locally. This is source integration, not completion of every related production requirement.
- [x] PROD-WS-CANONICAL-REPAIR: `ws/prod-canonical-repair` integrated locally. This is source integration, not completion of every related production requirement.
- [x] PROD-WS-EVIDENCE-BINDING: `ws/prod-evidence-binding` integrated locally. This is source integration, not completion of every related production requirement.
- [x] PROD-WS-AWS-UI-FIXTURES: `ws/prod-aws-ui-fixtures` integrated locally. This is source integration, not completion of every related production requirement.
- [x] PROD-WS-AWS-BROWSER-CONTRACT: `ws/prod-aws-browser-contract` integrated locally. This is source integration, not completion of every related production requirement.
- [x] PROD-WS-START-UNCERTAINTY: `ws/prod-start-uncertainty` integrated locally. This is source integration, not completion of every related production requirement.
- [x] PROD-WS-PG-GRANT-CLOCK: `ws/prod-pg-grant-clock` integrated locally. This is source integration, not completion of every related production requirement.
- [x] PROD-WS-INTEGRATED-CI: `ws/prod-integrated-ci` integrated locally. This is source integration, not completion of every related production requirement.

## Paused workstreams

- [ ] PROD-WS-ECS-REPLICA-REPAIR: `ws/prod-ecs-replica-repair`. Frozen source remains in its worktree; review handoff before resuming.

## Separate release states

- [ ] implementationComplete: not established.
- [ ] sandboxVerified: not established.
- [ ] pilotReady: not established.
- [ ] productionApproved: not established.

Detailed acceptance, dependencies, evidence levels and prior records remain in `../../ledger.json` and generated `../../REQUIREMENTS.md`. Historical wave-8 tasks remain complete; this production backlog does not restart them.
