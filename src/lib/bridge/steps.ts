/**
 * The planned step list of a workflow-executed Deployment.
 *
 * The existing timeline UI (`components/ui/phase-timeline.tsx`) renders a
 * Deployment's `steps` grouped by `phase`, and `components/deploy/live-progress`
 * patches them from `step` events by `stepId`. A deployment that a Temporal
 * workflow executes must therefore look exactly like one the engine runs: the
 * bridge creates the full list up front (all `pending`), and the execution
 * worker's product port (`execution/product-port.ts`, ws-act) upserts progress
 * onto the SAME rows.
 *
 * That contract has three parts, and this file is the control-plane half:
 *   - id    `step-<StepName>`                  (the port finds a row by this id)
 *   - seq   the index in the port's ORDER table (it sorts by this)
 *   - phase / title per StepName               (the port writes these for a row it creates)
 * `STEP_TABLE` mirrors the port's `STEPS` table, entry for entry and in the same
 * order. tests/bridge/steps.test.ts pins the order and the deploy sequence
 * against `workflows/definitions/deploy.ts` so a drift fails a test, not a user.
 * If the worker ever creates a row this list did not plan (a step it adds), the
 * UI still renders it — it just was not shown ahead of time.
 *
 * The step LIST is the deploy workflow's declared sequence
 * (`DEPLOY_STEPS` in `workflows/definitions/deploy.ts`, which imports the
 * Temporal sandbox and so cannot be imported here). `build` is shown because
 * the workflow declares it; when images are pinned the workflow records it
 * `skipped`.
 */
import type { DeploymentStep } from "@/lib/domain/types";
import type { StepName } from "@/lib/workflows/types";

/** Mirror of `STEPS` in execution/product-port.ts: same keys, same order. */
export const STEP_TABLE: Readonly<Record<StepName, { phase: DeploymentStep["phase"]; title: string }>> = {
  validate: { phase: "prepare", title: "Validate desired state" },
  lease: { phase: "prepare", title: "Take the environment lease" },
  credentials: { phase: "prepare", title: "Broker credentials" },
  plan: { phase: "prepare", title: "Plan infrastructure" },
  policy: { phase: "prepare", title: "Evaluate policy" },
  approval: { phase: "prepare", title: "Wait for approval" },
  final_plan: { phase: "prepare", title: "Confirm the plan is unchanged" },
  apply_network: { phase: "provision", title: "Apply network" },
  apply_data: { phase: "provision", title: "Apply data stores" },
  apply_infrastructure: { phase: "provision", title: "Apply infrastructure" },
  build: { phase: "release", title: "Build artifacts" },
  publish: { phase: "release", title: "Publish artifacts" },
  deploy: { phase: "release", title: "Deploy workloads" },
  secrets: { phase: "release", title: "Sync secrets" },
  ingress: { phase: "release", title: "Configure ingress" },
  dns_tls: { phase: "release", title: "Configure DNS and TLS" },
  migrate: { phase: "release", title: "Run migrations" },
  execute_capability: { phase: "release", title: "Run the operation" },
  verify_infrastructure: { phase: "verify", title: "Verify infrastructure" },
  verify_application: { phase: "verify", title: "Verify the application" },
  observe: { phase: "verify", title: "Observe the environment" },
  finalize: { phase: "verify", title: "Finalize" },
  release: { phase: "verify", title: "Release the lease" },
};

/** The order the product port sorts rows by. */
export const STEP_ORDER = Object.keys(STEP_TABLE) as StepName[];

/** The steps `infrastructureDeployWorkflow` reports, in its order. */
export const DEPLOY_WORKFLOW_STEPS: readonly StepName[] = [
  "validate",
  "lease",
  "plan",
  "policy",
  "approval",
  "final_plan",
  "apply_infrastructure",
  "build",
  "deploy",
  "migrate",
  "verify_infrastructure",
  "verify_application",
  "observe",
  "finalize",
  "release",
];

/** Row id the product port looks a step up by. */
export const stepRowId = (step: StepName): string => `step-${step}`;

/** The deployment's planned timeline: every workflow step, `pending`, in the port's row shape. */
export function plannedWorkflowSteps(steps: readonly StepName[] = DEPLOY_WORKFLOW_STEPS): DeploymentStep[] {
  return steps.map((step) => ({
    id: stepRowId(step),
    seq: STEP_ORDER.indexOf(step),
    phase: STEP_TABLE[step].phase,
    title: STEP_TABLE[step].title,
    targetId: "",
    status: "pending" as const,
  }));
}
