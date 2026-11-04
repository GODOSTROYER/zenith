# WS-DB-LEDGER — the operations ledger edges execution needs, and no raw SQL outside the store

Workstream: WS-DB-LEDGER (new; orchestrator brief) — Branch ws/db-ledger — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-db-ledger
Base: platform/integration @ e92a3df (tsc clean)

## Situation (from the WS-ACT handoff; verify in code)
`src/lib/execution/platform.ts` (real ports over the control store) works around missing store
functions with RAW SQL — each only makes an operation more restricted, but SQL outside
`src/lib/controlplane` bypasses the repositories' tenancy/transition guarantees:
1. `running → awaiting_approval` for the workflow's plan-level approval gate (the ledger has no
   such edge; `approvals.record` needs `awaiting_approval`). Needed because `beginExecution`
   (broker) consumes the proposal-level approvals and moves the operation to `running`; when the
   concrete plan then requires approval, the workflow must suspend for a new human approval.
2. `setPlanDigest` (standalone).
3. `setPolicyDecision` (approvers' requirements read `policy_decision_id`).
4. `ops.get(id)` — a system-level lookup by id alone (the workflow passes only the operation id).
5. No `running → cancelled` edge: the adapter ends a cancelled running op `uncertain` if a
   `resource.applying` event exists, else `failed`.
WS-CAP also asked for `approved → denied` (a policy denial at execution currently cancels + records
a deny decision) — add the edge only if it is a clean, additive transition; otherwise document why not.

## Objective
Add these as proper repository/service functions with the same guarantees as the existing ones
(conditional transitions, event emission in the same transaction, fencing where applicable,
system-level functions clearly separated from tenant-scoped ones), then delete the raw SQL in
src/lib/execution/platform.ts.

## Owned paths
src/lib/controlplane/** (repos, services, transition table, ADDITIVE type changes in
src/lib/controlplane/types.ts, a new migration only if the SQL schema needs it — then re-emit
`supabase/migrations/0014_platform_core.sql` with `npm run platform:emit-sql` and keep
`-- --check` green) ; src/lib/execution/platform.ts ; tests/controlplane/** ;
tests/execution/platform.test.ts and NEW tests/execution/ledger-*.test.ts only (another job owns
the rest of tests/execution) .

## Tests
- each new function on PGlite (and the real-Postgres lane when ZENITH_TEST_PLATFORM_PG_URL is set):
  legal/illegal transitions, tenancy (foreign workspace refused uniformly), events emitted
  atomically, idempotent repeats, concurrent suspend/approve races resolved by the conditional update.
- the suspend → human approval → re-claim → apply path end to end on the store.
- execution platform.ts has no remaining `sql\`` / raw query (a source-scan test).

## Verification
- npx tsc --noEmit ; npx eslint src/lib/controlplane src/lib/execution/platform.ts tests/controlplane tests/execution
- npx vitest run --maxWorkers=2 tests/controlplane tests/execution/platform.test.ts tests/execution/ledger tests/capabilities
- npm run platform:emit-sql -- --check
