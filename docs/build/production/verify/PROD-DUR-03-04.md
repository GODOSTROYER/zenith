# PROD-DUR-03 Exact approved executable semantics and PROD-DUR-04 Dispatch authorization and bounded autonomy: verification notes

Built only; nothing here was executed (typecheck and eslint on the changed files only). Another machine runs every test below. Branch `prod/dur-b-w3`, platform migration **31** (version 30 is not used by this branch).

## 1. What was built

Audit first. At the base commit the saved-plan apply already dispatched the **original reviewed bytes** (`planArtifacts.consume` with a `beforeDispatch` guard that re-checks custody, workspace and approval); the stale LIMITATIONS sentence "applies that exact new saved file" no longer describes `src/lib/execution/apply.ts`. What was missing, and is now built:

| Gap found | Fix |
| --- | --- |
| "What will run" was checked piecemeal (plan digest, custody source digest, workspace comparison, migration binding). No single value covered migration classification, release script, provenance/context digests, ownership transfers or a runbook version, and an approval did not bind to any of them. | One canonical **executable semantics digest** with 12 independently hashed components. Approval binds to it, every dispatch recomputes it, a mismatch refuses with a replan/reapproval path. |
| Release steps (build, rollout, migration) had no re-derivation of semantics, and rollout/migration had no dispatch-time authorization recheck. | `assertOperationSemantics` at build, rollout and migration dispatch: semantics recompute plus `approvalStatus` (current policy, roles, standing grants, approvals). |
| No standing grant concept; `autonomy` was the only unattended path. | Bounded, revocable **standing grants** (a person's pre-approval) recorded as ordinary approvals, with dispatch-time revocation. |

### Semantics digest (PROD-DUR-03)

New `src/lib/execution/semantics/`:
- `digest.ts` (pure): `computeExecutableSemantics`, `diffSemantics`, `readExecutableSemantics`. Components: `revision` (revision id, deployed revision, manifest digest), `recipe` (approved source set digest and per-service commit, Dockerfile, recipe, archive; LIFE-08), `scripts` (release command digest, service, timeout), `migrations` (LIFE-10 declared class, effective class raised by SQL, SQL digest), `targets` (graph digest, provider, region, environment, connection id and configuration digest), `configuration` (rendered OpenTofu configuration digest), `providerLocks` (lock digest, OpenTofu version), `backend` (kind and `backend.tf.json` digest), `savedPlan` (plan digest), `provenance` (build context dir and inspected context digest per pipeline; LIFE-08/09), `ownership` (active field-ownership transfers for resources of this graph; LIFE-12), `runbook` (signed runbook id, version, definition digest; MACH-03). Arrays are sorted, so ordering never invalidates.
- `errors.ts`: `SemanticsChangedError` (an `ApplicationFailure` of type `plan_changed`, non retryable: every workflow already ends it as "failed, reapproval required"; message names components only, never values).
- `collect.ts`: gathers the inputs from trusted authorities only (product store, resolved connection, rendered workspace, ownership registry, approved-source capture, the immutable operation input). A malformed runbook claim is never dropped silently.
- `store.ts`: `SemanticsStore` port, write-once, plus `MemorySemanticsStore`. `dispatch.ts`: `recordReviewedSemantics`, `assertApprovedSemantics`. `operation.ts`: `assertOperationSemantics` for release steps.
- `src/lib/controlplane/db/migrations/0031_executable_semantics.ts` (version 31, registered in `migrations/index.ts`) and `src/lib/controlplane/db/repos/executable-semantics.ts` (`createPlatformSemanticsStore`, not added to `repos/index.ts`, like the release store).

Wiring (all in the real callers):
- `planInfrastructure` (`src/lib/execution/plan.ts`): computes the semantics of the plan it just produced, records them write-once BEFORE the reviewed plan is published, and puts the document in the `tofu_plan` evidence summary the approver reads.
- Review projection (`operation-review.ts`): `OperationPlanReview.semantics`; a present but malformed document makes the review unreadable (approval disabled), never a pass. `getOperationDetail` returns it, so REST and the page show it.
- Approval (`capabilities/approvals.ts`): at a plan gate whose review carries semantics, `semanticsDigest` is required and must equal the recorded digest (`semantics_mismatch`, audited); an `approval_semantics_bound` event names approval id, semantics digest and plan digest. REST `POST /operations/:id/approve` accepts `semanticsDigest`; the approval card shows the digest with an explanation and sends it.
- `finalPlan`: the re-plan must carry the reviewed semantics (`SemanticsChangedError`, stage "final plan").
- `applyInfrastructure` `beforeDispatch` (immediately before the original bytes dispatch): recompute from freshly loaded context, graph, connection and workspace, compare with the stored row, then the existing current-authority check. `SemanticsChangedError` is passed through `classifyApplyFailure`.
- `buildArtifacts` (before any build), `deployWorkloads` (before the first rollout effect, secret sync included) and `runMigrationTask` (before the single use migration approval is consumed): `assertOperationSemantics` = semantics recompute, then `approvalStatus` again.
- Composition: `src/lib/platform/execution.ts` always supplies `semantics: createPlatformSemanticsStore(db)`.

### Standing grants (PROD-DUR-04)

`src/lib/capabilities/standing-grants.ts` (domain, pure eligibility, `MemoryStandingGrantStore`, create/revoke/list, use at propose, dispatch-time lapse), migration 31 tables, `repos/standing-grants.ts` (`createPlatformStandingGrantStore`). `BrokerStore.standingGrants?` is optional like `fieldOwnership`; `PlatformBrokerStore` and `MemoryBrokerStore` provide it (an absent store can neither create nor honour a grant).

Bounds, all mandatory (and again in SQL CHECKs and triggers): one environment (optionally project and resource), explicit capability list (never destructive, escape-hatch, `defaultAutonomy 6`, critical risk, or read-only), risk ceiling low/medium/high compared with the policy-evaluated risk, explicit agents (`integration:<id>` or `navigator:<id>`, never a human), `maxUses` 1..1000 reserved atomically, expiry 5 minutes to 30 days. It never covers: a requirement of more than one approver, an ownership transfer, a policy denial, a plan gate (round > 0: concrete plans are always reviewed by a person), or a requester equal to the creator when separation of duties is required.

Creation and revocation are browser-only, human, admin (revoker: creator or admin) and audited (`standing_grant_created|used|revoked` events). A use records an ordinary approval (approver = creator, role admin, reason names the grant) through the same `recordApproval`, so claim, current-policy recheck and SQL consumption are unchanged. **Dispatch-time revocation:** `lapsedStandingApprovalIds` drops an approval whose grant is revoked, expired or whose creator is no longer admin; `beginExecution` (`standing_grant_lapsed`) and the worker `approvalStatus` (`createExecutionBroker`, so apply, release and migration gates) both apply it.

REST: `GET|POST /api/platform/v1/standing-grants`, `POST /api/platform/v1/standing-grants/:id/revoke` (all `browser-only` in `bearer-paths.ts`). `Broker` facade: `createStandingGrant`, `revokeStandingGrant`, `listStandingGrants`. New broker error codes: `semantics_mismatch`, `semantics_changed`, `standing_grant_lapsed` (409).

### Shared types touched (additive)
`ExecutionDeps.semantics?`, `OperationPlanReview.semantics?`, `OperationDetail.planReview.semantics?`, `DecideInput.semanticsDigest?`, `BrokerStore.standingGrants?`, `BrokerErrorCode` additions, `Broker` facade methods, `PlanStage.workspace/graph/connection` (module private). `tests/execution/fakes/world.ts` gained the optional `semantics` world option.

## 2. Acceptance mapping

PROD-DUR-03: "Approval binds revision, recipe, scripts/migrations, targets/configuration, provider locks/backend and saved plan; changed relevant semantics invalidates approval."

| Clause | Implementation | Tests |
| --- | --- | --- |
| revision | `revision` component | `tests/execution/semantics.test.ts` (3 mutations, diff names `revision`) |
| recipe | `recipe` component from approved source snapshots | semantics.test.ts (5 mutations) |
| scripts / migrations (LIFE-10) | `scripts`, `migrations` components; collector uses `assessMigration` | semantics.test.ts (pure mutations; collector: unclassified, class change, command change) |
| targets / configuration | `targets`, `configuration` | semantics.test.ts |
| provider locks / backend | `providerLocks`, `backend` (`backend.tf.json` digest) | semantics.test.ts |
| saved plan | `savedPlan` | semantics.test.ts |
| provenance + contextDigest (LIFE-08/09), ownership (LIFE-12), runbook (MACH-03) | `provenance`, `ownership`, `runbook` | semantics.test.ts (mutations, collector ownership filter, runbook reference parsing) |
| approval binds | approve requires and audits the digest | `tests/platform/semantics-approval.test.ts` (missing, wrong, right, reject, legacy, detail exposure) |
| write-once record | migration 31 trigger, `SemanticsStore` | `tests/controlplane/executable-semantics.test.ts` (both lanes), semantics.test.ts (memory store) |
| invalidates at every dispatch | final plan, apply, build, rollout, migration | `tests/execution/semantics-dispatch.test.ts` |
| refusal path to replan/reapproval | `plan_changed` failure type, component names, page already offers reapproval | semantics.test.ts (failure type, names, no value in message), semantics-dispatch.test.ts |

PROD-DUR-04: "Policy/authorization rechecked at dispatch; browser-human approvals unforgeable; destructive/high-risk gates mandatory; standing grants are explicitly bounded."

| Clause | Implementation | Tests |
| --- | --- | --- |
| rechecked at dispatch | `beginExecution` (existing), apply `beforeDispatch` and release gates through `approvalStatus` (current policy, roles, grants, approvals), standing approvals lapse | semantics-dispatch.test.ts ("decides authorization again" at rollout and migration, apply withdrawn approval), standing-grants.test.ts (revoked, expired, creator demoted at `beginExecution`) |
| browser-human unforgeable | grant create/revoke use `requireHumanSession` and browser-only routes; approve route unchanged and still browser-only | standing-grants.test.ts (agent, wrong session, non-member, editor), `tests/middleware/platform-bearer.test.ts` (inventory 65 to 68, three routes classified browser-only) |
| destructive/high-risk gates mandatory | `standingIneligibleReason`; plan gates and multi-approver and transfers never covered; policy denial wins | standing-grants.test.ts (18 refused creations, never-standing catalog check, risk ceiling, count 2, deny) |
| standing grants explicitly bounded | scope, capabilities, risk, principals, count, expiry; SQL CHECK and triggers; atomic reservation | standing-grants.test.ts (count, concurrency, expiry, scope, principal), executable-semantics.test.ts (SQL bounds, immutability, concurrency, revoke, void) |
| audit | `standing_grant_created/used/revoked`, `approval_semantics_bound` events | standing-grants.test.ts, semantics-approval.test.ts |

## 3. Verification commands (other machine)

```
npx vitest run tests/execution/semantics.test.ts tests/execution/semantics-dispatch.test.ts
npx vitest run tests/execution/apply.test.ts tests/execution/plan.test.ts tests/execution/release.test.ts tests/execution/release-safety.test.ts tests/execution/journey.test.ts tests/execution/approved-source.test.ts
npx vitest run tests/capabilities/standing-grants.test.ts tests/capabilities/approvals.test.ts tests/capabilities/execution.test.ts tests/capabilities/broker.test.ts
npx vitest run tests/platform/semantics-approval.test.ts tests/platform/plan-approval.test.ts tests/middleware/platform-bearer.test.ts
npx vitest run tests/controlplane/executable-semantics.test.ts tests/controlplane/migrations.test.ts        # PGlite lane
ZENITH_TEST_PLATFORM_PG_URL=<postgres url> npx vitest run tests/controlplane/executable-semantics.test.ts tests/capabilities/standing-grants.test.ts tests/platform/semantics-approval.test.ts
npx tsc --noEmit -p . && npx eslint src/lib/execution/semantics src/lib/capabilities src/lib/platform tests/execution tests/capabilities
```

Expected: all pass, zero skipped (the PostgreSQL lane only with the env var). Existing suites must stay green because every new dispatch check is inert without a wired semantics store and the approval check applies only to reviews that carry semantics.

Typecheck: `npx tsc --noEmit -p .` exit 0 and `npx eslint` on every changed and new file clean at the time of the commit.

## 4. Known gaps, things that may break first, shared-file updates

Things that may break first:
1. `tests/controlplane/migrations.test.ts`: the contiguity test (versions contiguous from 1) fails on this branch alone because version 30 belongs to a sibling worker; the assembler fills it. The table inventory lists in that test and `tests/security` tenancy lists need `approved_semantics`, `standing_grants`, `standing_grant_uses`.
2. `semantics-dispatch.test.ts` release-step cases drive `planInfrastructure` over the web+db migrating manifest with the scripted fakes; if the fake drivers lack a kind for that graph, plan first with a smaller manifest (the production behaviour does not depend on it).
3. `projectPlanReview` of the fake plan view in `semantics-dispatch.test.ts` ("shows the same digest") needs the fake plan to satisfy the review schema, as production plans do.
4. `tests/middleware/platform-bearer.test.ts` expects 68 routes (65 + 3); sibling workers adding routes change the number, reconcile on assembly.

Limits (stated, not hidden):
- **Destroy and teardown.** `execution/destroy.ts` keeps its own original-plan custody and admin approval; it does not record or compare the semantics digest (DUR-C owns plan artifacts and cleanup). Standing grants can never cover destroy.
- **Native runbook runs** keep their own `bindingDigest` (runbook id, version, definition digest, targets, windows) and per-step broker grants (MACH-03). The semantics `runbook` component binds operations whose immutable input carries `runbook: { runbookId, version, definitionDigest }`; nothing in the product emits that field yet, so it is exercised by tests and the collector only.
- **Migration SQL.** The migration class is the declared class (raised by SQL only when the caller supplies SQL, which the deploy path does not); the component records `sqlDigest: null` until SQL is available to classify.
- **Build provenance** is produced after approval; the `provenance` component binds the inspected context digest and directory, and signed provenance continues to be verified against the approved recipe at admission (LIFE-09).
- **Standing grants have no browser UI** (REST only) and do not appear in the MCP operation view; MCP output shape is unchanged. A grant's creator role is re-resolved at use and at dispatch; the use count is spent at proposal, not at execution (a cancelled operation does not return it).
- **Legacy plans** reviewed before this build have no semantics: approval keeps its old behaviour, and dispatch refuses them (when the store is wired) with "No executable semantics were recorded ... Plan again".
- **Live acceptance** (operated default browser approval journey, real provider apply) is not performed or claimed.

Shared-file updates the orchestrator must make:
- Migrations inventory: version 31 `executable_semantics`, tables `approved_semantics` (write-once), `standing_grants`, `standing_grant_uses`; RLS enabled; `service_role` grants: select/insert on `approved_semantics`, select/insert/update on the two grant tables; no anon/authenticated access. Emit supabase SQL after the 30/31 merge.
- Tenancy classification (`tenancy.test.ts`, controlplane SQL scoping): every new store function filters on `workspace_id`; tenant-scoped tables: `approved_semantics` (PK workspace/operation/plan, FK to operations), `standing_grants` (workspace_id, unique workspace/id), `standing_grant_uses` (FKs to grants and operations by workspace). Store functions: `createPlatformSemanticsStore.record/get`; `createPlatformStandingGrantStore.create/get/list/revoke/reserveUse/attachApproval/voidUse/usesForOperation`.
- Gate manifest and platform coverage: add `tests/controlplane/executable-semantics.test.ts` (suite `approved semantics and standing grants [postgres]`, postgres: true), and the unit/platform files `tests/execution/semantics.test.ts`, `tests/execution/semantics-dispatch.test.ts`, `tests/capabilities/standing-grants.test.ts`, `tests/platform/semantics-approval.test.ts`.
- LIMITATIONS: replace "Existing engine regenerates a matching plan and applies that exact new saved file, not retained original approval-time bytes" with the current behaviour (original bytes dispatch, now with semantics and authority recheck); add the limits above (destroy not bound, runbook field unemitted, standing grants REST only).
- Workflow/gate wiring: none beyond the composition line in `src/lib/platform/execution.ts`.

## 5. Suggested ledger implementationStatus

- PROD-DUR-03: `executable_semantics_digest_bound_at_approval_and_every_dispatch_contract_and_local_engine_tests_pending_live_operated_acceptance_open`
- PROD-DUR-04: `dispatch_reauthorization_all_release_steps_and_bounded_standing_grants_with_dispatch_revocation_built_live_acceptance_open`
