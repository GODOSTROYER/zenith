import type { Deployment, DeploymentEvent, DeploymentStatus, Output, StepStatus } from "@/lib/domain/types";
import { followsStatus } from "@/lib/domain/deployment-status";

export interface DeploymentPatch {
  status?: DeploymentStatus;
  steps: Record<string, { status: StepStatus; error?: string }>;
  outputs: Output[];
}

export const EMPTY_DEPLOYMENT_PATCH: DeploymentPatch = { steps: {}, outputs: [] };

const TERMINAL = new Set<DeploymentStatus>(["succeeded", "failed", "rolled_back", "cancelled"]);
const FINISHED_STEP = new Set<StepStatus>(["done", "failed", "skipped"]);
const PHASE_ORDER: Partial<Record<DeploymentStatus, number>> = { planning: 0, awaiting_approval: 1, applying: 2, verifying: 3, rolling_back: 4 };

/** Polling is authoritative once completed; an earlier SSE patch cannot rewind it. */
export function reconcileDeployment(base: Deployment, patch: DeploymentPatch): Deployment {
  const keys = new Set(base.outputs.map((output) => output.key));
  const patchIsEarlier = patch.status !== undefined && !TERMINAL.has(patch.status)
    && (PHASE_ORDER[patch.status] ?? 0) < (PHASE_ORDER[base.status] ?? 0);
  // A replayed terminal status must not undo a rollback the record already shows.
  const cannotFollow = patch.status !== undefined && !followsStatus(base.status, patch.status);
  return {
    ...base,
    status: TERMINAL.has(base.status) || patchIsEarlier || cannotFollow ? base.status : (patch.status ?? base.status),
    steps: base.steps.map((step) => patch.steps[step.id] && !FINISHED_STEP.has(step.status)
      ? { ...step, ...patch.steps[step.id] } : step),
    outputs: [...base.outputs, ...patch.outputs.filter((output) => !keys.has(output.key))],
  };
}

/**
 * Fold one streamed event into a patch. The log can hold stale events after a
 * terminal one (see `followsStatus`), so the patch never moves backwards: a
 * status that cannot follow the current one is dropped, and a finished step
 * is not reopened.
 */
export function applyStreamEvent(patch: DeploymentPatch, event: DeploymentEvent): DeploymentPatch {
  if (event.type === "status") {
    if (patch.status !== undefined && !followsStatus(patch.status, event.status)) return patch;
    return { ...patch, status: event.status };
  }
  if (event.type === "step") {
    const current = patch.steps[event.stepId];
    if (current && FINISHED_STEP.has(current.status) && !FINISHED_STEP.has(event.status)) return patch;
    return { ...patch, steps: { ...patch.steps, [event.stepId]: { status: event.status, error: event.error ?? current?.error } } };
  }
  if (event.type === "output")
    return { ...patch, outputs: [...patch.outputs.filter((o) => o.key !== event.output.key), event.output] };
  return patch;
}
