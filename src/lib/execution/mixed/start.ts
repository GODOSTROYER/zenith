/**
 * Starting an approved mixed parent from the signed-in web app (PROD-MIX-02).
 *
 * Approval and start are separate acts, as for portability: a person approved the
 * parent operation (its immutable input carries the child set), then the person it
 * was proposed for starts it here. Everything is re-proved first (`verifyParent`),
 * then the operation is claimed through the broker (one claim, ever) and the parent
 * workflow is started through the durable start intent. A start that cannot be
 * confirmed is reported as such and never repeated blindly.
 */
import { BrokerError, isBrokerError, notFound } from "@/lib/capabilities/errors";
import type { Broker } from "@/lib/capabilities/platform";
import * as plans from "@/lib/controlplane/db/repos/mixed-parent-plans";
import type { Principal } from "@/lib/controlplane/types";
import { MIXED_PARENT_CAPABILITY } from "./types";
import { verifyParent, type MixedDeps } from "./service";

export interface MixedWorkflowStarter {
  available(): Promise<{ available: true } | { available: false; reason: string }>;
  start(input: { workspaceId: string; operationId: string; environmentId: string; parentPlanId: string }): Promise<{ workflowId: string; runId: string }>;
}

export function defaultMixedStarter(): MixedWorkflowStarter {
  return {
    async available() {
      const { temporalAvailable } = await import("@/lib/workflows/client");
      const result = await temporalAvailable();
      return result.available ? { available: true } : { available: false, reason: "The workflow engine could not be reached." };
    },
    async start(input) {
      const { startWorkflowIntent } = await import("@/lib/workflows/start-intent");
      const started = await startWorkflowIntent("mixedParent", input);
      return { workflowId: started.workflowId, runId: started.runId };
    },
  };
}

export interface StartedMixedParent { operationId: string; parentPlanId: string; status: "running"; startedNow: boolean; workflow: { id: string; runId: string } }

export async function startMixedParent(
  broker: Broker,
  deps: MixedDeps,
  input: { workspaceId: string; operationId: string; caller: Principal },
  starter: MixedWorkflowStarter = defaultMixedStarter(),
): Promise<StartedMixedParent> {
  const detail = await broker.getOperationDetail({ workspaceId: input.workspaceId, operationId: input.operationId, principal: input.caller });
  const op = detail.operation;
  if (op.capability !== MIXED_PARENT_CAPABILITY || !op.environmentId) throw notFound();
  const stored = await plans.getPlanByParentOperation(deps.sql, input.workspaceId, op.id);
  if (!stored) throw notFound();
  // Only the person the operation was proposed for may start it from the browser.
  const requester = op.principal.onBehalfOf ?? op.principal.id;
  if (requester !== input.caller.id) throw notFound();
  if (op.status === "awaiting_approval") {
    throw new BrokerError("approval_required", "This mixed plan has not been approved. A person must approve its exact child set first.", "Open the operation in the Zenith web app and approve it.", { status: op.status });
  }
  if (!["approved", "queued", "running"].includes(op.status)) {
    throw new BrokerError("invalid_state", `This operation is ${op.status}; only an approved operation can be started.`, "Plan again if the change is still wanted.", { status: op.status });
  }
  try {
    await verifyParent(deps, { workspaceId: input.workspaceId, operationId: op.id, planId: stored.plan.parentPlanId, requireRunning: false });
  } catch (error) {
    throw new BrokerError("invalid_state", error instanceof Error ? error.message.slice(0, 300) : "The mixed plan cannot start.", "Fix what the message names, or plan again; nothing was claimed or started.");
  }
  const availability = await starter.available();
  if (!availability.available) {
    throw new BrokerError("invalid_state", "The workflow engine is not reachable, so nothing was started and no approval was consumed.", "Try again later; this call did not claim the operation.", { reason: availability.reason });
  }
  let startedNow = false;
  if (op.status !== "running") {
    try {
      await broker.beginExecution({ workspaceId: op.workspaceId, operationId: op.id, holder: `workflow:${op.id}`, audience: "worker", leaseMs: 5 * 60_000 });
      startedNow = true;
    } catch (error) {
      if (!(isBrokerError(error) && error.code === "already_claimed")) throw error;
    }
  }
  try {
    const started = await starter.start({ workspaceId: op.workspaceId, operationId: op.id, environmentId: op.environmentId, parentPlanId: stored.plan.parentPlanId });
    return { operationId: op.id, parentPlanId: stored.plan.parentPlanId, status: "running", startedNow, workflow: { id: started.workflowId, runId: started.runId } };
  } catch {
    throw new BrokerError("invalid_state", "The operation is claimed but its workflow start could not be confirmed.", "Inspect the operation. A start is never repeated blindly, and a replacement proposal would not be a retry.", { operationStatus: startedNow ? "running" : op.status });
  }
}
