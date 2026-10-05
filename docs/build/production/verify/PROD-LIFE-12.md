# PROD-LIFE-12 Single owner per mutable field

## 1. What was built
New pure module `src/lib/ownership/` (one door `@/lib/ownership`):
- `types.ts`, `paths.ts`: owners (`iac | native-op | autoscaler | provider-managed`), rules, transfers, writes, conflicts.
- `registry.ts`: `FieldOwnershipRegistry` (resource type + field path -> owner; registration refuses two rules claiming one field), default rules that mirror existing behaviour (ECS/K8s/Azure replicas -> autoscaler when attached, release image -> native-op for built artifacts, EC2 `ami` and Azure flexible-server zones -> provider-managed, SSM parameter value -> native-op), exact digest-bound `OwnershipTransfer` handling (`transferDigest`, `transferRequest`).
- `facts.ts`: autoscaled / release-managed facts derived from the compiled graph (`spec.autoscaling`, native HPA / app-autoscaling nodes).
- `conflicts.ts`: `evaluateWrite` (allowed | transfer_required | refused), `checkNativeOperation` / `assertNativeOperationAllowed` (service.scale, deployment.deploy/rollback, drift.repair), `checkPlanFieldOwnership` / `assertPlanFieldOwnership` over a NormalizedPlan.
- `drift.ts`: `classifyDrift` (unauthorized_change | native_divergence | expected_variance) and `applyFieldOwnership` (drops autoscaler/provider variance, marks native-op-owned drift non-repairable).
- `lifecycle.ts`: `ignoreChangesFor`, `lifecycleIgnoreChanges`, `mergeIgnoreChanges`.

Typed API for PROD-COST-03: `resolveFieldOwner`, `evaluateWrite`, `FieldOwnershipRegistry`, `transferRequest`, `factsForNode`/`factsByAddress`, `FieldConflict`, `OwnershipTransfer`.

Integrations (edited files):
- `src/lib/capabilities/broker.ts` + `types.ts`: optional `ProposeContext.fieldOwnership` guard; propose and check throw `BrokerError("conflict")` with `details.reason = "field_ownership_conflict"` before anything is persisted.
- `src/lib/execution/plan.ts` (`inspectDeployDeletions`): plan-time refusal (StepFailedError) of IaC updates to non-iac fields.
- `src/lib/reconcile/core.ts`, `src/lib/execution/verify.ts`: drift reports pass through `applyFieldOwnership`.
- `src/lib/providers/aws/drivers/compute/ecs-service-compile.ts`: `lifecycle.ignore_changes = ["desired_count"]` only when an autoscaler is attached (no output change otherwise).

## 2. Acceptance mapping
"Native operations, IaC and autoscalers have explicit field ownership and conflict detection; no competing writers."
- Explicit ownership: registry + default rules -> `tests/ownership/field-ownership.test.ts` (registry, facts).
- Native operation conflicts: `tests/ownership/field-ownership.test.ts` (native operation enforcement), `tests/capabilities/field-ownership-broker.test.ts` (both stores).
- IaC conflicts: plan enforcement block in `tests/ownership/field-ownership.test.ts`.
- Autoscaler: facts, drift and lifecycle blocks; `tests/providers/aws/drivers/compute/ecs-ownership-lifecycle.test.ts`.
- Drift uses ownership: drift classification block.
- No competing writers via transfers: exact, digest-bound, expiring, from-owner-checked transfers (registry block).

## 3. Verification commands
- `npx vitest run tests/ownership tests/capabilities/field-ownership-broker.test.ts tests/providers/aws/drivers/compute/ecs-ownership-lifecycle.test.ts` (all pass; broker test uses the existing PGlite harness, no extra env).
- Regression: `npx vitest run tests/capabilities tests/reconcile tests/resources tests/providers/aws/drivers/compute tests/execution` should be unchanged.
- `npx tsc --noEmit -p .`: only pre-existing errors in `src/lib/tofu/engine.ts` and `tests/ci/platform-coverage.test.ts` (not touched by this work).

## 4. Known gaps and orchestrator follow-ups
- Ownership transfers are not persisted: no table was added (no migration). Callers pass `transfers`; a durable store bound to the approval flow is follow-up work. Until then the plan-time check (`execution/plan.ts`) has no transfers and refuses every non-iac field update.
- The broker guard is opt-in: callers that know the target node must supply `ProposeContext.fieldOwnership`. Wiring it into the MCP/REST propose paths (which resolve resources) is not done. Native operation drivers (`ecs-operations.ts`, `kubernetes/ops.ts`) still keep their own runtime checks.
- Only ECS compile consumes `ignoreChangesFor`; Azure/GCP/EC2 keep their hard-coded `ignore_changes`, which a test asserts match the registry. `spec.autoscaling` is not yet a manifest field; the autoscaled fact also comes from native HPA / `aws:appautoscaling_target` nodes.
- Rules are seeded for ECS, K8s, Azure Container Apps, GCP Cloud Run, EC2, Azure flexible servers and SSM parameters only.
- No tests were run locally (build-only rule).
- Shared files: none changed. No DB tables, so no migration inventory update. Optionally add the new test paths to `scripts/ci/gate-manifest.mjs`, and a LIMITATIONS note for the gaps above.

## 5. Suggested ledger implementationStatus
`field_ownership_registry_plan_and_proposal_enforcement_drift_classification_ignore_changes_contract_only_transfer_persistence_pending`
