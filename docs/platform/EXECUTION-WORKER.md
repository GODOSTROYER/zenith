# Execution worker and workflows

How real-infrastructure operations run: Temporal workflows (deterministic
orchestration), the execution worker process that hosts them and their
activities, and the small client the control plane uses to start, signal and
query them. Decision record: `docs/adr/0009-temporal-workflows.md`. Contract:
`src/lib/workflows/types.ts`.

**Honest status (source snapshot `3c1fa66`, 2026-10-01).** The worker opens an
explicitly configured platform store, validates startup requirements and calls
`createActivities`, which delegates to `composeExecutionActivities` in
`src/lib/platform/execution.ts`. That composition supplies the stores, broker,
credential sessions, driver registry, OpenTofu, cost, observability and AWS/GCP
release ports. Azure builds require source wiring. `createStubActivities` remains an explicit test factory; it is
never the worker's fallback. Product deploys and MCP v3 start workflows.
This wiring is not live-cloud acceptance. No Temporal Cloud, cloud or Docker
run is claimed by this sync. See
[What was and was not verified](#what-was-and-was-not-verified).

## Topology

```
 control plane (Next / Vercel / any Node host)            Temporal (Cloud or self-hosted)
   src/lib/workflows/client.ts                              namespace, task queue "zenith-execution"
     startDeploy / startDestroy / startDayTwo / startRemediation ─▶  encrypted payloads (ids, digests, counts)
     signalApproval / cancelOperation / getProgress ─────▶          │
                                                                    │ polls
 execution worker (long-running container; private local plans) ◀┘
   workers/execution/worker.ts
     workflows  = src/lib/workflows/definitions/**   (deterministic; runs in the Temporal sandbox)
     activities = createActivities → src/lib/platform/execution.ts → src/lib/execution/**
                                                    (store, drivers, OpenTofu, credential broker)
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

All five live in `src/lib/workflows/definitions/` and are exported by name from
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

### `infrastructureDestroyWorkflow(DestroyWorkflowInput) -> WorkflowResult`

`lease → destroy plan → policy → human approval → final destroy plan → destroy apply → verify absence → finalize → release`

`src/lib/workflows/definitions/destroy.ts` uses the destruction activities from
`src/lib/execution/destroy.ts`. Human approval is required even when policy
returns allow. The final plan must match the reviewed digest; mutation runs
once, and unknown absence ends `uncertain`. The browser admin action and its
evidence/retention/ownership guards are in
[TEARDOWN.md](operations/TEARDOWN.md); default managed session and first-review
entry-point limits still apply. Teardown never runs as compensation.

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
| `not_implemented` (explicit test factory or refused unsupported path) | `failed` | No supported implementation ran; production does not select test stubs |
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
5. **Never destroy as compensation** from deploy/day-two activities. Explicit
   teardown belongs only to the reviewed, human-approved destroy workflow
   (`src/lib/execution/destroy.ts`).
6. `reconcileObserve` (a new activity, see `ReconcileActivities` in `types.ts`)
   takes `{ passId, workspaceId, environmentId, lease }`; `passId` is the
   workflow id and the lease holder. `acquireLease.operationId` is used as the
   lease holder id, so for reconcile it carries the pass id, which is not an
   operation id: the lease service must not require it to exist as an operation.
7. `src/lib/workflows/activities/fake.ts` is the scriptable in-memory
   implementation the tests use. Use it to test code that depends on workflow
   behaviour; do not mistake it for evidence about a cloud.

## Configuration

Before polling, `workers/execution/startup.ts` requires:

- Explicit `ZENITH_TEMPORAL_ADDRESS` (even for a local server).
- `ZENITH_SECRET_KEY`: 64 hex characters, used to derive a private plan
  fingerprint key via HKDF. Do not print it or put it in workflow payloads.
- A usable `ZENITH_CONTROL_SIGNING_JWK` or `ZENITH_CONTROL_KMS_KEY_ID`.
- An explicitly configured platform store (`ZENITH_PLATFORM_DB` or a database
  URL, including its Supabase fallback), opened with current schema. Postgres
  migrations must be applied with `npm run migrate:platform` before startup.

`ZENITH_WORKER_IDENTITY` is optional. An explicit value must contain 1–64
letters, digits, dots, underscores or hyphens. The sanitized default
`zenith-exec-<host>-<pid>` satisfies both the Temporal config and runtime
lease-holder rules. The policy bundle, product store and OIDC signer
must also be configured for the activities that use them. Startup does not
prove deploy permissions or live cloud readiness.

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
| `ZENITH_TEMPORAL_TLS_CA_FILE` | unset | client, worker | PEM server CA bundle path (custom CA) |
| `ZENITH_TEMPORAL_TLS_CERT_FILE` | unset | client, worker | mTLS client certificate path; set together with the key file |
| `ZENITH_TEMPORAL_TLS_KEY_FILE` | unset | client, worker | mTLS client private key path; **secret**, contents never logged |
| `ZENITH_TEMPORAL_TLS_SERVER_NAME` | unset | client, worker | TLS server name (SNI) override; verification stays on |
| `ZENITH_WORKER_TASK_QUEUE` | `zenith-execution` | worker | task queue to poll |
| `ZENITH_WORKER_MAX_CONCURRENT_ACTIVITIES` | `8` | worker | parallel activity executions (1–1000) |
| `ZENITH_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS` | `40` | worker | parallel workflow tasks (1–1000) |
| `ZENITH_WORKER_SHUTDOWN_GRACE_MS` | `600000` | worker | how long running activities may finish after SIGTERM before they are cancelled |
| `ZENITH_WORKER_HEARTBEAT_THROTTLE_MS` | `10000` | worker | longest gap between heartbeats reaching the server; bounds cancel latency (100–60000) |
| `ZENITH_WORKER_WORKFLOW_BUNDLE` | unset | worker | path to a prebuilt workflow bundle (production); unset bundles the TypeScript at start-up |
| `ZENITH_WORKER_LOG_LEVEL` | `INFO` | worker | `TRACE`…`ERROR` |
| `ZENITH_WORKER_HEALTH_LOG_INTERVAL_MS` | `60000` | worker | periodic health log line; `0` disables |
| `ZENITH_WORKER_IDENTITY` | `zenith-exec-<host>-<pid>` | worker | lease-holder identity, 1–64 letters/digits/dots/underscores/hyphens; invalid values refuse startup |
| `ZENITH_WORKER_PLAN_DIR` | `<ZENITH_DATA or .data>/platform-plans` | worker | private binary-plan directory, created with mode `0700`; plans may contain secrets |
| `ZENITH_WORKER_HEALTH_PORT` | `9464` | worker | loopback `/healthz` and `/readyz`; 1–65535 |
| `ZENITH_WORKER_PLAN_MAX_AGE_HOURS` | `24` | legacy inspection | scan threshold only; 1–8760, never authorizes deletion |
| `ZENITH_PLAN_ARTIFACT_KEY` | unset | worker | dedicated 64-hex original-plan encryption key; disjoint from all vault keys, shared by cooperating workers |
| `ZENITH_PLAN_ARTIFACT_PREVIOUS_KEYS` | unset | worker | private JSON array of earlier 32-byte artifact keys (hex/base64), decrypt-only |
| `ZENITH_TOFU_IDENTITY_FILE` | packaged path | worker | checksum-verified packaged executable identity; required before polling |
| `ZENITH_SECRET_KEY` | unset | client, worker | 64-hex secret for payload encryption; required in production; worker also requires it for plan fingerprints |
| `ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS` | unset | client, worker | private JSON array of previous 64-hex keys for decrypting retained histories; see payload encryption below |

Tests never read the real environment and never use `localhost:7233`.

## Local development

```powershell
# 1. a local Temporal (dev server, in-memory, no UI)
temporal server start-dev --headless --port 7233
#    Use another port if 7233 is taken (something else may be listening there);
#    then set ZENITH_TEMPORAL_ADDRESS=127.0.0.1:<port> for the worker and the app.

# 2. the worker (from the repo root)
$env:ZENITH_TEMPORAL_ADDRESS = "127.0.0.1:7233"
$env:ZENITH_WORKER_IDENTITY = "zenith-exec-01"
# Supply the secret key, dedicated artifact key, control signer and PostgreSQL privately.
# Migrate through version 7 and supply the packaged OpenTofu identity before starting.
npm run worker
```

The integrated `package.json` script reads `.env.local` when present:

```json
"worker": "tsx --env-file-if-exists=.env.local workers/execution/worker.ts"
```

The worker can invoke provider APIs through composed activities. Startup
failure is an operator configuration/schema error, never a silent selection of
stubs. Non-AWS connections are verified (GCP, Azure, Kubernetes; OCI by runner
registration only), and OCI platform sessions run only through an active
registered runner (`src/lib/platform/credentials.ts`); use the provider limits and
[state backend reference](operations/DEPLOYING.md#214-customer-state-backends).

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

## Packaged worker acceptance

`scripts/acceptance/packaged-worker.mjs` is an opt-in harness for the actual
Linux image entrypoint. It uses only Node built-ins on the host, builds the
requested architecture with `--pull --no-cache`, and installs dependencies from
the committed lockfile inside the build. It never mounts host `node_modules`,
source files, workflow bundles or replacement activities into the worker.

Run each architecture separately:

```sh
ZENITH_PACKAGED_WORKER_ACCEPTANCE=1 node scripts/acceptance/packaged-worker.mjs --platform linux/amd64
ZENITH_PACKAGED_WORKER_ACCEPTANCE=1 node scripts/acceptance/packaged-worker.mjs --platform linux/arm64
```

The explicit Docker `acceptance` target adds an image-local fixture client to
the production runtime. The final/default `production` target excludes that
client and its store-seeding code. Both targets inherit the same worker bundle,
workflow bundle, policy assets, production dependencies, uid 10001 and entrypoint
`tini -- node dist/execution/worker.cjs`. The image now defaults `ZENITH_DATA` to
`/var/lib/zenith` and `ZENITH_WORKER_PLAN_DIR` to its private `platform-plans`
subdirectory; an unconfigured nonroot worker no longer attempts to create plans
under root-owned `/app/.data`. Its Docker health check calls the loopback
readiness endpoint. Writable volumes at `/var/lib/zenith` and `/tmp` are required
with a read-only root filesystem.

The harness creates a unique internal network and dedicated Postgres, Temporal
and worker volumes. It publishes no host ports, reuses no existing database and
starts no Zenith API/app server, cloud emulator or provider resource. It uses
pinned Postgres 16.15 and the multiarch
[official Temporal CLI image](https://github.com/temporalio/cli/blob/main/README.md)
for a development server with isolated persistence. Random database credentials,
an Ed25519 signer and the payload/plan key are generated into private temporary
environment files. Raw Docker output is bounded and kept private. Completion,
failure, timeout and SIGINT/SIGTERM all enter cleanup; resource deletion requires
this invocation's ownership label. SIGKILL or a Docker daemon outage can prevent
cleanup and must be handled by the operator using the reported run id.

Before generating any credentials or calling Docker, the harness resolves the
source and temporary base to canonical paths and rejects temporary storage
inside the source tree, including symlink aliases. It verifies the created
scratch directory's location and mode 0700. Private diagnostics use the same
outside-source guard. Prior runs used an outside-source temporary base; the
guard does not assert that a credential leak occurred.

Each removal has at most two ownership-checked attempts. A successful exact-name
listing must prove absence, including after a removal command times out; the
report records a bounded outcome for every resource.

The pinned Temporal CLI runs as uid 1000. Its disposable persistence volume
mounts at the image's owned `/home/temporal`, and the harness requires a real
`operator cluster health` response before testing worker startup. A fresh volume
at an unowned path is not a supported fixture. The worker still has to pass all
four readiness checks through its actual entrypoint on a read-only filesystem.

Failure evidence contains only fixed container roles, allowlisted container
status, running/OOM flags, exit codes and worker startup categories. It never
exports arbitrary daemon errors or worker/native messages. Before cleanup, the
harness captures at most 200 log lines per label-owned dependency, worker or
startup-refusal container into
an outside-source temporary directory named with the run id and `diagnostics`.
Directories are mode 0700 and files are mode 0600; every generated database
password, payload key, private signer value and full database URL is scrubbed.
These files remain private for failure diagnosis and must not be uploaded as
CI evidence. Only capture counts appear in the public report. Runtime secret
files and labeled containers, volumes, networks and images are still removed
on failure. The operator should delete the private diagnostic directory after
review. A startup category identifies the failed stage, not a verified cause.

Its intended checks are:

- Actual entrypoint refusals for a missing platform schema, invalid secret key
  and unusable signer, without secret output. Detached launch is bounded to
  120 seconds, followed by a 45-second observation window. Only a verified
  non-OOM worker exit of one and its expected startup category count as refusal;
  a Docker client timeout does not establish a worker outcome.
- A migrated Postgres control store, verified policy/signer, real Temporal
  polling and registered production activities.
- A successful reconciliation of an environment with no deployed resources.
- A real read-only `infrastructure.observe` proposal through the production
  broker, signed read-grant verification, policy reevaluation by the worker and
  an expected safe refusal because the fixture has no resource target. Both the
  workflow and operation ledger must end `failed`; this is a refusal contract,
  not a successful provider observation.
- Readiness loss during separate store/Temporal outages while liveness stays
  available, recovery, uid/filesystem checks and real PostgreSQL logical expiry of
  an encrypted lifecycle fixture. Ciphertext and every legacy sentinel remain
  retained; these sentinels are not executable plans or producer-provenance evidence.
- SIGTERM draining and exit zero for the idle packaged worker.

Evidence reports the commit, dirty source-input hash, harness hash, lockfile and
installed versions, image id, actual Node/OpenTofu architecture, Docker host
architecture and whether execution was emulated. Client evidence is checked
against fixed schemas before logging.
Locked dependency versions must pass the fixed version-format checks before
any are added to public evidence, and the inspected image id must be a SHA-256
identifier. Invalid values cause a fixed failure and never enter the report.
The source-input digest binds the worker
Dockerfile, root and optional Dockerfile-specific ignore controls, and every
regular file and directory in the declared host COPY roots, including
Git-ignored files. This is a conservative superset of Docker's filtered inputs;
symlinks, special files, missing inputs, unsupported COPY declarations and ADD
inputs fail admission. Paths, file modes and contents are framed in the digest,
with bounded inventory reads. A second capture must match after the fresh
build, before starting services. Evidence calls this an inventory-complete
pre/post check of a live context, with `immutableBuildContext: false`. A
transient change and restoration during Docker's read can evade that check;
immutable snapshot handoff remains a separate production requirement. The
digest exports no source contents or private paths.

The product metadata is a disclosed isolated **file-store fixture**; its members
and unconnected provider metadata
are not browser authentication or a verified cloud connection. The platform
store, policy, signer, workflow client, registered activities and Temporal service
are real. No activity port is replaced. No browser approval or cloud write is
performed. Retention sentinels are not real OpenTofu plans. In-flight cloud
activity drain, a production Postgres product authority, plan/apply and live
provider transports remain separate acceptance requirements.

Source/lint validation of this harness alone does not satisfy PROD-PKG-01..03.
Only a completed per-architecture run can establish the scoped checks above;
each report keeps the remaining limits explicit.

## Temporal Cloud

Set `ZENITH_TEMPORAL_ADDRESS=<namespace>.<account>.tmprl.cloud:7233`,
`ZENITH_TEMPORAL_NAMESPACE=<namespace>.<account>` and
`ZENITH_TEMPORAL_API_KEY`. The key forces TLS. For a regional endpoint
(`*.api.temporal.io`) the connection also sends the `temporal-namespace`
metadata header the API-key flow requires. mTLS client certificates are also
supported (`ZENITH_TEMPORAL_TLS_CERT_FILE` + `ZENITH_TEMPORAL_TLS_KEY_FILE`, optional
CA and server name; files are read once at startup, so rotating them needs a restart;
see [DEPLOYING.md](operations/DEPLOYING.md)). **None of this has been run against Temporal Cloud**:
there is no account on this machine; the option shapes follow the SDK's
documented API-key and TLS options. Namespace, retention and API-key rotation
are operator choices; the worker only needs the key in its environment. Keep the
key in a secret store and out of images and logs (`describeTemporalConfig`
reports only whether one is set).

### Payload encryption

`src/lib/workflows/codec.ts` configures the same Temporal `PayloadCodec` on the
control-plane client and execution-worker process, following the SDK's
[client/worker codec wiring](https://docs.temporal.io/develop/typescript/best-practices/data-handling/data-encryption).
Set `ZENITH_SECRET_KEY` to the same 64-hex secret on both processes. Production
workflow-client creation and worker startup refuse a missing or invalid key
before connecting. Without a key, development/test clients use the SDK's
plaintext converter; the execution worker's existing startup checks still
require its plan fingerprint key in every environment. A supplied invalid key
is always an error, including in development.

The codec derives a separate 32-byte encryption key with HKDF-SHA256, empty
salt and info `zenith.temporal.payload.v1`. Each complete protobuf payload,
including its original metadata, is encrypted with AES-256-GCM and a fresh
12-byte nonce. Wire metadata contains only `encoding=binary/zenith.temporal.v1`
and `zenith.temporal.key-id`, the first 32 hex characters of SHA-256 of the
derived key. Both values are authenticated as associated data. The wire data
is nonce (12 bytes), authentication tag (16 bytes), then ciphertext. Unknown
keys, invalid envelopes and failed authentication raise fixed errors without
including payloads, key ids or secrets.

For rotation, set `ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS` on **both** processes
to a private JSON array of previous 64-hex secret keys. New payloads use only
the current `ZENITH_SECRET_KEY`; the retained keys are decrypt-only and retain
their original fingerprint ids. Restart clients/workers together after a
rotation; client caching also distinguishes the active and retained key set.
Keep old keys as long as their histories, retries, queries or archived histories
must be readable. Removing a key makes those encrypted payloads unreadable;
there is no automatic history re-encryption. This config rotates Temporal
payloads only; other stores using `ZENITH_SECRET_KEY` have their own migration
requirements.

Legacy plaintext histories remain readable, including by encrypted workers.
Encryption/decryption runs outside the deterministic workflow sandbox and
does not change workflow definitions or their command sequence. Replay of an
encrypted history must pass `dataConverter: temporalDataConverterFromEnv()`
to `Worker.runReplayHistory`; the existing plaintext replay suites remain
valid. Workflow ids, task queues, visibility/search attributes and default
failure messages/stack traces are **not encrypted** by a payload codec.
The existing ids-only and redaction contracts still apply: cloud credentials
must never enter workflow payloads. No codec server for UI/CLI decryption is
provided, and live Temporal Cloud acceptance has not been run. The gated
`tests/workflows/codec-replay.test.ts` covers encrypted execution and replay
against a local Temporal server with scripted activities.

## Scaling and operations

- Temporal load-balances workers on the same queue. Binary plans remain in
  `ZENITH_WORKER_PLAN_DIR`; filesystem sharing and failover between replicas
  have not been verified. Capacity planning can use the task queue's
  schedule-to-start latency (Temporal metric
  `temporal_activity_schedule_to_start_latency`); CPU alone is insufficient: most
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
  (task queue → workers). Loopback probes at `127.0.0.1:9464` are implemented in
  `workers/execution/health.ts`: `/healthz` reports process liveness (200), while
  `/readyz` requires reachable Temporal/store, loaded policy and six registered
  providers (200 or 503). Checks are bounded to two seconds and return only
  `ok`/`unavailable`/`unknown`; readiness does not prove cloud permissions. Use an
  in-container probe; remote pod probes cannot reach the loopback listener.
- Durable originals: migration 7 stores authenticated ciphertext and separate use/expiry state in PostgreSQL. Workers need the same dedicated artifact keyring and matching source/backend/lock/executable context. Another worker applies the original after separate fresh drift, ownership, policy and human checks; fresh files cannot replace it.
- Plan maintenance: `src/lib/execution/plan-janitor.ts` starts immediately and runs every five minutes, marking at most 100 expired artifact uses per pass. It retains ciphertext and all historical local files. `ZENITH_WORKER_PLAN_MAX_AGE_HOURS` applies only to legacy inspection and does not authorize deletion.
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

Historical WS-WF record, not rerun by this sync (Windows 11, Node 24.19,
Temporal CLI 1.8.2 dev server, SDK 1.24.0; before activity composition):
everything in [Testing](#testing); the esbuild command and the workflow bundle
build that `docker/worker.Dockerfile` uses; `node dist/execution/worker.cjs`
booting from that bundle, polling, running a stub workflow to its
`not_implemented` failure, and a duplicate start returning the same run.

Not verified: a Docker build of the image (Docker is unavailable here); the
Linux `@swc/core` binding; SIGTERM handling on Linux (Windows cannot deliver
SIGTERM; the handler logic is unit-tested with a fake process); Temporal Cloud
and API-key auth; mTLS; composed activities against live providers; behaviour under real load; the
time-skipping server's fidelity to a production server (it is used only for the
24 h approval window and the periodic re-check).

## Not built (next steps)

- `proposeRepair` and auto-repair in the reconcile workflow.
- Search attributes (workspace, environment, capability) for listing operations
  in Temporal visibility.
- Frozen golden replay histories.
- Live acceptance of composed execution, provider sessions/state backends and
  replica failover. The HTTP reconcile controller is already scheduled by
  `.github/workflows/tick.yml`; this does not schedule the observe-only Temporal
  reconcile workflow.


### Durable plan rollout and recovery
Drain workers using local-only plans before migration 7 and the custody-aware worker
are installed. Configure `ZENITH_PLAN_ARTIFACT_KEY` privately and back it up separately
from PostgreSQL; install the checksum-verified packaged OpenTofu identity. Startup
refuses PGlite, missing/overlapping artifact keys, an incompatible schema or executable
identity before polling. Old pending approvals without original producer provenance
need a new review; local files cannot be imported or retroactively attested.

A destroy source review already has a running claim. Its exact original is associated
with the separate awaiting-approval destroy proposal before the first human decision.
A decision that wins that window causes a safe refusal, including partial approval;
refresh cannot cancel an approved or partly decided proposal. The source completion
binds the destination ID/digest. Destination planning inspects that association and
makes only a fresh guard plan, without republishing the original.

The engine owns the durable dispatch CAS, using canonical current policy/roles and
exact current-round human approval IDs/count/digests whose expiry SQL rechecks at the
last clock boundary. After dispatch, lost replies or crashes keep the attempt uncertain
and block automatic replay. Inspect provider state and operation evidence before a
new reviewed action. A fence or policy change cannot revoke an already accepted
provider call atomically.

Restore requires matching artifact keys, fingerprint key, source/backend/lock context
and executable identity as well as the platform records. Previous artifact keys decrypt
only; every new seal uses the current key. Preserve old keys while originals may still
need authentication. Physical retention/pruning, immutable re-encryption/key retirement,
recovery epochs, live backend restore and cross-platform portability require separate
verification and policy. No such deletion is implemented by maintenance.

The mandatory PostgreSQL restore scenario checks actual `pg_dump --version` and
`pg_restore --version` before copying data. Both clients must report the same full
version and match the server major. Set absolute `ZENITH_TEST_PG_DUMP_BIN` and
`ZENITH_TEST_PG_RESTORE_BIN` paths to select the matching clients; otherwise validated
PATH clients are used. Missing or mismatched tools fail the scenario. Private backup
bytes and credential-bearing connection URLs never enter command arguments or results.
The five independent-handle cases formerly registered as PGlite skips now register
only in PostgreSQL; their exact titles remain mandatory, including missing-PG detection.
