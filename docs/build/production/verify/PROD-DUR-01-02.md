# PROD-DUR-01 / PROD-DUR-02 verification handoff

Branch `prod/dur-a-w3`, based on c9a942d6. Platform migration **30**. Build only; nothing here was executed by the builder
except typecheck and lint (see section 3 for what the verifier must run).

Requirements:

- **PROD-DUR-01 Durable intent and outbox.** Product, platform, Temporal and runner authorities have durable intent/outbox
  and idempotent start/signal across every crash window.
- **PROD-DUR-02 Authoritative state and projections.** Operation authority versus UI projection defined; independent workers
  and concurrent writers preserve state without treating local locks as external atomicity.

## 1. What was built

### Design in one paragraph

The `platform.operations` row stays the authority for what an operation *is* (its conditional transitions, approval
consumption and lease fencing are unchanged and verified). Migration 30 adds **one versioned fence record per operation**
(`platform.operation_authority`, maintained by a database trigger, so no writer can forget to bump it) and **one outbox**
(`platform.durable_intents`) for every effect that leaves the database. Any worker may deliver an intent; delivery is
at-least-once under a fenced claim (`claim_epoch`), every transport call carries the intent id as the receiver-side
idempotency key, and a superseded holder cannot settle. UI/API surfaces derive their answer from the authority record plus the
retained intents (`projectOperation`) instead of from product-store copies or process-local state.

### Files

New:

| File | Role |
| --- | --- |
| `src/lib/controlplane/db/migrations/0030_durable_intent_authority.ts` | `operation_authority`, trigger `operation_authority_sync`, backfill, `durable_intents`, guard trigger, RLS, grants |
| `src/lib/controlplane/authority/index.ts` | `readAuthority`, `casTransition` (versioned compare-and-set), `projectOperation`, `derivePhase` |
| `src/lib/controlplane/outbox/index.ts` | `enqueueIntent`, `claimDue`, `settleIntent`, `adoptStartIntents`, `deriveApprovalSignals`, `relayOnce` (with fault-injection seams) |
| `src/lib/controlplane/outbox/temporal.ts` | Real transport: `workflow_signal` via `SignalWorkflowExecution(requestId = intent id)`, `workflow_start` via `recoverWorkflowStartIntent`; `runIntentRelay` |
| `src/lib/controlplane/outbox/signal.ts` | `signalDurably` (commit intent, then deliver inline), `approvalSignalKey` |
| `tests/controlplane/durable-intent-authority.test.ts` | Authority CAS, intent identity/atomicity, relay crash windows (PGlite + real PG) |
| `tests/workflows/start-recovery.test.ts` | Start-recovery crash windows against an owned real Temporal frontend |
| `tests/runners/idempotent-enqueue.test.ts` | Deterministic runner job identity, attach vs generation advance, race (memory, PGlite, real PG) |

Changed:

