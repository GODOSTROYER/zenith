/**
 * Every timeout, retry policy and "may have acted" fact the workflows depend
 * on, in one place. Workflow code (`deploy.ts`, `dayTwo.ts`, ...) contains no
 * numbers of its own.
 *
 * Deterministic module: it is bundled into the Temporal workflow sandbox, so it
 * imports only `@temporalio/workflow` and, relatively, type-only modules (see
 * tests/workflows/sandbox.test.ts, which enforces that).
 *
 * The retry model, and why:
 *
 *  - Reads (validate, policy, verify, observe, approval check) are safe to
 *    repeat: 5 attempts, exponential backoff.
 *  - Lease operations are short and idempotent: 3 attempts.
 *  - Planning is read-only but expensive (minutes of `tofu plan`): 3 attempts.
 *  - Mutating steps (apply, deploy, migrate, capability execution) get exactly
 *    ONE attempt at the Temporal layer. Idempotency lives inside the activity
 *    (keyed on operationId + step, fenced). Letting Temporal replay a half-run
 *    `tofu apply` on another worker after a crash would be the one thing worse
 *    than stopping, so a crashed or timed-out mutating activity surfaces as a
 *    failure the workflow finalizes as `uncertain`, never as a silent retry.
 *  - Mutating activities are cancelled with WAIT_CANCELLATION_COMPLETED so the
 *    workflow never releases the lease while a mutation is still running.
 */

import { ActivityCancellationType, type ActivityOptions, type RetryPolicy } from "@temporalio/workflow";
import { FAILURE_TYPES, type ExecutionActivities, type ReconcileActivities, type StepName } from "../types";

/* --------------------------------- limits --------------------------------- */

/** Lease time-to-live. Renewed between steps and by long activities' heartbeats. */
export const LEASE_TTL_MS = 5 * 60 * 1000;

/** How long an approval may take to be recorded before the operation expires. */
export const APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * While waiting for approval the workflow also re-checks the approval record on
 * this interval, so a lost `approvalRecorded` signal costs at most this long.
 */
export const APPROVAL_POLL_INTERVAL_MS = 30 * 60 * 1000;

/** Longest text the workflow puts in an `error` / step `detail`. */
export const MAX_DETAIL_CHARS = 500;

/* ------------------------ "may this step have acted" ----------------------- */

/**
 * The step -> "this step may have changed something outside the workflow" table.
 *
 * It decides the final status when a step fails in a way the activity did not
 * classify: `true` -> `uncertain` (we cannot prove what the step left behind),
 * `false` -> `failed`. It also arms the `mutationStarted` latch: once any `true`
 * step has been entered, a later lost lease is `uncertain` too, because the
 * environment is known to have been touched and another writer may now be acting.
 *
 * `build` is `false` on purpose: it produces content-addressed images and does
 * not touch the environment. `plan`, `final_plan`, `policy`, `validate`,
 * `verify_*`, `observe` and the lease/approval bookkeeping are reads.
 *
 * Typed as an exhaustive Record so adding a StepName forces a decision here.
 */
export const STEP_MAY_HAVE_ACTED: Readonly<Record<StepName, boolean>> = {
  validate: false,
  lease: false,
  credentials: false,
  plan: false,
  policy: false,
  approval: false,
  final_plan: false,
  apply_network: true,
  apply_data: true,
  apply_infrastructure: true,
  build: false,
  publish: true,
  deploy: true,
  secrets: true,
  ingress: true,
  dns_tls: true,
  migrate: true,
  verify_infrastructure: false,
  verify_application: false,
  observe: false,
  execute_capability: true,
  finalize: false,
  release: false,
};

/* ----------------------------- retry policies ------------------------------ */

/**
 * Failure types that must never be retried, whatever the throwing side set on
 * `nonRetryable`. Defense in depth: the activity marks these non-retryable
 * itself (`activities/failures.ts`), and the policy repeats it.
 */
export const NON_RETRYABLE_TYPES: string[] = [
  FAILURE_TYPES.leaseLost,
  FAILURE_TYPES.leaseBusy,
  FAILURE_TYPES.planChanged,
  FAILURE_TYPES.stepFailed,
  FAILURE_TYPES.notImplemented,
];

const backoff = (maximumAttempts: number, maximumInterval: string): RetryPolicy => ({
  initialInterval: "1s",
  backoffCoefficient: 2,
  maximumInterval,
  maximumAttempts,
  nonRetryableErrorTypes: NON_RETRYABLE_TYPES,
});

const READ_RETRY = backoff(5, "30s");
const LEASE_RETRY = backoff(3, "10s");
const PLAN_RETRY = backoff(3, "1m");
const BUILD_RETRY = backoff(3, "1m");
/** One attempt: see the module comment. */
const MUTATING_RETRY: RetryPolicy = { maximumAttempts: 1, nonRetryableErrorTypes: NON_RETRYABLE_TYPES };
/**
 * The terminal status write is the one thing the workflow must not give up on:
 * no `maximumAttempts` (Temporal's "unlimited"), so it retries until the store
 * answers, bounded only by the activity's scheduleToCloseTimeout.
 */
const TERMINAL_WRITE_RETRY: RetryPolicy = {
  initialInterval: "1s",
  backoffCoefficient: 2,
  maximumInterval: "30s",
  nonRetryableErrorTypes: NON_RETRYABLE_TYPES,
};

const HEARTBEAT = "60s";

const read = (startToCloseTimeout: string): ActivityOptions => ({ startToCloseTimeout, retry: READ_RETRY });

const mutating = (startToCloseTimeout: string): ActivityOptions => ({
  startToCloseTimeout,
  heartbeatTimeout: HEARTBEAT,
  retry: MUTATING_RETRY,
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

export type ActivityName = keyof ExecutionActivities | keyof ReconcileActivities;

/**
 * Per-activity options. Long-running activities (heartbeatTimeout set) MUST
 * heartbeat at least every 30 s; that is also how cancellation reaches them.
 * Reads have no heartbeat timeout and must finish inside startToClose.
 */
export const ACTIVITY_OPTIONS: Readonly<Record<ActivityName, ActivityOptions>> = {
  // progress projection: best effort (OperationRun.mark), so it does not retry for long
  recordStep: { startToCloseTimeout: "30s", retry: backoff(3, "10s") },
  // the terminal status must land
  markOperation: { startToCloseTimeout: "30s", scheduleToCloseTimeout: "1h", retry: TERMINAL_WRITE_RETRY },

  acquireLease: { startToCloseTimeout: "30s", retry: LEASE_RETRY },
  renewLease: { startToCloseTimeout: "30s", retry: LEASE_RETRY },
  releaseLease: { startToCloseTimeout: "30s", retry: LEASE_RETRY },

  validateDesiredState: read("2m"),
  planInfrastructure: { startToCloseTimeout: "30m", heartbeatTimeout: HEARTBEAT, retry: PLAN_RETRY },
  evaluatePolicy: read("2m"),
  checkApproval: read("1m"),
  finalPlan: { startToCloseTimeout: "30m", heartbeatTimeout: HEARTBEAT, retry: PLAN_RETRY },

  applyInfrastructure: mutating("60m"),
  buildArtifacts: { startToCloseTimeout: "45m", heartbeatTimeout: HEARTBEAT, retry: BUILD_RETRY },
  deployWorkloads: mutating("30m"),
  runMigrations: mutating("30m"),
  executeCapability: mutating("30m"),

  verifyInfrastructure: read("10m"),
  verifyApplication: read("10m"),
  observeEnvironment: read("10m"),
  reconcileObserve: read("10m"),
};
