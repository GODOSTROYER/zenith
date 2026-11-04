/**
 * Typed production bridge entrypoints. The outbox owns durable admission,
 * current authority, the sole transport attempt and exact retained readback.
 * Proposal approval admits planning; activities authorize provider writes later.
 */
import type { DestroyWorkflowInput } from "@/lib/workflows/definitions/destroy";
import type { DeployWorkflowInput } from "@/lib/workflows/types";
import { startWorkflowIntent, type ConfirmedWorkflowStart } from "@/lib/workflows/start-intent";

export function startDeploymentWorkflow(input: DeployWorkflowInput): Promise<ConfirmedWorkflowStart> {
  return startWorkflowIntent("deploy", input);
}

export function startDestroyWorkflow(input: DestroyWorkflowInput): Promise<ConfirmedWorkflowStart> {
  return startWorkflowIntent("destroy", input);
}
