/**
 * Workflow versioning contract (PROD-OPS-03).
 *
 * Two independent safety nets protect a workflow that is still running while the
 * worker fleet is replaced:
 *
 *  1. Code level: `patched("<id>")` markers in `definitions/`. Every marker must be
 *     listed in `WORKFLOW_PATCHES` below (tests/workflows/versioning-audit.test.ts
 *     fails on an unregistered or stale entry), and every committed history in
 *     tests/fixtures/workflow-histories must replay against the current bundle
 *     (tests/workflows/history-replay.test.ts).
 *  2. Routing level: Temporal Worker Deployment versions (build ids). A rolling
 *     deploy starts workers of the new build id; the server routes new workflows
 *     (and, for AUTO_UPGRADE, running ones) only after the new version is made
 *     current, and PINNED workflows stay on the build that started them until
 *     they finish.
 *
 * This file is NOT workflow code (the sandbox bundle never imports it): it is read
 * by the worker process, tests and operator scripts only.
 *
 *   ZENITH_WORKER_VERSIONING        off | auto_upgrade | pinned   (default off)
 *   ZENITH_WORKER_DEPLOYMENT_NAME   deployment name               (default zenith-execution)
 *   ZENITH_WORKER_BUILD_ID          required when versioning is not off; the image
 *                                   digest or release tag of THIS worker build
 *
 * `off` keeps today's behaviour (the SDK derives a build id for diagnostics only; no
 * routing). `auto_upgrade` is the rolling default: replay determinism is guarded by
 * the patch registry and the history replay gate, so running workflows may move to
 * the newest current version. `pinned` is for a release that is NOT replay
 * compatible: running workflows finish on the old build, which must stay deployed
 * until `temporal worker deployment describe-version` shows zero pinned workflows.
 * Deployment-version routing needs a Temporal server with worker deployments
 * enabled (Temporal Cloud, or a self-hosted server with
 * `system.enableDeploymentVersions`); a server without it refuses the poll, so this
 * is opt-in rather than on by default. See docs/platform/operations/ROLLING-UPGRADES.md.
 */

import type { WorkerDeploymentOptions } from "@temporalio/worker";

export type WorkerVersioningMode = "off" | "auto_upgrade" | "pinned";

export interface WorkerVersioningConfig {
  mode: Exclude<WorkerVersioningMode, "off">;
  deploymentName: string;
  buildId: string;
}

export class WorkerVersioningError extends Error {
  readonly code = "worker_versioning_invalid";
}

export const DEFAULT_WORKER_DEPLOYMENT_NAME = "zenith-execution";
const DEPLOYMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
/** Temporal joins `deployment.build`; a '.' in either part is ambiguous, so it is refused. */
const BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9_:+-]{0,127}$/;

type Env = Readonly<Record<string, string | undefined>>;

/** Parse the versioning environment. Returns undefined when versioning is off. Fails closed on any malformed value. */
export function workerVersioningFromEnv(env: Env = process.env): WorkerVersioningConfig | undefined {
  const raw = env.ZENITH_WORKER_VERSIONING?.trim().toLowerCase() || "off";
  if (raw !== "off" && raw !== "auto_upgrade" && raw !== "pinned") {
    throw new WorkerVersioningError("ZENITH_WORKER_VERSIONING must be off, auto_upgrade or pinned");
  }
  if (raw === "off") {
    // A build id with versioning off is almost certainly a forgotten switch; refuse rather than silently route nothing.
    if (env.ZENITH_WORKER_BUILD_ID?.trim()) throw new WorkerVersioningError("ZENITH_WORKER_BUILD_ID is set but ZENITH_WORKER_VERSIONING is off; set the mode or unset the build id");
    return undefined;
  }
  const deploymentName = env.ZENITH_WORKER_DEPLOYMENT_NAME?.trim() || DEFAULT_WORKER_DEPLOYMENT_NAME;
  if (!DEPLOYMENT_NAME.test(deploymentName)) throw new WorkerVersioningError("ZENITH_WORKER_DEPLOYMENT_NAME must be 1-100 letters, digits, '_' or '-'");
  const buildId = env.ZENITH_WORKER_BUILD_ID?.trim();
  if (!buildId) throw new WorkerVersioningError("ZENITH_WORKER_BUILD_ID is required when worker versioning is enabled (use the worker image digest or release tag)");
  if (!BUILD_ID.test(buildId)) throw new WorkerVersioningError("ZENITH_WORKER_BUILD_ID must be 1-128 letters, digits, '_', ':', '+' or '-' and must not contain '.'");
  return { mode: raw, deploymentName, buildId };
}

/** The Temporal option fragment for a versioned worker. */
export function workerDeploymentOptionsFor(config: WorkerVersioningConfig): WorkerDeploymentOptions {
  return {
    version: { deploymentName: config.deploymentName, buildId: config.buildId },
    useWorkerVersioning: true,
    defaultVersioningBehavior: config.mode === "pinned" ? "PINNED" : "AUTO_UPGRADE",
  };
}

/** Log-safe description (no secrets are involved, but the mode must be visible at startup). */
export function describeWorkerVersioning(config: WorkerVersioningConfig | undefined): { versioning: WorkerVersioningMode; deployment?: string; buildId?: string } {
  return config ? { versioning: config.mode, deployment: config.deploymentName, buildId: config.buildId } : { versioning: "off" };
}

/* ------------------------------ patch registry ------------------------------ */

export interface WorkflowPatchEntry {
  /** the exact string passed to `patched()` / `deprecatePatch()` */
  id: string;
  /** the registered workflow type whose code contains the marker */
  workflow: string;
  /**
   * `active`: the marker is live and histories without it must still replay.
   * `deprecated`: `deprecatePatch(id)` replaced `patched(id)`; no history without the marker may remain.
   */
  status: "active" | "deprecated";
  /** why the branch exists; one line */
  reason: string;
  /** when `active` may become `deprecated` */
  removableWhen: string;
}

export const WORKFLOW_PATCHES: readonly WorkflowPatchEntry[] = [
  { id: "ecs-replica-repair-v1", workflow: "dayTwoOperationWorkflow", status: "active", reason: "drift.repair gained the ECS replica repair recipe steps", removableWhen: "every dayTwoOperationWorkflow started before the patch has closed or been retention-pruned" },
  { id: "durable-build-launch-v1", workflow: "infrastructureDeployWorkflow", status: "active", reason: "build step uses the durable build-launch activity options and uncertain-launch handling", removableWhen: "every infrastructureDeployWorkflow that passed the build step before the patch has closed" },
  { id: "reconcile-canonical-proposals-v1", workflow: "reconcileEnvironmentWorkflow", status: "active", reason: "reconcile passes run the canonical repair lifecycle (proposals) instead of observe-only", removableWhen: "every reconcileEnvironmentWorkflow started before the patch has closed (passes are short, so this is the first candidate)" },
];

/**
 * Every workflow type the worker registers: the exported function names of
 * definitions/index.ts. Adding a workflow means adding it here, to
 * WORKFLOW_HISTORY_SCENARIOS (tests/workflows/history-scenarios.ts) and recording a fixture;
 * the audit and replay tests fail otherwise.
 */
export const REGISTERED_WORKFLOW_TYPES = [
  "infrastructureDeployWorkflow",
  "infrastructureDestroyWorkflow",
  "dayTwoOperationWorkflow",
  "remediationWorkflow",
  "reconcileEnvironmentWorkflow",
  "teardownReviewWorkflow",
  "reconcileSweepWorkflow",
  "criticalMaintenanceWorkflow",
  "codingAgentRunWorkflow",
  "mixedParentWorkflow",
] as const;
