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

## 3b. Follow-up: persisted transfers, plan-time transfers, default-on broker guard
- Migration: platform migration 18 `ownership_transfers` (`src/lib/controlplane/db/migrations/0018_ownership_transfers.ts`, registered in `migrations/index.ts`; checksum `d19177da5b80a5bde2ea6b51d232f288d7123546d7aca483d216d710bd769e7a`). Table `platform.ownership_transfers`: workspace/project/environment, address, resource type, field path, from/to owner, transfer digest, `operation_id` + `approval_id` (FK to the approving human approval), `proposal_digest` (the immutable proposal), approved/expires/revoked columns, RLS on with no policies, append-only trigger (only one-way revocation), service_role select/insert + update(revoked_at, revoked_by) only (also in the emitter's hardening block). prod/compose was merged first. Platform 17 is MACH-03's; the supabase aggregate for this change is `supabase/migrations/0020_platform_core.sql` (EMITTED_FILE bumped). It was generated WITHOUT migration 17 in the tree: after merging MACH-03, re-run `npx tsx scripts/platform/emit-sql.ts`, and adjust the 0019/0020 file names, inventory rows and counts if MACH-03 took a different supabase number.
- Store: `src/lib/controlplane/db/repos/ownership-transfers.ts` (namespace `ownershipTransfers`, in repos index and bindRepos): `recordForApprovedOperation`, `listActive`, `revoke`, `guardFor`. Transfers are created ONLY by `approvals.record`, in the same transaction that moves an operation to approved: a human user approval of the exact proposal digest, for the transfers stored in `proposal.broker.ownershipTransfers` (digests recomputed, never trusted). Models cannot create them; they can only request one (`input.requestOwnershipTransfer = true`), which forces a require_approval outcome and shows the exact transfer to the approver.
- Plan-time: the `execution/plan.ts` inspector loads `resources.activeOwnershipTransfers` (optional ResourcesPort method, implemented in `execution/platform.ts`; fakes without it get none). Non-iac updates pass only with a matching unrevoked transfer. Defaults: a field with no rule is owned by iac, so ordinary updates are never refused; only fields with an explicit autoscaler, native-op or provider-managed owner are enforced.
- Broker default-on: `BrokerStore.fieldOwnership?` (implemented by `PlatformBrokerStore`, tenant-scoped in SQL). `propose` and `check` call it after policy evaluation (so only an authorized principal learns anything) for service.scale, deployment.deploy/rollback and drift.repair. REST, MCP, bridge and reconciler all go through the broker, so all are covered. An explicit `ctx.fieldOwnership` still wins. A store-supplied guard is lenient in exactly one case, to keep existing day-two journeys working: a native op on a field only the manifest owns by default proceeds with an approver-visible warning (the next apply may revert it). Autoscaler, provider, release and transferred fields are refused either way.
- Tests: `tests/capabilities/ownership-transfers.test.ts` (pglite and postgres lanes), `tests/ownership/field-ownership.test.ts` (includes "does not refuse ordinary iac-owned updates" and "allows a non-iac update only with a matching unrevoked transfer"), tenancy classification in `tests/controlplane/tenancy.test.ts`.
- Inventories I updated: `scripts/ci/apply-supabase-migrations.sh` (adds 0020), `docs/platform/operations/DEPLOYING.md` (count 17, highest 18, row 18, aggregate 0020), `tests/controlplane/migrations.test.ts` (version 18 name and checksum), `tests/ci/platform-coverage.test.ts` (committed file list). Tenancy classification (SWEPT, with foreign-workspace attempts): `ownershipTransfers.listActive`, `.guardFor`, `.revoke`, `.recordForApprovedOperation`. The sql-scoping test is static discovery; every query filters `workspace_id`.
- Verify: `ZENITH_TEST_PLATFORM_PG_URL=... npx vitest run tests/capabilities/ownership-transfers.test.ts tests/controlplane/tenancy.test.ts tests/controlplane/migrations.test.ts tests/security/controlplane-sql-scoping.test.ts tests/ci/platform-coverage.test.ts tests/docs/operator-docs.test.ts tests/ownership`.

## 4. Known gaps and orchestrator follow-ups
- Revocation has a store function but no REST/UI route yet; ownership is rechecked at propose time only (not again at claim).
- Only ECS compile consumes `ignoreChangesFor`; Azure/GCP/EC2 keep their hard-coded `ignore_changes`, which a test asserts match the registry. `spec.autoscaling` is not yet a manifest field; the autoscaled fact also comes from native HPA / `aws:appautoscaling_target` nodes.
- Rules are seeded for ECS, K8s, Azure Container Apps, GCP Cloud Run, EC2, Azure flexible servers and SSM parameters only.
- No tests were run locally (build-only rule).
- Shared files edited as instructed (see 3b).

## 5. Suggested ledger implementationStatus
`field_ownership_registry_plan_and_proposal_enforcement_drift_classification_ignore_changes_contract_only_transfer_persistence_pending`
