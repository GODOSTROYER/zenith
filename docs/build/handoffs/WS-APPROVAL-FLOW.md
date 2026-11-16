# WS-APPROVAL-FLOW — make the plan-level approval gate work end to end

Workstream: WS-APPROVAL-FLOW (new; orchestrator brief) — Branch ws/approval-flow — worktree Z:\Projects\Spawned.ai\zenith-wt\ws-approval-flow
Base: platform/integration (COMPOSE, DB-LEDGER, BRIDGE, MCP, SEC-* merged; tsc clean)

## The seam (found in orchestrator review; read the code to confirm each point)
Four parts were built separately and disagree about what happens when the CONCRETE PLAN needs approval:
- BRIDGE (src/lib/bridge/deploy.ts, lifecycle.ts) proposes `deployment.deploy` WITHOUT a plan; a
  human approves the proposal; the bridge calls `beginExecution` (consumes those approvals, status
  `running`) and starts the deploy workflow. After a later approval it calls
  `workflows.signalApproval(opId)` (lifecycle.ts ~127).
- The deploy workflow (src/lib/workflows/definitions/deploy.ts ~85-100) plans, runs `evaluatePolicy`
  on the concrete plan, and on `require_approval` runs `run.approvalGate()`
  (src/lib/workflows/definitions/runtime.ts ~273): `checkApproval` → if not approved, drop the
  lease, `markOperation(awaiting_approval)`, wait for the `approvalRecorded` signal / poll, re-check,
  then re-acquire the lease. `approval.rejected` halts the operation.
- DB-LEDGER: `markOperation(awaiting_approval)` → `suspendForApproval` (running → awaiting_approval,
  opens a NEW approval round; migration 4 `approval_rounds`; src/lib/execution/platform.ts ~85,
  src/lib/controlplane/operations/execution.ts). Approvals are unique per (operation, round, approver).
- COMPOSE's broker adapter (src/lib/platform/broker.ts ~40-110) — written BEFORE approval rounds existed:
  - `reevaluate`: `require_approval` && !approvalCoversPlan(op, facts) → turned into `deny`
    "reapproval_required" — so a plan that needs approval FAILS at evaluatePolicy instead of reaching
    the approval gate.
  - `approvalStatus`: returns `{approved:false, rejected:true}` when !approvalCoversPlan → the gate
    halts immediately instead of waiting; and `approvals()` ignores rounds (counts consumed approvals
    while running, any round).
Net effect today: fail-closed (no bypass), but a production deploy from the product whose plan
requires approval can never complete.

## Objective — the intended flow, proven end to end
1. Proposal-level approval (as today) → beginExecution → workflow starts.
2. Concrete plan → evaluatePolicy: `require_approval` stays `require_approval` (recorded decision),
   it is NOT converted to deny; `deny` stays deny.
3. approvalGate → checkApproval → `approvalStatus` answers from the CURRENT approval round only:
   approved iff enough eligible humans (role, separation of duties, kind user, not expired, bound to
   this operation's proposal digest) approved IN THE CURRENT ROUND, after the plan digest being
   gated was recorded (the plan they reviewed); rejected iff a current-round reject (or the op is
   rejected/cancelled/denied); otherwise neither → the workflow suspends (new round) and waits.
   Approvals from earlier rounds (including those consumed by beginExecution) NEVER count for the
   plan gate. Decide whether an approval must also carry the plan digest explicitly; if the
   approvals table cannot bind it, binding by round-after-setPlanDigest is acceptable only if a
   test proves an approval recorded before a re-plan cannot authorize the new plan (finalPlan's
   plan_changed check is the second line of defence).
4. The human approves through the existing browser-only approve path (REST
   operations/{id}/approve and the bridge's approveWorkflowDeployment) — which must accept an
   operation suspended at the plan gate (status awaiting_approval, current round), record the
   approval in the current round, and signal the workflow (`signalApproval`). The workflow resumes,
   re-acquires the lease (new fence), re-plans (finalPlan == approved digest) and applies.
5. `issueGrant` for the apply step: authorised by the current-round plan approval.

## Owned paths
src/lib/platform/broker.ts ; src/lib/capabilities/{approvals,execution,operations,evaluate}.ts
(only what the flow needs; keep the Broker facade signatures) ; src/lib/bridge/lifecycle.ts ;
src/lib/execution/{plan,steps,platform}.ts (NOT compile.ts — WS-REF owns it) ;
src/lib/controlplane/** (only additive helpers, e.g. list approvals for the current round) ;
src/lib/workflows/definitions/** ONLY if strictly necessary — any workflow code change must stay
replay-compatible (tests/workflows/replay.test.ts must pass; use `patched()` if behaviour changes) ;
tests/platform/** , tests/workflows/** , tests/execution/** (new files + platform/ledger tests) ,
tests/capabilities/** , tests/bridge/** .
Do NOT touch src/lib/actions/defs/**, src/lib/agent-access/v3/**, src/app/(product)/** or
src/lib/execution/compile.ts (other running jobs).

## Acceptance tests (extend tests/platform/deploy-e2e.test.ts or add tests/platform/plan-approval-e2e.test.ts;
Temporal test environment + PGlite + file store + mocked AWS + fake tofu, as deploy-e2e does)
- Production deploy proposed through the bridge WITHOUT a plan → proposal approval (browser user)
  → workflow plans → policy require_approval on the plan → operation awaiting_approval in round 1
  → a second browser approval → signal → workflow resumes → final plan equals approved digest →
  apply → succeeded. Assert events, rounds, approvals, decision records, lease fence changed.
- Round-0 approvals (consumed by beginExecution) do not satisfy the plan gate.
- A reject in the plan round → operation failed/rejected, no apply.
- Plan changes after the plan approval → plan_changed, no apply.
- Separation of duties and minimum role enforced in the plan round.
- Approval timeout path still expires the operation.
- No approval via bearer/integration/navigator (browser-only stays enforced).

## Verification
- npx tsc --noEmit ; npx eslint src/lib/platform src/lib/capabilities src/lib/bridge src/lib/execution src/lib/controlplane tests/platform tests/workflows tests/capabilities tests/bridge
- npx vitest run --maxWorkers=2 tests/platform tests/workflows tests/execution tests/capabilities tests/bridge tests/controlplane
  (Temporal tests may need the time-skipping test server; if the local temporal CLI cannot run in
  your sandbox, say which tests did not run — the orchestrator runs them outside.)

## Also: make the gated plan reviewable (the UI keeps plan-bound approval disabled until this exists)
WS-UI-WIRE (merged before you start, pages under src/app/(product)/platform/**) found no readable
plan-artifact contract, so its approval card refuses to approve a plan-bound operation (rejection
works). Provide one:
- `GET /api/platform/v1/operations/{id}` (and the broker's getOperationDetail) includes, for an
  operation at the plan gate, the gated plan's normalized, model-safe view (the `planView`
  projection: addresses, actions, attribute names, sensitive values masked — never raw values),
  its plan digest, the policy decision and the cost delta, read from the `tofu_plan` evidence the
  plan activity recorded. Bounded size; tenant-scoped; unknown stays unknown.
- Enable plan-bound approval in the platform operation page/approval card: the browser POST
  carries the reviewed plan digest; the approve path refuses when it differs from the current one.
Additional owned paths for this part: src/app/api/platform/v1/operations/** ,
src/app/(product)/platform/operations/** , src/components/platform/approval-card.tsx (additive) ,
tests/platform-ui/** .