| File | Change |
| --- | --- |
| `src/lib/controlplane/db/migrations/index.ts` | register migration 30 |
| `src/lib/workflows/start-intent.ts` | extract `sendStart` (behaviour-identical refactor of the sole transport write); add `recoverWorkflowStartIntent`, `START_RECOVERY_WINDOW_MS` |
| `src/lib/bridge/deps.ts` | default `signalApproval`/`cancelOperation` go through `signalDurably` when `workspaceId` is passed and a platform store is open; fall back to the legacy direct signal otherwise |
| `src/lib/bridge/lifecycle.ts` | pass the workspace id; `pending` delivery is reported honestly ("recorded durably, will be retried") instead of "no workflow found" |
| `src/lib/bridge/projection.ts` | `projectAcknowledgedStart`: repairs the product `workflowStartedAt` from the acknowledged start intent |
| `src/lib/platform/critical-jobs.ts` | the `runner-reaper` critical job also runs `runIntentRelay` (isolated: relay failure is counted as `relayFailed`, never a reaper failure) |
| `src/app/api/platform/v1/operations/[id]/route.ts` | additive `authority` field (projection) on the operation detail, omitted in local memory mode |
| `src/lib/runners/dispatch.ts` | optional `idempotencyKey` on `EnqueueRunnerJobInput` (deterministic job id, attach-to-existing on retry or race) |
| `src/lib/runners/tofu-runner-dispatch.ts` | apply/destroy of the approved plan enqueue with `tofu.apply:<approvedDigest>` / `tofu.destroy:<approvedDigest>` |
| `src/lib/machines/dispatcher.ts` | every mutating machine operation (file.write/upload, package.install, service.configure, exec, restart, runbook steps; anything the capability catalog marks `mutates`) enqueues with a deterministic key over (workspace, operation, operation name, args); read-only operations stay random |
| `src/lib/actions/defs/env.ts`, `env-teardown.ts`, `project.ts` | `inFlight()` (product projection) is no longer a decision input for real deployments; new `environmentBusy()` reads the authority record via `environmentActivity()`. env update/set-connection/delete, teardown review/teardown and project delete are now async and use it |

### Operation authority record (DUR-02)

- `platform.operation_authority(workspace_id, operation_id, version, status, approval_round, plan_digest, workflow_id, fence_token, updated_at)`.
  `version` starts at 1 and is bumped by trigger `operation_authority_sync` when any of status, approval_round, plan_digest,
  workflow_id, runner_job_id, fence_token, lease_scope, lease_holder or policy_decision_id changes. Heartbeats and
  bookkeeping writes do not move it. Existing operations are backfilled at version 1.
- `casTransition(sql, {expectedVersion, from, to, patch, fence, event})`: locks the authority row, compares the version, then
  runs the ordinary `transition` (all of its approval/lease/terminal-state rules) in the same transaction. Of two writers
  holding the same version exactly one commits; the other receives `version_conflict` and has changed nothing. A foreign
  tenant sees `authority: null`.
- Authority versus projection (the definition):
  - **Authority** = `operations` row + `operation_authority.version` + the retained `workflow_start_intents` row + settled
    `durable_intents` rows + runner job rows. Only these decide.
  - **Projection** = `projectOperation()` output (`phase`, `unconfirmed`, `cancelRequested`, intents) and everything a UI
    renders from it, plus the product-store `Deployment` (`status`, `workflowStartedAt`, steps). Projections are derived,
    never read back as an input to a decision, and repaired from authority (`projectAcknowledgedStart`).
  - Phases: `pending_decision`, `ready_to_start`, `start_recorded`, `start_attempted_unconfirmed`, `running`, `completed`,
    `failed`, `cancelled`, `uncertain`, `closed_without_effect`. `unconfirmed` is true for an attempted start with no
    acknowledgement or a dead (undelivered) intent; surfaces must say "inspect", never "failed".

### Durable intent outbox (DUR-01)

- `platform.durable_intents(id, workspace_id, operation_id, kind, idempotency_key, payload, payload_digest, authority_version, state, outcome, claim_epoch, claimed_by, lease_until, attempts, next_attempt_at, last_error_code, ...)`.
  Kinds: `workflow_signal`, `workflow_start`. `id = di_ + sha256([workspace, kind, key])[0:40]`, unique per
  `(workspace_id, kind, idempotency_key)`, so every worker and every crash computes the same identity. Payload is bounded
  (4000 bytes) and refused if it carries secret-named members or secret-shaped values (`assertNoSecretKeys`). No grant,
  envelope or credential ever enters an intent. Identity columns are immutable and a settled row cannot reopen
  (`durable_intent_guard`); fences only move forward.
