/**
 * Workflow entry point for the Temporal worker's bundler (`workflowsPath`).
 *
 * Only workflow functions are exported, by name: the worker registers
 * every exported function as a workflow type, so helpers must not leak out of
 * here. Everything under `definitions/` is deterministic code that runs in the
 * workflow sandbox (imports limited to `@temporalio/workflow` and relative
 * modules; no `@/` alias, which the bundler cannot resolve).
 *
 * Versioning: this is v1; nothing is patched. Changing the order of activities,
 * adding or removing a step, or changing a timer for a workflow that may still
 * be running requires `patched("<id>")` / `deprecatePatch` from
 * `@temporalio/workflow` (see docs/platform/EXECUTION-WORKER.md). The replay
 * test in tests/workflows/replay.test.ts fails when such a change is made
 * without one.
 */

export { infrastructureDeployWorkflow } from "./deploy";
export { infrastructureDestroyWorkflow } from "./destroy";
export { dayTwoOperationWorkflow } from "./dayTwo";
export { remediationWorkflow } from "./remediation";
export { reconcileEnvironmentWorkflow } from "./reconcile";

export { teardownReviewWorkflow } from "./destroy-review";
export { reconcileSweepWorkflow } from "./reconcileSweep";
