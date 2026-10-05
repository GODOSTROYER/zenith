/**
 * Starting an approved portability operation from the signed-in web app.
 *
 * Approval and execution are separate acts: a person approves the exact proposal
 * in the browser, then a person starts it. (An operation an integration proposed
 * is started by that integration through `zenith_execute_approved_operation`;
 * this is the human path, and the route behind it refuses any bearer credential.)
 *
 * It claims the operation through the broker (one claim, ever: a second caller
 * gets `already_claimed`), then records a durable start intent and starts the
 * generic day-two workflow, which re-checks policy, waits for approval if
 * policy still requires one, takes the environment lease and runs
 * `executeCapability`. A start that cannot be confirmed is reported as such and
 * never repeated; the claim and its retained intent are what recovery reads.
 */
import { BrokerError, isBrokerError, notFound } from "@/lib/capabilities/errors";
import type { Broker } from "@/lib/capabilities/platform";
import type { Principal } from "@/lib/controlplane/types";
import { isPortabilityCapability } from "./inputs";

export interface StartedPortabilityOperation {
  operationId: string;
  status: "running";
  startedNow: boolean;
  workflow: { id: string; runId: string };
}

export interface WorkflowStarter {
  available(): Promise<{ available: true } | { available: false; reason: string }>;
  start(input: { operationId: string; workspaceId: string; environmentId: string; capability: string }): Promise<{ workflowId: string; runId: string }>;
}

/** The real workflow engine, imported lazily because it pulls in the Temporal client. */
export function defaultWorkflowStarter(): WorkflowStarter {
  return {
    async available() {
      const { temporalAvailable } = await import("@/lib/workflows/client");
      const result = await temporalAvailable();
      return result.available ? { available: true } : { available: false, reason: "The workflow engine could not be reached." };
    },
    async start(input) {
      const { startWorkflowIntent } = await import("@/lib/workflows/start-intent");
      const started = await startWorkflowIntent("dayTwo", input);
      return { workflowId: started.workflowId, runId: started.runId };
    },
  };
}

export async function startPortabilityOperation(
  broker: Broker,
  input: { workspaceId: string; operationId: string; caller: Principal },
  starter: WorkflowStarter = defaultWorkflowStarter()
): Promise<StartedPortabilityOperation> {
  const detail = await broker.getOperationDetail({ workspaceId: input.workspaceId, operationId: input.operationId, principal: input.caller });
  const op = detail.operation;
  if (!isPortabilityCapability(op.capability) || !op.environmentId) throw notFound();
  // Only the person the operation was proposed for may start it from the browser.
  const requester = op.principal.onBehalfOf ?? op.principal.id;
  if (requester !== input.caller.id) throw notFound();

  if (op.status === "awaiting_approval") {
    throw new BrokerError("approval_required", "This operation has not been approved. A person must approve it first.", "Open the operation in the Zenith web app and approve the exact proposal.", { status: op.status });
  }
  if (!["approved", "queued", "running"].includes(op.status)) {
    throw new BrokerError("invalid_state", `This operation is ${op.status}; only an approved operation can be started.`, "Propose it again if it is still wanted.", { status: op.status });
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
    const started = await starter.start({ operationId: op.id, workspaceId: op.workspaceId, environmentId: op.environmentId, capability: op.capability });
    return { operationId: op.id, status: "running", startedNow, workflow: { id: started.workflowId, runId: started.runId } };
  } catch {
    throw new BrokerError(
      "invalid_state",
      "The operation is claimed but its workflow start could not be confirmed.",
      "Inspect the operation. A start is never repeated blindly, and a replacement proposal would not be a retry.",
      { operationStatus: startedNow ? "running" : op.status }
    );
  }
}
