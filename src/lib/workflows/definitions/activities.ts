/**
 * The activity proxies the workflows call, one `proxyActivities` per activity so
 * each carries its own timeouts and retry policy from `policies.ts`.
 *
 * Deterministic module (workflow sandbox): the activity implementations are
 * never imported here, only their TypeScript type (`WorkerActivities`), so no
 * Node code, store or environment reaches the workflow bundle.
 */

import { ActivityCancellationType, proxyActivities } from "@temporalio/workflow";
import type { WorkerActivities } from "../types";
import { ACTIVITY_OPTIONS, type ActivityName } from "./policies";

/** Only the patched reconcile branch uses these changed history options. */
export const canonicalReconcileActivities = proxyActivities<Pick<WorkerActivities, "reconcileObserve">>({
  ...ACTIVITY_OPTIONS.reconcileObserve,
  heartbeatTimeout: "60s",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

function proxyFor<K extends ActivityName>(name: K): WorkerActivities[K] {
  return proxyActivities<WorkerActivities>(ACTIVITY_OPTIONS[name])[name];
}

/**
 * Listed explicitly so a new activity in `ExecutionActivities` fails to compile
 * here until it is given a policy in `ACTIVITY_OPTIONS`.
 */
export const activities: WorkerActivities = {
  recordStep: proxyFor("recordStep"),
  markOperation: proxyFor("markOperation"),
  acquireLease: proxyFor("acquireLease"),
  renewLease: proxyFor("renewLease"),
  releaseLease: proxyFor("releaseLease"),
  validateDesiredState: proxyFor("validateDesiredState"),
  planInfrastructure: proxyFor("planInfrastructure"),
  evaluatePolicy: proxyFor("evaluatePolicy"),
  checkApproval: proxyFor("checkApproval"),
  finalPlan: proxyFor("finalPlan"),
  applyInfrastructure: proxyFor("applyInfrastructure"),
  buildArtifacts: proxyFor("buildArtifacts"),
  deployWorkloads: proxyFor("deployWorkloads"),
  runMigrations: proxyFor("runMigrations"),
  verifyInfrastructure: proxyFor("verifyInfrastructure"),
  verifyApplication: proxyFor("verifyApplication"),
  observeEnvironment: proxyFor("observeEnvironment"),
  executeCapability: proxyFor("executeCapability"),
  reconcileObserve: proxyFor("reconcileObserve"),
};
