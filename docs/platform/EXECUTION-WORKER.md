# Execution worker and workflows

How real-infrastructure operations run: Temporal workflows (deterministic
orchestration), the execution worker process that hosts them and their
activities, and the small client the control plane uses to start, signal and
query them. Decision record: `docs/adr/0009-temporal-workflows.md`. Contract:
`src/lib/workflows/types.ts`.

**Honest status.** The workflows, client, worker bootstrap, image recipe and
tests are real and tested. The *activities* are stubs: every one fails with a
non-retryable `not_implemented` ("nothing was changed") until the workstreams
that own the store, lease service, OpenTofu runner, policy engine, drivers and
credential broker plug their implementations into `createActivities`. Nothing
here has run against a cloud, a real store, OpenTofu, Temporal Cloud or a
Docker build. See [What was and was not verified](#what-was-and-was-not-verified).

## Topology

```
 control plane (Next / Vercel / any Node host)            Temporal (Cloud or self-hosted)
   src/lib/workflows/client.ts                              namespace, task queue "zenith-execution"
     startDeploy / startDayTwo / startRemediation ───────▶  workflow history (ids, digests, counts only)
     signalApproval / cancelOperation / getProgress ─────▶          │
                                                                    │ polls
 execution worker (long-running container, stateless)  ◀──────────┘
   workers/execution/worker.ts
     workflows  = src/lib/workflows/definitions/**   (deterministic; runs in the Temporal sandbox)
     activities = src/lib/workflows/activities/**    (the ONLY code touching store, drivers,
                                                      OpenTofu, credential broker)
```

- The control plane only **starts, signals and queries** workflows. It never
  runs an activity and never holds a long-lived job.
- Workflow ids are `op-<operationId>` (operations) and `reconcile-<environmentId>`
  (reconcile passes). The id makes starts idempotent.
- Payloads carry ids, digests, counts and short redacted messages. No
  credentials, secret values, plan files or provider responses: Temporal
  history is durable and replicated.
- The existing product engine remains for sandbox and LocalStack; this path is
  for real infrastructure.

## Workflows

All four live in `src/lib/workflows/definitions/` and are exported by name from
`definitions/index.ts` (the worker registers every exported function as a
workflow type, so nothing else is exported there).

### `infrastructureDeployWorkflow(DeployWorkflowInput) -> WorkflowResult`

```
validate → lease → plan → policy → [approval] → final_plan
  → apply_infrastructure → build → deploy → migrate
  → verify_infrastructure → verify_application → observe → finalize → release
```

| Step | Activity | Notes |
|---|---|---|
| validate | `validateDesiredState` | any `problems` fail the operation before a lease is taken |
| lease | `acquireLease` (`env:<environmentId>`, 5 min TTL) | renewed before every later step; long activities renew as they heartbeat |
| plan | `planInfrastructure` | read-only |
| policy | `evaluatePolicy(planDigest)` | `deny` → `failed` with the reasons; `require_approval` → approval; `allow` → straight on |
| approval | `checkApproval`, and `markOperation(awaiting_approval)` only if it has to wait | see [Approval](#approval); skipped when policy allows |
| final_plan | `finalPlan(approvedPlanDigest)` | non-retryable `plan_changed` → `failed`, "re-approval needed", nothing applied |
| apply_infrastructure | `applyInfrastructure` | mutating; one attempt |
| build | `buildArtifacts` | skipped when `input.build` is false (manifest pins images) |
| deploy | `deployWorkloads(images)` | mutating; one attempt |
| migrate | `runMigrations` | mutating; one attempt |
| verify_infrastructure / verify_application | `verifyInfrastructure` / `verifyApplication` | `failed` → `failed`; `unknown` → `uncertain` |
| observe | `observeEnvironment` | diagnostic: a failed observation does not undo a verified deploy |
| finalize | `markOperation(succeeded)` | |
| release | `releaseLease` | always, on every path that acquired a lease |

`input.preApproved` is informational. Policy is re-evaluated against the
concrete plan and is authoritative: a "pre-approved" proposal whose policy now
says `require_approval` still waits for an approval.

### `dayTwoOperationWorkflow(DayTwoWorkflowInput)` and `remediationWorkflow(RemediationWorkflowInput)`

`lease → policy re-check → [approval] → execute_capability → verify_application → finalize → release`

One shared body (`definitions/capability.ts`). The capability runs once
(`executeCapability`, one attempt). A failed or inconclusive verification ends
the operation `failed` / `uncertain`; **nothing re-runs the capability and
nothing rolls it back**. Whether to try again is a new proposal.
Remediation additionally records the `verifyApplication` result on the step
(checks passed and evidence id) and never re-runs on failure.

### `reconcileEnvironmentWorkflow(ReconcileWorkflowInput) -> ReconcileWorkflowResult`

`acquireLease(reconcile:<environmentId>) → reconcileObserve → releaseLease`.
Observe and report only. `allowAutoRepair` is accepted and echoed as
`repair: "not_implemented"` when drift is found: repairing needs a
`proposeRepair` activity that files a **new operation through the capability
broker** (policy, approval and the ledger all apply). That activity does not
exist, so the workflow says so instead of pretending a repair was considered.
Another pass holding the lease yields `status: "skipped"`. A reconcile pass is
not an operation and never calls `markOperation`.

### Signals and queries

| Name | Kind | Meaning |
|---|---|---|
| `approvalRecorded` | signal | an approval row was written; the workflow re-verifies through `checkApproval` (the signal only wakes it) |
| `cancel` | signal | stop: cancel the current activity, mark `cancelled`, release the lease |
| `progress` | query | `WorkflowProgress`: status plus every step's status, detail and timestamps |

Temporal-level cancellation (`handle.cancel()`) behaves the same as the `cancel`
signal.

## Final statuses

A workflow returns a `WorkflowResult` (it does not throw for failed / uncertain /
cancelled operations) and writes the same status with `markOperation`.

| Situation | Final status | Notes |
|---|---|---|
| all steps passed | `succeeded` | |
| invalid desired state | `failed` | before any lease |
| policy `deny` | `failed` | reasons in `error` |
| approval rejected | `failed` | nothing changed |
| approval not recorded within 24 h | `expired` | nothing changed |
| `plan_changed` at `final_plan` | `failed` | "re-approval needed"; nothing applied |
| lease busy at acquire | `failed` | nothing changed |
| `LeaseLost` at a step that may act, or after any such step ran | `uncertain` | work stops; reconcile observes |
| `LeaseLost` before anything was changed | `failed` | |
| `StepFailed` (activity says it ended cleanly) at apply | `failed` | "partial apply; reconcile will observe" |
| unclassified error, timeout or crash in apply / deploy / migrate / execute_capability | `uncertain` | one attempt, never replayed |
| unclassified error in a step that cannot act (plan, build, verify...) | `failed` | says so when earlier steps had already changed things and were not rolled back |
| verification `failed` | `failed` | changes stay applied |
| verification `unknown` | `uncertain` | never reported as success |
| cancelled | `cancelled` | says whether mutating steps had started; nothing is rolled back or destroyed |
| `not_implemented` (stub activity) | `failed` | "nothing was changed" |
| terminal status cannot be written at all | the workflow itself fails | the store is down; retried for up to an hour first |

`uncertain` is terminal for automation: nothing re-dispatches it. Reconciliation
observes reality and a human or a new operation decides.

### Which steps "may have acted"

`STEP_MAY_HAVE_ACTED` in `definitions/policies.ts` (an exhaustive
`Record<StepName, boolean>`, so a new step forces a decision):

- may act (`true`): `apply_network`, `apply_data`, `apply_infrastructure`,
  `publish`, `deploy`, `secrets`, `ingress`, `dns_tls`, `migrate`,
  `execute_capability`
- cannot act (`false`): `validate`, `lease`, `credentials`, `plan`, `policy`,
  `approval`, `final_plan`, `build` (content-addressed images, no environment
  change), `verify_*`, `observe`, `finalize`, `release`

The failure classification lives in `definitions/failures.ts` and is
table-tested (`tests/workflows/failures.test.ts`).

## Retries, timeouts, heartbeats

Declared once, in `ACTIVITY_OPTIONS` (`definitions/policies.ts`). Workflow code
contains no numbers.

| Class | Activities | Attempts | Timeouts |
|---|---|---|---|
| reads | validate, policy, checkApproval, verify\*, observe | 5, exponential (1 s → 30 s) | start-to-close 1–10 min |
| lease | acquire / renew / release | 3 (1 s → 10 s) | 30 s |
| plan | planInfrastructure, finalPlan | 3 | 30 min, heartbeat 60 s |
| build | buildArtifacts | 3 | 45 min, heartbeat 60 s |
| **mutating** | applyInfrastructure, deployWorkloads, runMigrations, executeCapability | **1** | apply 60 min, others 30 min; **heartbeat 60 s**; cancelled with `WAIT_CANCELLATION_COMPLETED` |
| bookkeeping | recordStep | 3 | 30 s; best effort (see below) |
| terminal write | markOperation | unlimited | 30 s each, 1 h overall |

Why mutating steps get one attempt: idempotency lives inside the activity
(keyed on operation id + step, fenced). Letting Temporal replay a half-run
`tofu apply` on another worker after a crash is the one thing worse than
stopping, so a crash surfaces as `uncertain`.

`nonRetryableErrorTypes` on every policy: `LeaseLost`, `LeaseBusy`,
`plan_changed`, `StepFailed`, `not_implemented`.

`recordStep` is a projection (the deployment record the UI follows). A failure
to project does not abort a deploy; the `progress` query always has the truth.

## Lease

- Scope `env:<environmentId>` (deploy, day-two, remediation), TTL 5 minutes,
  fenced (`LeaseRef.fenceToken`).
- The workflow calls `renewLease` before every step; long activities renew
  themselves while they heartbeat.
- Released exactly once on every path that acquired one (success, failure,
  cancellation), after the terminal status is written, and never while a
  mutating activity is still running.
- **Waiting for approval holds no lease.** The 5-minute TTL would expire during a
  human wait anyway and an idle hold would block every other operation on the
  environment. When the approval is not already there, the workflow releases
  before the wait and takes a fresh lease (new fence token) after the approval
  lands; `final_plan` then re-plans against
  the approved digest, so anything that changed in between is caught as
  `plan_changed`.

## Approval

`checkApproval` first: an approval that already exists (or a rejection) is taken
on the spot, with the lease still held and no `awaiting_approval` transition.
Otherwise the workflow releases its lease, calls `markOperation(awaiting_approval)`
and loops: `checkApproval` → approved / rejected / neither; on neither, wait for
the `approvalRecorded` signal or a 30-minute poll, whichever first. The poll means a lost signal costs at most 30
minutes. Every decision comes from `checkApproval` (the database row), never from
the signal alone, so a signal cannot approve anything. An approval recorded
before the workflow started waiting is seen on the first check (no signal race).
After 24 hours: `expired`.

## Cancellation

`cancel` signal (or `handle.cancel()`) cancels the current step's scope:
the running activity is cancelled (delivered through its next heartbeat), the
operation is marked `cancelled`, the lease is released. **The workflow never
destroys, rolls back or compensates anything.** Compensating stateful resources
(databases, volumes, buckets) automatically would destroy data; only
non-stateful workload rollback could ever be added, and it is out of scope. A
cancelled operation that had started mutating steps says so in its `error` and
is reconciled by observation.

Cancellation latency for a running activity is bounded by the heartbeat
throttle (`ZENITH_WORKER_HEARTBEAT_THROTTLE_MS`, default 10 s). Without that cap
the SDK throttles to 80 % of the heartbeat timeout (48 s).

## Writing the real activities

`src/lib/workflows/activities/index.ts` documents the rules; the essentials:

1. **Payloads**: ids, digests, counts, short redacted summaries only.
2. **Credentials** exist only inside `CredentialBroker.withSession`; never
   returned, logged, persisted or put in a result or error.
3. **Mutating activities** are idempotent on (operationId, step), check the
   fence token before and after the external call, and **heartbeat at least
   every 30 s** (the heartbeat timeout is 60 s). Long ones that hold the lease
   renew it as they go. Observe `Context.current().cancellationSignal` and stop
   cleanly (for tofu, interrupt the process and let it release its state lock).
4. **Throw typed failures** (`activities/failures.ts`) when the outcome is
   known: `leaseLost`, `leaseBusy`, `planChanged`, `stepFailed`. Leave everything
   else as a plain error: for a mutating step the workflow finalizes
   `uncertain`, which is the honest answer when a crash or timeout hides what
   happened. `withFailureMapping` converts `LeaseLostError` and
   `TofuPlanChangedError` automatically.
5. **Never destroy** from an activity the workflows call.
6. `reconcileObserve` (a new activity, see `ReconcileActivities` in `types.ts`)
   takes `{ passId, workspaceId, environmentId, lease }`; `passId` is the
   workflow id and the lease holder. `acquireLease.operationId` is used as the
   lease holder id, so for reconcile it carries the pass id, which is not an
   operation id: the lease service must not require it to exist as an operation.
7. `src/lib/workflows/activities/fake.ts` is the scriptable in-memory
   implementation the tests use. Use it to test code that depends on workflow
   behaviour; do not mistake it for evidence about a cloud.

## Configuration

Read in **one function per concern**: `temporalConfigFromEnv`
(`src/lib/workflows/config.ts`, used by both the client and the worker) and
`executionWorkerConfigFromEnv` (`workers/execution/config.ts`). Invalid values
fail fast with a message that never contains a secret.

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `ZENITH_TEMPORAL_ADDRESS` | `localhost:7233` | client, worker | Temporal frontend `host:port` |
| `ZENITH_TEMPORAL_NAMESPACE` | `default` | client, worker | Temporal namespace |
| `ZENITH_TEMPORAL_API_KEY` | unset | client, worker | Temporal Cloud API key; **secret**, never logged; implies TLS |
| `ZENITH_TEMPORAL_TLS` | `false` | client, worker | force TLS without an API key |
| `ZENITH_WORKER_TASK_QUEUE` | `zenith-execution` | worker | task queue to poll |
| `ZENITH_WORKER_MAX_CONCURRENT_ACTIVITIES` | `8` | worker | parallel activity executions (1–1000) |
| `ZENITH_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS` | `40` | worker | parallel workflow tasks (1–1000) |
| `ZENITH_WORKER_SHUTDOWN_GRACE_MS` | `600000` | worker | how long running activities may finish after SIGTERM before they are cancelled |
| `ZENITH_WORKER_HEARTBEAT_THROTTLE_MS` | `10000` | worker | longest gap between heartbeats reaching the server; bounds cancel latency (100–60000) |
| `ZENITH_WORKER_WORKFLOW_BUNDLE` | unset | worker | path to a prebuilt workflow bundle (production); unset bundles the TypeScript at start-up |
| `ZENITH_WORKER_LOG_LEVEL` | `INFO` | worker | `TRACE`…`ERROR` |
| `ZENITH_WORKER_HEALTH_LOG_INTERVAL_MS` | `60000` | worker | periodic health log line; `0` disables |
| `ZENITH_WORKER_IDENTITY` | `zenith-exec:<host>:<pid>` | worker | worker identity in Temporal |

Tests never read the real environment and never use `localhost:7233`.

## Local development

```powershell
# 1. a local Temporal (dev server, in-memory, no UI)
temporal server start-dev --headless --port 7233
#    Use another port if 7233 is taken (something else may be listening there);
#    then set ZENITH_TEMPORAL_ADDRESS=127.0.0.1:<port> for the worker and the app.

# 2. the worker (from the repo root)
npx tsx workers/execution/worker.ts
```

Desired `package.json` script (not added here; `package.json` is not in this
workstream's paths):

```json
"worker": "tsx --env-file-if-exists=.env.local workers/execution/worker.ts"
```

Until the activities are implemented, starting a deploy makes the workflow fail
fast with "Activity markOperation is not implemented in this worker build;
nothing was changed" (a reconcile pass returns `status: "failed"` with the same
reason). That is the expected behaviour of the stub build.

**Bundling.** The worker bundles `src/lib/workflows/definitions/index.ts` with
Temporal's bundler. The definitions use relative imports only, so the repo's
`@/` path alias is not needed inside them (a test proves an `@/` import fails to
bundle, the same import made relative bundles, and a Node built-in import is
refused). Production builds the bundle once (`workers/execution/build-bundle.ts`)
and points `ZENITH_WORKER_WORKFLOW_BUNDLE` at it. Temporal's bundler compiles
TypeScript with `swc-loader`; on a host where the swc native addon cannot load
(this Windows machine: `@swc/core` 1.16 refuses its cache directory's ACL) the
bundler retries with an esbuild loader and logs `swc could not compile the
workflows; used the esbuild fallback`. Linux containers use swc.

**Where the client may run.** `src/lib/workflows/client.ts` uses the Temporal
gRPC client: Node runtime only (route handlers with `runtime = "nodejs"`), not
edge, not client components. It may need `serverExternalPackages` in
`next.config.ts` for `@temporalio/*` if Next's bundler objects; not checked.

## Temporal Cloud

Set `ZENITH_TEMPORAL_ADDRESS=<namespace>.<account>.tmprl.cloud:7233`,
`ZENITH_TEMPORAL_NAMESPACE=<namespace>.<account>` and
`ZENITH_TEMPORAL_API_KEY`. The key forces TLS. For a regional endpoint
(`*.api.temporal.io`) the connection also sends the `temporal-namespace`
metadata header the API-key flow requires. mTLS client certificates are not
wired (only API-key auth). **None of this has been run against Temporal Cloud**:
there is no account on this machine; the option shapes follow the SDK's
documented API-key and TLS options. Namespace, retention and API-key rotation
are operator choices; the worker only needs the key in its environment. Keep the
key in a secret store and out of images and logs (`describeTemporalConfig`
reports only whether one is set).

History payloads are not encrypted (no data converter / codec is configured).
They hold ids, digests, counts and redacted messages by contract; if that ever
stops being enough, add a payload codec on both the client and the worker.

## Scaling and operations

- The worker is stateless. Run as many replicas as needed against the same task
  queue; Temporal load-balances. Add replicas when the task queue's
  schedule-to-start latency grows (Temporal metric
  `temporal_activity_schedule_to_start_latency`), not on CPU alone: most
  activity time is waiting on tofu or a cloud API.
- `ZENITH_WORKER_MAX_CONCURRENT_ACTIVITIES` bounds parallel activities *per
  replica*. `tofu` plans and applies are memory-hungry (provider processes);
  budget memory generously per concurrent activity (a rule of thumb of about 1 GiB
  each is an unmeasured guess) and lower the concurrency rather than letting the
  kernel kill a mid-apply provider.
- One task queue serves every tenant. A noisy tenant can queue in front of
  others; Temporal task-queue fairness/priority is the lever if that shows up.
  The `env:<id>` lease already serializes work on one environment.
- Rolling redeploys: on SIGTERM the worker stops polling and drains (see
  below); the next worker resumes the workflows. Set the orchestrator's stop
  timeout (Kubernetes `terminationGracePeriodSeconds`, Docker `--stop-timeout`)
  **above** `ZENITH_WORKER_SHUTDOWN_GRACE_MS` or the worker is SIGKILLed mid
  activity.
- Health: the process logs one JSON line at start-up (`execution worker ready`,
  with the config minus secrets) and a `health` line every
  `ZENITH_WORKER_HEALTH_LOG_INTERVAL_MS`. Pollers are visible in the Temporal UI
  (task queue → workers). There is no HTTP health endpoint.
- Run the container with an init (`tini` is in the image entrypoint) so orphaned
  provider processes are reaped; use a read-only root filesystem with `/tmp` and
  `/var/lib/zenith` writable.

### What happens when a worker dies

| Moment | Result |
|---|---|
| between activities | another worker picks the workflow up and replays it to the same point; nothing re-runs |
| during a read activity (validate, plan, verify...) | the activity is retried per its policy (heartbeat or start-to-close timeout, then a new attempt) |
| during a **mutating** activity (apply, deploy, migrate, execute) | the server notices after the 60 s heartbeat timeout; **the activity is not retried** (one attempt); the operation ends `uncertain`, the lease is released, reconcile observes the environment |
| during a drain (SIGTERM) | the worker finishes running activities within the grace period, then cancels them; the workflow resumes on the next worker |
| the worker never returns (network partition) | same as a crash: heartbeat timeout, then `uncertain` |

The fence token is what makes the last two safe: a stale activity that wakes up
later finds its lease gone and stops (`LeaseLost`).

## Changing workflows safely

A workflow that is running may be replayed by any future worker, so its code must
stay compatible with recorded history. Adding, removing or reordering
activities, or changing a timer, needs `patched("<change-id>")` /
`deprecatePatch` from `@temporalio/workflow`, in three steps: patch in, deprecate
once old executions have finished, remove. `tests/workflows/replay.test.ts`
replays histories captured from real runs against the current code (deploy
happy path, approval + signal, failure, cancellation, retried reads, day-two,
remediation, reconcile) and includes a negative control (a reordered workflow is
rejected). Once a version ships, freeze histories recorded by it as golden files
and replay them on every change.

## Testing

```powershell
npx vitest run tests/workflows
```

- Real Temporal servers, started by the suite on their own ports (never
  `localhost:7233`): `tests/workflows/support.ts` tries `createLocal` with the
  installed `temporal` CLI, then the SDK's own download, then a spawned
  `temporal server start-dev --headless` on a random port; time-dependent tests
  use `createTimeSkipping()` (the SDK's cached or downloaded test server). A suite
  skips itself with the reason if none can start.
- Activities are `activities/fake.ts`: scriptable failures, delays, holds and a
  small lease table. They prove workflow behaviour only.
- Coverage: happy path and step order; policy deny; approval wait, signal,
  rejection, expiry, lost signal, plan changed during the wait; `plan_changed`;
  lease loss and busy lease; mutating-step failure classification; verification
  failed / unknown; retries and exhaustion; cancellation (signal, Temporal
  cancel, during approval, before any lease); heartbeat timeout as a crashed
  worker; rolling worker replacement; duplicate starts; the client; the
  availability probe; the bundler and `@/` alias; replay determinism; secret
  hygiene (no credential-shaped keys in any recorded activity input or result,
  errors scrubbed).

## What was and was not verified

Verified here (Windows 11, Node 24.19, Temporal CLI 1.8.2 dev server, SDK 1.24.0):
everything in [Testing](#testing); the esbuild command and the workflow bundle
build that `docker/worker.Dockerfile` uses; `node dist/execution/worker.cjs`
booting from that bundle, polling, running a stub workflow to its
`not_implemented` failure, and a duplicate start returning the same run.

Not verified: a Docker build of the image (Docker is unavailable here); the
Linux `@swc/core` binding; SIGTERM handling on Linux (Windows cannot deliver
SIGTERM; the handler logic is unit-tested with a fake process); Temporal Cloud
and API-key auth; mTLS; any real activity; behaviour under real load; the
time-skipping server's fidelity to a production server (it is used only for the
24 h approval window and the periodic re-check).

## Not built (next steps)

- The real activities (owned by other workstreams) and their `ActivityDeps`.
- `proposeRepair` and auto-repair in the reconcile workflow.
- Search attributes (workspace, environment, capability) for listing operations
  in Temporal visibility.
- Payload encryption, golden replay histories, a schedule for reconcile passes.
