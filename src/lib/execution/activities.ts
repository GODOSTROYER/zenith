/**
 * `createExecutionActivities(deps)` — the real activities behind the
 * `ExecutionActivities` contract (`src/lib/workflows/types.ts`), plus the
 * reconcile pass's `reconcileObserve`.
 *
 * This is the ONLY place in the system where the resource model, the OpenTofu
 * engine, policy facts, the driver registry, the credential broker and the
 * stores meet. Each activity lives in a focused module:
 *
 *   steps.ts       recordStep, markOperation, acquireLease, renewLease, releaseLease
 *   plan.ts        validateDesiredState, planInfrastructure, evaluatePolicy, checkApproval, finalPlan
 *   apply.ts       applyInfrastructure
 *   release.ts     buildArtifacts, deployWorkloads, runMigrations
 *   verify.ts      verifyInfrastructure, verifyApplication, observeEnvironment, reconcileObserve
 *   capability.ts  executeCapability
 *
 * Wire it in the worker, then wrap the result with `withFailureMapping`
 * (workflows/activities/failures.ts) so `LeaseLostError` and
 * `TofuPlanChangedError` cross the Temporal boundary as typed failures:
 *
 *     const db = await platformDb();
 *     const activities = withFailureMapping(
 *       createExecutionActivities({
 *         ...createPlatformPorts(db),
 *         product: createProductPort(),
 *         broker,                       // capability broker adapter (WS-CAP)
 *         credentials: awsBroker,       // AwsCredentialBroker
 *         prober: createSafeProber(),
 *         build, sourceBundle, workloads, migrations,   // AWS compute-driver helpers
 *         fingerprintKey,               // from a server secret, same on every worker
 *         heartbeat: (d) => Context.current().heartbeat(d),
 *         activitySignal: () => Context.current().cancellationSignal,
 *         workerId: config.identity,
 *         planDir: "/var/lib/zenith/plans",
 *       })
 *     );
 *
 * Every activity returns ids, digests, counts and short scrubbed strings; none
 * returns or persists a credential, a plan file or a raw provider payload.
 */
import type { ExecutionActivities, LeaseRef } from "@/lib/workflows/types";
import { createApplyActivities } from "./apply";
import { createCapabilityActivities } from "./capability";
import { createPlanActivities } from "./plan";
import { createReleaseActivities } from "./release";
import { createRuntime } from "./runtime";
import type { ExecutionDeps } from "./ports";
import { createStepActivities } from "./steps";
import { createVerifyActivities } from "./verify";

/** Structurally identical to `WorkerActivities` (`ExecutionActivities & ReconcileActivities`) in workflows/types.ts. */
export interface ExecutionWorkerActivities extends ExecutionActivities {
  reconcileObserve(input: { passId: string; workspaceId: string; environmentId: string; lease: LeaseRef }): Promise<{ drift: number; unknown: number }>;
}

export function createExecutionActivities(deps: ExecutionDeps): ExecutionWorkerActivities {
  const rt = createRuntime(deps);
  const verify = createVerifyActivities(rt);
  return {
    ...createStepActivities(rt),
    ...createPlanActivities(rt),
    ...createApplyActivities(rt),
    ...createReleaseActivities(rt),
    ...createCapabilityActivities(rt),
    verifyInfrastructure: verify.verifyInfrastructure,
    verifyApplication: verify.verifyApplication,
    observeEnvironment: verify.observeEnvironment,
    reconcileObserve: verify.reconcileObserve,
  };
}
