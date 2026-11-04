# WS-DESTROY-PROPOSE continuation

Branch: `ws/destroy-propose`. HEAD remains `ec3176f316de63a5e98656a57b43563e027cf9af`.
All changes are uncommitted in this worktree. No .git mutations, dependency changes,
Docker/WSL use, cloud access or pushes were performed.

## Result

- `env.teardown` is registered with strict `{ environmentId }`, admin role,
  browser-only execution and a high-risk review requiring approval.
- Planning reads recorded destroy evidence without proposing or starting anything.
  Execution proposes `infrastructure.destroy`; the broker reloads the original,
  non-simulated `tofu_plan` evidence, validates tenant/environment, digest, source
  operation state/expiry, `destroy: true` and consistent deletion facts. The
  immutable proposal binds the facts, digest, evidence/source ids and retention.
  Caller body facts and raw normalized-plan contexts cannot authorize destroy.
- Human approval through the existing browser-only operation endpoint starts
  `startDestroy` through the bridge's broker claim. Duplicate starts share one
  in-process promise and cross-process execution is protected by the ledger CAS.
  Unconfirmed starts are recorded as uncertain; payloads contain only ids.
- Existing workflow plan approval rounds are preserved. The PGlite regression
  verifies that round-zero approvals cannot authorize execution and that the
  worker returns a real current-round human approval id.
- Kubernetes/Zenith use C1 dry-run, final review, teardown and absence checks;
  OpenTofu providers keep their existing path. Retention is conservative, uncertain
  or skipped results never prove absence, and external provider error text is
  stripped. C1 transport tests use explicit fakes, not live provider evidence.
- `BrokerStore.denyOperation` calls the ledger denial service. Approved execution
  denials link the persisted denial, revoke grants and emit one denial event;
  no cancellation fallback. Memory and PGlite contracts test tenant boundaries,
  invalid decision linkage, duplicate attempts and grant revocation.
- Integration and Navigator are refused at the action bridge and broker, even
  at maximum configured autonomy, and cannot approve teardown.

## Files

Added:

- `src/lib/actions/defs/env-teardown.ts`
- `src/lib/bridge/destroy.ts`
- `src/lib/bridge/teardown-session.ts`
- `src/lib/capabilities/destroy-plan.ts`
- `src/lib/capabilities/teardown-contract.d.ts`
- `tests/actions/env-teardown.test.ts`
- `tests/bridge/teardown-session.test.ts`
- `tests/capabilities/destroy-propose.test.ts`
- `tests/execution/destroy-providers.test.ts`
- `tests/bridge/WS-DESTROY-PROPOSE-HANDOFF.md`

Modified:

- `src/lib/actions/defs/index.ts`
- `src/lib/bridge/deps.ts`
- `src/lib/bridge/lifecycle.ts`
- `src/lib/capabilities/action-bridge.ts`
- `src/lib/capabilities/broker.ts`
- `src/lib/capabilities/evaluate.ts`
- `src/lib/capabilities/execution.ts`
- `src/lib/capabilities/memory-store.ts`
- `src/lib/capabilities/platform-store.ts`
- `src/lib/capabilities/ports.ts`
- `src/lib/capabilities/types.ts`
- `src/lib/execution/destroy.ts`
- `tests/capabilities/execution.test.ts`
- `tests/capabilities/store-contract.test.ts`

`src/lib/platform/broker.ts` was verified and tested but needed no edits: its
current-round human approval id behavior already satisfies the requirement.

## Verification (all commands run from this worktree)

1. `npx vitest run --maxWorkers=1 tests/capabilities/destroy-propose.test.ts tests/actions/env-teardown.test.ts tests/execution/destroy-providers.test.ts`
   - First run: **17 passed, 16 failed, 0 skipped**; 1 file passed, 2 failed.
     Fixed the invalid autonomy fixture and the incorrect dependency on
     deployment compilation for C1 teardown.
   - Second run: **32 passed, 1 failed, 0 skipped**; 2 files passed, 1 failed.
     Fixed the integration fixture's accountable subject to match its credential.
2. `npx vitest run --maxWorkers=1 tests/capabilities tests/actions tests/bridge tests/execution tests/platform`
   - First run: **1486 passed, 1 failed, 11 skipped**; 81 files passed, 1 failed,
     1 skipped. Fixed the new action's missing capability mapping while retaining
     its explicit human-only refusal. The command also matches `tests/platform-ui`.
   - Final run: **1493 passed, 0 failed, 11 skipped**; 82 files passed, 1 skipped.
     Includes added denial-store and provider-result/error regressions.
3. `npx tsc --noEmit`
   - First run: **failed, 3 diagnostics**: 2 in the owned broker, 1 in the
     unowned credentials router. Fixed the owned fact-type errors.
   - Final run: **failed, 1 diagnostic**, solely `src/lib/platform/credentials.ts(161,54)`.
     No further whole-repo TypeScript runs were performed (two total).