- Claim: `FOR UPDATE SKIP LOCKED`, increments `claim_epoch` and `attempts`, sets a lease. Settle is conditional on the exact
  `claim_epoch`, so a holder whose lease lapsed cannot settle after another worker re-claimed. Retry uses exponential
  backoff (max 60 s); after `MAX_ATTEMPTS` (12) the row dies `exhausted` and the projection reports `unconfirmed`.
  `not_found` on a signal retries 4 times (the workflow may not be visible yet) then dies `not_found`.
- Relay: the `runner-reaper` critical job (durable Temporal schedule plus the existing HTTP/in-process fallback, both under
  the existing fenced `critical-job:runner-reaper` lease) runs `runIntentRelay` after reaping. Each pass first **adopts**
  unacknowledged start intents idle for 30 s and **derives** approval wake-ups from authority state, then claims and
  delivers due intents.
- Workflow start recovery (`recoverWorkflowStartIntent`): see table W4 to W8. It never mints a new attempt id, workflow id,
  approval or lease. In `attempted` phase it first does an independent Describe plus first-history readback; only if the
  workflow does not exist, the attempt is younger than 30 minutes, the endpoint digest matches, and the operation is still
  `running` under a live lease does it resend the **identical** request (same requestId, workflow id, arguments, memo,
  identity), which Temporal deduplicates. A found-but-different execution, an expired window or a lapsed operation returns
  `refused` (the intent is kept as evidence for the operator).
- Runner jobs are not outbox rows (`runner_jobs` is already the durable queue and carries signed envelopes). Their identity
  is made deterministic instead (`idempotencyKey`). Identity is per (workspace, agent, operation, job kind, key, generation).
  A job that is queued, claimed, running, succeeded or timed out (outcome unknown) is **attached to**, never duplicated. Only a
  job that definitively did not take effect (failed, rejected, expired, cancelled) lets the next generation (max 8) be queued, so
  ordinary retry after a definite failure still works while a crash-retry can never queue a second effect.

Runner/agent job kinds and their disposition:

| Job kind | External effect? | Disposition |
| --- | --- | --- |
| `tofu.run` apply/destroy | yes | keyed `tofu.apply|destroy:<approvedDigest>` |
| `tofu.run` plan, `probe.http`/`probe.tcp`/`probe.dns`, read jobs (`enqueueReadJob`) | no (read-only) | random id, deliberately: a repeated read must observe fresh state |
| zenithd machine requests: file.write, file.upload, package.install, service.configure, container.exec/exec, machine.service.restart, runbook steps | yes | keyed by the dispatcher; the same (workspace, operation) identity as the evidence layer's permanent dispatch marker |
| zenithd machine reads (inspect, list, status, logs, file.read, portCheck) | no | random id |
| `aws.http`, `oci.http`, `k8s.http` proxy jobs | per request, mixed reads and writes | **not keyed, by design**: AWS/OCI use POST for reads (Describe*), so a deterministic id would attach a poll to its first, stale result. The identity of the effect is the provider call's own client token and the reaper never re-queues an uncertain job. Documented limit. |
| build launches (CodeBuild StartBuild) | yes | not runner jobs; already a permanent natural identity (`build_launches` operation/service attempt CAS) plus a provider idempotency token |
| cleanup (writer barriers/holds, plan artifact cleanup) | yes | not runner jobs; cleanup is gated by `cleanup_writer_holds` and the same barrier triggers |

### Crash-window table

Legend: "closed" = no duplicate effect and no lost intent; "explicit uncertain" = the system refuses to guess and records
`uncertain` for operator inspection (existing, verified policy: nothing re-dispatches `uncertain`). Tests marked (T) need
the owned Temporal CLI; (PG) run on PGlite and, with `ZENITH_TEST_PLATFORM_PG_URL`, on real PostgreSQL.

