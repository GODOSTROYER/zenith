# PROD-COST-03 Bounded economic optimization

## 1. Summary
- `src/lib/placement/optimizer.ts`: pure optimizer `optimizeEconomics`. Right-sizing (one size step or one replica) and same-provider site relocation, priced with the COST-01 catalog and COST-02 cost/latency/residency models. Defines `FieldOwnershipCheck` (default `refuseUnknownFieldOwnership`, plus `staticFieldOwnership` for tests).
- `src/lib/placement/optimizer-submit.ts`: `submitOptimizationProposals` hands proposals to the existing capability broker (`service.scale` for container-service steps, `infrastructure.plan` otherwise). Proposes only; never approves or executes. Returns history entries for the caller to persist.
- `src/lib/placement/index.ts`: exports both.
- `tests/placement/optimizer.test.ts`: contract tests (real default catalog, real memory-store broker).

## 2. Acceptance mapping
Acceptance: "Measurable bounded nonflapping optimizations respect approval/field ownership and transfer/latency/residency cost."
- Measurable: measured usage required (`no_measured_baseline`), billed reconciliation (`baseline_unreconciled`), savings labelled `estimate` with baseline, catalog version, exclusions, min USD/pct thresholds. Tests: "measured baseline and estimate labelling", "thresholds...".
- Bounded: one step per change, `maxChangesPerWindow`, `maxWindowShiftPct`, history counted. Tests: "bounded change size per window".
- Non-flapping: downscale ceiling below upscale trigger (policy rejects no band), cooldown, reversal lockout, one proposal per resource per run. Tests: "does not flap", "applies a cooldown", "refuses to undo".
- Approval: only via broker `propose`; policy and human approval decide; idempotent. Test: "submission through the capability broker".
- Field ownership: `FieldOwnershipCheck`, unknown or external refused, not-managed nodes never changed. Tests: "field ownership".
- Transfer/latency/residency: relocation prices changed cross-region egress via the cost model, one-time data copy, payback, p95 target and regression bound, residency on every destination, zone capacity. Tests: "transfer, latency and residency".

## 3. Verification (other machine)
`npx vitest run tests/placement/optimizer.test.ts` (no env vars; memory-store broker). Expected: all pass. Also run `tests/placement/` and `tests/capabilities/broker.test.ts` for regressions (no existing file changed except `index.ts` exports).

## 4. Known gaps
- Cross-cloud relocation is out of scope (placement solver owns it). Right-sizing covers container_service, compute_instance, postgres, redis; non-container changes go to `infrastructure.plan` as an `optimize` input the plan pipeline must learn to consume.
- Utilization, measured usage and history persistence are inputs; no collector or store is added here. No new SQL or tables.
- Relocation tests assert invariants, not specific savings (catalog price differences decide whether any move qualifies).
- No orchestrator shared-file changes needed. Registry (PROD-LIFE-12) must implement `FieldOwnershipCheck` and be passed as `ownership`; field names used: `spec.size`, `spec.replicas`, `region`, `provider`.
- Tests were not run here (build-only rule); tsc shows only pre-existing errors in unrelated files (tofu/engine.ts, tests/ci/platform-coverage.test.ts).

## 5. Suggested implementationStatus
"implemented_unverified: pure optimizer + broker submission + contract tests; awaiting test run and field-ownership registry wiring"
