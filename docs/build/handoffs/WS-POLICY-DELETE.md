# WS-POLICY-DELETE — destructive plan facts reach policy; deletions always need a human

Workstream: WS-POLICY-DELETE (orchestrator brief) — Branch ws/policy-delete — worktree Z:/Projects/Spawned.ai/zenith-wt/ws-policy-delete
Base: ws/integrate-w6 (staging: deletion guards from WS-DESTROY-GUARDS merged)

## Situation (from WS-DESTROY-GUARDS)
src/lib/execution/plan.ts now records `statefulDeletes` / `dnsDeletes` as evidence fields, and the engine
refuses an unguarded deletion at apply. But policy only sees the older `destroyedStatefulAddresses` /
`dnsChanges` facts, and there is no approval rule that forces HUMAN REVIEW for any plan that deletes
stateful resources or DNS records in every environment class — so an auto-allowed operation reaches
apply and is refused there instead of entering human review.

## Do
1. Add optional arrays `statefulDeletes` and `dnsDeletes` to `PlanFacts` (src/lib/policy/types.ts ~20)
   and the strict schemas (src/lib/policy/schema.ts ~60, src/lib/execution/plan-evidence.ts ~56,
   src/lib/controlplane/db/repos/operation-review.ts ~15); include them in the stage facts.
2. policy/rego/approval.rego: any plan with stateful deletes or DNS deletes requires approval by a human
   in EVERY environment class, regardless of autonomy level (agents never auto-apply deletions); keep
   existing rules; Rego tests for each class and autonomy level.
3. `npm run policy:build` then `npm run policy:check` (opa 1.19.1). If opa cannot run in your sandbox,
   leave the Rego + tests and SAY the bundle was not rebuilt — the orchestrator rebuilds it.
4. Tests: an auto-allowed environment with a stateful delete now gets require_approval at evaluatePolicy
   (not a late apply refusal); the UI/approval card shows the deletions (existing plan view fields).

## Owned paths
policy/rego/** , policy/dist/** , src/lib/policy/** , src/lib/execution/plan-evidence.ts ,
src/lib/controlplane/db/repos/operation-review.ts , src/lib/execution/plan.ts (stage facts only) ,
tests/policy/** , tests/execution/policy-delete*.test.ts .

## Verification
- npx tsc --noEmit ; npx eslint <touched paths>
- npm run policy:check ; npx vitest run --maxWorkers=2 tests/policy tests/execution tests/security/policy-invariants.test.ts