| # | Boundary | Crash point | Before this change | Now | Test |
| --- | --- | --- | --- | --- | --- |
| W1 | DB commit | before the deciding transaction commits (propose/approve/claim/CAS/enqueue) | nothing durable | unchanged: one transaction, nothing durable, caller sees the error. `enqueueIntent` joins the caller's transaction, `casTransition` is one transaction | durable-intent-authority: "rolled-back transition", "crash before the deciding transaction commits" (PG) |
| W2 | DB commit | after commit, response lost | idempotency-key replay returns the same operation | unchanged; a retried writer additionally holds a stale `version` and is refused by CAS | durable-intent-authority: CAS stale/replay (PG) |
| W3 | Start | operation claimed `running` (lease), process dies before the start intent is prepared | lease lapses, reconciler marks `uncertain` | unchanged: **explicit uncertain**, no workflow ever existed; recorded limitation | existing operations/housekeeping tests |
| W4 | Start | start intent `prepared`, dies before the attempt CAS | intent retained, no recovery | relay adopts after 30 s and runs the ordinary start path (re-validates current approval, policy and lease; may refuse) | start-recovery: "prepared-only crash" (T) |
| W5 | Start | attempt CAS committed (`attempted`), dies before the Start RPC | stuck `attempted` forever (the design never re-sent) | relay: Describe says NotFound, within 30 min, operation still running under a live lease, so resend the identical request once; otherwise `refused` for the operator | start-recovery: "crash after the attempt CAS", "refused outside its window..." (T) |
| W6 | Start | Start RPC response lost | readback only | unchanged readback; relay now also resolves it | existing start-intent tests + W5/W7 |
| W7 | Start | Temporal accepted, dies before the acknowledgement commit | readback on the next call of the same caller | relay readback acknowledges with no second Start RPC; a foreign execution under the id is refused | start-recovery: "crash after an accepted Start...", "...not the retained original is refused" (T) |
| W8 | Projection | acknowledged in SQL, dies before the product save of `workflowStartedAt` | product kept saying "not started" | relay handler repairs the product projection from the acknowledged intent; `GET /api/platform/v1/operations/:id` returns the derived `authority.phase` independent of the product copy | start-recovery: "relay adopts..." (T, platform side); product repair is best effort and reviewed, not independently tested |
| W9 | Signal | approval committed, dies before any signal intent exists | wake-up lost up to the workflow's 30 min poll | `deriveApprovalSignals` creates one intent per authority version from state (acknowledged start, op still approved/rejected for a plan round, no signal since the last change) | durable-intent-authority: "approval wake-up sweep predicate" (PG) |
| W10 | Signal | intent committed, dies before delivery | n/a (volatile) | any worker delivers | durable-intent-authority: "after the intent commit, before any claim" (PG) |
| W11 | Signal | claimed, dies before transport / after transport, before settle | n/a | lease lapses, new claim epoch, redelivery under the **same** intent id (Temporal dedupes by requestId); stale holder cannot settle | durable-intent-authority: "after the claim", "after transport", "superseded holder", "concurrent relays" (PG) |
| W12 | Signal | workflow not yet visible / Temporal down | error surfaced, request lost | bounded retry with backoff; then dead `not_found` / `exhausted`, surfaced as `unconfirmed` | durable-intent-authority retry/not_found tests (PG); start-recovery real NotFound shape (T) |
| W13 | Signal | cancel requested, dies before the signal | request lost | intent `cancel:<op>` committed first; caller learns "recorded, will be retried" | durable-intent-authority projection `cancelRequested` (PG) |
| W14 | Runner | dies before enqueue | no job exists; activity retry enqueues | unchanged | n/a |
| W15 | Runner | job queued, dies before the caller learned the id | retry queued a second job (second apply) | with `idempotencyKey` (tofu apply/destroy and every mutating machine operation, see the job-kind table) the retry attaches to the queued job; racing workers queue exactly one; definite failure advances a generation | idempotent-enqueue (memory, PGlite, PG) |
| W16 | Runner | runner executed, result ack lost | first settle wins, `already_settled`, late receipt retained | unchanged (verified) | existing late-effect-receipts |
| W17 | Runner | claimed/running past lease | reaper `timed_out`, operation `uncertain`, never re-queued | unchanged (verified) | existing dispatch/reaper tests |