4. `npx eslint src/lib/actions/defs/env-teardown.ts src/lib/actions/defs/index.ts src/lib/capabilities src/lib/platform/broker.ts src/lib/bridge src/lib/execution/destroy.ts tests/capabilities/destroy-propose.test.ts tests/capabilities/execution.test.ts tests/actions/env-teardown.test.ts tests/execution/destroy-providers.test.ts`
   - **Passed: 0 errors, 0 warnings.**
5. `npx eslint src/lib/actions/defs/env-teardown.ts src/lib/actions/defs/index.ts src/lib/capabilities src/lib/platform/broker.ts src/lib/bridge src/lib/execution/destroy.ts tests/capabilities/destroy-propose.test.ts tests/capabilities/execution.test.ts tests/actions/env-teardown.test.ts tests/bridge/teardown-session.test.ts tests/execution/destroy-providers.test.ts`
   - **Passed: 0 errors, 0 warnings.**
6. `npx eslint src/lib/actions/defs/env.ts src/lib/actions/defs/env-teardown.ts src/lib/actions/defs/index.ts src/lib/capabilities src/lib/platform/broker.ts src/lib/bridge src/lib/execution/destroy.ts tests/capabilities tests/actions tests/bridge tests/execution tests/platform`
   - **Passed: 0 errors, 0 warnings.**
7. `git diff --check`
   - Every run passed with **0 whitespace errors** (final run after this report).

Skipped: 6 Temporal tests (CLI unavailable), 3 real OpenTofu journey tests
(binary unavailable to their availability check), and 2 network schema checks
(`ZENITH_TEST_TOFU_NETWORK` not enabled). The real-Postgres lane was not selected
because `ZENITH_TEST_PLATFORM_PG_URL` was not set. No direct tofu/opa/go/temporal
binary commands, production build, real browser identity calls or live provider
teardown were run. The existing OPA WASM and PGlite tests did execute.

## Required outside-path integration / limitations

1. **Whole-repo TypeScript remains red.** At `src/lib/platform/credentials.ts:161`,
   `req.purpose` has type `CredentialPurpose` including `secret.write`, while the
   local direct-session helper accepts only `observe | deploy`. Before that call,
   after the AWS dispatch, reject unsupported purposes explicitly:

   ```ts
   if (req.purpose !== "observe" && req.purpose !== "deploy") {
     return deny("purpose_capability_mismatch", "This direct provider session does not support secret writing.");
   }
   ```

   This file is unowned; it was left unchanged as instructed. The orchestrator
   must apply the appropriate narrow guard and rerun TypeScript.
2. **C1 provider modules are absent at this base.** Integrate
   `src/lib/providers/kubernetes/teardown.ts` exporting
   `teardownKubernetesEnvironment` and `src/lib/providers/zenith/teardown.ts`
   exporting `teardownZenithEnvironment`, with the pinned C1 contract. The owned
   declaration file contains only compile-time contract declarations and supplies
   no runtime implementation. Imports fail closed until those modules exist.
3. **Zenith managed sessions need composition wiring.** Customer credential
   connections have no `zenith` config (`providers/zenith/session.ts` documents
   this). `createDestroyActivities` supports `DestroyProviderPorts`, either as
   its second argument or the preserved runtime dependency `destroyProviders`.
   Add `destroyProviders?: import("@/lib/execution/destroy").DestroyProviderPorts`
   beside credentials in `src/lib/execution/ports.ts:520`, and wire
   `destroyProviders.withZenithSession` in `src/lib/platform/execution.ts:41-48`
   to the platform's tenant-scoped managed-session opener. It must resolve only
   configured credential references inside the callback and keep the session
   out of evidence, responses and workflow history. Kubernetes uses the existing
   credential-broker callback. Missing managed wiring fails closed.
4. **An existing destroy review is required.** The action reads the newest
   eligible recorded `infrastructure.plan` operation in the environment; it does
   not generate a new plan during the product's planning mode. Without valid
   original destroy evidence it blocks and asks for a read-only destroy review.
   The existing `planDestroyInfrastructure` activity supports such a plan
   operation. No new plan-generation workflow/endpoint was invented here.
5. **The ledger denial edge is approved-only.** A queued operation denied at
   execution is refused with `invalid_state`; no grant is issued and no cancel
   fallback is used, but it remains queued. If queued -> denied is required,
   add `denied` to `ALLOWED_TRANSITIONS.queued` in
   `src/lib/controlplane/db/repos/operations.ts:128`, extend the denial predicate
   in `src/lib/controlplane/db/repos/operations-execution.ts:89` to
   `status in ('approved','queued')`, and extend the memory adapter accordingly.
   These ledger files are unowned and were not changed.

## Decisions and deviations

Pinned contracts and Broker facade signatures are unchanged. Additive broker
context/store ports were introduced as requested. No existing completed destroy
engine/approval-round behavior was redone. C1 compile-time declarations and the
managed-session port are necessary integration seams because the provider modules
and managed credential composition are not present in this base. Non-OpenTofu
teardown validates the deployed graph without demanding deployment compilation;
the provider teardown contract performs live ownership discovery. Stateful
retention remains conservative. Every unconfirmed start/mutation is reported as
unknown/uncertain rather than success.
