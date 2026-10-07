# PROD-MIX-01 Execution partitions and authorities / PROD-MIX-02 Parent and immutable child plans

Branch `prod/mix-01-02-w4b`, base ad78c593 (wave 3). Platform migration **43** (versions 37-42 belong to sibling workers; the
assembler fills the gap). Build only: nothing here was executed by the builder except typecheck and eslint. Live cloud acceptance
is deferred by the user; the live harness below is gated and is never a pass when skipped.

## 1. What was built

### Audit of what already existed

| Existing | State at the base | What this change does with it |
| --- | --- | --- |
| `src/lib/execution/mixed-partitions.ts` | Pure logical planner (`planMixedPartitions`): graph integrity, account/region/backend identity per binding, state-object disjointness, typed references, dependency cycles, per-partition `subplanDigest` / `effectDigest`, parent digests. `executionEnabled: false` literal. | **Reused, not replaced.** Two additive changes: `PartitionBinding.environmentId` (the child environment whose own state prefix holds that partition's state; absent keeps every old caller byte-identical) and `bindingIdentity` is now exported so a stored plan can be re-verified. |
| `src/lib/execution/mixed-child-admission.ts` + `repos/mixed-child-intents.ts` + migration 14 | First, deliberately **non-executable** custody slice: `reserve` always refuses, descriptors carry `executionEnabled:false` literals. | **Left untouched.** It stays the verified custody preview. The new layer below is the executable path; it does not call into or weaken it. See "Known gaps" for how the two relate. |
| `findGraphProblems` (`graph.ts`) cross-provider refusal | Every node on a provider other than the environment's is refused. | Refusal text and behaviour are **unchanged for every caller without an admission**. A node's refusal is lifted only by a `MixedAdmission` (below). |
| Start intents (DUR-A), semantics digest (DUR-B), `OperationRun`, broker claim, durable `workflow_start_intents` | Operation-keyed, single-provider workflows only. | Reused: the parent is a normal operation; children start through the same broker claim and durable start intent; the parent workflow is a new `OperationRun` workflow. |

### Model

1. **Partitioner** (`mixed/partitioner.ts`): every node is assigned to exactly one bound child by (provider, region) from the node
   and the account from the connection. No verified connection for a (provider, region): refused (`unbound_partition`). Two
   connections could host a node and no explicit pin: refused (`ambiguous_partition`). A bound child that hosts nothing: refused.
   Connection must be this workspace's, `verified`, not revoked. Each child gets its own state backend from the existing
   `backendForConnection` under its own child-environment prefix, gated by `assertBackendAdmissible`.
2. **Parent plan** (`mixed/parent-plan.ts`, types in `mixed/types.ts`, kept stable for MIX-03/04): ordered set of immutable
   `ChildSubplan`s, each with `subplanDigest`, `effectDigest` and its own `semanticsDigest` (`childSemanticsDigest`: subplan +
   connection identity + backend digests). `childSetDigest` is the digest of the ordered child set.
3. **Approval binding.** The parent is an ordinary `deployment.deploy` operation on the parent environment. Its immutable
   proposal input (`parentProposalInput`) is the plan id, parent digest, child set digest and every child's digests, so the
   existing approve route approves exactly that set (the input is part of the proposal digest). `attachParentOperation` proves
   byte-for-byte equality with the plan, write-once. `verifyParent` requires `approval_required` and at least one recorded human
   (user principal) approval of that exact proposal digest; a policy `allow` without a person is refused. The approver sees the
   plan id, child set digest and each child (new lines in `buildProposal` via `mixed/details.ts`).
4. **Children are real operations.** Each partition adopts one normal deploy operation of its child environment
   (`adoptChildOperation`): the operation's revision must expand to a graph that is an exact subset of the approved subplan
   (`verifyChildGraph`: same address, kind, provider, region, native type, ownership, spec digest; every managed node present),
   and the child connection/backend must still match the approval (`reverifyAuthority`). Binding is write-once. The child keeps
   its own approvals, DUR-B semantics, DUR-C custody and DUR-D effect ledger.
5. **Replacing the refusal.** `admitMixedGraph` mints a `MixedAdmission` only if the graph digest equals the plan's, every node is
   covered by a partition, and every partition's connection is currently bound, verified, unrevoked and unchanged since approval
   (all or nothing). `findGraphProblems(graph, provider, drivers, admission)` then lifts the foreign-placement refusal for exactly
   the admitted addresses; forged look-alike objects are not admissions (WeakSet registry). The parent workflow's validate step
   runs `findGraphProblems` with the admission, so every ordinary per-node check (driver, externalRef, ownership) still applies.
6. **Parent/child Temporal workflows with durable receipts.** `mixedParentWorkflow` (`workflows/definitions/mixedParent.ts`,
   `OperationRun`: lease, cancellation, one terminal status, never compensates) runs `validate -> lease -> execute_capability ->
   finalize -> release`. Per child, in dependency order: `advanceMixedChild` (dependency gate, child approval wait, re-verify
   graph and authority, broker claim, durable start intent, `started`), `awaitMixedChild` (4-minute windows, renews the parent
   lease, observes the child operation, records the **durable receipt** and the child's DUR-B reviewed semantics digest write-once),
   `settleMixedParent`. A failed, cancelled, uncertain, timed-out or blocked child stops the parent; later children become
   `blocked`; nothing is rolled back or destroyed. A `succeeded` child with no reviewed semantics digest is recorded `uncertain`,
   never success. The parent's final `succeeded` is re-derived from receipts (`settleOutcome`).
7. **Stable addresses** (`mixed/addresses.ts`): `<provider>:<region>:<digest(account)>::<graph address>`. Independent of partition
   ids, connection ids, binding ids, ordinals and operation ids, so they survive resume, worker change, connection rotation and
   re-planning. The registry is stored immutably (`mixed_addresses`) and re-compared with a fresh derivation at every parent start
   and every child advance (`address_drift` refuses).
8. **Resume safety.** Every activity decides from durable rows (`mixed_child_plans.state`, receipts, operation status), never from
   workflow memory. Crash windows: claimed-but-not-started child (adopted + op running): retry skips the claim and re-sends
   through the same idempotent start intent; started child: observation only; receipt recorded but state update lost: both happen
   in one transaction.

### Files

New:

| File | Role |
| --- | --- |
| `src/lib/execution/mixed/types.ts` | stable parent/child types, constants, error class (committed first for MIX-03/04) |
| `src/lib/execution/mixed/addresses.ts` | stable address derivation, registry comparison |
| `src/lib/execution/mixed/partitioner.ts` | provider/account/region/backend partitioning, connection authorization gate |
| `src/lib/execution/mixed/parent-plan.ts` | parent plan builder, digests, proposal input, integrity check |
| `src/lib/execution/mixed/verify.ts` | child graph subset proof, authority re-verification |
| `src/lib/execution/mixed/admission.ts` | `MixedAdmission` (replacement of the cross-provider refusal) |
| `src/lib/execution/mixed/receipt.ts`, `settle.ts` | content-addressed receipts; parent outcome from receipts |
| `src/lib/execution/mixed/service.ts` | plan, adopt, verify, advance, observe, settle over ports (`MixedWorld`, `ChildLauncher`) |
| `src/lib/execution/mixed/world.ts`, `runtime.ts` | product-store/connection port and production composition |
| `src/lib/execution/mixed/start.ts` | browser start of the approved parent (claim + durable start intent) |
| `src/lib/execution/mixed/details.ts` | approver-facing lines for the parent proposal |
| `src/lib/controlplane/db/migrations/0043_mixed_parent_plans.ts` | tables, triggers, RLS, grants |
| `src/lib/controlplane/db/repos/mixed-parent-plans.ts` | store functions |
| `src/lib/workflows/definitions/mixedParent.ts`, `src/lib/workflows/mixed-activities.ts` | workflow and worker activities |
| `src/app/api/platform/v1/mixed/plans/**`, `_lib/mixed.ts` | REST: plan+propose, read, adopt child, start |
| `scripts/acceptance/mixed-evidence.ts`, `tests/live/mixed-cloud.live.test.ts` | gated live harness / evidence verifier |

Changed (additive): `mixed-partitions.ts` (see above), `graph.ts` (`findGraphProblems` optional `admission`), `workflow-start-intents.ts`
(new start kind `mixedParent`; the `deploy` kind now **refuses** an operation whose input carries `mixedParentPlanId`, so a mixed
parent can never run through the single-provider deploy workflow), `workflows/types.ts` (`WORKFLOW_TYPES.mixedParent`),
`definitions/index.ts`, `workers/execution/worker.ts` (registers `createMixedActivities`), `capabilities/broker.ts` (details lines),
`repos/index.ts`, `migrations/index.ts`, `_lib/bearer-paths.ts` (3 route patterns).

### Database (migration 43)

Tables `platform.mixed_parent_plans`, `mixed_child_plans`, `mixed_child_receipts`, `mixed_addresses`; all tenant-owned
(`workspace_id`), RLS enabled, no anon/authenticated access, service role select/insert/update (receipts and addresses select/insert
only). Triggers: parent/child identity and subplan columns immutable; `parent_operation_id`, `child_operation_id` and
`executable_semantics_digest` write-once; versions advance by one; state machines forward-only; a terminal child state requires a
matching receipt; receipts need a `started` child bound to the same operation; receipts and addresses are append-only; nothing is
deletable. Stored data: ids, digests, bounded JSON of the plan. No credentials, plan files, outputs or provider responses.

## 2. Acceptance mapping

### PROD-MIX-01: "Partition graph by provider/account/region/backend; bind separate authorized connections before replacing existing cross-provider refusal."

| Clause | Implementation | Tests |
| --- | --- | --- |
| partition by provider/account/region/backend | `assignPartitions` (provider+region from node, account from connection, backend from `backendForConnection` per child environment); planner enforces state-object disjointness | `tests/execution/mixed/parent-plan.test.ts` "partitioning..." (distinct backend/identity/state digests, ordering, determinism, unbound, ambiguous+pin, unused child, backend refused) |
| separate authorized connections | `assertConnectionAuthorized` (workspace, `verified`, unrevoked), re-run by `reverifyAuthority` before adopt, before parent start and before every child claim | parent-plan.test.ts "binds only verified..." and "re-proved against the stored connection"; mixed-parent-plans.test.ts "refuses to plan when...", "re-proves the connection..." |
| replace refusal only when every partition is bound and verified | `admitMixedGraph` + `findGraphProblems(..., admission)`; used by `verifyMixedParent` and `verifyParent` | parent-plan.test.ts "replacing the cross-provider refusal only on proof" (refusal kept without admission, lifted for admitted addresses only, forged object refused, all-or-nothing on revoked/missing/foreign/changed/pending connection, changed graph, uncovered node); existing `mixed-partitions.test.ts` still asserts the refusal text |

### PROD-MIX-02: "Dependency-ordered child workflows have immutable subplans, parent approval/evidence and durable receipts; stable resource addresses survive resume."

| Clause | Implementation | Tests |
| --- | --- | --- |
| dependency-ordered child workflows | `mixedParentWorkflow`; `advanceChild` dependency gate blocks (terminal) any child whose dependency did not succeed | `tests/workflows/mixed-parent.test.ts` (order, one at a time, stop on failed/cancelled/uncertain, blocked, waiting path); mixed-parent-plans.test.ts "dependency-ordered execution..." |
| immutable subplans | `mixed_child_plans` subplan columns immutable by trigger; `assertParentPlanIntegrity` recomputes digests | parent-plan.test.ts "parent plan..." (tamper detection); mixed-parent-plans.test.ts "the database refuses to rewrite history" |
| parent approval binds the child set | proposal input = plan + child digests; `attachParentOperation` exact match; `verifyParent` requires a recorded human approval of that proposal digest | parent-plan.test.ts "proposal input is exactly the plan"; mixed-parent-plans.test.ts "the parent operation is the approval vehicle" (wrong digest, wrong env, policy-allow without a person, no approval) |
| each child has its own semantics digest | `childSemanticsDigest` (parent-time, approved); child DUR-B reviewed digest captured write-once and carried in the receipt | parent-plan.test.ts "each child carries its own semantics digest", "a changed connection identity changes..."; mixed-parent-plans.test.ts "the reviewed semantics digest is write-once", receipts carry the digest |
| parent evidence | `GET /mixed/plans/:id` (plan, per-child state, receipts); `mixed-evidence.ts` verifier | tests/acceptance/mixed-evidence.test.ts |
| durable receipts | `mixed_child_receipts` append-only, content-addressed, recorded in the same transaction as the child's terminal state | mixed-parent-plans.test.ts "receipts are append-only..." and the full-order test |
| stable addresses survive resume | `deriveAddresses`/`assertAddressesStable`, registry stored immutably, re-checked on every start and advance | parent-plan.test.ts "stable resource addresses" (rotation, no raw account, drift refused, clash refused); mixed-parent-plans.test.ts registry stored |
| no destructive compensation | no destroy/rollback activity exists in the workflow; children blocked, never undone | mixed-parent.test.ts asserts no destroy/rollback/compensate activity is ever called |

## 3. Verification commands (verifier machine)

Node 22, from the worktree.

```
npx tsc --noEmit -p . && npx eslint src/lib/execution/mixed src/lib/workflows src/lib/controlplane/db/repos/mixed-parent-plans.ts src/app/api/platform/v1/mixed tests/execution/mixed tests/controlplane/mixed-parent-plans.test.ts tests/workflows/mixed-parent.test.ts tests/acceptance/mixed-evidence.test.ts tests/live

# pure contract + planner (no database, no Temporal)
npx vitest run tests/execution/mixed tests/execution/mixed-partitions.test.ts tests/acceptance/mixed-evidence.test.ts tests/live

# platform database: PGlite always, real PostgreSQL when the owned URL is set
npx vitest run tests/controlplane/mixed-parent-plans.test.ts
ZENITH_TEST_PLATFORM_PG_URL=postgres://...:PORT/db npx vitest run tests/controlplane/mixed-parent-plans.test.ts

# real Temporal (owned CLI), scripted activities
ZENITH_TEST_TEMPORAL=1 npx vitest run tests/workflows/mixed-parent.test.ts tests/workflows/sandbox.test.ts tests/workflows/replay.test.ts

# regression of areas touched
npx vitest run tests/controlplane tests/workflows/start-intent.test.ts tests/middleware/platform-bearer.test.ts tests/execution tests/capabilities tests/bridge
```

Expected: all pass; `tests/live` reports the live describe as **skipped with a console warning**, and its always-on verifier test passes.
First things to check if something fails (none of it was run): (a) `seedAwaitingApproval` + `approve` leaving `approval_required = true`
and status `approved` (the parent-approval tests rely on both); (b) `proposeOperation` storing `proposal.input` verbatim; (c) the
`reconcile-composition` / `worker.test.ts` activity lists (the worker now also registers four mixed activities: if a test asserts the
exact registered activity set it needs the four names `verifyMixedParent`, `advanceMixedChild`, `awaitMixedChild`, `settleMixedParent`);
(d) `tests/middleware/platform-bearer.test.ts` route inventory count (3 new patterns); (e) the new `WorkflowStartKind` in
`start-intent` tests that enumerate kinds; (f) the workflow sandbox test (new definition file imports only `@temporalio/workflow`
and relative modules).

### Live harness (deferred, gated)

`tests/live/mixed-cloud.live.test.ts` is skipped unless `ZENITH_LIVE_MIXED=1` plus `ZENITH_LIVE_MIXED_API_URL`,
`ZENITH_LIVE_MIXED_WORKSPACE_ID`, `ZENITH_LIVE_MIXED_PLAN_ID`, `ZENITH_LIVE_MIXED_TOKEN_FILE` (a FILE holding an integration token).
Operator runbook for the real run (approvals need a person's browser): create one verified connection and one child environment
per provider; `POST /api/platform/v1/mixed/plans`; approve the returned operation in the web app; propose one deploy per child
environment and `POST .../children`; `POST .../start`; approve each child as it reaches its gate; then run the live test against the
plan id. The verifier checks status, receipts, per-child reviewed semantics digests, order, distinct backends/identities and stable
addresses. It reads stored platform evidence only; it calls no cloud.

## 4. Known gaps, things that may break first, shared-file updates

Known gaps (honest):

1. **Nothing was executed.** All tests are written, typechecked and linted only.
2. **No live cloud.** No provider API was called; no mixed deployment was observed in a real account. `requiredEvidence` live_sandbox and
   operational_rehearsal remain open.
3. **Child operations are normal single-environment deploy operations.** The child environment and its product Deployment must
   exist (a person proposes the deploy through the usual flow) before it is adopted. The parent does not create environments or
   deployments. OCI cannot be a child through the product store because OCI is not a product `ProviderId` (existing LIFE-01
   limitation); the pure partitioner supports it.
4. **Typed outputs between children are not materialized here (MIX-03).** A plan with cross-partition data edges declares typed
   references that start `unavailable`; `verifyParent` refuses to start a plan whose child is blocked by unmaterialized references
   unless `MixedDeps.referencesReady` vouches (the seam MIX-03 plugs into). `effectDigest` already pins incoming materialization.
5. **Failure/teardown ordering beyond fail-stop is MIX-04.** This change implements: stop at the first non-success, later children
   `blocked`, per-child 26-hour wait cap (child never started: failed; started: uncertain), cancellation settles the plan, no
   compensation. It does not implement partial-success review, expiry policy per child, drift/migration ordering or an
   operator-driven teardown; `teardownOrder` is only the reverse dependency fact.
6. **Not Temporal-native `startChild`.** Children are separate operation workflows (`op-<childId>`) started through the broker claim
   and the DUR-A start intent, then observed by long-poll activities. A true `executeChild` would bypass the claim and start-intent
   guards. The parent workflow has a bounded history budget (4-minute windows, 26-hour cap, 8 children maximum, `MAX_MIXED_CHILDREN`).
7. **A claimed child whose start cannot be confirmed** ends the parent `uncertain`; there is no operator-authorized continuation
   (DUR operator continuation work). A child that is started and then outlives a cancelled parent keeps running under its own
   workflow; its receipt is recorded only if something observes it again (no sweeper was added).
8. **Product projection** of a started child's `workflowStartedAt` relies on the existing relay repair (`projectAcknowledgedStart`);
   it was not independently tested for children.
9. **Conservative admission:** `verifyParent` re-verifies every child's connection on every advance, so a connection revoked after
   its child finished still refuses later children. Intentional (all or nothing).
10. **Custody preview unchanged.** `mixed_child_custody` / `reserveMixedChildStart` still refuse everything. The new layer does not
    consume custody rows. Reconciling the two (retiring the preview once this layer is verified) is a follow-up.
11. No UI page; the surface is REST plus the existing approval UI (the proposal now shows the child set lines).
12. Verified behaviour changed: `workflow-start-intents.bind` for kind `deploy` now refuses an operation whose input has
    `mixedParentPlanId` (new, additive refusal; no existing operation has that key).

Shared-file updates the orchestrator/assembler must make:

- **Migration 43**: emit-sql, `supabase/migrations/*`, `scripts/ci/apply-supabase-migrations.sh`, `DEPLOYING.md` inventory,
  `tests/controlplane/migrations.test.ts` table list (4 new tables, 5 functions: `mixed_parent_plan_guard`, `mixed_child_plan_guard`,
  `mixed_append_only`, `mixed_child_receipt_guard`). `index.ts` lists 43 after 36; the contiguity check needs 37-42 filled.
- **Tenancy / SQL scoping classification** (`repos.mixedParentPlans`, every function takes `workspaceId` and filters on it in SQL, none is
  system-scoped): `getPlan`, `getPlanByParentOperation`, `listPlansForEnvironment`, `createPlan`, `getAddresses`, `listChildren`,
  `attachParentOperation`, `adoptChild`, `markChildStarted`, `recordExecutableSemantics`, `recordReceipt`, `getReceipt`, `listReceipts`,
  `blockChild`, `setParentStatus`, `readOperationFacts`. New tables all tenant-owned with RLS, composite FKs to `operations`.
- **Gate manifest**: `tests/controlplane/mixed-parent-plans.test.ts` in the platform PostgreSQL group; `tests/workflows/mixed-parent.test.ts`
  in the Temporal group; `tests/execution/mixed/parent-plan.test.ts` and `tests/acceptance/mixed-evidence.test.ts` in the default group;
  `tests/live/mixed-cloud.live.test.ts` as a gated live lane whose skip must not count.
- **Route inventory**: `tests/middleware/platform-bearer.test.ts` count +3 (GET/POST `/mixed/plans`, GET `/mixed/plans/:id`, POST
  `/mixed/plans/:id/children|start`).
- **Worker activity list**: four new registered activities (see item (c) above).
- **LIMITATIONS**: replace "mixed-provider partitions are separate source work" with the status below; keep "live mixed-cloud, typed outputs
  (MIX-03) and distributed failure/teardown order (MIX-04) remain open".

## 5. Suggested ledger implementationStatus

PROD-MIX-01: `source_complete_partitioner_bound_connection_admission_reachable_via_parent_workflow_runtime_and_live_acceptance_pending`

PROD-MIX-02: `source_complete_parent_child_plans_receipts_stable_addresses_workflow_and_rest_wired_runtime_and_live_acceptance_pending`
(contract and local_engine tests written, not run; live_sandbox and operational_rehearsal not started; typed outputs and
failure/teardown ordering are MIX-03/04.)