Not a crash window: Temporal workflow/activity state itself is durable history owned by Temporal; activities already
re-verify authority through `checkApproval` and fenced leases.

### Local locks as authority (audit result)

| Location | What it is | Disposition |
| --- | --- | --- |
| `bridge/lifecycle.ts` `__zenithBridgeStarts` | same-process duplicate-click coalescing | kept; the code comment and this doc state it is not authority. Cross-process fences are the broker claim CAS and the permanent start-attempt CAS. No decision reads it. |
| `engine/engine.ts` `__zenithInflight` | simulated-provider engine ticks (product store) | out of scope: simulator only, real providers go through the workflow bridge. Not changed. |
| `actions/defs/env.ts` `inFlight(environmentId)` | product-store projection | **Fixed**: kept only as a display helper and for simulator (non-workflow) deployments that have no platform operation. Every dispatch/concurrency decision (env update, set-connection, delete, teardown review, teardown, project delete) goes through `environmentBusy()`, which reads `environmentActivity()` over `operation_authority` (queued, running, uncertain, or approved with a retained start intent). Authority unreadable fails closed on product evidence; local memory mode (no platform store) has only the product record. |
| Other decision points audited | `capabilities/destroy-review.ts` `activeDeploymentId` check | kept: it is the product environment writer fence (a fence in the product store's own authority, taken together with the platform `env:<id>` lease the same function holds), not a display projection. `bridge/lifecycle.ts` approve/cancel/start still read `d.status`/`d.workflowStartedAt` as cheap UI preconditions, but every state change they cause is re-decided by the broker CAS on the platform operation (approval consumption, claim, cancel with `from`-status), so a stale projection can refuse or mislead a button but cannot commit a wrong transition. Not converted; listed as residual. `execution/product-port.ts` writer takeover is the product-store writer CAS. |
| `bridge/readiness.ts` inflight map | probe de-duplication cache | not authority |

## 2. Acceptance mapping

| Acceptance clause | Implementation | Tests |
| --- | --- | --- |
| DUR-01: durable intent/outbox on product, platform, Temporal, runner authorities | `durable_intents` + relay (platform/Temporal signals and starts); `workflow_start_intents` + adoption/recovery (Temporal start); `runner_jobs` + deterministic ids (runner); product projection repair (product) | durable-intent-authority, start-recovery, idempotent-enqueue |
| DUR-01: idempotent start across every crash window | `recoverWorkflowStartIntent` (identical request, same requestId, window + lease + endpoint guards), W4 to W8 | start-recovery (T) |
| DUR-01: idempotent signal across every crash window | deterministic intent id, `requestId = intent id`, fenced claim/settle, `deriveApprovalSignals`, durable cancel | durable-intent-authority crash-window block (PG), start-recovery NotFound (T) |
| DUR-01: runner enqueue/ack | `idempotencyKey` deterministic job id, attach-on-retry/race; ack is the existing exactly-once settle | idempotent-enqueue; existing late-effect-receipts |
| DUR-02: operation authority versus UI projection defined | section 1 definition; `operation_authority`, `projectOperation`, `GET .../operations/:id` `authority` | durable-intent-authority "projection" tests |
| DUR-02: concurrent writers preserve state (versioned CAS / fencing) | `casTransition`, trigger-maintained version, `claim_epoch` fences | durable-intent-authority "exactly one commits", "superseded holder", "concurrent relays" (real PG for independent backends) |
| DUR-02: no local lock/projection treated as authority | audit table above; `environmentBusy` over `environmentActivity`; decisions rest on SQL CAS and fences | durable-intent-authority "concurrency decision reads the authority record" (PG) |

## 3. Verification commands (verifier machine)

Environment: Node 22. Real PostgreSQL via `ZENITH_TEST_PLATFORM_PG_URL` (owned database with an explicit port). Temporal tests
need the owned Temporal CLI (`findTemporalCli`); set `ZENITH_TEST_TEMPORAL=1` to make its absence a failure.

```
# typecheck/lint (already run by the builder, see below)
npx tsc --noEmit -p .
npx eslint <changed files>

# PGlite lane only
npx vitest run tests/controlplane/durable-intent-authority.test.ts tests/runners/idempotent-enqueue.test.ts

# plus real PostgreSQL (independent backends, real row locks)
ZENITH_TEST_PLATFORM_PG_URL=postgres://...:PORT/db npx vitest run tests/controlplane/durable-intent-authority.test.ts tests/runners/idempotent-enqueue.test.ts

# real Temporal (owned CLI) plus actual SQL/Broker
ZENITH_TEST_TEMPORAL=1 ZENITH_TEST_WORKFLOW_START_REQUIRED=1 ZENITH_TEST_PLATFORM_PG_URL=... \
  npx vitest run tests/workflows/start-recovery.test.ts tests/workflows/start-intent.test.ts

# regression of areas touched
npx vitest run tests/controlplane tests/platform/critical-jobs.test.ts tests/bridge tests/runners tests/capabilities/routes.test.ts tests/platform/plan-approval-routes.test.ts tests/docs/operator-docs.test.ts
```

Expected: all pass, zero skipped except the Temporal file when the CLI is unavailable and not required. Explicit
expectations worth checking first: (a) in `start-intent.test.ts` the existing "SQL claim commit acknowledgement loss..." test
still shows **no Start RPC from `startWorkflowIntent`** (the resend exists only on the relay entrypoint); (b) migrations
test: PLATFORM_SCHEMA_VERSION is now 30 and the emitted Supabase SQL must be regenerated by the assembler.

## 4. Known gaps, things that may break first, shared-file updates

Known gaps (honest):

1. **Not run.** None of the new tests were executed by the builder (build-only rule). Most likely first failures: a
   transition edge or helper name in the harness-based tests, the Temporal tests' reliance on the `dayTwoOperationWorkflow`
   completing under the test worker, `describeWorkflowExecution` NotFound error shape (`isNotFound` accepts gRPC code 5,
   `cause.code` 5 and `WorkflowNotFoundError`), and `sha256()` availability in PGlite for `adoptStartIntents`/`deriveApprovalSignals`
   id computation.
2. W3 (claimed `running`, process dies before the start intent is prepared) still ends as explicit `uncertain`, not as a
   recovered start. Deliberate: with no intent there is nothing to prove an attempt boundary.
3. W5 resend is bounded to 30 minutes and a live operation lease. Past that the intent stays `attempted` and the operator
   inspects it; there is no operator-authorized continuation or recovery epoch in this change (that is the DUR operator
   continuation work).
4. W9 approval sweep now has isolated predicate tests (eligible; no acknowledged start / no plan round / no plan digest / inside quiet period / cancelled; no repeat). The workflow's own 30-minute approval poll remains the last-resort backstop.
4b. **Out of scope (OPS-04):** operator-authorized continuation of a refused/expired start and recovery epochs. Not built here.
5. Runner keys: see the job-kind table. Provider HTTP proxy jobs (`aws.http`, `oci.http`, `k8s.http`) are deliberately unkeyed (reads and writes share the transport). Machine request keying overlaps DUR-D (uncertain mutations/dedup); the key is additive and uses the identity the evidence layer already enforces.
6. Decision points converted to authority (section 1 audit). Remaining projection reads are display only. Simulator (engine) deployments have no platform operation and are still decided from the product store.
7. Product projection repair (`projectAcknowledgedStart`) runs only in the relay handler and is best effort; no standalone
   test (the product store scope helpers are modeled elsewhere). The platform-side projection (`projectOperation`) is tested.
8. Verified behaviours changed: none removed. `WorkflowGateway.signalApproval/cancelOperation` gained an optional
   `workspaceId` and a `pending` reason (additive). The sole-transport-write in `start-intent.ts` was extracted to
   `sendStart` with identical semantics (including swallowing a malformed ack as "readback only").
9. The `cleanup_writer_transition` trigger fires on the `prepared -> attempted` edge only. Relay resend does not change phase,
   so it crosses no new barrier; an `attempted` intent remains an unresolved writer for cleanup until acknowledged.

Shared interfaces for concurrent workers (additive only):

- `OperationRecord` and `OPERATION_COLUMNS` are **unchanged**. Versioning lives in `platform.operation_authority`, read via
  `readAuthority`; write paths that want a fence call `casTransition`. DUR-B/C/D should not add columns to the authority
  table; they may add `durable_intents.kind` values only through their own migration (the check constraint is explicit).
- To fence a new state change on an operation: read `readAuthority`, decide, call `casTransition` with the version.
- To make an outward effect durable: `enqueueIntent(tx, {kind, idempotencyKey, payload})` inside the deciding transaction,
  add a handler in `createTemporalIntentHandlers` (or an equivalent handler map passed to `relayOnce`).
- `projectOperation` is the one read model for delivery status; add fields there rather than deriving phases elsewhere.

New tables (for tenancy.test.ts / controlplane-sql-scoping classification):

| Table | Tenancy | Store functions | Notes |
| --- | --- | --- | --- |
| `platform.operation_authority` | tenant (`workspace_id`), FK to operations, cascade | `readAuthority`, `casTransition`, `projectOperation` (all name `workspace_id`) | written only by trigger (service role has `select`) |
| `platform.durable_intents` | tenant (`workspace_id`), FK to operations, cascade | per-operation: `enqueueIntent`, `getIntent`, `settleIntent`, `projectOperation`; **cross-tenant system sweeps by design**: `claimDue`, `adoptStartIntents`, `deriveApprovalSignals` | all new modules live under `src/lib/controlplane/authority` and `outbox`, deliberately **outside** `db/repos`, so they are not in `controlplane-sql-scoping` or the repo registry; add reviewed entries if the verifier wants them scanned |

Shared-file updates the orchestrator/assembler must make:

- Run emit-sql for migration 30; update the migrations inventory and `tests/controlplane/migrations.test.ts`, `supabase/migrations/*`, `scripts/ci/apply-supabase-migrations.sh`, `docs/platform/operations/DEPLOYING.md`.
- Gate manifest: add `tests/controlplane/durable-intent-authority.test.ts` and `tests/runners/idempotent-enqueue.test.ts` to the platform PostgreSQL group, `tests/workflows/start-recovery.test.ts` to the workflow/Temporal group (owned CLI).
- Critical maintenance: no new job name was added (the relay rides `runner-reaper`), so `CRITICAL_JOBS`, the schedule and the `scheduled_job_runs` constraint are unchanged. The `runner-reaper` run record now has extra counts (`adopted`, `claimed`, `delivered`, `retried`, `dead`, `stale`, `relayFailed`).
- LIMITATIONS: replace the DUR-01/02 lines (see suggested status below) and keep "operator continuation and recovery epochs remain open".

## 5. Suggested ledger implementationStatus

PROD-DUR-01: `source_complete_durable_signal_start_recovery_runner_identity_runtime_acceptance_pending`
(durable intent/outbox, relay, start recovery and tofu apply idempotency built and wired; real PostgreSQL, owned Temporal and
independent-process acceptance pending; recovery epochs and operator continuation not built).

PROD-DUR-02: `source_complete_authority_record_cas_projection_runtime_acceptance_pending`
(versioned authority record, CAS, derived projection and API field built; real PostgreSQL concurrency acceptance pending;
product-store guards such as `inFlight` still read a projection).
