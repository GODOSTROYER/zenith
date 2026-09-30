/**
 * The activity set the execution worker registers.
 *
 * STATUS: every activity is a stub that fails with a non-retryable
 * `not_implemented` failure. The real implementations (store, lease service,
 * OpenTofu runner, policy engine, drivers, credential broker) are built in
 * their own workstreams and plug in here through `ActivityDeps`. The stubs
 * exist so the worker boots, the workflows bundle, and an accidental run
 * against this build ends `failed` with a clear message ("nothing was
 * changed") instead of hanging or, worse, appearing to work.
 *
 * Rules every real activity must follow (the workflows depend on them):
 *
 *  - Inputs and results carry ids, digests, counts and short redacted
 *    summaries only. No credentials, secret values, plan files or provider
 *    responses (Temporal history is durable and replicated).
 *  - Cloud credentials exist only inside `CredentialBroker.withSession` and
 *    never leave the activity.
 *  - Mutating activities (applyInfrastructure, deployWorkloads, runMigrations,
 *    executeCapability) are idempotent on (operationId, step), check the fence
 *    token before AND after the external call, and heartbeat at least every
 *    30 s (heartbeatTimeout is 60 s; cancellation is delivered through
 *    heartbeats). Long activities that hold the lease renew it as they run.
 *  - Throw typed failures from `./failures` when the outcome is known
 *    (LeaseLost, plan_changed, StepFailed). Leave everything else as a plain
 *    error: for a mutating step the workflow will finalize `uncertain`, which
 *    is the honest answer when a crash or timeout hides what happened.
 *  - Never destroy anything from an activity the workflows call.
 */

import { withFailureMapping, notImplemented } from "./failures";
import type { WorkerActivities } from "../types";

/** What the real activities will need. Extended by the workstreams that implement them. */
export interface ActivityDeps {
  /** worker identity, e.g. `zenith-exec:<host>:<pid>`; used as the lease holder tag in logs */
  workerIdentity: string;
}

const stub = (name: keyof WorkerActivities) => async (): Promise<never> => {
  throw notImplemented(name);
};

export function createActivities(_deps: ActivityDeps): WorkerActivities {
  const activities: { [K in keyof WorkerActivities]: WorkerActivities[K] } = {
    recordStep: stub("recordStep"),
    markOperation: stub("markOperation"),
    acquireLease: stub("acquireLease"),
    renewLease: stub("renewLease"),
    releaseLease: stub("releaseLease"),
    validateDesiredState: stub("validateDesiredState"),
    planInfrastructure: stub("planInfrastructure"),
    evaluatePolicy: stub("evaluatePolicy"),
    checkApproval: stub("checkApproval"),
    finalPlan: stub("finalPlan"),
    applyInfrastructure: stub("applyInfrastructure"),
    buildArtifacts: stub("buildArtifacts"),
    deployWorkloads: stub("deployWorkloads"),
    runMigrations: stub("runMigrations"),
    verifyInfrastructure: stub("verifyInfrastructure"),
    verifyApplication: stub("verifyApplication"),
    observeEnvironment: stub("observeEnvironment"),
    executeCapability: stub("executeCapability"),
    reconcileObserve: stub("reconcileObserve"),
  };
  return withFailureMapping(activities);
}
