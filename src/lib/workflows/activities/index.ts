/**
 * The activity set the execution worker registers.
 *
 * Production delegates to the platform composition root. The explicit stub
 * factory is retained for workflow contract tests only; the worker never uses it.
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
import { composeExecutionActivities, type ComposeExecutionOptions } from "@/lib/platform/execution";

/** What the real activities will need. Extended by the workstreams that implement them. */
export type ActivityDeps = ComposeExecutionOptions;

const stub = (name: keyof WorkerActivities) => async (): Promise<never> => {
  throw notImplemented(name);
};

export function createActivities(deps: ActivityDeps): WorkerActivities {
  return composeExecutionActivities(deps);
}

/** Explicit test factory. Never selects a stub as a production fallback. */
export function createStubActivities(_deps?: { workerIdentity: string }): WorkerActivities {
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
