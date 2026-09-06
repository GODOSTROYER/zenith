import type { Deployment, DeploymentStatus, Output, StepStatus } from "@/lib/domain/types";

export interface DeploymentPatch {
  status?: DeploymentStatus;
  steps: Record<string, { status: StepStatus; error?: string }>;
  outputs: Output[];
}

const TERMINAL = new Set<DeploymentStatus>(["succeeded", "failed", "rolled_back", "cancelled"]);
const FINISHED_STEP = new Set<StepStatus>(["done", "failed", "skipped"]);
const PHASE_ORDER: Partial<Record<DeploymentStatus, number>> = { planning: 0, awaiting_approval: 1, applying: 2, verifying: 3, rolling_back: 4 };

/** Polling is authoritative once completed; an earlier SSE patch cannot rewind it. */
export function reconcileDeployment(base: Deployment, patch: DeploymentPatch): Deployment {
  const keys = new Set(base.outputs.map((output) => output.key));
  const patchIsEarlier = patch.status !== undefined && !TERMINAL.has(patch.status)
    && (PHASE_ORDER[patch.status] ?? 0) < (PHASE_ORDER[base.status] ?? 0);
  return {
    ...base,
    status: TERMINAL.has(base.status) || patchIsEarlier ? base.status : (patch.status ?? base.status),
    steps: base.steps.map((step) => patch.steps[step.id] && !FINISHED_STEP.has(step.status)
      ? { ...step, ...patch.steps[step.id] } : step),
    outputs: [...base.outputs, ...patch.outputs.filter((output) => !keys.has(output.key))],
  };
}
